// Safety-critical unit tests for the Firebird engine. Pure Node, no Electron.
// Run: node test/engine.test.js   (exit code 0 = all passed)
const assert = require("assert");
const engine = require("../src/engine");
const { defaults } = require("../src/config");

// Base policy = shipped defaults (OSC/remote may NOT release a blackout).
const cfg = { ...defaults };
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("  ok -", name); };

console.log("Firebird engine safety tests\n");

test("blackout latches through a scene change (the core bug)", () => {
  const s = engine.initialState();
  engine.applyCommand(s, { action: "blackout", value: true, source: "local" }, cfg);
  assert.strictEqual(s.blackout, true);
  // A scene command must NOT release the latch.
  engine.applyCommand(s, { action: "scene", value: "HEAVY", source: "osc" }, cfg);
  assert.strictEqual(s.blackout, true, "scene change silently released blackout");
  // Scene still staged underneath for when blackout is released.
  assert.strictEqual(s.scene, "HEAVY");
});

test("blackout latches through a timeline cue (internal clock)", () => {
  const s = engine.initialState();
  s.clockSource = "internal";
  s.playing = true;
  engine.applyCommand(s, { action: "blackout", value: true, source: "local" }, cfg);
  // Advance past the HEAVY cue at t=18.
  for (let i = 0; i < 100; i++) engine.tickInternalClock(s, 0.25);
  assert.strictEqual(s.blackout, true, "auto-cue released blackout");
});

test("remote/OSC cannot release a blackout; local can", () => {
  const s = engine.initialState();
  engine.applyCommand(s, { action: "blackout", value: true, source: "local" }, cfg);
  engine.applyCommand(s, { action: "blackout", value: false, source: "remote" }, cfg);
  assert.strictEqual(s.blackout, true, "remote released blackout");
  engine.applyCommand(s, { action: "blackout", value: false, source: "osc" }, cfg);
  assert.strictEqual(s.blackout, true, "osc released blackout");
  engine.applyCommand(s, { action: "blackout", value: false, source: "local" }, cfg);
  assert.strictEqual(s.blackout, false, "local could not release blackout");
});

test("engaging blackout is allowed from every source (safe direction)", () => {
  for (const source of ["local", "remote", "osc"]) {
    const s = engine.initialState();
    engine.applyCommand(s, { action: "blackout", value: true, source }, cfg);
    assert.strictEqual(s.blackout, true, `${source} could not engage blackout`);
  }
});

test("output gate forces everything safe under blackout", () => {
  const s = engine.initialState();
  s.blaize.brightness = 100; s.blaize.strobe = 80; s.master = 90; s.blaize.preset = 20;
  engine.applyCommand(s, { action: "blackout", value: true, source: "local" }, cfg);
  const out = engine.deriveOutputs(s);
  assert.strictEqual(out.blaizeChannels[engine.BLAIZE_BLACKOUT_CH], 1, "blaize blackout not asserted");
  assert.strictEqual(out.blaizeChannels[engine.BLAIZE_CH.brightness], 0, "brightness not zeroed");
  assert.strictEqual(out.blaizeChannels[engine.BLAIZE_CH.strobe], 0, "strobe not zeroed");
  assert.strictEqual(out.master, 0, "master not zeroed");
  assert.strictEqual(out.projectorBlank, true, "projector not blanked");
  assert.strictEqual(out.depthfxBlank, true, "Kinect depth-FX layer not blanked");
  assert.strictEqual(out.laser.emit, false, "laser energized under blackout");
});

test("depth-FX params clamp and never affect blackout", () => {
  const s = engine.initialState();
  engine.applyCommand(s, { action: "depthfx", key: "trails", value: 5, source: "remote" }, cfg);
  assert.strictEqual(s.depthfx.trails, 0.99, "trails not clamped");
  engine.applyCommand(s, { action: "blackout", value: true, source: "local" }, cfg);
  engine.applyCommand(s, { action: "depthfx", key: "enabled", value: true, source: "osc" }, cfg);
  assert.strictEqual(s.blackout, true, "a depthfx command disturbed blackout");
});

