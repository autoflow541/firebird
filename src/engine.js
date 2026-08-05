// Firebird Show Control — pure state engine (no Electron / no sockets).
//
// This module is deliberately dependency-free so the safety-critical logic can be
// unit-tested with plain `node` (see test/engine.test.js). main.js owns a single
// mutable `state`, feeds it commands via applyCommand(), and turns the result
// into real output with deriveOutputs() -> the single hardware "gate".
//
// SAFETY MODEL (see SAFETY.md):
//   * blackout LATCHES. Nothing except an explicit, authorized blackout release
//     turns it off — not a scene change, not a timeline cue, not a remote button.
//   * blackout OVERRIDES at the output boundary: deriveOutputs() forces every
//     controllable output to its safe value while blackout is engaged, regardless
//     of what scene/preset/master the rest of the state requests.
//   * The SAFE direction (engage blackout) is available to every source. The
//     UNSAFE direction (release blackout, arm laser, open projector) is
//     local-operator-only unless config explicitly widens it.
//   * The laser can never be armed by software alone: arming also requires a
//     hardware interlock signal (state.laser.interlock), which defaults false.

const SCENES = ["INTRO", "HEAVY", "BREAKDOWN", "AMBIENT", "BLACKOUT"];

// Scene -> Blaize preset. BLACKOUT intentionally has no preset (handled by gate).
const PRESET_BY_SCENE = { INTRO: 0, HEAVY: 10, BREAKDOWN: 20, AMBIENT: 26 };

const VISUAL_LIMITS = {
  preset: [0, 31], speed: [0, 100], size: [0, 100],
  brightness: [0, 100], strobe: [0, 100], shading: [0, 100]
};

// Blaize channel numbers for continuous visual params (preset select is special).
const BLAIZE_CH = { speed: 44, size: 45, brightness: 46, strobe: 47, shading: 50 };
const BLAIZE_MULTICOLOR_CH = 36;
const BLAIZE_BLACKOUT_CH = 37;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function initialState() {
  return {
    scene: "INTRO",
    blackout: false, // latching; see SAFETY.md
    playing: false,
    song: "Firebird",
    bpm: 128,
    beat: 1,
    elapsed: 0,
    audioReactive: true,
    master: 82,
    clockSource: "ableton", // overwritten from config by main.js
    blaize: {
      connected: false, host: "127.0.0.1", port: 17017,
      preset: 0, speed: 30, size: 50, brightness: 100, strobe: 0, shading: 0, multicolor: false
    },
    ableton: {
      connected: false, host: "", port: 42070, feedbackPort: 42071,
      lastMessage: "Waiting for Ableton", lastSeen: 0
    },
    // Kinect depth-FX layer (Processing sketch FirebirdDepthFX). trails =
    // feedback persistence 0..0.99 (higher = longer tracers); colorSpeed = hue
    // cycle rate; near/far = depth window in mm that isolates the performer.
    depthfx: { enabled: true, trails: 0.85, colorSpeed: 1.0, near: 500, far: 2500, mirror: true },
    laser: {
      // enabled: software master switch (config LASER_ENABLED). interlock: live
      // hardware safety signal. armed: operator has armed AND both above are true.
      // output: which transport the beam control uses — "none" | "dmx" | "ilda".
      // (DMX = Art-Net direct; ILDA = via an ILDA DAC/laser-software bridge.)
      enabled: false, interlock: false, armed: false, output: "none"
    },
    fixtures: [
      { id: "washL", name: "Wash L", type: "RGBW", level: 76, color: "#ec325d" },
      { id: "washR", name: "Wash R", type: "RGBW", level: 76, color: "#7357ff" },
      { id: "beam", name: "Center Beam", type: "Moving head", level: 64, color: "#f1b947" },
      { id: "laser", name: "Laser", type: "Safe hold", level: 0, color: "#54e19b", locked: true }
    ],
    cueIndex: 0,
    cues: [
      { time: 0, scene: "INTRO", note: "Logo / low haze" },
      { time: 18, scene: "HEAVY", note: "Full band entrance" },
      { time: 48, scene: "BREAKDOWN", note: "Half-time pulse" },
      { time: 76, scene: "AMBIENT", note: "Wide violet wash" },
      { time: 104, scene: "BLACKOUT", note: "End hit" }
    ]
  };
}

