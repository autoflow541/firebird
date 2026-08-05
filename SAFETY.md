# Firebird — Safety Model

This document is the contract every change to Firebird must respect. If a change
would violate anything here, it does not ship. Read it before touching
`src/engine.js`, `src/main.js`, or any output path.

Firebird controls light, projection, and (in future) DMX and lasers in front of a
live audience. The failure modes are not "a page 500s" — they are a blinding
strobe that will not stop, a stage that will not go dark on cue, or a laser in an
eye. The design below is built around those failure modes.

---

## 1. Blackout is a latching, output-boundary override

**Rule.** Master blackout overrides timelines, scenes, effects, and remote
commands. Once engaged it stays engaged until a deliberate, authorized *release*.

**How it is enforced (not just displayed):**

- `state.blackout` is a latch. In `engine.js`, **no scene change, timeline cue,
  preset, or visual command ever writes `blackout`.** Only an explicit
  `blackout`/`panic` command can set it, and only an authorized `blackout:false`
  can clear it. (This is the single biggest fix from the prototype, where any
  scene change silently recomputed `blackout` and released it.)
- `engine.deriveOutputs(state)` is the **single gate** every output passes
  through. While blackout is engaged it forces: Blaize blackout channel on
  (`C37V1`), Blaize brightness and strobe to 0, master to 0, projector blank,
  laser off. There is no code path that reaches hardware except through this
  function, so there is no path that can light the rig while blackout latches.
- `main.js` **re-asserts** the Blaize blackout channel on every 250 ms heartbeat,
  so a single dropped TCP write cannot leave the rig lit. On Blaize reconnect the
  full safe state is re-flushed.

**Direction asymmetry (fail-safe):** engaging blackout (the safe direction) is
allowed from every source — operator, phone remote, Ableton/OSC. *Releasing*
blackout (the unsafe direction) is **local operator only** by default
(`ALLOW_OSC_BLACKOUT_RELEASE` / `ALLOW_REMOTE_BLACKOUT_RELEASE` are `false`). The
spacebar panic on the operator console is **engage-only** — it can never release.

**What is still required for a real show (not yet built):** software blackout is
necessary but not sufficient. Before a live show there must be a **hardware
blackout / grand-master** path (a DMX all-channels-to-zero snapshot on a physical
button, or a dimmer/relay master) that does **not** depend on Firebird, Blaize,
Windows, or the network being alive. See REVIEW.md → *Critical before a live
show*.

---

## 2. The laser can never be armed by software alone

**Rule.** Laser output stays disabled until hardware **and** a physical interlock
are verified, and software is never the only thing standing between "off" and
"firing."

**How it is enforced:**

- `LASER_ENABLED` defaults to `false`. Nothing arms with it off.
- Even with it on, `engine.applyCommand` will only arm the laser when **all** of:
  the software switch is on, a live **hardware interlock** signal is present
  (`state.laser.interlock`, driven by a real input — defaults absent), blackout is
  not engaged, and the request came from the **local operator** (never remote,
  never OSC).
- `deriveOutputs` gates the actual output line on `enabled && interlock && armed
  && !blackout`. Engaging blackout disarms the laser; losing the interlock
  disarms the laser.
- **Belt and suspenders:** the software arming logic is layered *behind* the
  physical interlock, not in place of it. The physical interlock/e-stop must break
  the laser's power/emission path in hardware regardless of what software says.

**Do not** wire a laser to Firebird until a laser-safety officer has verified the
physical interlock, beam zones, and e-stop, and `LASER_ENABLED` has been turned on
deliberately for that verified rig. This is enforced by the unit tests in
`test/engine.test.js`.

---

## 3. The show survives loss of the internet / website

**Rule.** Firebird is local-first. If the public website or the internet
connection fails, the show continues.

**How it is enforced:**

- Everything that runs the show — the state engine, the Ableton OSC clock, the
  Blaize bridge, the operator console, the phone remote — runs **on the local
  show computer** inside the Electron app. None of it calls out to the internet.
- The phone remote is served by the **local** machine over the LAN, not through
  any cloud service.
- `lights.auto-flow.co` is a **marketing / download page only**. It is never on
  the show's control path. See REVIEW.md → *What runs in the cloud vs local*.

---

## 4. No unauthenticated control endpoints

**Rule.** The control surface is LAN-only and authenticated. It is never exposed
to the public internet.

**How it is enforced:**

- The control server requires a **per-session token** (regenerated each launch,
  shown in the operator window and console) on every `/command` and `/events`
  request, compared in constant time.
- **DNS-rebinding protection:** requests whose `Host` header is a domain name
  (rather than a bare LAN IP / localhost) are rejected, so a malicious website you
  browse to cannot reach the bridge.
- No wildcard CORS. Request bodies are size-capped.
- OSC binds to **loopback by default** (`OSC_BIND=127.0.0.1`) because Ableton runs
  on the same machine; feedback goes to a **fixed** host from config, never
  "whoever sent the last packet."
- **Never port-forward** `CONTROL_PORT` or `OSC_PORT`. If off-site control is ever
  needed, it goes through an authenticated VPN/WireGuard tunnel into the LAN — not
  a public port. See REVIEW.md.

---

## 5. Ableton is the authoritative clock

**Rule.** Ableton is the musical clock; Firebird does not run a second clock that
can fight it.

**How it is enforced:**

- Default `CLOCK_SOURCE=ableton`: `elapsed`/`beat` are driven **only** from
  Ableton OSC (`/firebird/position`, `/firebird/beat`). Firebird's internal
  timeline does not free-run (`tickInternalClock` is a no-op in this mode).
- `CLOCK_SOURCE=internal` is an explicit rehearsal / no-Ableton mode. Even then,
  auto-cues **never** touch the blackout latch.

---

## Change checklist

Before merging any change, confirm:

- [ ] No new code writes `state.blackout` except the `blackout`/`panic` handlers.
- [ ] Every new output goes through `deriveOutputs` and is forced safe under blackout.
- [ ] No new source can release blackout or arm the laser without local authorization.
- [ ] No new network endpoint is added without the token + host check.
- [ ] `npm test` passes (the safety suite).