test("laser cannot be armed without the hardware interlock", () => {
  const s = engine.initialState();
  s.laser.enabled = true; // software master switch on
  engine.applyCommand(s, { action: "laser", key: "output", value: "dmx", source: "local" }, cfg);
  engine.applyCommand(s, { action: "laser", key: "arm", value: true, source: "local" }, cfg);
  assert.strictEqual(s.laser.armed, false, "laser armed with no interlock");
  // Add interlock, then arm succeeds.
  engine.applyCommand(s, { action: "laser", key: "interlock", value: true, source: "local" }, cfg);
  engine.applyCommand(s, { action: "laser", key: "arm", value: true, source: "local" }, cfg);
  assert.strictEqual(s.laser.armed, true, "laser would not arm with interlock present");
});

test("laser output selector: local-only, disarms on change, blocks arm when OFF", () => {
  const s = engine.initialState();
  s.laser.enabled = true; s.laser.interlock = true;
  // Cannot arm with output OFF.
  engine.applyCommand(s, { action: "laser", key: "arm", value: true, source: "local" }, cfg);
  assert.strictEqual(s.laser.armed, false, "armed with no output selected");
  // Remote cannot pick the output.
  engine.applyCommand(s, { action: "laser", key: "output", value: "ilda", source: "remote" }, cfg);
  assert.strictEqual(s.laser.output, "none", "remote changed the laser output");
  // Local picks ILDA, arms.
  engine.applyCommand(s, { action: "laser", key: "output", value: "ilda", source: "local" }, cfg);
  engine.applyCommand(s, { action: "laser", key: "arm", value: true, source: "local" }, cfg);
  assert.strictEqual(s.laser.armed, true, "did not arm after selecting ILDA");
  assert.strictEqual(engine.deriveOutputs(s).laser.output, "ilda");
  // Switching output must disarm.
  engine.applyCommand(s, { action: "laser", key: "output", value: "dmx", source: "local" }, cfg);
  assert.strictEqual(s.laser.armed, false, "output change did not disarm");
});

test("laser cannot be armed remotely, or while software-disabled, or during blackout", () => {
  const s = engine.initialState();
  s.laser.enabled = true; s.laser.interlock = true;
  engine.applyCommand(s, { action: "laser", key: "arm", value: true, source: "remote" }, cfg);
  assert.strictEqual(s.laser.armed, false, "remote armed the laser");
  const s2 = engine.initialState();
  s2.laser.enabled = false; s2.laser.interlock = true;
  engine.applyCommand(s2, { action: "laser", key: "arm", value: true, source: "local" }, cfg);
  assert.strictEqual(s2.laser.armed, false, "laser armed while LASER_ENABLED=false");
  const s3 = engine.initialState();
  s3.laser.enabled = true; s3.laser.interlock = true;
  engine.applyCommand(s3, { action: "blackout", value: true, source: "local" }, cfg);
  engine.applyCommand(s3, { action: "laser", key: "arm", value: true, source: "local" }, cfg);
  assert.strictEqual(s3.laser.armed, false, "laser armed during blackout");
});

test("engaging blackout disarms a live laser", () => {
  const s = engine.initialState();
  s.laser.enabled = true; s.laser.interlock = true; s.laser.output = "dmx";
  engine.applyCommand(s, { action: "laser", key: "arm", value: true, source: "local" }, cfg);
  assert.strictEqual(s.laser.armed, true);
  engine.applyCommand(s, { action: "blackout", value: true, source: "remote" }, cfg);
  assert.strictEqual(s.laser.armed, false, "blackout did not disarm the laser");
});

test("losing the interlock disarms the laser", () => {
  const s = engine.initialState();
  s.laser.enabled = true; s.laser.interlock = true; s.laser.output = "dmx";
  engine.applyCommand(s, { action: "laser", key: "arm", value: true, source: "local" }, cfg);
  engine.applyCommand(s, { action: "laser", key: "interlock", value: false, source: "local" }, cfg);
  assert.strictEqual(s.laser.armed, false, "laser stayed armed after interlock dropped");
});

test("Ableton clock: internal timeline does not free-run", () => {
  const s = engine.initialState(); // clockSource defaults to "ableton"
  s.playing = true;
  const before = s.elapsed;
  for (let i = 0; i < 40; i++) engine.tickInternalClock(s, 0.25);
  assert.strictEqual(s.elapsed, before, "internal clock ran while Ableton is authoritative");
});

console.log(`\n${passed} tests passed.`);