// Which sources may perform the UNSAFE direction of each action. The SAFE
// direction (engaging blackout, turning the laser OFF, blanking the projector)
// is always allowed from anywhere.
function canRelease(source, state, config) {
  if (source === "local") return true;
  if (source === "osc") return !!config.ALLOW_OSC_BLACKOUT_RELEASE;
  if (source === "remote") return !!config.ALLOW_REMOTE_BLACKOUT_RELEASE;
  return false;
}

// Apply one command to `state` (mutating it). Returns a short list of human log
// lines describing anything notable (e.g. an ignored unauthorized action).
// `cmd` must carry `action`; `cmd.source` is "local" | "remote" | "osc" (default
// "local"). `config` supplies the authorization policy + clock authority.
function applyCommand(state, cmd, config) {
  const source = cmd.source || "local";
  const log = [];

  switch (cmd.action) {
    case "blackout": {
      // Latching. Engaging is always allowed; releasing is authorization-gated.
      const want = cmd.value ?? !state.blackout;
      if (want) {
        state.blackout = true;
        state.laser.armed = false; // blackout disarms the laser, always
      } else if (canRelease(source, state, config)) {
        state.blackout = false;
      } else {
        log.push(`blocked blackout release from '${source}' (not authorized)`);
      }
      break;
    }
    case "panic": {
      state.blackout = true;
      state.laser.armed = false;
      break;
    }
    case "scene": {
      const scene = String(cmd.value).toUpperCase();
      if (!SCENES.includes(scene)) break;
      if (scene === "BLACKOUT") {
        state.blackout = true;
        state.laser.armed = false;
      } else {
        // A scene NEVER releases a latched blackout. It only stages the look that
        // will appear once blackout is (deliberately) released.
        state.scene = scene;
        if (PRESET_BY_SCENE[scene] !== undefined) state.blaize.preset = PRESET_BY_SCENE[scene];
      }
      break;
    }
    case "togglePlay":
      state.playing = !state.playing;
      break;
    case "transport":
      state.playing = Boolean(cmd.value);
      break;
    case "bpm":
      state.bpm = clamp(Number(cmd.value) || state.bpm, 30, 300);
      break;
    case "master":
      state.master = clamp(Number(cmd.value), 0, 100);
      break;
    case "audioReactive":
      state.audioReactive = Boolean(cmd.value);
      break;
    case "seek":
      state.elapsed = Math.max(0, Number(cmd.value) || 0);
      break;
    case "stepCue": {
      const index = clamp(state.cueIndex + (Number(cmd.value) || 1), 0, state.cues.length - 1);
      state.cueIndex = index;
      state.elapsed = state.cues[index].time;
      const scene = state.cues[index].scene;
      if (scene === "BLACKOUT") state.blackout = true;
      else state.scene = scene;
      break;
    }
    case "fixture": {
      const fixture = state.fixtures.find((item) => item.id === cmd.id);
      if (fixture && !fixture.locked) Object.assign(fixture, cmd.value);
      break;
    }
    case "visual": {
      if (cmd.key === "multicolor") {
        state.blaize.multicolor = Boolean(cmd.value);
      } else if (VISUAL_LIMITS[cmd.key]) {
        const [min, max] = VISUAL_LIMITS[cmd.key];
        state.blaize[cmd.key] = clamp(Math.round(Number(cmd.value)), min, max);
      }
      break;
    }
    case "depthfx": {
      // Kinect depth-FX params. Purely visual; blackout still blanks the layer
      // (enforced in deriveOutputs), so these can come from any source safely.
      const d = state.depthfx;
      const limits = { trails: [0, 0.99], colorSpeed: [0, 10], near: [0, 8000], far: [0, 8000] };
      if (cmd.key === "enabled") d.enabled = Boolean(cmd.value);
      else if (cmd.key === "mirror") d.mirror = Boolean(cmd.value);
      else if (limits[cmd.key]) { const [mn, mx] = limits[cmd.key]; d[cmd.key] = clamp(Number(cmd.value), mn, mx); }
      break;
    }
    case "laser": {
      // Arming is local-only and requires the software master switch AND a live
      // hardware interlock AND no active blackout. Disarming is always allowed.
      if (cmd.key === "interlock") {
        state.laser.interlock = Boolean(cmd.value); // set by the hardware bridge
        if (!state.laser.interlock) state.laser.armed = false;
      } else if (cmd.key === "output") {
        // Selecting the transport (ILDA/DMX/OFF) is local-only and always
        // DISARMS first — you never hot-swap the output path on a live beam.
        const mode = String(cmd.value);
        if (source !== "local") {
          log.push(`blocked laser output change from '${source}' (local operator only)`);
        } else if (["none", "dmx", "ilda"].includes(mode)) {
          state.laser.armed = false;
          state.laser.output = mode;
        }
      } else if (cmd.key === "arm") {
        const want = Boolean(cmd.value);
        if (!want) {
          state.laser.armed = false;
        } else if (source !== "local") {
          log.push(`blocked laser arm from '${source}' (local operator only)`);
        } else if (!state.laser.enabled) {
          log.push("blocked laser arm (LASER_ENABLED is false)");
        } else if (!state.laser.interlock) {
          log.push("blocked laser arm (hardware interlock not present)");
        } else if (state.laser.output === "none") {
          log.push("blocked laser arm (no output selected — pick ILDA or DMX)");
        } else if (state.blackout) {
          log.push("blocked laser arm (blackout engaged)");
        } else {
          state.laser.armed = true;
        }
      }
      break;
    }
    default:
      // Unknown action: ignore silently (do not crash the show on bad input).
      break;
  }
  return log;
}

