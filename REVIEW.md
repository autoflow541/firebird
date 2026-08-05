# Firebird Show Control — Engineering Review

Reviewed as a live-show systems engineer / UX / software architect against the
original prototype (Electron `src/main.js` + browser remote + ChatGPT-hosted
`site/`). This document records the findings **and** what has already been fixed
in this hardening pass. Items marked **[FIXED]** are addressed in the code now in
`afa/firebird`; items marked **[TODO]** need the physical rig or a follow-up
build.

The changes so far are proven by `npm test` (`test/engine.test.js`, 10 passing
safety tests) and `npm run check` (syntax) — see README.

---

## 1. What currently works (prototype, before this pass)

- A genuinely local Electron app: operator console, separate full-screen
  **projector** window, and a **phone remote** served over the LAN.
- **Blaize** integration over TCP `127.0.0.1:17017` using the real documented
  protocol (`C<channel>V<value>`, verified against `vendor/.../tcp_notes.txt`):
  32 preset selects, speed/size/brightness/strobe/shading, multicolor, blackout.
- **Ableton/OSC** input on UDP `42070` with a working hand-rolled OSC parser, plus
  status feedback on `42071`. A sensible address map (`/firebird/scene`,
  `/blackout`, `/bpm`, `/transport`, `/go`, `/back`, `/panic`, …).
- Scene→preset mapping, BPM tap, editable fixture levels, a song timeline, and a
  laser row deliberately held **locked at zero**.
- Live state fan-out to every surface via SSE + Electron IPC.

The bones are right: local-first, Ableton-as-clock intent, laser held off.

---

## 2. Bugs / fragile areas

- **[FIXED] Blackout was not a latch.** `update()` recomputed `state.blackout =
  (scene === "BLACKOUT")` on *every* scene change, and the auto-cue loop did the
  same. Now blackout only changes via explicit `blackout`/`panic`, and scenes
  never touch it.
- **[FIXED] Two clocks fought.** A 250 ms `setInterval` free-ran `elapsed` and
  auto-fired cues whenever `playing`, competing with Ableton and re-deriving
  blackout. Now the internal clock only runs in explicit `internal` mode and never
  touches blackout.
- **[FIXED] Blackout could be silently lost.** `sendBlaize` no-ops when the socket
  is down, so blackout did nothing if Blaize was disconnected, and a dropped
  packet was never retried. Now the blackout channel is re-asserted every
  heartbeat and the full safe state is re-flushed on reconnect.
- **[FIXED] Bizarre BPM hack.** `/bpm` values `< 2` were mangled as
  `value*1000+19`. Removed; `/firebird/bpm` takes a plain float.
- **[FIXED] Feedback host hijack.** Feedback was sent to *the last IP that sent
  any OSC packet* (`state.ableton.host`). Now the destination is fixed by config.
- **[TODO] No persistence.** Cues/scenes are hardcoded in `renderer.js` and
  `engine.js`, and the timeline is a demo. A real show needs a saved show file
  (see roadmap).

---

## 3. Security risks (esp. remote control over the internet)

- **[FIXED] Unauthenticated control endpoint.** `/command` accepted any JSON POST
  from anyone who could reach the port — full show control, including blackout,
  with zero auth. Now every `/command` and `/events` request requires a
  constant-time-checked **per-session token**.

  *Failure scenario:* anyone on the venue Wi-Fi (a guest, a phone that joined the
  open SSID) runs `curl -XPOST .../command -d '{"action":"blackout"}'` mid-set and
  kills the show, on repeat. *Fix:* token gate + LAN-only posture.

- **[FIXED] `Access-Control-Allow-Origin: *` + no auth = drive-by control.** Any
  website the operator visited could POST to the bridge (CSRF / DNS-rebinding).
  Now: wildcard CORS removed, and requests with a domain-name `Host` header are
  rejected (DNS-rebind block).

  *Failure scenario:* operator opens a random page on the show laptop; that page's
  JS scans `192.168.x.x:42080` and blacks out the stage. *Fix:* host-header
  allowlist (bare IP / localhost only) + token.

