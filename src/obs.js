// OBS control via the official obs-websocket-js client (OBS 28+ has the
// obs-websocket server built in: Tools -> WebSocket Server Settings).
//
// Loaded with dynamic import() so this stays optional: if the library isn't
// installed the rest of Firebird runs untouched and OBS control simply reports
// unavailable. Non-safety — OBS control never touches blackout or the laser.
//
// "Use libraries whenever possible" (user preference): this wraps the maintained
// obs-websocket-js rather than hand-rolling the v5 protocol.

let OBSWebSocket = null;
let obs = null;
let onStatus = () => {};
const status = { available: false, connected: false, streaming: false, recording: false, error: "" };

function emit() { try { onStatus({ ...status }); } catch {} }

async function ensureLib() {
  if (OBSWebSocket) return true;
  try {
    const mod = await import("obs-websocket-js");
    OBSWebSocket = mod.default || mod.OBSWebSocket || mod;
    return true;
  } catch (error) {
    status.error = "obs-websocket-js not installed — run `npm install` in the firebird folder";
    emit();
    return false;
  }
}

async function connect(url, password) {
  if (!(await ensureLib())) return;
  try {
    if (obs) { try { await obs.disconnect(); } catch {} }
    obs = new OBSWebSocket();
    obs.on("ConnectionClosed", () => { status.connected = false; status.error = "OBS disconnected"; emit(); });
    obs.on("StreamStateChanged", (d) => { status.streaming = !!d.outputActive; emit(); });
    obs.on("RecordStateChanged", (d) => { status.recording = !!d.outputActive; emit(); });
    await obs.connect(url, password || undefined);
    const s = await obs.call("GetStreamStatus").catch(() => ({}));
    const r = await obs.call("GetRecordStatus").catch(() => ({}));
    status.available = true;
    status.connected = true;
    status.streaming = !!s.outputActive;
    status.recording = !!r.outputActive;
    status.error = "";
  } catch (error) {
    status.connected = false;
    status.error = error && error.message ? error.message : "OBS connect failed";
  }
  emit();
}

async function call(op, args) {
  if (!obs || !status.connected) return { ok: false, error: "OBS not connected" };
  try { const res = await obs.call(op, args); return { ok: true, res }; }
  catch (error) { return { ok: false, error: error.message }; }
}

module.exports = {
  setOnStatus: (fn) => { onStatus = fn; },
  getStatus: () => ({ ...status }),
  connect,
  disconnect: async () => { if (obs) { try { await obs.disconnect(); } catch {} } status.connected = false; emit(); },
  startStream: () => call("StartStream"),
  stopStream: () => call("StopStream"),
  toggleStream: () => call("ToggleStream"),
  startRecord: () => call("StartRecord"),
  stopRecord: () => call("StopRecord"),
  toggleRecord: () => call("ToggleRecord"),
  setScene: (name) => call("SetCurrentProgramScene", { sceneName: String(name) })
};
