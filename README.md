# Firebird Show Control — Auto-Flow

Local-first live show control: **Ableton is the clock**, Firebird owns scenes,
master blackout, the Blaize visual engine, a projector output, and a token-gated
phone remote. Everything that runs the show runs on the **local** machine — the
show keeps going if the internet or `lights.auto-flow.co` is down.

> **Read [SAFETY.md](SAFETY.md) before connecting any hardware, and
> [REVIEW.md](REVIEW.md) for the full engineering review + roadmap.** This is a
> hardened prototype: software safety is in place, but a live show still needs a
> hardware grand-master and (for lasers) a physical interlock. See REVIEW.md.

## Run

1. Double-click `Start Firebird.bat` (installs the Electron runtime first time).
2. On launch, the operator window and the console print a **control token** and a
   LAN URL like `http://192.168.1.20:42080/?t=<token>`.
3. Open that URL on a phone/tablet **on the same Wi-Fi**. The token in the URL is
   required — the server rejects requests without it.

Command line (from this folder — not `C:\Windows\System32`):

```bash
npm.cmd install
npm.cmd start
```

Verify the safety logic any time:

```bash
npm test        # 10 safety-model unit tests (blackout latch, laser interlock, gate)
npm run check   # syntax-check every source file
```

## Safety at a glance

- **Master blackout latches and overrides everything** — scenes, timelines,
  effects, remote commands. Only the local operator can release it. Spacebar =
  engage-only panic. (SAFETY.md §1)
- **Laser is disabled in software and can never be armed by software alone** — it
  also requires a live hardware interlock and the local operator. (SAFETY.md §2)
- **No unauthenticated control**: per-session token + DNS-rebind protection; OSC
  on loopback by default. **Never port-forward** to the internet. (SAFETY.md §4)

## Configuration

Defaults are safe and need no config. To override, drop a `firebird.config.json`
next to `package.json` (see `firebird.config.example.json`) or set
`FIREBIRD_<KEY>` environment variables. Keys: `CONTROL_PORT`, `OSC_BIND`,
`OSC_PORT`, `OSC_FEEDBACK_HOST`, `OSC_FEEDBACK_PORT`, `CLOCK_SOURCE`,
`BLAIZE_HOST`, `BLAIZE_PORT`, `LASER_ENABLED`, `ALLOW_OSC_BLACKOUT_RELEASE`,
`ALLOW_REMOTE_BLACKOUT_RELEASE`. See `src/config.js` for the full list + comments.

## Show files

**SAVE** / **LOAD** in the Song Timeline panel write/read a show as JSON (default
`shows/`): song, tempo, the cue list, and the fixture patch. The timeline is
data-driven, so loading a show redraws it. Loading a show is a setup action — it
**never** changes safety state (blackout, laser, master stay as they are).

## Blaize visual engine

The original `Blaize_V3_PWFB` source is bundled under `vendor/Blaize_V3_PWFB`. Run
`Blaize_V3_PWFB.pde` in Processing (Network + oscP5 libraries). Firebird connects
over TCP to `127.0.0.1:17017` and reconnects automatically, re-asserting the full
safe state (including blackout) after any reconnect. Protocol reference:
`vendor/Blaize_V3_PWFB/tcp_notes.txt`. Scene→preset: Intro 0, Heavy 10,
Breakdown 20, Ambient 26.

## Clip deck (built-in visuals)

The **CLIPS** tab is a Resolume-style grid: layers (rows) x columns of clips,
composited on the GPU (WebGL2) in the projector window. Click a clip to play and
edit it; the column buttons (or keys **Q–I**) fire a whole column; each layer has
opacity, blend mode (normal/add/screen/multiply/overlay/difference/lighten/darken),
bypass and stop. A live preview runs the same compositor as the projector.

- **Sources:** 10 built-in audio-reactive generators (plasma, tunnel, kaleidoscope,
  rings, nebula, starfield, spectrum, neon grid, voronoi, aurora), solid colour,
  image, video (local files), webcam. Per-clip speed, scale, hue, intensity and
  audio-reactivity.
- **Audio + clock:** the Sound tab's analysis (level, bass/mid/high, onsets, 16-band
  spectrum) feeds every generator; beats lock to Ableton / BPM.
- **Crossfades:** every layer has a FADE time. Triggering a clip, or stopping the
  layer, dissolves from the old clip instead of cutting (smoothstep ease).
