// Unit tests for the projection-mapping warp math. Pure Node.
// Run: node test/warp.test.js
const assert = require("assert");
const warp = require("../src/warp");

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("  ok -", name); };
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~= ${b}`);

console.log("Firebird warp (projection mapping) tests\n");

test("identity: unit square maps to itself", () => {
  const sq = [[0, 0], [1, 0], [0, 1], [1, 1]];
  const h = warp.computeHomography(sq, sq);
  for (const [x, y] of sq) {
    const [px, py] = warp.applyHomography(h, x, y);
    near(px, x); near(py, y);
  }
});

test("corner-pin: source corners land exactly on destination quad", () => {
  const src = [[0, 0], [1920, 0], [0, 1080], [1920, 1080]];
  // An arbitrary skewed quad (like a banner seen at an angle).
  const dst = [[120, 60], [1700, 200], [300, 1000], [1500, 900]];
  const h = warp.computeHomography(src, dst);
  for (let i = 0; i < 4; i++) {
    const [px, py] = warp.applyHomography(h, src[i][0], src[i][1]);
    near(px, dst[i][0], 1e-3); near(py, dst[i][1], 1e-3);
  }
});

test("interior points stay inside a convex destination quad", () => {
  const src = [[0, 0], [100, 0], [0, 100], [100, 100]];
  const dst = [[0, 0], [200, 0], [0, 200], [200, 200]]; // uniform 2x scale
  const h = warp.computeHomography(src, dst);
  const [cx, cy] = warp.applyHomography(h, 50, 50);
  near(cx, 100); near(cy, 100); // centre maps to centre of the 2x quad
});

test("matrix3dFor returns a well-formed matrix3d string", () => {
  const s = warp.matrix3dFor(1920, 1080, [
    { x: 0, y: 0 }, { x: 1920, y: 0 }, { x: 0, y: 1080 }, { x: 1920, y: 1080 }
  ]);
  assert.ok(s.startsWith("matrix3d("), "not a matrix3d string");
  const nums = s.slice(9, -1).split(",").map(Number);
  assert.strictEqual(nums.length, 16, "matrix3d must have 16 entries");
  assert.ok(nums.every((n) => Number.isFinite(n)), "matrix3d has non-finite entries");
});

console.log(`\n${passed} tests passed.`);
