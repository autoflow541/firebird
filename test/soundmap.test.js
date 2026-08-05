// Tests for the audio-feature -> control-command mapping. Pure Node.
// Run: node test/soundmap.test.js
const assert = require("assert");
const sm = require("../src/soundmap");

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("  ok -", name); };
const find = (cmds, action, key) => cmds.find((c) => c.action === action && (key === undefined || c.key === key));

console.log("Firebird soundmap tests\n");

test("default mapping drives the Blaize visual params from the bands", () => {
  const cmds = sm.featuresToCommands({ level: 0.5, bass: 0.8, mid: 0.4, high: 0.2, onset: false });
  assert.strictEqual(find(cmds, "visual", "brightness").value, 50);
  assert.strictEqual(find(cmds, "visual", "size").value, 80);
  assert.strictEqual(find(cmds, "visual", "speed").value, 40);
  assert.strictEqual(find(cmds, "visual", "shading").value, 20);
});

test("onset pulses strobe; no onset leaves it at 0", () => {
  assert.strictEqual(find(sm.featuresToCommands({ onset: true }), "visual", "strobe").value, 60);
  assert.strictEqual(find(sm.featuresToCommands({ onset: false }), "visual", "strobe").value, 0);
});

test("master + depthfx are opt-in", () => {
  const off = sm.featuresToCommands({ level: 0.5, high: 0.4 });
  assert.ok(!find(off, "master"), "master should be off by default");
  assert.ok(!find(off, "depthfx"), "depthfx should be off by default");
  const on = sm.featuresToCommands({ level: 0.5, high: 0.4 }, { master: true, depthfx: true });
  assert.strictEqual(find(on, "master").value, 50);
  assert.ok(find(on, "depthfx", "colorspeed"), "depthfx colorspeed missing");
  assert.ok(find(on, "depthfx", "trails"), "depthfx trails missing");
});

test("sensitivity scales and clamps to 0..100", () => {
  const cmds = sm.featuresToCommands({ level: 0.6 }, { sensitivity: 3 });
  assert.strictEqual(find(cmds, "visual", "brightness").value, 100); // 0.6*3 clamped
});

test("SAFETY: sound mapping emits only visual/master/depthfx + laser 'fx' — never blackout/arm/scene", () => {
  const cmds = sm.featuresToCommands({ level: 1, bass: 1, mid: 1, high: 1, onset: true }, { master: true, depthfx: true });
  const allowed = new Set(["visual", "master", "depthfx"]);
  for (const c of cmds) {
    if (c.action === "laser") {
      assert.strictEqual(c.key, "fx", "sound may only emit the laser 'fx' modulation, not " + c.key);
    } else {
      assert.ok(allowed.has(c.action), `sound emitted a disallowed action: ${c.action}`);
    }
  }
});

console.log(`\n${passed} tests passed.`);
