/**
 * clips.js — pure data model for the clip deck (layers x columns), Resolume-style.
 *
 * Dual-use (browser <script> + Node tests), no dependencies. All deck logic lives
 * here so it can be unit-tested without a GPU. The WebGL compositor only *reads* a
 * deck; every change goes through applyOp().
 *
 * A deck is { version, columns, layers:[ { id,name,opacity,blend,bypass,active,clips:[clip|null] } ] }.
 * `active` is the column index of the clip currently playing on that layer (-1 = none).
 * Layers composite bottom (index 0) to top.
 *
 * SAFETY / TRUST: the deck is purely visual and sits UNDER the blackout latch (the
 * projector blanks it on blackout, see projector.js). Only the local operator may
 * edit clips (which can point at files on disk). Remote/OSC sources may only
 * trigger existing clips and move opacity/bypass — see REMOTE_OPS.
 */
(function (root) {
  "use strict";

  const BLEND_MODES = ["normal", "add", "screen", "multiply", "overlay", "difference", "lighten", "darken"];
  const SOURCE_TYPES = ["shader", "glsl", "solid", "image", "video", "webcam"];
  const MAX_CODE = 8000;
  const MAX_LAYERS = 8;
  const MAX_FX = 4;
  const MAX_FADE = 10;

  // Per-layer effects. Order matters: the index is the shader's uType (see
  // shaders.js FX_FRAG; 5 is reserved for blur, which has its own two-pass shader).
  // params: [label, default]. All params are 0..1. `start` below = what a freshly
  // added effect uses so it is visibly doing something.
  const FX_TYPES = ["color", "transform", "mirror", "mosaic", "rgbsplit", "blur", "trails", "invert"];
  const FX_INDEX = { color: 0, transform: 1, mirror: 2, mosaic: 3, rgbsplit: 4, blur: 5, trails: 6, invert: 7 };
  const EFFECTS = {
    color:     { label: "Color",     params: [["Brightness", 0.5], ["Contrast", 0.5], ["Saturation", 0.5]], start: [0.5, 0.6, 0.7] },
    transform: { label: "Transform", params: [["Zoom", 0.5], ["Rotate", 0], ["Offset X", 0.5], ["Offset Y", 0.5]], start: [0.5, 0, 0.5, 0.5] },
    mirror:    { label: "Mirror",    params: [["Segments", 0], ["Angle", 0]], start: [0.3, 0] },
    mosaic:    { label: "Mosaic",    params: [["Size", 0]], start: [0.35] },
    rgbsplit:  { label: "RGB split", params: [["Amount", 0], ["Angle", 0]], start: [0.35, 0] },
    blur:      { label: "Blur",      params: [["Radius", 0]], start: [0.3] },
    trails:    { label: "Trails",    params: [["Decay", 0]], start: [0.7] },
    invert:    { label: "Invert",    params: [["Amount", 0]], start: [1] }
  };
  const FX_MODS = ["none", "level", "bass", "mid", "high", "beat", "lfo", "ramp", "noise"];
  const MAX_COLUMNS = 16;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v !== null ? Number(v) : d);

  // Starter for the live-coded "glsl" clip type. You write one function; the header
  // (shaders.js) gives you uTime, uBeat, uBass/uMid/uHigh/uLevel/uOnset, uBands[16],
  // uAudio and helpers (pal, fbm, vnoise, hash21, band, beatPulse, hueRot).
  const GLSL_TEMPLATE = [
    "// p = centred coords, t = clip time. Return a colour.",
    "vec3 fx(vec2 uv, vec2 p, float t){",
    "  float r = length(p);",
    "  float a = uAudio;",
    "  float w = sin(r * 8.0 - t * 2.0 - uBass * a * 4.0);",
    "  return pal(r * 0.3 + t * 0.05) * (0.5 + 0.5 * w) * (0.7 + 0.5 * beatPulse() * a);",
    "}"
  ].join("\n");

  function defaultClip() {
    return {
      name: "", type: "shader", shader: "plasma", color: "#d4a017", src: "", loop: true,
      code: GLSL_TEMPLATE,
      speed: 1,      // time multiplier (also video playbackRate)
      scale: 1,      // zoom
      hue: 0,        // hue rotation, 0..1 = full turn
      amount: 0.5,   // intensity (0.5 = neutral)
      audio: 0.5     // audio reactivity 0..1
    };
  }

  // Clean an arbitrary clip object into a valid one (or null). `shaderIds` is the
  // list of known generator ids; an unknown id falls back to the first.
  function normalizeClip(c, shaderIds) {
    if (!c || typeof c !== "object") return null;
    const d = defaultClip();
    const type = SOURCE_TYPES.includes(c.type) ? c.type : d.type;
    const ids = shaderIds && shaderIds.length ? shaderIds : [d.shader];
    // Media may only come from local files (file: URLs). Anything else is dropped so
    // a hand-edited deck/show can't make the projector fetch arbitrary URLs.
    const src = typeof c.src === "string" && /^file:/i.test(c.src) ? c.src : "";
    const color = typeof c.color === "string" && /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : d.color;
    return {
      name: String(c.name || "").slice(0, 40),
      type,
      shader: ids.includes(c.shader) ? c.shader : ids[0],
      color, src,
      code: typeof c.code === "string" && c.code.trim() ? c.code.slice(0, MAX_CODE) : d.code,
      loop: c.loop !== false,
      speed: clamp(num(c.speed, d.speed), 0, 4),
      scale: clamp(num(c.scale, d.scale), 0.1, 8),
      hue: clamp(num(c.hue, d.hue), 0, 1),
      amount: clamp(num(c.amount, d.amount), 0, 1),
      audio: clamp(num(c.audio, d.audio), 0, 1)
    };
  }

  function defaultEffect(type) {
    const def = EFFECTS[type];
    return { type, on: true, p: def.start.slice(), mod: "none", amt: 0.5 };
  }
  function normalizeEffect(e) {
    if (!e || typeof e !== "object" || !EFFECTS[e.type]) return null;
    const def = EFFECTS[e.type];
    return {
      type: e.type,
      on: e.on !== false,
      p: def.params.map((d, i) => clamp(num(Array.isArray(e.p) ? e.p[i] : null, d[1]), 0, 1)),
      mod: FX_MODS.includes(e.mod) ? e.mod : "none",
      amt: clamp(num(e.amt, 0.5), 0, 1)
    };
  }

  function normalizeLayer(l, index, columns, shaderIds) {
    const src = l && typeof l === "object" ? l : {};
    const clips = [];
    for (let i = 0; i < columns; i++) clips.push(normalizeClip(Array.isArray(src.clips) ? src.clips[i] : null, shaderIds));
    let active = Number.isInteger(src.active) ? src.active : -1;
    if (active < 0 || active >= columns || !clips[active]) active = -1;
    return {
      id: String(src.id || "L" + (index + 1)),
      name: String(src.name || "Layer " + (index + 1)).slice(0, 24),
      opacity: clamp(num(src.opacity, 1), 0, 1),
      blend: BLEND_MODES.includes(src.blend) ? src.blend : "normal",
      bypass: !!src.bypass,
      fade: clamp(num(src.fade, 0.4), 0, MAX_FADE), // crossfade seconds on trigger / stop
      fx: (Array.isArray(src.fx) ? src.fx : []).map(normalizeEffect).filter(Boolean).slice(0, MAX_FX),
      active,
      clips
    };
  }

  function normalizeDeck(deck, shaderIds) {
    const src = deck && typeof deck === "object" ? deck : {};
    const columns = clamp(Math.round(num(src.columns, 8)), 1, MAX_COLUMNS);
    const srcLayers = Array.isArray(src.layers) && src.layers.length ? src.layers.slice(0, MAX_LAYERS) : [{}];
    return { version: 1, columns, layers: srcLayers.map((l, i) => normalizeLayer(l, i, columns, shaderIds)) };
  }

  // A starter deck so the grid is not empty on first launch: one row per "role",
  // a generator in every cell. `shaderIds` come from shaders.js.
  function defaultDeck(shaderIds) {
    const ids = shaderIds && shaderIds.length ? shaderIds : ["plasma"];
    const columns = 8;
    const roles = [
      ["Background", ["nebula", "plasma", "aurora", "voronoi", "tunnel", "kaleido", "starfield", "neongrid"]],
      ["Pulse", ["rings", "kaleido", "tunnel", "spectrum", "rings", "voronoi", "neongrid", "plasma"]],
      ["Accent", ["spectrum", "starfield", "rings", "aurora", "spectrum", "plasma", "voronoi", "tunnel"]],
      ["Overlay", ["starfield", "aurora", "spectrum", "rings", "starfield", "aurora", "spectrum", "rings"]]
    ];
    const layers = roles.map(([name, picks], li) => ({
      id: "L" + (li + 1), name,
      opacity: li === 0 ? 1 : 0.8,
      blend: li === 0 ? "normal" : li === 3 ? "screen" : "add",
      bypass: false, active: -1, fade: 0.4, fx: [],
      clips: Array.from({ length: columns }, (_, ci) => {
        const shader = ids.includes(picks[ci]) ? picks[ci] : ids[ci % ids.length];
        return Object.assign(defaultClip(), { shader, name: shader.charAt(0).toUpperCase() + shader.slice(1), hue: (ci * 0.11 + li * 0.07) % 1 });
      })
    }));
    return normalizeDeck({ columns, layers }, ids);
  }

  // Ops a non-local source (phone remote, OSC) may perform.
  const REMOTE_OPS = new Set(["trigger", "column", "stop", "stopAll", "layer"]);
  const REMOTE_LAYER_KEYS = new Set(["opacity", "bypass"]);

  // Apply one operation to `deck` (mutating it). Returns true if anything changed.
  //   { op:"trigger", layer, col }   play the clip at layer/col (no-op on an empty cell)
  //   { op:"column", col }           trigger col on every layer that has a clip there
  //   { op:"stop", layer }           clear the layer
  //   { op:"stopAll" }
  //   { op:"layer", layer, patch }   name / opacity / blend / bypass
  //   { op:"clip", layer, col, clip, shaderIds }   (local only) set or clear a cell
  // `trusted` = local operator. Untrusted callers are limited to REMOTE_OPS.
  function applyOp(deck, op, opts) {
    const trusted = !!(opts && opts.trusted);
    if (!deck || !op || typeof op.op !== "string") return false;
    if (!trusted) {
      if (!REMOTE_OPS.has(op.op)) return false;
      if (op.op === "layer") {
        const keys = Object.keys(op.patch || {});
        if (!keys.length || keys.some((k) => !REMOTE_LAYER_KEYS.has(k))) return false;
      }
    }
    const L = Number.isInteger(op.layer) ? deck.layers[op.layer] : null;
    switch (op.op) {
      case "trigger": {
        if (!L || !Number.isInteger(op.col) || op.col < 0 || op.col >= deck.columns || !L.clips[op.col]) return false;
        L.active = op.col; return true;
      }
      case "column": {
        if (!Number.isInteger(op.col) || op.col < 0 || op.col >= deck.columns) return false;
        let changed = false;
        for (const layer of deck.layers) if (layer.clips[op.col]) { layer.active = op.col; changed = true; }
        return changed;
      }
      case "stop": {
        if (!L || L.active === -1) return false;
        L.active = -1; return true;
      }
      case "stopAll": {
        let changed = false;
        for (const layer of deck.layers) if (layer.active !== -1) { layer.active = -1; changed = true; }
        return changed;
      }
      case "layer": {
        if (!L || !op.patch || typeof op.patch !== "object") return false;
        const p = op.patch;
        if (p.opacity != null) L.opacity = clamp(num(p.opacity, L.opacity), 0, 1);
        if (p.bypass != null) L.bypass = !!p.bypass;
        if (p.blend != null && BLEND_MODES.includes(p.blend)) L.blend = p.blend;
        if (p.name != null) L.name = String(p.name).slice(0, 24);
        if (p.fade != null) L.fade = clamp(num(p.fade, L.fade), 0, MAX_FADE);
        return true;
      }
      case "fx": {
        // { op:"fx", layer, index, effect } — set the effect at `index` (index ==
        // length appends); effect null removes it. Local only (not in REMOTE_OPS).
        if (!L || !Number.isInteger(op.index) || op.index < 0 || op.index > L.fx.length) return false;
        if (op.effect === null) {
          if (op.index >= L.fx.length) return false;
          L.fx.splice(op.index, 1); return true;
        }
        const e = normalizeEffect(op.effect);
        if (!e) return false;
        if (op.index === L.fx.length) { if (L.fx.length >= MAX_FX) return false; L.fx.push(e); } else L.fx[op.index] = e;
        return true;
      }
      case "clip": {
        if (!L || !Number.isInteger(op.col) || op.col < 0 || op.col >= deck.columns) return false;
        L.clips[op.col] = normalizeClip(op.clip, op.shaderIds);
        if (!L.clips[op.col] && L.active === op.col) L.active = -1;
        return true;
      }
      default: return false;
    }
  }

  // Any layer actually producing output?
  function anyActive(deck) {
    return !!deck && deck.layers.some((l) => !l.bypass && l.active >= 0 && l.opacity > 0 && l.clips[l.active]);
  }

  // Show-file helpers: a saved deck always starts with nothing playing.
  function exportDeck(deck) {
    const copy = JSON.parse(JSON.stringify(deck));
    copy.layers.forEach((l) => (l.active = -1));
    return copy;
  }

  const api = {
    BLEND_MODES, SOURCE_TYPES, MAX_LAYERS, MAX_COLUMNS, MAX_FX, MAX_FADE, FX_TYPES, FX_INDEX, FX_MODS, EFFECTS, REMOTE_OPS,
    defaultEffect, normalizeEffect, GLSL_TEMPLATE, MAX_CODE,
    defaultClip, normalizeClip, normalizeDeck, defaultDeck, applyOp, anyActive, exportDeck
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FirebirdClips = api;
})(typeof window !== "undefined" ? window : this);
