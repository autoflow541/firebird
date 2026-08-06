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

test("laser with KEY as guard (requireInterlock=false): local arms, remote can't, blackout still kills", () => {
  const s = engine.initialState();
  s.laser.enabled = true; s.laser.requireInterlock = false; s.laser.output = "dmx";
  engine.applyCommand(s, { action: "laser", key: "arm", value: true, source: "local" }, cfg);
  assert.strictEqual(s.laser.armed, true, "local could not arm with key as the guard");
  assert.strictEqual(engine.deriveOutputs(s).laser.emit, true, "should emit when armed with key guard");
  // Remote still cannot arm.
  const s2 = engine.initialState();
  s2.laser.enabled = true; s2.laser.requireInterlock = false; s2.laser.output = "dmx";
  engine.applyCommand(s2, { action: "laser", key: "arm", value: true, source: "remote" }, cfg);
  assert.strictEqual(s2.laser.armed, false, "remote armed the laser");
  // Blackout still disarms AND blanks the beam.
  engine.applyCommand(s, { action: "blackout", value: true, source: "local" }, cfg);
  assert.strictEqual(s.laser.armed, false, "blackout did not disarm");
  assert.strictEqual(engine.deriveOutputs(s).laser.emit, false, "blackout did not blank the laser");
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

test("sound drives visuals + modulates an ARMED laser, but never arms it or blacks out", () => {
  const s = engine.initialState();
  s.master = 100; // isolate fx from master scaling for this assertion
  s.laser.enabled = true; s.laser.requireInterlock = false; s.laser.output = "dmx";
  // Sound CAN drive a visual.
  engine.applyCommand(s, { action: "visual", key: "brightness", value: 70, source: "sound" }, cfg);
  assert.strictEqual(s.blaize.brightness, 70, "sound could not drive a visual");
  // Sound CANNOT engage blackout, arm the laser, or change its output.
  engine.applyCommand(s, { action: "blackout", value: true, source: "sound" }, cfg);
  assert.strictEqual(s.blackout, false, "sound engaged blackout");
  engine.applyCommand(s, { action: "laser", key: "arm", value: true, source: "sound" }, cfg);
  assert.strictEqual(s.laser.armed, false, "sound armed the laser");
  engine.applyCommand(s, { action: "laser", key: "output", value: "ilda", source: "sound" }, cfg);
  assert.strictEqual(s.laser.output, "dmx", "sound changed the laser output");
  // laser fx from sound is IGNORED while not armed (can't move a beam that's off).
  engine.applyCommand(s, { action: "laser", key: "fx", value: 90, source: "sound" }, cfg);
  assert.strictEqual(s.laser.fx, 0, "sound moved the laser while it was not armed");
  // Operator arms; NOW sound moves the beam, always.
  engine.applyCommand(s, { action: "laser", key: "arm", value: true, source: "local" }, cfg);
  engine.applyCommand(s, { action: "laser", key: "fx", value: 90, source: "sound" }, cfg);
  assert.strictEqual(s.laser.fx, 90, "sound could not move the armed laser");
  assert.strictEqual(engine.deriveOutputs(s).laser.fx, 90, "armed laser fx not in output");
  // Blackout zeroes the fx and the beam.
  engine.applyCommand(s, { action: "blackout", value: true, source: "local" }, cfg);
  const out = engine.deriveOutputs(s);
  assert.strictEqual(out.laser.emit, false, "blackout did not kill the beam");
  assert.strictEqual(out.laser.fx, 0, "blackout did not zero laser fx");
});

test("MASTER scales Blaize brightness and armed-laser fx", () => {
  const s = engine.initialState();
  s.blaize.brightness = 100; s.master = 50;
  assert.strictEqual(engine.deriveOutputs(s).blaizeChannels[engine.BLAIZE_CH.brightness], 50, "master did not scale brightness");
  s.laser.enabled = true; s.laser.requireInterlock = false; s.laser.output = "dmx"; s.laser.fx = 100;
  engine.applyCommand(s, { action: "laser", key: "arm", value: true, source: "local" }, cfg);
  assert.strictEqual(engine.deriveOutputs(s).laser.fx, 50, "master did not scale laser fx");
  s.master = 0;
  assert.strictEqual(engine.deriveOutputs(s).blaizeChannels[engine.BLAIZE_CH.brightness], 0, "master 0 did not zero brightness");
});

test("show export/load round-trips cues + song + fixtures", () => {
  const s = engine.initialState();
  s.song = "Neon Wolves"; s.bpm = 140;
  const show = engine.exportShow(s);
  const s2 = engine.initialState();
  engine.loadShow(s2, show);
  assert.strictEqual(s2.song, "Neon Wolves");
  assert.strictEqual(s2.bpm, 140);
  assert.deepStrictEqual(s2.cues.map((c) => c.scene), s.cues.map((c) => c.scene));
  assert.strictEqual(s2.fixtures.length, s.fixtures.length);
});

test("loadShow sanitizes cues (sorted, clamped bpm) and resets the playhead", () => {
  const s = engine.initialState();
  s.elapsed = 50; s.cueIndex = 3;
  engine.loadShow(s, { bpm: 9999, cues: [{ time: 40, scene: "ambient" }, { time: 0, scene: "intro" }] });
  assert.strictEqual(s.bpm, 300, "bpm not clamped");
  assert.deepStrictEqual(s.cues.map((c) => c.time), [0, 40], "cues not sorted");
  assert.strictEqual(s.cues[0].scene, "INTRO", "scene not upper-cased");
  assert.strictEqual(s.elapsed, 0); assert.strictEqual(s.cueIndex, 0);
});

test("SAFETY: loading a show never disturbs blackout or the laser", () => {
  const s = engine.initialState();
  s.laser.enabled = true; s.laser.requireInterlock = false; s.laser.output = "dmx";
  engine.applyCommand(s, { action: "blackout", value: true, source: "local" }, cfg);
  engine.loadShow(s, { song: "X", cues: [{ time: 0, scene: "HEAVY" }] });
  assert.strictEqual(s.blackout, true, "loading a show released blackout");
  assert.strictEqual(engine.deriveOutputs(s).laser.emit, false, "laser emitted after show load under blackout");
});

test("Ableton clock: internal timeline does not free-run", () => {
  const s = engine.initialState(); // clockSource defaults to "ableton"
  s.playing = true;
  const before = s.elapsed;
  for (let i = 0; i < 40; i++) engine.tickInternalClock(s, 0.25);
  assert.strictEqual(s.elapsed, before, "internal clock ran while Ableton is authoritative");
});

console.log(`\n${passed} tests passed.`);
