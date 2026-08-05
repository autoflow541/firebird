# Firebird — AR (mapping a human)

AR here isn't a separate system — it's **projection mapping where the surface is a
live person.** Body tracking drives a mapped surface's four corners, so whatever
you project (webcam, scene, Kinect) follows the performer as they move: a
projected costume, tracers pinned to the body, energy from the torso, etc.

Tracking uses **MediaPipe Pose** (Google Tasks Vision — current, maintained).

## Use it
1. Open the **projection map** editor, add a surface, set its **source** (e.g.
   Webcam or Scene), and tick **TRACK (AR)**. Save.
2. On the operator console, click **AR TRACK ME**. It opens the webcam, runs pose
   tracking, and drives every Track(AR) surface to your body live.
3. Move — the mapped content follows you. `armap.js` turns the pose (shoulders +
   hips, or a full-body bbox) into the quad; it's smoothed to kill jitter.

`src/armap.js` (the landmarks→quad math) is unit-tested (6 tests). The live
tracking + projection needs the real webcam/projector to verify.

## MediaPipe assets (important for shows)
By default `ar.js` loads MediaPipe from a **CDN** (needs internet the first run):
- `window.FIREBIRD_MP_BASE` — tasks-vision bundle + wasm base
  (default `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14`).
- `window.FIREBIRD_MP_MODEL` — the pose `.task` model (default the Google-hosted
  `pose_landmarker_lite`).

For a **reliable offline show**, download these once and serve them locally, then
set the two globals to the local paths (e.g. in a small inline script in
`index.html`, or vendor under `vendor/mediapipe/`). Firebird runs fine without AR;
if the assets can't load it just shows "AR unavailable".

## Tuning (`window.FirebirdAR.config`)
- `mode`: `"torso"` (shoulders+hips) or `"bbox"` (whole body).
- `margin`: how far the quad expands past the body (default 0.15).
- `smooth`: 0..1 easing (higher = snappier, lower = smoother; default 0.35).

## Next tier
Body **segmentation mask** (project only *on* the person — true digital costume),
hands/face tracking as effect emitters, multi-person surfaces.
