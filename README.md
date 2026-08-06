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
test/engine.test.js   safety-model unit tests
vendor/Blaize_V3_PWFB  bundled Blaize Processing sketch + Max devices
```
