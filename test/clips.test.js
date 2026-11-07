// Tests for the clip-deck data model + shader library. Pure Node (no GPU).
// Run: node test/clips.test.js
const assert = require("assert");
const C = require("../src/clips");
const S = require("../src/shaders");

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("  ok -", name); };
const local = { trusted: true };

console.log("Firebird clip deck tests\n");

test("default deck is valid, every cell filled, nothing playing", () => {
  const d = C.defaultDeck(S.ids);
  assert.ok(d.layers.length >= 4);
  for (const l of d.layers) {
    assert.strictEqual(l.active, -1);
    assert.strictEqual(l.clips.length, d.columns);
    l.clips.forEach((c) => { assert.ok(c); assert.ok(S.ids.includes(c.shader)); });
  }
  assert.ok(!C.anyActive(d));
});

test("trigger plays a clip; empty cell is a no-op; out-of-range is rejected", () => {
  const d = C.defaultDeck(S.ids);
  assert.ok(C.applyOp(d, { op: "trigger", layer: 1, col: 3 }, local));
  assert.strictEqual(d.layers[1].active, 3);
  assert.ok(C.anyActive(d));
  d.layers[2].clips[0] = null;
  assert.strictEqual(C.applyOp(d, { op: "trigger", layer: 2, col: 0 }, local), false);
  assert.strictEqual(d.layers[2].active, -1);
  assert.strictEqual(C.applyOp(d, { op: "trigger", layer: 99, col: 0 }, local), false);
  assert.strictEqual(C.applyOp(d, { op: "trigger", layer: 0, col: 99 }, local), false);
});

test("column triggers every layer that has a clip there; stop / stopAll clear", () => {
  const d = C.defaultDeck(S.ids);
  d.layers[1].clips[2] = null;
  C.applyOp(d, { op: "column", col: 2 }, local);
  assert.strictEqual(d.layers[0].active, 2);
  assert.strictEqual(d.layers[1].active, -1, "empty cell in that column stays stopped");
  C.applyOp(d, { op: "stop", layer: 0 }, local);
  assert.strictEqual(d.layers[0].active, -1);
  C.applyOp(d, { op: "column", col: 1 }, local);
  C.applyOp(d, { op: "stopAll" }, local);
  assert.ok(!C.anyActive(d));
});

test("anyActive ignores bypassed and zero-opacity layers", () => {
  const d = C.defaultDeck(S.ids);
  C.applyOp(d, { op: "trigger", layer: 0, col: 0 }, local);
  assert.ok(C.anyActive(d));
  C.applyOp(d, { op: "layer", layer: 0, patch: { bypass: true } }, local);
  assert.ok(!C.anyActive(d));
  C.applyOp(d, { op: "layer", layer: 0, patch: { bypass: false, opacity: 0 } }, local);
  assert.ok(!C.anyActive(d));
});

test("layer patch clamps opacity and rejects unknown blend modes", () => {
  const d = C.defaultDeck(S.ids);
  C.applyOp(d, { op: "layer", layer: 0, patch: { opacity: 7 } }, local);
  assert.strictEqual(d.layers[0].opacity, 1);
  C.applyOp(d, { op: "layer", layer: 0, patch: { opacity: -3 } }, local);
  assert.strictEqual(d.layers[0].opacity, 0);
  C.applyOp(d, { op: "layer", layer: 0, patch: { blend: "screen" } }, local);
  assert.strictEqual(d.layers[0].blend, "screen");
  C.applyOp(d, { op: "layer", layer: 0, patch: { blend: "nonsense" } }, local);
  assert.strictEqual(d.layers[0].blend, "screen");
});

test("clip edits are normalized: params clamped, unknown shader falls back", () => {
  const d = C.defaultDeck(S.ids);
  C.applyOp(d, { op: "clip", layer: 0, col: 0, clip: { type: "shader", shader: "does-not-exist", speed: 99, scale: -5, hue: 3, audio: 2 }, shaderIds: S.ids }, local);
  const c = d.layers[0].clips[0];
  assert.strictEqual(c.shader, S.ids[0]);
  assert.strictEqual(c.speed, 4);
  assert.strictEqual(c.scale, 0.1);
  assert.strictEqual(c.hue, 1);
  assert.strictEqual(c.audio, 1);
});

