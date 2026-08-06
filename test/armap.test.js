// Tests for the AR "map a human" geometry. Pure Node.
// Run: node test/armap.test.js
const assert = require("assert");
const ar = require("../src/armap");

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("  ok -", name); };
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} !~= ${b}`);
const quadNear = (q, exp) => exp.forEach((c, i) => { near(q[i].x, c[0]); near(q[i].y, c[1]); });

console.log("Firebird armap (map-a-human) tests\n");

// Build a landmark array with shoulders/hips at known spots.
function pose(ls, rs, lh, rh) {
  const a = new Array(33).fill({ x: 0.5, y: 0.5 });
  a[11] = ls; a[12] = rs; a[23] = lh; a[24] = rh;
  return a;
}

test("torso quad uses shoulders (top) and hips (bottom), left/right sorted", () => {
  const q = ar.landmarksToQuad(pose({ x: 0.4, y: 0.3 }, { x: 0.6, y: 0.3 }, { x: 0.4, y: 0.7 }, { x: 0.6, y: 0.7 }), { margin: 0 });
  quadNear(q, [[0.4, 0.3], [0.6, 0.3], [0.4, 0.7], [0.6, 0.7]]);
});

test("left/right shoulders swapped still yield TL=leftmost", () => {
  const q = ar.landmarksToQuad(pose({ x: 0.6, y: 0.3 }, { x: 0.4, y: 0.3 }, { x: 0.6, y: 0.7 }, { x: 0.4, y: 0.7 }), { margin: 0 });
  near(q[0].x, 0.4); near(q[1].x, 0.6); // TL is the smaller-x shoulder
});

test("margin expands the quad outward from its centre", () => {
  const q = ar.landmarksToQuad(pose({ x: 0.4, y: 0.4 }, { x: 0.6, y: 0.4 }, { x: 0.4, y: 0.6 }, { x: 0.6, y: 0.6 }), { margin: 0.5 });
  // centre is 0.5,0.5; corners move 50% further out.
  near(q[0].x, 0.35); near(q[0].y, 0.35); near(q[3].x, 0.65); near(q[3].y, 0.65);
});

test("bbox mode wraps all points; values clamp to 0..1", () => {
  const q = ar.landmarksToQuad([{ x: 0.1, y: 0.2 }, { x: 0.9, y: 0.2 }, { x: 0.1, y: 0.8 }, { x: 0.9, y: 0.8 }], { mode: "bbox", margin: 0 });
  quadNear(q, [[0.1, 0.2], [0.9, 0.2], [0.1, 0.8], [0.9, 0.8]]);
});

test("returns null when landmarks are missing", () => {
  assert.strictEqual(ar.landmarksToQuad(null), null);
  assert.strictEqual(ar.landmarksToQuad([{ x: 0, y: 0 }]), null);
});

test("smoothQuad eases toward the new quad", () => {
  const prev = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
  const next = [{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }];
  const s = ar.smoothQuad(prev, next, 0.5);
  near(s[0].x, 0.5); near(s[2].y, 0.5);
});

test("headPose: centre between ears, width = ear distance, angle = tilt", () => {
  const a = new Array(9).fill({ x: 0.5, y: 0.5 });
  a[7] = { x: 0.4, y: 0.3 }; a[8] = { x: 0.6, y: 0.3 }; // ears
  const h = ar.headPose(a);
  near(h.x, 0.5); near(h.y, 0.3); near(h.width, 0.2); near(h.angle, 0);
});

test("headPose tilt: raised right ear yields a positive angle; null if no ears", () => {
  const a = new Array(9).fill({ x: 0.5, y: 0.5 });
  a[7] = { x: 0.4, y: 0.3 }; a[8] = { x: 0.6, y: 0.4 };
  assert.ok(ar.headPose(a).angle > 0, "tilt angle not positive");
  assert.strictEqual(ar.headPose([{ x: 0, y: 0 }]), null);
});

test("smoothPose eases each field toward the new pose", () => {
  const s = ar.smoothPose({ x: 0, y: 0, width: 0, angle: 0 }, { x: 1, y: 1, width: 1, angle: 1 }, 0.5);
  near(s.x, 0.5); near(s.width, 0.5); near(s.angle, 0.5);
});

console.log(`\n${passed} tests passed.`);
