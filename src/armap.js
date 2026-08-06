/**
 * armap.js — pure geometry for the two AR features (no dependencies, unit-tested;
 * the MediaPipe/webcam plumbing lives in ar.js / ar-filter.js).
 *
 *  1) landmarksToQuad — "map a human": pose landmarks -> a mapping quad (TL,TR,
 *     BL,BR normalized) so a mapped surface follows a moving person.
 *  2) headPose — the AR sombrero filter: pose landmarks -> a hat transform
 *     { x, y, width, angle } (head-centre normalized, ear-to-ear width, tilt rad).
 *
 * Pose indices (MediaPipe Pose): 0 nose, 2 left eye, 5 right eye, 7 left ear,
 * 8 right ear, 11/12 shoulders, 23/24 hips.
 */
(function (root) {
  "use strict";

  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  // ---- (1) map-a-human quad ------------------------------------------------
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
    const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
    const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
    return pts.map((p) => ({ x: clamp01(cx + (p.x - cx) * (1 + margin)), y: clamp01(cy + (p.y - cy) * (1 + margin)) }));
  }

  function smoothQuad(prev, next, alpha) {
    if (!prev) return next;
    if (!next) return prev;
    const a = alpha == null ? 0.35 : alpha;
    return next.map((p, i) => ({ x: prev[i].x + (p.x - prev[i].x) * a, y: prev[i].y + (p.y - prev[i].y) * a }));
  }

  // ---- (2) AR sombrero filter — head placement -----------------------------
  function headPose(landmarks) {
    if (!landmarks || landmarks.length < 9) return null;
    const le = landmarks[7], re = landmarks[8]; // ears
    if (!le || !re) return null;
    return {
      x: (le.x + re.x) / 2,
      y: (le.y + re.y) / 2,
      width: Math.hypot(re.x - le.x, re.y - le.y),
      angle: Math.atan2(re.y - le.y, re.x - le.x)
    };
  }

  function smoothPose(prev, next, alpha) {
    if (!prev) return next;
    if (!next) return prev;
    const a = alpha == null ? 0.4 : alpha;
    const lerp = (p, n) => p + (n - p) * a;
    return { x: lerp(prev.x, next.x), y: lerp(prev.y, next.y), width: lerp(prev.width, next.width), angle: lerp(prev.angle, next.angle) };
  }

  const api = { landmarksToQuad, smoothQuad, headPose, smoothPose, clamp01 };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FirebirdArMap = api;
})(typeof window !== "undefined" ? window : this);
