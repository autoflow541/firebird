# Firebird — Streaming (OBS) & Capture

Firebird is built to drive a stream, not replace it. OBS Studio does the encoding
and the RTMP/streaming; Firebird gives it (1) a live **browser source**, (2)
**control** so cues and the operator run OBS, and (3) one-click **captures**.

## 1. Browser source (projector as a streaming background/overlay)

The operator console shows a **Stream** panel with an OBS Browser Source URL like:

```
http://<lan-ip>:42080/stream?t=<token>
```

In OBS: **Sources → + → Browser**, paste that URL. It renders a transparent live
lower-third (song / scene / BPM, Auto-Flow branded) with a red LIVE dot.

- Add **`&bg=1`** to the URL for a full **moving background** layer that follows
  the current scene colour — a ready-made stream backdrop with no extra software.
- The Kinect depth-FX / Blaize visuals are their own fullscreen apps — capture
  those in OBS with a **Window/Display Capture**, and keep the Firebird browser
  source on top as the overlay.

## 2. OBS control (cues + operator run OBS)

Uses the official **obs-websocket-js** library against OBS's built-in server.

1. In OBS: **Tools → WebSocket Server Settings → Enable**. Note the port (default
   `4455`) and password.
2. Set them in `firebird.config.json`: `OBS_URL` (`ws://127.0.0.1:4455`),
   `OBS_PASSWORD`, and `OBS_AUTOCONNECT: true` to connect on launch.
3. Run `npm install` in the firebird folder once (adds obs-websocket-js).
4. In the operator Stream panel: **Connect OBS**, then **Go Live** / **Record**.

From Ableton you can trigger OBS with OSC:

| OSC address | Value | Action |
|---|---|---|
| `/firebird/obs/stream` | int 0/1 | stop / start streaming |
| `/firebird/obs/record` | int 0/1 | stop / start recording |
| `/firebird/obs/scene` | string | switch to an OBS scene by name |

If obs-websocket-js isn't installed or OBS isn't running, the panel just shows
OFFLINE — the rest of Firebird is unaffected (OBS control is non-safety and never
touches blackout or the laser).

## 3. Captures

**Capture PNG** in the Stream panel saves a snapshot of the **projector** output
to `captures/` (falls back to the operator window if the projector is closed).

## Notes / next

- Not runtime-tested against OBS in this build — verify on your show machine.
- Roadmap: expose OBS scene list in the UI; per-scene auto-switch tied to Firebird
  scenes; virtual-camera toggle; NDI output option.
