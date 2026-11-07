// Tests for the audience-light DMX path: frame building, beat/flash limiting,
// ENTTEC / Art-Net framing, and the engine's fixture trust rules. Pure Node.
// Run: node test/dmx.test.js
const assert = require("assert");
const dmx = require("../src/dmx");
const engine = require("../src/engine");
const { config } = require("../src/config");

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("  ok -", name); };

const silent = { level: 0, bass: 0, mid: 0, high: 0 };
function rig(fixtures, patch) {
  const s = engine.initialState();
  s.fixtures = fixtures.map((f, i) => dmx.normalizeFixture(f, i));
  Object.assign(s, patch || {});
  return s;
}
const ctxOf = (o) => Object.assign({ audio: silent, beatPos: 0.5, bpm: 120, flash: true, cfg: {}, now: 0 }, o || {});
const frameOf = (s, ctx) => dmx.buildFrame(s, engine.deriveOutputs(s), ctxOf(ctx));
const slots = (fr, from, n) => Array.from(fr.slice(from - 1, from - 1 + n));

console.log("Firebird DMX tests\n");

test("default fixtures are UNPATCHED: a fresh install writes nothing to DMX", () => {
  const s = engine.initialState();
  assert.ok(s.fixtures.every((f) => !f.enabled));
  assert.ok(frameOf(s).every((v) => v === 0));
});

test("RGB fixture: colour x level x master lands on its three slots", () => {
  const s = rig([{ id: "a", profile: "rgb", addr: 10, enabled: true, level: 100, color: "#ff8000" }], { master: 100 });
  assert.deepStrictEqual(slots(frameOf(s), 10, 3), [255, 128, 0]);
  s.master = 50;
  assert.deepStrictEqual(slots(frameOf(s), 10, 3), [128, 64, 0]);
});

test("dimmer-channel fixtures: dimmer carries intensity, colour stays full", () => {
  const s = rig([{ id: "a", profile: "dimrgb", addr: 1, enabled: true, level: 50, color: "#00ff00" }], { master: 100 });
  assert.deepStrictEqual(slots(frameOf(s), 1, 4), [128, 0, 255, 0]);
});

test("RGBW fixture pulls white out of the colour", () => {
  const s = rig([{ id: "a", profile: "rgbw", addr: 1, enabled: true, level: 100, color: "#ff6464" }], { master: 100 });
  assert.deepStrictEqual(slots(frameOf(s), 1, 4), [155, 0, 0, 100]);
});

test("custom map supports fixed channels; unknown tokens become 0", () => {
  const s = rig([{ id: "a", profile: "custom", map: "dim,r,g,b,f0,f255,bogus", addr: 1, enabled: true, level: 100, color: "#ffffff" }], { master: 100 });
  assert.deepStrictEqual(slots(frameOf(s), 1, 7), [255, 255, 255, 255, 0, 255, 0]);
});

test("addresses are bounds-checked: a fixture at 511 only writes slots 511-512", () => {
  const s = rig([{ id: "a", profile: "dimrgb", addr: 511, enabled: true, level: 100, color: "#ffffff" }], { master: 100 });
  const fr = frameOf(s);
  assert.strictEqual(fr.length, 512);
  assert.deepStrictEqual(slots(fr, 511, 2), [255, 255]);
  assert.strictEqual(dmx.normalizeFixture({ addr: 900, enabled: true }, 0).enabled, false, "out-of-range address stays unpatched");
});

test("sound reactivity: level modulates between (1-amt) and 1 of the fixture level", () => {
  const f = [{ id: "a", profile: "dimmer", addr: 1, enabled: true, level: 100, react: "level", amt: 1 }];
  const s = rig(f, { master: 100 });
  assert.strictEqual(frameOf(s, { audio: { ...silent, level: 0 } })[0], 0);
  assert.strictEqual(frameOf(s, { audio: { ...silent, level: 1 } })[0], 255);
  assert.strictEqual(frameOf(s, { audio: { ...silent, level: 0.5 } })[0], 128);
  s.fixtures[0].amt = 0.5; // never drops below half
  assert.strictEqual(frameOf(s, { audio: { ...silent, level: 0 } })[0], 128);
});

