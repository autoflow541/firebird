/**
 * armap.js — pure geometry for "mapping a human". Turns body-tracking landmarks
 * into a projection-mapping quad (TL, TR, BL, BR normalized), so a mapped surface
 * can follow a moving person. AR = projection mapping where the surface is a body.
 *
 * Dual-use (browser <script> + Node tests), no dependencies. The MediaPipe/webcam
 * plumbing lives in ar.js; this is just the math so it can be unit-tested.
 *
 * Landmarks are normalized {x,y} (0..1). Pose indices used (MediaPipe Pose):
 *   11 left shoulder, 12 right shoulder, 23 left hip, 24 right hip.
 */
(function (root) {
  "use strict";

  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  // Build a quad from pose landmarks.
  //   mode "torso" (default): shoulders + hips.
  //   mode "bbox": bounding box of all provided points.
  // margin expands the quad outward (fraction of its size). Returns 4 {x,y}
  // corners in TL,TR,BL,BR order, or null if there isn't enough to work with.
  function landmarksToQuad(landmarks, opts) {
    const o = opts || {};
    const margin = o.margin == null ? 0.15 : o.margin;
    if (!landmarks || landmarks.length < 4) return null;

    let pts;
    if (o.mode === "bbox") {
      const xs = landmarks.map((p) => p.x), ys = landmarks.map((p) => p.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      pts = [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: minX, y: maxY }, { x: maxX, y: maxY }];
    } else {
      const ls = landmarks[11], rs = landmarks[12], lh = landmarks[23], rh = landmarks[24];
      if (!ls || !rs || !lh || !rh) return null;
      const topL = ls.x <= rs.x ? ls : rs, topR = ls.x <= rs.x ? rs : ls;
      const botL = lh.x <= rh.x ? lh : rh, botR = lh.x <= rh.x ? rh : lh;
      pts = [{ x: topL.x, y: topL.y }, { x: topR.x, y: topR.y }, { x: botL.x, y: botL.y }, { x: botR.x, y: botR.y }];
    }

    // Expand outward from the centroid by `margin`.
    const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
    const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
    return pts.map((p) => ({
      x: clamp01(cx + (p.x - cx) * (1 + margin)),
      y: clamp01(cy + (p.y - cy) * (1 + margin))
    }));
  }

  // Exponential smoothing between two quads to kill jitter (alpha = new weight).
  function smoothQuad(prev, next, alpha) {
    if (!prev) return next;
    if (!next) return prev;
    const a = alpha == null ? 0.35 : alpha;
    return next.map((p, i) => ({ x: prev[i].x + (p.x - prev[i].x) * a, y: prev[i].y + (p.y - prev[i].y) * a }));
  }

  const api = { landmarksToQuad, smoothQuad, clamp01 };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FirebirdArMap = api;
})(typeof window !== "undefined" ? window : this);
