# FirebirdDepthFX — Kinect depth projector layer

Live depth-tracked visuals for Firebird: the Kinect isolates you from the
background, and your motion leaves **colour-shifting tracers** on the projector.
Firebird drives it over OSC and **master blackout blanks it**.

## Which Kinect do I have?

| | Kinect **v1** (Xbox 360) | Kinect **v2** (Xbox One) |
|---|---|---|
| Model on label | **1414** or **1473** | **1520** |
| Size / look | Smaller; **motorized tilt base that physically moves** | Bigger, boxier; **no tilt** |
| Connection | USB2 + power via a special splitter | **USB3** + Xbox-One **Kinect adapter** |
| Processing library | *Open Kinect for Processing* | **KinectPV2** |
| Windows driver | Kinect SDK 1.8 / libfreenect | **Kinect for Windows SDK 2.0** |

This sketch ships configured for **v2**. If yours is v1, follow the two `CAPTURE`
comments in `FirebirdDepthFX.pde` (swap the import, the `setup()` block, and the
one line in `getDepth()`) — nothing else changes.

## One-time setup (v2)

1. Install **Kinect for Windows SDK 2.0** (Microsoft). Plug the Kinect into a
   **USB3** port via the Xbox-One Kinect adapter. Confirm it works in the SDK's
   *Kinect Configuration Verifier* / *Depth Basics* sample first.
2. Install **Processing 4** (processing.org).
3. In Processing: **Sketch → Import Library → Manage Libraries**, install
   **KinectPV2** and **oscP5**.
4. Open `FirebirdDepthFX.pde`.

## Run

1. Set `DISPLAY` at the top of the sketch to your **projector's** screen number
   (`1` = primary; `2` = a second display). While testing on one screen, use the
   windowed `size(1280,720,P2D)` line noted in `settings()`.
2. Press **Run** (▶). Stand 0.5–2.5 m in front of the Kinect — you should appear
   as a glowing, trailing silhouette. Tune the depth window (`near`/`far`, mm) so
   only *you* light up, not the back wall.
3. Local test keys (no Firebird needed): **b** blackout toggle, **m** mirror,
   **[ / ]** shorter/longer trails.

## Firebird control (OSC on port 42073)

Firebird sends these automatically (set `DEPTHFX_HOST`/`DEPTHFX_PORT` in
`firebird.config.json` if the sketch runs on another machine):

| Address | Type | Effect |
|---|---|---|
| `/depthfx/blackout` | int 0/1 | **1 = blank the layer** (master blackout) |
| `/depthfx/enabled` | int 0/1 | layer on/off |
| `/depthfx/trails` | float 0–0.99 | tracer length (feedback persistence) |
| `/depthfx/colorspeed` | float | hypercolor hue-cycle rate |
| `/depthfx/near` · `/depthfx/far` | float mm | depth window that isolates you |
| `/depthfx/mirror` | int 0/1 | flip X to match your movement |

From Ableton or the operator you can also send `/firebird/depthfx/<key>` (e.g.
`/firebird/depthfx/trails 0.9`) — Firebird relays it here and keeps blackout
authority.

## Notes

- Runs as its **own** fullscreen layer on the projector. If you also run Blaize on
  the projector, pick one per look (or put them on separate outputs) — future work
  is compositing them.
- Depth-window isolation is the robust default. For multi-person separation you can
  switch to body-index (`kinect.enableBodyTrackImg(true)` + `getBodyTrackImage()`),
  noted in the sketch.
- Not runtime-tested against hardware in this build — verify on your show machine.