- **Layer FX:** up to 4 effects per layer, in order: Color, Transform, Mirror /
  kaleidoscope, Mosaic, RGB split, Blur, Trails (feedback) and Invert. Any effect's
  first parameter can be modulated by level / bass / mid / high / beat, or an
  Ableton-locked LFO / ramp / noise.
- **GLSL clips (TouchDesigner-style):** set a clip's source to `glsl` and live-code
  `vec3 fx(vec2 uv, vec2 p, float t)`. You get uTime, uBeat, uBass/uMid/uHigh/uLevel/
  uOnset, uBands[16] and helpers (`pal`, `fbm`, `vnoise`, `band`, `beatPulse`,
  `hueRot`). Compile errors show under the editor. Only the local operator can edit code.
- **Mapping:** set a projection-map surface's source to **Clip deck** to corner-pin
  the composite onto a real surface.
- **Control:** OSC `/firebird/clip`, `/column`, `/layer/N/opacity` (see the Ableton
  doc). OSC and the phone remote can trigger and fade clips but never edit them.
- **Safety:** the deck sits under the blackout latch (blackout renders black and
  pauses all media); nothing plays at launch; media must be local `file:` paths.

The deck is saved per venue in `firebird.deck.json` (git-ignored).

## Audience lights (DMX) + guitar rig

FIXTURES tab -> **DMX OUTPUT**: **ENTTEC USB Pro** (auto-detects the COM port; install the
FTDI VCP driver if Windows doesn't see it) or any **Art-Net** node. The choice is saved in
`firebird.dmx.json`. Then patch each light:

1. **Profile** (dimmer, RGB, RGBW, dimmer+RGB, ... or a custom channel map) and **DMX
   address**. Typing an address patches the fixture. Fixtures start unpatched, so nothing
   is written to DMX until you do this. **IDENTIFY** lights one white for 1.5 s.
2. **Reacts to**: steady, sound level, bass, mids, highs, beat pulse, or **flash on beat**;
   **depth** sets how far it moves from its level (level is the ceiling).
3. Sound comes from the SOUND tab (guitar into your audio interface), the beat from Ableton
   or the BPM.

Safety: master blackout zeroes every channel immediately (including fixed channels and
IDENTIFY); flash-to-beat is hard-limited to 3 flashes per second at any BPM (above 180 BPM
it flashes every 2nd/3rd beat) and has its own off switch; remote/OSC can change a
fixture's look but never its patch; on quit a final all-zero frame is sent. When the DMX
output is on, the laser's DMX channels are merged into the same frame (still gated by arm,
interlock and blackout).

**Push 2:** in the MIDI tab tick *Push 2 pad grid -> clips* (bottom row = bottom layer,
each pad = one clip column), and LEARN knobs/pads for lights reactivity depth, level,
flash on/off, react-to-beat/sound/bass, fire column 1-8 and stop all clips.

## Ableton Live (the clock)

Firebird listens for OSC on UDP **42070** (loopback by default) and sends status
feedback on UDP **42071** to a **fixed** host from config. Ableton drives
position/beat; Firebird does not run a competing clock. Full setup and the OSC
contract: [ableton/FIREBIRD-ABLETON-SETUP.md](ableton/FIREBIRD-ABLETON-SETUP.md).

## Where things run

| Local show computer | Cloud |
| --- | --- |
| Engine, blackout latch, output gate, Ableton OSC, Blaize, operator + projector, LAN remote | `lights.auto-flow.co` landing/download page only — never on the control path |

## Layout

```
src/
  config.js      configuration + safe defaults
  engine.js      pure state machine + safety gate (unit-tested, no Electron)
  main.js        Electron: windows, OSC, Blaize TCP, token-gated control server
  renderer.js    operator console
  remote.js      phone remote (engage-only blackout, token from URL)
  projector.js   full-screen projector output
  dmx.js         DMX frame builder, beat/flash limiter, ENTTEC + Art-Net framing (pure)
  dmxout.js      DMX transports (ENTTEC serial / Art-Net)
  fixtures.js    FIXTURES tab UI
  clips.js       clip-deck model + ops (pure, unit-tested)
  shaders.js     generator library + blend/media/output GLSL
  compositor.js  WebGL2 layer compositor (projector + preview)
  deck.js        CLIPS tab UI
test/            engine (safety), warp, soundmap, armap, clips unit tests
vendor/Blaize_V3_PWFB  bundled Blaize Processing sketch + Max devices
```