test("beat reactivity pulses on the beat and decays", () => {
  const s = rig([{ id: "a", profile: "dimmer", addr: 1, enabled: true, level: 100, react: "beat", amt: 1 }], { master: 100 });
  const onBeat = frameOf(s, { beatPos: 3.0 })[0], later = frameOf(s, { beatPos: 3.9 })[0];
  assert.ok(onBeat > 240 && later < 40, `${onBeat} -> ${later}`);
});

test("SAFETY: flash-to-beat never exceeds 3 flashes per second at any BPM", () => {
  assert.strictEqual(dmx.flashEvery(120), 1);
  assert.strictEqual(dmx.flashEvery(180), 1);
  assert.strictEqual(dmx.flashEvery(181), 2);
  assert.strictEqual(dmx.flashEvery(360), 2);
  assert.strictEqual(dmx.flashEvery(361), 3);
  for (const bpm of [90, 128, 174, 180, 200, 240, 300]) {
    // simulate 10 s at 1 kHz and count rising edges
    let edges = 0, prev = 0;
    for (let t = 0; t < 10000; t++) {
      const beatPos = (t / 1000) * bpm / 60;
      const v = dmx.flashPulse({ beatPos, bpm, flash: true });
      if (v && !prev) edges++;
      prev = v;
    }
    assert.ok(edges / 10 <= dmx.MAX_FLASH_HZ + 0.01, `${bpm} BPM -> ${edges / 10} flashes/s`);
  }
  assert.strictEqual(dmx.flashPulse({ beatPos: 4.0, bpm: 120, flash: false }), 0, "flash switch off = no flashes");
});

test("flash fixtures follow the limiter: only flash beats are lit", () => {
  const s = rig([{ id: "a", profile: "dimmer", addr: 1, enabled: true, level: 100, react: "flash", amt: 1 }], { master: 100 });
  assert.strictEqual(frameOf(s, { beatPos: 4.1, bpm: 240 })[0], 255);  // beat 4, every=2 -> flash
  assert.strictEqual(frameOf(s, { beatPos: 5.1, bpm: 240 })[0], 0);    // beat 5 skipped
  assert.strictEqual(frameOf(s, { beatPos: 4.6, bpm: 240 })[0], 0);    // past the duty window
});

test("SAFETY: blackout zeroes every fixture slot - even identify, flash and reactivity", () => {
  const s = rig([
    { id: "a", profile: "rgb", addr: 1, enabled: true, level: 100, color: "#ffffff", react: "flash", amt: 1 },
    { id: "b", profile: "dimrgbstrobe", addr: 20, enabled: true, level: 100, color: "#ffffff" }
  ], { master: 100 });
  assert.ok(frameOf(s, { beatPos: 4.1 }).some((v) => v > 0), "sanity: lit before blackout");
  engine.applyCommand(s, { action: "blackout", value: true, source: "local" }, config);
  const fr = frameOf(s, { beatPos: 4.1, identify: { id: "a", until: 1e12 }, now: 1 });
  assert.ok(fr.every((v) => v === 0), "every slot must be 0 during blackout (fixed channels too)");
});

test("SAFETY: blackout also zeroes fixed 'f255' channels (not just colour)", () => {
  const s = rig([{ id: "a", profile: "custom", map: "f255,dim", addr: 1, enabled: true, level: 100 }], { master: 100, blackout: true });
  assert.deepStrictEqual(slots(frameOf(s), 1, 2), [0, 0]);
});

