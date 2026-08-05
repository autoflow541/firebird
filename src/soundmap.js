/**
 * soundmap.js — pure mapping from audio features to Firebird control commands.
 *
 * Dual-use (browser <script> + Node tests), no dependencies. Kept pure so the
 * "what does the music drive" logic is unit-tested without audio hardware.
 *
 * SAFETY: this only ever emits VISUAL / MASTER / DEPTHFX commands. It never emits
 * blackout or laser commands, and the engine additionally rejects any non-allowed
 * action from source "sound" (belt and suspenders). Sound can never black the
 * stage out or arm a laser.
 */
(function (root) {
  "use strict";

  function pct(x) { return Math.max(0, Math.min(100, Math.round(x * 100))); }

  // features: { level, bass, mid, high } each 0..1, plus onset (boolean).
  // cfg: sensitivity (0.25..4, default 1) + per-target on/off flags.
  function featuresToCommands(features, cfg) {
    const f = features || {};
    const c = cfg || {};
    const s = c.sensitivity == null ? 1 : c.sensitivity;
    const amp = (v) => Math.min(1, (v || 0) * s);
    const cmds = [];

    if (c.brightness !== false) cmds.push({ action: "visual", key: "brightness", value: pct(amp(f.level)) });
    if (c.size !== false)       cmds.push({ action: "visual", key: "size", value: pct(amp(f.bass)) });
    if (c.speed !== false)      cmds.push({ action: "visual", key: "speed", value: pct(amp(f.mid)) });
    if (c.shading !== false)    cmds.push({ action: "visual", key: "shading", value: pct(amp(f.high)) });
    if (c.strobeOnset !== false) cmds.push({ action: "visual", key: "strobe", value: f.onset ? 60 : 0 });
    if (c.master)               cmds.push({ action: "master", value: pct(amp(f.level)) });
    if (c.depthfx) {
      cmds.push({ action: "depthfx", key: "colorspeed", value: +(amp(f.high) * 5).toFixed(2) });
      cmds.push({ action: "depthfx", key: "trails", value: +(0.7 + amp(f.level) * 0.29).toFixed(2) });
    }
    // Laser modulation ("always" on): the engine applies this ONLY when the laser
    // is armed, so it moves an armed beam but can never arm it or beat a blackout.
    if (c.laser !== false) cmds.push({ action: "laser", key: "fx", value: pct(amp(f.level)) });
    return cmds;
  }

  const api = { featuresToCommands, pct };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FirebirdSoundMap = api;
})(typeof window !== "undefined" ? window : this);
