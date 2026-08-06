// Firebird Show Control — configuration.
//
// Loads defaults, then overlays an optional firebird.config.json placed next to
// package.json, then overlays environment variables. Everything here is chosen
// so the SAFE default requires no config: OSC and the control server are bound
// as tightly as the documented single-machine setup allows, the laser is
// disabled, and Ableton cannot release a blackout.
//
// NEVER port-forward CONTROL_PORT / OSC_PORT to the public internet. The control
// surface is a LAN-only surface protected by a per-session token; it is not
// designed to be internet-facing. See SAFETY.md.

const fs = require("fs");
const path = require("path");

const defaults = {
  // --- Control server (serves operator-lite web UI + phone remote on the LAN) ---
  // Fixed port so it can be allowed through the firewall deliberately. Bind to
  // 0.0.0.0 so phones on the same Wi-Fi can reach it; the per-session token is
  // what gates access, not the bind address.
  CONTROL_PORT: 42080,
  CONTROL_BIND: "0.0.0.0",
  // Max accepted /command body size (bytes). Guards against a slow-loris/huge-body.
  MAX_COMMAND_BYTES: 4096,

  // --- OSC (Ableton is the show clock) ---
  // Ableton/Max for Live runs on the SAME machine in the documented setup, so we
  // listen on loopback only by default — nothing on the LAN can inject OSC. If
  // Ableton runs on another machine, set OSC_BIND to this machine's LAN IP.
  OSC_BIND: "127.0.0.1",
  OSC_PORT: 42070, // Firebird LISTENS here (input from Ableton)
  OSC_FEEDBACK_PORT: 42071, // Firebird SENDS status here
  // Feedback destination is fixed by config, NOT learned from the last sender
  // (learning lets any host on the wire hijack the feedback stream).
  OSC_FEEDBACK_HOST: "127.0.0.1",

  // Ableton Link — network tempo/beat sync (industry standard). Needs the optional
  // native module `abletonlink` (npm install). Off by default; OSC clock still works.
  ABLETON_LINK_ENABLED: false,

  // --- Clock authority ---
  // "ableton" = Ableton drives position/beat/bpm and Firebird never free-runs.
  // "internal" = Firebird runs its own timeline (rehearsal / no-Ableton mode).
  CLOCK_SOURCE: "ableton",

  // --- Blaize (Processing visual engine) TCP bridge ---
  BLAIZE_HOST: "127.0.0.1",
  BLAIZE_PORT: 17017,

  // --- Kinect depth FX (Processing sketch: visuals/FirebirdDepthFX) ---
  // Firebird sends control OSC (blackout + effect params) to the depth-FX sketch.
  DEPTHFX_HOST: "127.0.0.1",
  DEPTHFX_PORT: 42073,

  // --- Streaming / OBS (OBS 28+: Tools > WebSocket Server Settings) ---
  // Firebird can drive OBS (start/stop stream+record, switch scenes) so Ableton
  // cues and the operator control the stream. Non-safety.
  OBS_URL: "ws://127.0.0.1:4455",
  OBS_PASSWORD: "",
  OBS_AUTOCONNECT: false,

  // --- Safety ---
  // Master blackout must override timelines, scenes, effects and remote commands.
  // By default only the LOCAL operator can RELEASE a blackout; OSC/remote can only
  // ENGAGE it. Flip this only if you have a deliberate reason.
  ALLOW_OSC_BLACKOUT_RELEASE: false,
  ALLOW_REMOTE_BLACKOUT_RELEASE: false,

  // Laser stays hard-disabled in software AND requires a hardware interlock signal
  // before it can ever be armed. Software alone is NEVER sufficient to fire a
  // laser — see SAFETY.md. Leave false until the physical interlock is wired and
  // verified by a laser-safety officer.
  LASER_ENABLED: false,

  // If true, Firebird also requires a wired hardware-interlock signal before it
  // will arm. Set false when the laser's own KEY SWITCH is the hardware guard
  // (software still isn't the sole guard — the key is). Blackout still kills the
  // beam and only the local operator can arm, regardless of this setting.
  LASER_REQUIRE_INTERLOCK: true,

  // Laser output transport, also switchable at runtime from the operator console:
  //   "none" (default, safe) | "dmx" (Art-Net direct) | "ilda" (via an ILDA DAC /
  //   laser-software bridge). Selecting a transport never emits a beam by itself —
  //   emission still requires LASER_ENABLED + interlock + arm + no blackout.
  LASER_OUTPUT: "none",

  // DMX-over-Art-Net. Firebird sends an all-ZERO DMX frame (blanked/shutter-closed)
  // unless the laser is truly armed, then sets the fixture's channels to
  // LASER_DMX_ARMED starting at LASER_DMX_ADDRESS (1-based). Match these to your
  // laser's DMX manual before use.
  ARTNET_HOST: "127.0.0.1",
  ARTNET_UNIVERSE: 0,
  LASER_DMX_ADDRESS: 1,
  LASER_DMX_ARMED: [255, 255],
  // Sound-driven intensity channel (1-based; 0 = unset). Set to the DS-1000RGB
  // dimmer/intensity channel from its DMX chart so sound modulates the beam.
  LASER_DMX_INTENSITY_CH: 0,

  // ILDA: Firebird cannot emit analog ILDA directly — it forwards arm/blank to an
  // ILDA DAC or laser software (Ether Dream / Helios / Pangolin Beyond, …) over
  // OSC. Point this at that bridge. Final wiring depends on which DAC you use.
  ILDA_BRIDGE_HOST: "127.0.0.1",
  ILDA_BRIDGE_PORT: 42074
};

function loadFile() {
  try {
    const file = path.join(__dirname, "..", "firebird.config.json");
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.warn("[config] ignoring invalid firebird.config.json:", error.message);
  }
  return {};
}

function coerce(defaultValue, raw) {
  if (typeof defaultValue === "number") return Number(raw);
  if (typeof defaultValue === "boolean") return raw === true || raw === "true" || raw === "1";
  return raw;
}

function build() {
  const fromFile = loadFile();
  const config = { ...defaults };
  for (const key of Object.keys(defaults)) {
    if (key in fromFile) config[key] = coerce(defaults[key], fromFile[key]);
    if (process.env[`FIREBIRD_${key}`] !== undefined) config[key] = coerce(defaults[key], process.env[`FIREBIRD_${key}`]);
  }
  return config;
}

module.exports = { config: build(), defaults };
