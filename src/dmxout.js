// DMX transports for the audience lights (main process). Pure framing lives in
// dmx.js; this file only moves bytes.
//
//   "enttec" - ENTTEC DMX USB Pro (and Pro Mk2 port 1) over a virtual COM port, via the
//              optional native module `serialport` (prebuilt, no compiler needed).
//   "artnet" - Art-Net OpDmx over UDP to ARTNET_HOST / ARTNET_UNIVERSE (any node).
//   "none"   - nothing is sent.
//
// SAFETY: frames are sent continuously (DMX is a refresh protocol), so a blackout
// is just the next all-zero frame. On stop/quit we send a final zero frame.

const dmx = require("./dmx");

let SerialPort = null;
try { ({ SerialPort } = require("serialport")); } catch { /* optional dependency */ }

const ZERO = new Uint8Array(512);

function create(opts) {
  const o = opts || {};
  const status = { output: "none", port: "", connected: false, error: "", serial: !!SerialPort };
  let port = null;
  let retry = null;
  let wantPath = "";
  let onChange = () => {};
  let artnetSend = null;

  const set = (patch) => {
    let changed = false;
    for (const [k, v] of Object.entries(patch)) if (status[k] !== v) { status[k] = v; changed = true; }
    if (changed) onChange({ ...status });
  };

  async function listPorts() {
    if (!SerialPort) return [];
    try {
      const all = await SerialPort.list();
      return all.map((p) => ({
        path: p.path,
        label: `${p.path}${p.manufacturer ? " · " + p.manufacturer : ""}${p.vendorId ? ` (${p.vendorId}:${p.productId})` : ""}`,
        enttec: p.vendorId === "0403" || /enttec|ftdi/i.test(p.manufacturer || "")
      }));
    } catch { return []; }
  }

  function closePort() {
    clearTimeout(retry); retry = null;
    const p = port; port = null;
    if (p) { p.removeAllListeners(); try { if (p.isOpen) p.close(() => {}); } catch {} }
    set({ connected: false });
  }

  async function openEnttec() {
    if (!SerialPort) return set({ connected: false, error: "serialport module not installed (npm install)" });
    let path = wantPath;
    if (!path) {
      const found = (await listPorts()).find((p) => p.enttec);
      if (!found) { set({ connected: false, port: "", error: "No ENTTEC USB DMX found - plug it in (or pick a COM port)" }); return scheduleRetry(); }
      path = found.path;
    }
    const p = new SerialPort({ path, baudRate: 57600, autoOpen: false });
    port = p;
    p.on("error", (e) => { set({ connected: false, error: e.message }); });
    p.on("close", () => { if (port === p) { port = null; set({ connected: false, error: "DMX interface disconnected" }); scheduleRetry(); } });
    p.open((err) => {
      if (err) { if (port === p) port = null; set({ connected: false, port: path, error: err.message }); return scheduleRetry(); }
      set({ connected: true, port: path, error: "" });
    });
  }
  function scheduleRetry() {
    clearTimeout(retry);
    if (status.output !== "enttec") return;
    retry = setTimeout(() => { if (status.output === "enttec" && !port) openEnttec(); }, 2000);
  }

  return {
    status: () => ({ ...status }),
    listPorts,
    onChange(fn) { onChange = fn; },
    // Provide the UDP sender for Art-Net mode: (buffer) => void
    setArtnetSender(fn) { artnetSend = fn; },
    // Choose the transport. `path` "" = auto-detect an ENTTEC.
    configure(output, path) {
      const mode = ["none", "enttec", "artnet"].includes(output) ? output : "none";
      closePort();
      wantPath = String(path || "");
      set({ output: mode, port: wantPath, error: "", connected: mode === "artnet" });
      if (mode === "enttec") openEnttec();
    },
    send(frame) {
      if (status.output === "artnet" && artnetSend) { artnetSend(dmx.artnetPacket(o.universe || 0, frame)); return; }
      if (status.output !== "enttec" || !port || !port.isOpen) return;
      if (port.writableLength > 4096) return; // drop a frame rather than build latency
      port.write(dmx.enttecPacket(frame));
    },
    // Final all-zero frame, then close. Safe to call more than once.
    stop(cb) {
      try {
        if (status.output === "enttec" && port && port.isOpen) {
          port.write(dmx.enttecPacket(ZERO), () => { closePort(); cb && cb(); });
          setTimeout(() => { closePort(); cb && cb(); }, 400);
          return;
        }
        if (status.output === "artnet" && artnetSend) artnetSend(dmx.artnetPacket(o.universe || 0, ZERO));
      } catch {}
      closePort(); cb && cb();
    }
  };
}

module.exports = { create };
