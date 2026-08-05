/**
 * warp.js — projective (homography) warp for projection mapping.
 *
 * Dual-use module: loads as a plain <script> in the projector/editor pages
 * (defines window.FirebirdWarp) AND as a Node module for unit tests
 * (module.exports). No dependencies.
 *
 * The core is the classic "general 2D projection" corner-pin: given a source
 * rectangle W×H and four destination corners, produce the CSS `matrix3d(...)`
 * that maps the element onto that quad. Corner order is TL, TR, BL, BR.
 */
(function (root) {
  "use strict";

  function adj(m) { // adjugate of a 3x3 (row-major, length 9)
    return [
      m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
      m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
      m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3]
    ];
  }
  function multmm(a, b) { // 3x3 * 3x3
    const c = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[3 * i + k] * b[3 * k + j];
      c[3 * i + j] = s;
    }
    return c;
  }
  function multmv(m, v) { // 3x3 * vec3
    return [
      m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
      m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
      m[6] * v[0] + m[7] * v[1] + m[8] * v[2]
    ];
  }

  // Map the standard basis to four points p1..p4 (each [x,y]).
  function basisToPoints(p1, p2, p3, p4) {
    const m = [p1[0], p2[0], p3[0], p1[1], p2[1], p3[1], 1, 1, 1];
    const v = multmv(adj(m), [p4[0], p4[1], 1]);
    return multmm(m, [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]]);
  }

  // Homography mapping src[] quad -> dst[] quad (each an array of 4 [x,y]).
  function computeHomography(src, dst) {
    const s = basisToPoints(src[0], src[1], src[2], src[3]);
    const d = basisToPoints(dst[0], dst[1], dst[2], dst[3]);
    return multmm(d, adj(s));
  }

  // Apply a homography to a point.
  function applyHomography(h, x, y) {
    const v = multmv(h, [x, y, 1]);
    return [v[0] / v[2], v[1] / v[2]];
  }

  // CSS matrix3d string that warps a W×H element so its corners (TL,TR,BL,BR)
  // land on dstCorners (array of 4 {x,y} in the same order).
  function matrix3dFor(w, h, dstCorners) {
    const src = [[0, 0], [w, 0], [0, h], [w, h]];
    const dst = dstCorners.map((c) => [c.x, c.y]);
    const t = computeHomography(src, dst);
    // Normalise so t[8] === 1, then lay out column-major as matrix3d expects.
    for (let i = 0; i < 9; i++) t[i] = t[i] / t[8];
    const m = [
      t[0], t[3], 0, t[6],
      t[1], t[4], 0, t[7],
      0, 0, 1, 0,
      t[2], t[5], 0, t[8]
    ];
    return "matrix3d(" + m.join(",") + ")";
  }

  const api = { computeHomography, applyHomography, matrix3dFor, adj, multmm, multmv };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FirebirdWarp = api;
})(typeof window !== "undefined" ? window : this);
