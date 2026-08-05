# Firebird — Projection Mapping

Warp Firebird's visuals onto real surfaces (angled walls, risers, banners, set
pieces) using a photo shot from the projector's viewpoint. This is 2.5D
corner-pin mapping — MadMapper-style basics, built in. (True 3D geometry mapping,
which needs the projector + object present to calibrate, is a future tier / a job
for MadMapper.)

## Open the editor
- In Firebird: **PROJECTION MAP** button (top of the Fixtures panel) — opens the
  editor window.
- From a phone: `http://<lan-ip>:42080/map?t=<token>` (same token as the remote).

## Workflow
1. **Load a photo** shot from as close to the **projector lens** as possible.
2. **+ Surface**, then drag its **4 corners** onto a real surface in the photo.
   Arrow keys nudge the whole surface (Shift = bigger steps) for fine alignment.
3. Pick a **source** and set **opacity**. **Duplicate** to repeat a surface.
   **Preview** hides the handles for a clean look.
4. **Save → Projector.** Because the photo is from the projector's view, what you
   outline is what lands on the wall — then fine-tune against the live projection.

Mapping is saved to `firebird.mapping.json` (git-ignored, per venue) and pushed to
the projector live. With no surfaces, the projector shows the full-frame look.

## Sources
- **Solid color** — a flat fill (with the colour picker).
- **Scene look** — the animated scene-coloured background.
- **Test grid** — for alignment.
- **Kinect depth FX** — links the mapping to the depth-FX sketch: Firebird forwards
  the surface's quad to `FirebirdDepthFX`, which **warps its silhouette + tracers
  onto that surface** (`/depthfx/mapped` + `/depthfx/quad`). So the map decides
  where your Kinect visuals land.

## Outputs (important)
Blaize, the Kinect depth-FX sketch, and Firebird's own projector window are
separate outputs — put them on separate projectors/displays (e.g. Blaize
crowd-facing, depth-FX performer-facing). A "Kinect depth FX" surface is drawn on
the **depth-FX sketch's** output (it renders nothing in Firebird's own projector
window); solid/scene/grid surfaces render in Firebird's projector window.

## Under the hood
- `src/warp.js` — corner-pin homography → CSS `matrix3d` (unit-tested, 4 tests).
- `src/projector.js` — renders each surface corner-pinned + per-surface opacity.
- Not runtime-tested against a real projector here — verify on the rig.
- Next tier: mesh/bezier warp for curved surfaces; masking; image/video sources.