test("identify lights one fixture white at full, then times out", () => {
  const s = rig([{ id: "a", profile: "rgb", addr: 1, enabled: true, level: 10, color: "#ff0000" }], { master: 100 });
  assert.deepStrictEqual(slots(frameOf(s, { identify: { id: "a", until: 100 }, now: 50 }), 1, 3), [255, 255, 255]);
  assert.deepStrictEqual(slots(frameOf(s, { identify: { id: "a", until: 100 }, now: 150 }), 1, 3), [26, 0, 0]);
});

test("laser DMX bytes ride in the frame only when the engine gate says emit", () => {
  const cfg = { LASER_DMX_ADDRESS: 30, LASER_DMX_ARMED: [255, 7], LASER_DMX_INTENSITY_CH: 33 };
  const s = rig([], { master: 100 });
  s.laser = { enabled: true, interlock: true, armed: true, output: "dmx", requireInterlock: false, fx: 50 };
  assert.deepStrictEqual(slots(frameOf(s, { cfg }), 30, 2), [255, 7]);
  assert.strictEqual(frameOf(s, { cfg })[32], 128);
  s.laser.armed = false;
  assert.ok(frameOf(s, { cfg }).every((v) => v === 0));
  s.laser.armed = true; s.blackout = true;
  assert.ok(frameOf(s, { cfg }).every((v) => v === 0), "blackout disarms the laser bytes");
});

test("ENTTEC DMX USB Pro packet framing", () => {
  const fr = new Uint8Array(512); fr[0] = 200; fr[511] = 9;
  const p = dmx.enttecPacket(fr);
  assert.strictEqual(p.length, 518);
  assert.deepStrictEqual([p[0], p[1], p[2], p[3], p[4]], [0x7e, 6, 0x01, 0x02, 0]); // len 513 = 0x0201
  assert.strictEqual(p[5], 200); assert.strictEqual(p[516], 9); assert.strictEqual(p[517], 0xe7);
});

test("Art-Net packet framing", () => {
  const p = dmx.artnetPacket(3, new Uint8Array(512));
  assert.strictEqual(p.toString("latin1", 0, 7), "Art-Net");
  assert.strictEqual(p.readUInt16LE(8), 0x5000);
  assert.strictEqual(p.readUInt16LE(14), 3);
  assert.strictEqual(p.readUInt16BE(16), 512);
  assert.strictEqual(p.length, 18 + 512);
});

test("beat clock free-runs on BPM and snaps to Ableton's beat-in-bar", () => {
  const c = dmx.makeBeatClock();
  for (let i = 0; i < 60; i++) c.tick(1 / 30, 120, 0); // 2 s at 120 BPM = 4 beats
  assert.ok(Math.abs(c.pos - 4) < 0.05, String(c.pos));
  c.tick(0, 120, 3);                                    // Ableton says: beat 3
  assert.strictEqual(c.pos % 4, 2);
});

test("engine: look changes allowed from anywhere, patch changes local-only", () => {
  const s = engine.initialState();
  const id = s.fixtures[0].id;
  engine.applyCommand(s, { action: "fixture", id, value: { level: 40, color: "#112233", react: "beat", amt: 0.3 }, source: "remote" }, config);
  assert.strictEqual(s.fixtures[0].level, 40);
  assert.strictEqual(s.fixtures[0].react, "beat");
  const log = engine.applyCommand(s, { action: "fixture", id, value: { addr: 1, enabled: true }, source: "remote" }, config);
  assert.ok(!s.fixtures[0].enabled && s.fixtures[0].addr === 0 && log.length, "remote must not patch");
  engine.applyCommand(s, { action: "fixture", id, value: { addr: 10, enabled: true, profile: "rgbw" }, source: "local" }, config);
  assert.deepStrictEqual([s.fixtures[0].addr, s.fixtures[0].enabled, s.fixtures[0].profile], [10, true, "rgbw"]);
  engine.applyCommand(s, { action: "fixture", id, value: { addr: 9999 }, source: "local" }, config);
  assert.strictEqual(s.fixtures[0].enabled, false, "invalid address un-patches rather than writing somewhere random");
});