// Advance the internal timeline by `dt` seconds. Only meaningful when Firebird is
// the clock (CLOCK_SOURCE=internal). Ableton drives elapsed directly otherwise.
// Auto-cues NEVER touch blackout — a latched blackout survives the timeline.
function tickInternalClock(state, dt) {
  if (state.clockSource !== "internal" || !state.playing) return;
  state.elapsed = +(state.elapsed + dt).toFixed(2);
  state.beat = (Math.floor(state.elapsed / (60 / state.bpm)) % 4) + 1;
  let index = -1;
  for (let i = 0; i < state.cues.length; i++) if (state.cues[i].time <= state.elapsed) index = i;
  if (index >= 0 && index !== state.cueIndex) {
    state.cueIndex = index;
    const scene = state.cues[index].scene;
    if (scene === "BLACKOUT") state.blackout = true; // safe direction only
    else state.scene = scene; // does NOT release an existing blackout
  }
}

// THE OUTPUT GATE. Given the current state, compute the ONLY values that may be
// sent to hardware. When blackout is engaged every output is forced safe here, so
// there is no code path that can drive light while blackout latches.
//   blaizeChannels: { <channel>: <value> } continuous params to assert
//   blaizePreset:   preset index to select, or null to leave as-is
//   master:         effective master level 0..100
//   projectorBlank: true => projector must show black
//   laserOn:        whether the laser output line may be energized (belt: also
//                   gated in hardware by the physical interlock)
function deriveOutputs(state) {
  const blackout = state.blackout;
  const channels = {};
  channels[BLAIZE_BLACKOUT_CH] = blackout ? 1 : 0;
  channels[BLAIZE_MULTICOLOR_CH] = state.blaize.multicolor ? 1 : 0;
  channels[BLAIZE_CH.speed] = state.blaize.speed;
  channels[BLAIZE_CH.size] = state.blaize.size;
  // Force visual brightness to 0 under blackout (belt-and-suspenders with ch37).
  channels[BLAIZE_CH.brightness] = blackout ? 0 : state.blaize.brightness;
  channels[BLAIZE_CH.strobe] = blackout ? 0 : state.blaize.strobe;
  channels[BLAIZE_CH.shading] = state.blaize.shading;

  return {
    blaizeChannels: channels,
    blaizePreset: blackout ? null : state.blaize.preset,
    master: blackout ? 0 : state.master,
    projectorBlank: blackout,
    // The Kinect depth-FX layer is part of the projector output, so blackout
    // blanks it too. The sketch honors this over any camera input.
    depthfxBlank: blackout,
    // Laser output. `emit` is the ONLY thing that may energize a beam, and it is
    // false unless the software switch, hardware interlock, an armed operator, a
    // selected transport, and NO blackout all line up. `output` picks the wire.
    laser: {
      emit: !blackout && state.laser.enabled && state.laser.interlock &&
            state.laser.armed && state.laser.output !== "none",
      output: state.laser.output
    }
  };
}

module.exports = {
  SCENES, PRESET_BY_SCENE, VISUAL_LIMITS, BLAIZE_CH, BLAIZE_MULTICOLOR_CH, BLAIZE_BLACKOUT_CH,
  initialState, applyCommand, tickInternalClock, deriveOutputs, canRelease, clamp
};
