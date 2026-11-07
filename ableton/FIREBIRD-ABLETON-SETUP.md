# Firebird + Ableton Live setup

Ableton Live is the **authoritative show clock**. Firebird follows Ableton and
never runs a competing timeline (unless you deliberately set
`CLOCK_SOURCE=internal` for rehearsal). See [../SAFETY.md](../SAFETY.md) §5.

## Connection

1. Start Firebird (Ableton and Firebird on the **same machine** — Firebird's OSC
   input binds to loopback `127.0.0.1` by default).
2. In Ableton Live, place an OSC-sending Max for Live device on a dedicated
   `FIREBIRD CONTROL` MIDI track.
3. Set the OSC destination to `127.0.0.1`, UDP port **42070**.
4. Send `/firebird/bpm` once — Firebird's Ableton panel turns green.
5. For feedback, receive OSC on UDP port **42071**.

> Running Ableton on a *different* machine? Set `FIREBIRD_OSC_BIND` to this
> machine's LAN IP and point the Max device there. Only do this on a trusted,
> private network — never across the public internet.

`vendor/Blaize_V3_PWFB/BlaizeControl Project/Max Patches/OSC Send.amxd` is a good
starting device.

## OSC contract

### Ableton → Firebird (UDP 42070, input)

| Address | Value | Result |
| --- | --- | --- |
| `/firebird/scene` | int 0–4 or scene name | Intro / Heavy / Breakdown / Ambient / Blackout |
| `/firebird/blackout` | int 0/1 | Engage blackout (release is ignored by default — see below) |
| `/firebird/panic` | bang/int | Engage blackout immediately |
| `/firebird/bpm` | float | Show tempo |
| `/firebird/transport` | int 0/1 | Stop / start |
| `/firebird/position` | float seconds | Drive the playhead (Ableton is the clock) |
| `/firebird/beat` | int | Current beat (1–4) for the beat indicator |
| `/firebird/go` · `/back` | bang/int | Step cue forward / back |
| `/firebird/song` | string | Displayed song title |
| `/firebird/preset` | int 0–31 | Select Blaize preset |
| `/firebird/visual/{speed,size,brightness,strobe,shading}` | float 0–100 | Visual params |

Clip deck (layers are numbered from the bottom, 0-based; columns 0-based):

| Address | Value | Result |
| --- | --- | --- |
| `/firebird/clip` | int layer, int column | Play the clip at that cell (empty cell ignored) |
| `/firebird/column` | int column | Fire that column on every layer that has a clip there |
| `/firebird/clip/stop` | int layer (omit = all) | Stop one layer, or every layer |
| `/firebird/layer/N/opacity` | float 0–1 | Layer N opacity (automatable from a Live envelope) |
| `/firebird/layer/N/bypass` | int 0/1 | Bypass layer N |

OSC and the phone remote can only trigger existing clips and move opacity/bypass.
Editing clips (which can point at files on disk) is local-operator only. The deck
never overrides blackout.

Legacy Blaize messages are still accepted: `/note`, `/speed`, `/size`,
`/brightness`, `/strobing`, `/shading`.

### Firebird → Ableton (UDP 42071, feedback)

`/firebird/status/{scene,blackout,playing,bpm,position,preset}`. Destination is a
**fixed** host from config (`OSC_FEEDBACK_HOST`, default `127.0.0.1`) — Firebird
does **not** learn the destination from incoming packets.

## Recommended Live set

- One group per song; one MIDI track named `FIREBIRD CONTROL`.
- Cue clips at every musical section, each launching a scene/preset OSC message.
- Stream `/firebird/position` (and ideally `/firebird/beat`) continuously so the
  playhead and beat indicator track tightly and recover after any dropout.
- Keep **Blackout** on a dedicated, clearly labelled clip **and** a footswitch.
- Map footswitches to `/firebird/go`, `/firebird/back`, and an unmistakable
  `/firebird/panic`.

## Scene values

`0` Intro · `1` Heavy · `2` Breakdown · `3` Ambient · `4` Blackout

## Safe operating rule

Ableton is **not** a certified emergency-stop. By default Ableton/OSC can **engage**
a blackout but **cannot release** one — release is a deliberate local-operator
action (`ALLOW_OSC_BLACKOUT_RELEASE=false`). Lasers require a physical
interlock/e-stop and verified beam zones **independent of the software** before
`LASER_ENABLED` is ever turned on. See [../SAFETY.md](../SAFETY.md).