test("clearing the playing clip stops the layer", () => {
  const d = C.defaultDeck(S.ids);
  C.applyOp(d, { op: "trigger", layer: 0, col: 4 }, local);
  C.applyOp(d, { op: "clip", layer: 0, col: 4, clip: null }, local);
  assert.strictEqual(d.layers[0].clips[4], null);
  assert.strictEqual(d.layers[0].active, -1);
});

test("SAFETY: media src must be a local file: URL (no http/data/javascript)", () => {
  for (const bad of ["http://evil.example/x.mp4", "https://x/y.png", "data:text/html,hi", "javascript:alert(1)", "//host/share/a.mp4"]) {
    assert.strictEqual(C.normalizeClip({ type: "video", src: bad }, S.ids).src, "", bad);
  }
  assert.strictEqual(C.normalizeClip({ type: "image", src: "file:///C:/shows/a.png" }, S.ids).src, "file:///C:/shows/a.png");
});

test("SAFETY: untrusted sources (OSC / phone) can only trigger and move opacity/bypass", () => {
  const d = C.defaultDeck(S.ids);
  const remote = { trusted: false };
  assert.ok(C.applyOp(d, { op: "trigger", layer: 0, col: 1 }, remote));
  assert.ok(C.applyOp(d, { op: "column", col: 2 }, remote));
  assert.ok(C.applyOp(d, { op: "layer", layer: 0, patch: { opacity: 0.3 } }, remote));
  assert.ok(C.applyOp(d, { op: "stopAll" }, remote));
  // editing clips (which can reference files) and renaming / re-blending are local-only
  const before = JSON.stringify(d);
  assert.strictEqual(C.applyOp(d, { op: "clip", layer: 0, col: 0, clip: { type: "image", src: "file:///etc/passwd" } }, remote), false);
  assert.strictEqual(C.applyOp(d, { op: "layer", layer: 0, patch: { blend: "add" } }, remote), false);
  assert.strictEqual(C.applyOp(d, { op: "layer", layer: 0, patch: { opacity: 1, name: "x" } }, remote), false);
  assert.strictEqual(JSON.stringify(d), before);
});

test("malformed ops and decks never throw", () => {
  const d = C.defaultDeck(S.ids);
  for (const bad of [null, undefined, {}, { op: 5 }, { op: "trigger" }, { op: "trigger", layer: "0", col: "1" }, { op: "layer", layer: 0 }, { op: "nope" }]) {
    assert.doesNotThrow(() => C.applyOp(d, bad, local));
  }
  assert.doesNotThrow(() => C.normalizeDeck(null, S.ids));
  assert.doesNotThrow(() => C.normalizeDeck({ columns: 9999, layers: "x" }, S.ids));
  const n = C.normalizeDeck({ columns: 9999, layers: Array(50).fill({}) }, S.ids);
  assert.strictEqual(n.columns, C.MAX_COLUMNS);
  assert.strictEqual(n.layers.length, C.MAX_LAYERS);
});

test("normalizeDeck drops an active index that points at an empty cell", () => {
  const n = C.normalizeDeck({ columns: 2, layers: [{ active: 1, clips: [{ type: "solid" }, null] }] }, S.ids);
  assert.strictEqual(n.layers[0].active, -1);
});

test("exportDeck never saves a playing state", () => {
  const d = C.defaultDeck(S.ids);
  C.applyOp(d, { op: "column", col: 0 }, local);
  assert.ok(C.exportDeck(d).layers.every((l) => l.active === -1));
  assert.ok(d.layers.some((l) => l.active === 0), "export must not mutate the live deck");
});

test("layers carry a crossfade time (clamped) and an effect list", () => {
  const d = C.defaultDeck(S.ids);
  assert.ok(d.layers.every((l) => l.fade > 0 && Array.isArray(l.fx) && l.fx.length === 0));
  C.applyOp(d, { op: "layer", layer: 0, patch: { fade: 99 } }, local);
  assert.strictEqual(d.layers[0].fade, C.MAX_FADE);
  C.applyOp(d, { op: "layer", layer: 0, patch: { fade: -1 } }, local);
  assert.strictEqual(d.layers[0].fade, 0);
});