- **[FIXED] OSC bound to `0.0.0.0`.** Anyone on the LAN could inject OSC (fake
  cues, fake blackout-release). Now OSC binds **loopback** by default (Ableton is
  local); LAN binding is opt-in for a trusted multi-machine rig.

- **[TODO] Internet exposure must stay off.** The ChatGPT-hosted `site/` cannot
  open a UDP/OSC socket or reach a LAN address, so it was never a real control
  path — good. **Do not** solve "control from the website" by port-forwarding the
  bridge. If remote-operator control is ever wanted, put it behind a
  **WireGuard/VPN** into the LAN, still token-gated. Documented in SAFETY.md §4.

---

## 4. Safety problems (blackout / DMX / projector / laser)

- **[FIXED] Blackout now overrides at the output boundary** (`deriveOutputs`), not
  just in the UI — forces Blaize off, brightness/strobe 0, master 0, projector
  blank, laser off. See SAFETY.md §1.
- **[FIXED] Laser arming is interlock-gated and local-only**, disarmed by blackout
  or interlock loss, and impossible with `LASER_ENABLED=false` (default). See
  SAFETY.md §2.
- **[TODO — CRITICAL BEFORE SHOW] Hardware grand-master / blackout.** Software
  blackout depends on Windows + Electron + Blaize + the network being alive. A
  live show needs a blackout that works when they are **not** — a physical DMX
  grand-master to zero, or a dimmer/relay kill, independent of Firebird.
- **[TODO — CRITICAL BEFORE HARDWARE] Projector "blank" is a black window, not a
  shutter.** A crashed app or GPU glitch can leave the projector showing a frozen
  frame or the desktop. For anything bright/close, use the projector's own
  shutter/AV-mute on a hardware control, and blank via a matte/dowser you can
  reach.
- **[TODO — CRITICAL BEFORE HARDWARE] Strobe safety.** Strobe is operator-settable
  0–100 with no rate clamp. Add a max-Hz clamp and a "no strobe" master for
  photosensitive-epilepsy safety before any real strobe fixture is attached.

---

## 5. Ableton / OSC architecture

- **[FIXED] Ableton is authoritative**, no competing free-run clock (SAFETY.md §5).
  `elapsed`/`beat` come from `/firebird/position` + `/firebird/beat`.
- **[TODO] Reduce hand-off ambiguity.** Today Ableton sends discrete cue messages.
  Recommended: Ableton also streams **beat/position continuously** (a Max `[live.step]`
  / transport → OSC every 1/16), so Firebird's UI playhead and any beat-synced
  visuals track sample-accurately and recover instantly after a dropout.
- **[TODO] OSC is UDP (lossy).** Cue-critical messages (scene, blackout) should be
  idempotent (they are) **and** repeated by Ableton for a few frames, or moved to
  a TCP/′reliable′ channel. Blackout especially should be sent as a sustained
  state, not a one-shot bang.
- **[GOOD] Keep the note-based compatibility map** (`/note`, `/speed`, …) so the
  existing Blaize Max devices (`note2osc.amxd`, `OSC Send.amxd`) keep working.

---

## 6. Can the website realistically talk to the local stage computer?

**Short answer: not the ChatGPT-hosted `site/`, and it shouldn't.** A page on
`*.chatgpt.site` (or any cloud host) runs in a browser sandbox: no UDP, no raw
OSC, and it cannot address `192.168.x.x` on the venue LAN. Bridging it would mean
opening a public relay into the show computer — exactly the internet-exposed
unauthenticated path the constraints forbid.

**Correct model (implemented):** the control surface is served **by the show
computer itself** over the LAN; phones/tablets hit `http://<lan-ip>:42080/?t=…`.
`lights.auto-flow.co` becomes a **landing + download** page only. If you ever want
true off-site control, it's a **VPN into the LAN**, never a public endpoint.

---

## 7. Mobile & desktop usability

- **[FIXED] Remote is now honest about authority.** Its blackout button is
  **engage-only** and relabels to "BLACKOUT ENGAGED · release at console," so a
  performer with the phone can always kill the stage but can't accidentally
  un-black it.