test("engine: fixture values are clamped / sanitised; sound can't touch fixtures; laser row stays locked", () => {
  const s = engine.initialState();
  const id = s.fixtures[0].id;
  engine.applyCommand(s, { action: "fixture", id, value: { level: 999, color: "javascript:alert(1)", react: "evil", amt: 9, __proto__: { x: 1 } }, source: "local" }, config);
  assert.strictEqual(s.fixtures[0].level, 100);
  assert.strictEqual(s.fixtures[0].color, "#ffffff");
  assert.strictEqual(s.fixtures[0].react, "none");
  assert.strictEqual(s.fixtures[0].amt, 1);
  const before = JSON.stringify(s.fixtures);
  engine.applyCommand(s, { action: "fixture", id, value: { level: 1 }, source: "sound" }, config);
  assert.strictEqual(JSON.stringify(s.fixtures), before);
  engine.applyCommand(s, { action: "fixture", id: "laser", value: { level: 100, addr: 1, enabled: true }, source: "local" }, config);
  assert.strictEqual(s.fixtures.find((f) => f.id === "laser").level, 0);
});

test("engine: add/remove fixtures (local only, capped); remove never deletes the laser row", () => {
  const s = engine.initialState();
  const n = s.fixtures.length;
  engine.applyCommand(s, { action: "fixtureAdd", source: "remote" }, config);
  assert.strictEqual(s.fixtures.length, n);
  engine.applyCommand(s, { action: "fixtureAdd", source: "local" }, config);
  assert.strictEqual(s.fixtures.length, n + 1);
  assert.strictEqual(s.fixtures[n].enabled, false);
  engine.applyCommand(s, { action: "fixtureRemove", id: "laser", source: "local" }, config);
  assert.ok(s.fixtures.some((f) => f.id === "laser"));
  engine.applyCommand(s, { action: "fixtureRemove", id: s.fixtures[n].id, source: "local" }, config);
  assert.strictEqual(s.fixtures.length, n);
  for (let i = 0; i < 100; i++) engine.applyCommand(s, { action: "fixtureAdd", source: "local" }, config);
  assert.ok(s.fixtures.length <= 32);
});

test("engine: 'lights' bulk control sets amt/level/react on enabled fixtures only; flash toggle", () => {
  const s = engine.initialState();
  engine.applyCommand(s, { action: "fixture", id: s.fixtures[0].id, value: { addr: 1, enabled: true }, source: "local" }, config);
  engine.applyCommand(s, { action: "lights", key: "amt", value: 25, source: "local" }, config);
  engine.applyCommand(s, { action: "lights", key: "react", value: "bass", source: "local" }, config);
  assert.strictEqual(s.fixtures[0].amt, 0.25);
  assert.strictEqual(s.fixtures[0].react, "bass");
  assert.notStrictEqual(s.fixtures[1].react, "bass", "unpatched fixtures are left alone");
  engine.applyCommand(s, { action: "lights", key: "flash", value: false, source: "local" }, config);
  assert.strictEqual(s.dmx.flash, false);
});

test("show files keep the DMX patch; loading never touches blackout", () => {
  const a = engine.initialState();
  engine.applyCommand(a, { action: "fixture", id: a.fixtures[0].id, value: { addr: 5, enabled: true, profile: "dimrgb", react: "beat" }, source: "local" }, config);
  const b = engine.initialState();
  b.blackout = true;
  engine.loadShow(b, JSON.parse(JSON.stringify(engine.exportShow(a))));
  assert.deepStrictEqual([b.fixtures[0].addr, b.fixtures[0].enabled, b.fixtures[0].profile, b.fixtures[0].react], [5, true, "dimrgb", "beat"]);
  assert.strictEqual(b.blackout, true);
});

console.log(`\n${passed} tests passed.`);