test("fx op: append, replace, remove, cap at MAX_FX, reject unknown types", () => {
  const d = C.defaultDeck(S.ids);
  for (const t of ["blur", "color", "mosaic", "trails"]) assert.ok(C.applyOp(d, { op: "fx", layer: 0, index: d.layers[0].fx.length, effect: C.defaultEffect(t) }, local));
  assert.strictEqual(d.layers[0].fx.length, C.MAX_FX);
  assert.strictEqual(C.applyOp(d, { op: "fx", layer: 0, index: 4, effect: C.defaultEffect("invert") }, local), false, "cap");
  assert.ok(C.applyOp(d, { op: "fx", layer: 0, index: 1, effect: C.defaultEffect("invert") }, local));
  assert.strictEqual(d.layers[0].fx[1].type, "invert");
  assert.ok(C.applyOp(d, { op: "fx", layer: 0, index: 0, effect: null }, local));
  assert.strictEqual(d.layers[0].fx.length, 3);
  assert.strictEqual(C.applyOp(d, { op: "fx", layer: 0, index: 0, effect: { type: "exec" } }, local), false);
  assert.strictEqual(C.applyOp(d, { op: "fx", layer: 0, index: 9, effect: null }, local), false);
});

test("effects are normalized: params clamped to 0..1, bad modulation source dropped", () => {
  const e = C.normalizeEffect({ type: "transform", p: [5, -2, "x", null, 9], mod: "bogus", amt: 7 });
  assert.deepStrictEqual(e.p, [1, 0, 0.5, 0.5]);
  assert.strictEqual(e.mod, "none");
  assert.strictEqual(e.amt, 1);
  assert.ok(C.FX_MODS.includes("lfo") && C.FX_MODS.includes("ramp") && C.FX_MODS.includes("noise"));
  for (const t of C.FX_TYPES) assert.strictEqual(C.defaultEffect(t).p.length, C.EFFECTS[t].params.length);
});

test("every effect type has a shader index; blur is the only separate-pass one", () => {
  assert.deepStrictEqual(C.FX_TYPES.map((t) => C.FX_INDEX[t]), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("glsl clips: code kept (capped), blank falls back to the template", () => {
  assert.strictEqual(C.normalizeClip({ type: "glsl", code: "x".repeat(99999) }, S.ids).code.length, C.MAX_CODE);
  assert.strictEqual(C.normalizeClip({ type: "glsl", code: "   " }, S.ids).code, C.GLSL_TEMPLATE);
  assert.ok(/vec3 fx\(vec2 uv, vec2 p, float t\)/.test(S.buildCustom(C.GLSL_TEMPLATE)));
});

test("SAFETY: fx / fade / glsl edits are local-only; remote can still trigger and fade opacity", () => {
  const d = C.defaultDeck(S.ids);
  const remote = { trusted: false };
  assert.strictEqual(C.applyOp(d, { op: "fx", layer: 0, index: 0, effect: C.defaultEffect("blur") }, remote), false);
  assert.strictEqual(C.applyOp(d, { op: "layer", layer: 0, patch: { fade: 5 } }, remote), false);
  assert.strictEqual(C.applyOp(d, { op: "clip", layer: 0, col: 0, clip: { type: "glsl", code: "void main(){ for(;;){} }" } }, remote), false);
  assert.ok(C.applyOp(d, { op: "layer", layer: 0, patch: { opacity: 0.2 } }, remote));
  assert.strictEqual(d.layers[0].fx.length, 0);
});

test("shader library: unique ids, each fragment defines fx() and has header + main", () => {
  assert.strictEqual(new Set(S.ids).size, S.ids.length);
  assert.ok(S.ids.length >= 10);
  for (const id of S.ids) {
    const src = S.buildFragment(id);
    assert.ok(src.startsWith("#version 300 es"), id);
    assert.ok(/vec3 fx\(vec2 uv, vec2 p, float t\)/.test(src), id + " missing fx()");
    assert.ok(/void main\(\)/.test(src), id);
  }
  assert.ok(C.BLEND_MODES.length === 8);
  assert.ok(/uMode == 7/.test(S.BLEND_FRAG), "blend shader covers all 8 modes");
});

console.log(`\n${passed} tests passed.`);