- **[GOOD] The remote layout** (big scene tiles, big transport) is thumb-friendly
  and already `maximum-scale=1` to stop pinch-zoom during a set.
- **[TODO] Reconnect UX.** SSE drops on Wi-Fi roam; add auto-reconnect + a visible
  "reconnecting" state on both remote and operator so a stale screen is obvious.
- **[TODO] Operator console at FOH.** Dark theme is right. Add: a persistent,
  unmissable blackout state banner; larger hit targets for the blackout button; a
  visible clock-source + Ableton-link indicator; and a laser ar/disarm panel that
  is clearly local-only. (Brand pass applied: Auto-Flow gold accent, dark UI kept.)

---

## 8. Best architecture for reliable live performance

```
            Ableton Live (authoritative clock)  ── OSC 42070 ─┐
                                                              ▼
  Operator console ─IPC─┐                             ┌────────────────┐
                        ├──►  FIREBIRD ENGINE (pure)  │  engine.js     │
  Phone remote ─token──►┤     • latching blackout     │  (unit-tested) │
   (LAN, SSE/POST)      │     • source authorization  └───────┬────────┘
                        │     • deriveOutputs = GATE          │
                        ▼                                      ▼
                 status feedback ◄─OSC 42071      ┌──────────────────────────┐
                                                  │  OUTPUT GATE (main.js)    │
                                                  │  Blaize TCP │ projector   │
                                                  │  DMX/Art-Net│ laser(lock) │
                                                  └──────────────────────────┘
        Independent of all the above: HARDWARE grand-master + laser interlock/e-stop
```

Principles: one pure state engine, one output gate, one authoritative clock,
fail-safe direction always available, and a hardware safety layer that owes
nothing to the software.

---

## 9. Cloud vs local

| Runs on the **local show computer** | Runs in the **cloud** |
| --- | --- |
| State engine, blackout latch, output gate | `lights.auto-flow.co` landing/download page |
| Ableton OSC clock in/feedback out | Docs, release notes, changelog |
| Blaize TCP bridge | (optional) crash/telemetry drop-off, post-show |
| Operator console + projector | Nothing on the show control path |
| LAN control server (token) + phone remote | |
| DMX/Art-Net + laser (future) | |

The only cloud dependency is a static marketing page. The show never waits on it.

---

## 10. Prioritized roadmap (prototype → show-ready)

### Critical before connecting hardware
1. **[FIXED]** Latching blackout + output-boundary gate.
2. **[FIXED]** Laser interlock model (software can never arm alone).
3. **[FIXED]** Token auth + DNS-rebind protection + loopback OSC.
4. **[TODO]** Strobe max-Hz clamp + global "no strobe."
5. **[TODO]** DMX/Art-Net output adapter behind `deriveOutputs` (start with a
   sACN/Art-Net library, all-zero on blackout, tested on a single dimmer).

### Critical before a live show
6. **[TODO]** Hardware grand-master / blackout independent of Firebird.
7. **[TODO]** Laser: physical interlock + e-stop + zone verification by a
   laser-safety officer; only then set `LASER_ENABLED`.
8. **[TODO]** Projector hardware shutter/AV-mute; verified safe frame on crash.
9. **[TODO]** Show file: save/load cues, scenes, fixture patch, presets.
10. **[TODO]** Full run-through with Ableton driving, plus a "cold restart mid-show"
    drill (kill and relaunch Firebird; confirm it recovers to safe state).

### Important improvements
11. Auto-reconnect + stale-screen indicators (remote + operator).
12. Continuous beat/position streaming from Ableton.
13. Repeat/sustain cue-critical OSC; watchdog on Ableton link.
14. Structured show log (every command + source + timestamp) for post-mortems.
15. Config UI for ports/hosts instead of hand-edited JSON.

### Nice-to-have
16. Forward tempo to Blaize (`C254`) for beat-synced visuals.
17. MIDI input as an alternative to OSC.
18. Multi-operator roles (lighting vs visuals) with scoped tokens.
19. Preset thumbnails in the UI (the `vendor/.../data/*.png` renders exist).
20. Timecode (LTC/MTC) sync option for festival slots.
```
