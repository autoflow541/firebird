/**
 * dmx.js — pure DMX frame builder for the audience lights (no Electron, no serial).
 *
 * Turns engine state (fixtures + master + blackout) plus live audio / beat into a
 * 512-slot DMX frame, and frames it for an ENTTEC DMX USB Pro or Art-Net. The
 * transports live in dmxout.js; this file is deterministic so it is unit-tested.
 *
 * SAFETY (see SAFETY.md):
 *   * Blackout => every fixture slot is 0, always. `out.master` is already 0 under
 *     blackout (engine.deriveOutputs) and identify/flash are gated on it too.
 *   * Flash-to-beat is rate-limited to MAX_FLASH_HZ (3 Hz, the photosensitivity
 *     guideline) no matter the BPM: above 180 BPM it flashes every 2nd/3rd beat.
 *   * Fixtures ship UNPATCHED (enabled:false, addr 0) so a fresh install never writes
 *     DMX over another device's channels (e.g. the laser at address 1).
 *   * The laser's DMX bytes are only written when the engine gate says emit.
 */
(function (root) {
  "use strict";

  const MAX_FLASH_HZ = 3;
  const FLASH_DUTY = 0.25; // fraction of a beat the flash stays on
  const REACT_MODES = ["none", "level", "bass", "mid", "high", "beat", "flash"];

  // Channel maps. Tokens: dim r g b w (intensity/colour), a uv - (always 0),
  // f<n> (fixed value n, e.g. f0 = strobe open, f255 = a macro/dimmer held at full).
  const PROFILES = {
    dimmer:       { label: "Dimmer (1ch)",            map: ["dim"] },
    rgb:          { label: "RGB (3ch)",               map: ["r", "g", "b"] },
    rgbw:         { label: "RGBW (4ch)",              map: ["r", "g", "b", "w"] },
    dimrgb:       { label: "Dimmer + RGB (4ch)",      map: ["dim", "r", "g", "b"] },
    rgbdim:       { label: "RGB + Dimmer (4ch)",      map: ["r", "g", "b", "dim"] },
    dimrgbw:      { label: "Dimmer + RGBW (5ch)",     map: ["dim", "r", "g", "b", "w"] },
    dimrgbstrobe: { label: "Dimmer + RGB + Strobe (5ch)", map: ["dim", "r", "g", "b", "f0"] },
    custom:       { label: "Custom map…",             map: null }
  };
  const MAX_CUSTOM = 32;

  function parseMap(str) {
    const out = [];
    for (const raw of String(str || "").split(/[\s,]+/)) {
      const t = raw.toLowerCase();
      if (!t) continue;
      if (/^f\d{1,3}$/.test(t)) out.push(t);
      else if (["dim", "r", "g", "b", "w", "a", "uv", "-"].includes(t)) out.push(t);
      else out.push("-");
      if (out.length >= MAX_CUSTOM) break;
    }
    return out;
  }
  function mapFor(f) {
    const p = PROFILES[f.profile];
    if (!p) return [];
    return p.map ? p.map : parseMap(f.map);
  }

  // At most MAX_FLASH_HZ flashes per second: flash every Nth beat when BPM is high.
  function flashEvery(bpm) {
    return Math.max(1, Math.ceil((Number(bpm) || 120) / (MAX_FLASH_HZ * 60)));
  }
  const frac = (x) => x - Math.floor(x);

  function flashPulse(ctx) {
    if (!ctx.flash) return 0;
    const every = flashEvery(ctx.bpm);
    const idx = Math.floor(ctx.beatPos);
    if ((((idx % every) + every) % every) !== 0) return 0;
    return frac(ctx.beatPos) < FLASH_DUTY ? 1 : 0;
  }

  function sourceValue(react, ctx) {
    const a = ctx.audio || {};
    switch (react) {
      case "level": return a.level || 0;
      case "bass": return a.bass || 0;
      case "mid": return a.mid || 0;
      case "high": return a.high || 0;
      case "beat": return Math.exp(-frac(ctx.beatPos) * 5);
      case "flash": return flashPulse(ctx);
      default: return 1;
    }
  }

  function hexToRgb(hex) {
    const n = parseInt(String(hex || "#ffffff").replace("#", ""), 16);
    return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [255, 255, 255];
  }

  // Write one fixture into `frame`. `intensity` is 0..1 and already includes master.
  function writeFixture(frame, f, intensity, color) {
    const map = mapFor(f);
    const addr = Math.floor(f.addr) - 1; // 0-based
    if (!map.length || !(addr >= 0)) return;
    const hasDim = map.includes("dim");
    let [r, g, b] = color;
    let w = 0;
    if (map.includes("w")) { w = Math.min(r, g, b); r -= w; g -= w; b -= w; } // RGB -> RGBW
    // With a dimmer channel the fixture does the dimming; otherwise scale the colour.
    const k = hasDim ? 1 : intensity;
    for (let i = 0; i < map.length; i++) {
      const slot = addr + i;
      if (slot < 0 || slot >= 512) continue;
      const t = map[i];
      let v = 0;
      if (t === "dim") v = intensity * 255;
      else if (t === "r") v = r * k;
      else if (t === "g") v = g * k;
      else if (t === "b") v = b * k;
      else if (t === "w") v = w * k;
      else if (t[0] === "f") v = Number(t.slice(1));
      frame[slot] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }

  // Laser DMX bytes (same logic main.js used for Art-Net). Only energised when the
  // engine gate says emit; otherwise leaves the slots at 0 (blanked / shutter closed).
  function writeLaser(frame, cfg, laser) {
    if (!laser || !laser.emit || laser.output !== "dmx") return;
    const base = Math.max(0, (cfg.LASER_DMX_ADDRESS || 1) - 1);
    (cfg.LASER_DMX_ARMED || []).forEach((v, i) => { if (base + i < 512) frame[base + i] = Number(v) & 255; });
    if (cfg.LASER_DMX_INTENSITY_CH > 0) {
      frame[cfg.LASER_DMX_INTENSITY_CH - 1] = Math.round(Math.max(0, Math.min(100, laser.fx || 0)) / 100 * 255);
    }
  }

  // state: engine state. out: engine.deriveOutputs(state). ctx: { audio:{level,bass,mid,high},
  // beatPos, bpm, flash:boolean, identify:{id,until}, now, cfg }.
  function buildFrame(state, out, ctx) {
    const frame = new Uint8Array(512);
    const blackout = !!state.blackout || out.projectorBlank;
    const master = blackout ? 0 : Math.max(0, Math.min(1, (out.master || 0) / 100));
    if (!blackout) {
      for (const f of state.fixtures || []) {
        if (f.locked || !f.enabled || !(f.addr >= 1)) continue;
        const idNow = ctx.identify && ctx.identify.id === f.id && ctx.now < ctx.identify.until;
        let intensity, color;
        if (idNow) { intensity = 1; color = [255, 255, 255]; }
        else {
          const base = Math.max(0, Math.min(1, (f.level || 0) / 100));
          const amt = REACT_MODES.includes(f.react) && f.react !== "none" ? Math.max(0, Math.min(1, f.amt == null ? 0.7 : f.amt)) : 0;
          const src = amt ? sourceValue(f.react, ctx) : 1;
          intensity = base * ((1 - amt) + amt * src) * master;
          color = hexToRgb(f.color);
        }
        writeFixture(frame, f, intensity, color);
      }
    }
    writeLaser(frame, ctx.cfg || {}, out.laser); // out.laser.emit is already false under blackout
    return frame;
  }

  // ENTTEC DMX USB Pro "Output Only Send DMX" packet (label 6), start code 0.
  function enttecPacket(frame) {
    const len = frame.length + 1;
    const buf = Buffer.alloc(len + 5);
    buf[0] = 0x7e; buf[1] = 6; buf[2] = len & 255; buf[3] = (len >> 8) & 255; buf[4] = 0;
    Buffer.from(frame).copy(buf, 5);
    buf[len + 4] = 0xe7;
    return buf;
  }

  // Art-Net OpDmx packet (same layout main.js used for the laser).
  function artnetPacket(universe, frame) {
    const header = Buffer.alloc(18);
    header.write("Art-Net\0", 0, "latin1");
    header.writeUInt16LE(0x5000, 8);
    header.writeUInt16BE(14, 10);
    header.writeUInt16LE(universe, 14);
    header.writeUInt16BE(frame.length, 16);
    return Buffer.concat([header, Buffer.from(frame)]);
  }

  // Continuous beat position locked to a BPM, snapped to Ableton's beat-in-bar.
  function makeBeatClock() {
    let pos = 0, lastBeat = 0;
    return {
      tick(dt, bpm, beat) {
        pos += dt * (bpm > 0 ? bpm : 120) / 60;
        if (beat && beat !== lastBeat) {
          lastBeat = beat;
          const base = Math.floor(pos / 4) * 4 + (beat - 1);
          const c = [base - 4, base, base + 4];
          pos = c.reduce((best, x) => (Math.abs(x - pos) < Math.abs(best - pos) ? x : best), c[0]);
        }
        return pos;
      },
      get pos() { return pos; }
    };
  }

  // Clean a fixture patch entry. Unpatched / unknown input stays DISABLED.
  function normalizeFixture(f, i) {
    const src = f && typeof f === "object" ? f : {};
    const addr = Math.round(Number(src.addr));
    const profile = PROFILES[src.profile] ? src.profile : "rgb";
    const hex = typeof src.color === "string" && /^#[0-9a-f]{6}$/i.test(src.color) ? src.color : "#ffffff";
    const pct = (v, d) => Math.max(0, Math.min(100, Number.isFinite(Number(v)) ? Number(v) : d));
    return {
      id: String(src.id || "fx" + (i + 1)).slice(0, 24),
      name: String(src.name || src.id || "Fixture " + (i + 1)).slice(0, 32),
      type: String(src.type || PROFILES[profile].label),
      profile,
      map: profile === "custom" ? parseMap(src.map).join(",") : "",
      addr: addr >= 1 && addr <= 512 ? addr : 0,
      enabled: !!src.enabled && addr >= 1 && addr <= 512,
      level: pct(src.level, 80),
      color: hex,
      react: REACT_MODES.includes(src.react) ? src.react : "none",
      amt: Math.max(0, Math.min(1, Number.isFinite(Number(src.amt)) ? Number(src.amt) : 0.7)),
      locked: !!src.locked
    };
  }

  const api = {
    MAX_FLASH_HZ, FLASH_DUTY, REACT_MODES, PROFILES, parseMap, flashEvery, flashPulse, sourceValue,
    buildFrame, enttecPacket, artnetPacket, makeBeatClock, normalizeFixture, writeLaser
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FirebirdDMX = api;
})(typeof window !== "undefined" ? window : this);
