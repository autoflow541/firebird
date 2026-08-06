const { app, BrowserWindow, ipcMain, screen, session, dialog } = require("electron");
const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");
const net = require("net");
const dgram = require("dgram");
const crypto = require("crypto");

const { config } = require("./config");
const engine = require("./engine");
const obs = require("./obs");
const link = require("./link");

let controlWindow;
let projectorWindow;
let mappingWindow;
let server;
let blaizeSocket;
let blaizeRetry;
let abletonOsc;
let abletonTimer;
const clients = new Set();

// Per-session control token. Regenerated every launch; printed to the console and
// shown (with a QR) in the operator window. Every /command and /events request
// must present it. This is what keeps the LAN control surface from being an
// unauthenticated open endpoint.
const CONTROL_TOKEN = crypto.randomBytes(18).toString("base64url");

let state = engine.initialState();
state.clockSource = config.CLOCK_SOURCE;
state.blaize.host = config.BLAIZE_HOST;
state.blaize.port = config.BLAIZE_PORT;
state.ableton.port = config.OSC_PORT;
state.ableton.feedbackPort = config.OSC_FEEDBACK_PORT;
state.laser.enabled = config.LASER_ENABLED;
state.laser.requireInterlock = config.LASER_REQUIRE_INTERLOCK;
state.laser.output = ["none", "dmx", "ilda", "shownet"].includes(config.LASER_OUTPUT) ? config.LASER_OUTPUT : "none";

let artnetSocket; // created at boot for the DMX laser transport

// Last values actually sent to Blaize, so we only transmit deltas — except the
// blackout channel, which we RE-ASSERT every heartbeat so a single dropped TCP
// write can never leave the rig lit while blackout is engaged.
let lastBlaize = { channels: {}, preset: null };

// Projection mapping (surfaces corner-pinned onto real-world quads). Loaded from
// firebird.mapping.json if present; edited via the mapping editor; pushed to the
// projector window. Not safety-critical (blackout still blanks the projector).
let mapping = loadMapping();

function mappingFile() { return path.join(__dirname, "..", "firebird.mapping.json"); }
function loadMapping() {
  try {
    if (fs.existsSync(mappingFile())) return JSON.parse(fs.readFileSync(mappingFile(), "utf8"));
  } catch (error) { console.warn("[mapping] ignoring invalid firebird.mapping.json:", error.message); }
  return { surfaces: [] };
}
function saveMapping() {
  try { fs.writeFileSync(mappingFile(), JSON.stringify(mapping, null, 2)); }
  catch (error) { console.error("[mapping] save failed:", error.message); }
}
function pushMapping() { projectorWindow?.webContents.send("show:mapping", mapping); }

function localAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family === "IPv4" && !item.internal) return item.address;
    }
  }
  return "localhost";
}

function remoteUrl() {
  return `http://${localAddress()}:${config.CONTROL_PORT}/?t=${CONTROL_TOKEN}`;
}

// OBS Browser Source URL (add &bg=1 for a full moving background layer).
function streamUrl() {
  return `http://${localAddress()}:${config.CONTROL_PORT}/stream?t=${CONTROL_TOKEN}`;
}

// OBS control (non-safety). Accepts commands from the operator (IPC) and Ableton
// (OSC). Never touches blackout or the laser.
function handleObs(cmd) {
  switch (cmd && cmd.op) {
    case "connect": return obs.connect(config.OBS_URL, config.OBS_PASSWORD);
    case "disconnect": return obs.disconnect();
    case "toggleStream": return obs.toggleStream();
    case "startStream": return obs.startStream();
    case "stopStream": return obs.stopStream();
    case "toggleRecord": return obs.toggleRecord();
    case "startRecord": return obs.startRecord();
    case "stopRecord": return obs.stopRecord();
    case "scene": return obs.setScene(cmd.value);
    default: return undefined;
  }
}

// Save a PNG capture of the projector output (or the operator window as fallback).
async function captureProjector() {
  const target = (projectorWindow && !projectorWindow.isDestroyed()) ? projectorWindow : controlWindow;
  if (!target) return null;
  const image = await target.webContents.capturePage();
  const dir = path.join(__dirname, "..", "captures");
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const file = path.join(dir, `firebird-${Date.now()}.png`);
  fs.writeFileSync(file, image.toPNG());
  return file;
}

// ---------------------------------------------------------------------------
// Command dispatch: everything funnels through here, then re-derives outputs.
// ---------------------------------------------------------------------------
function dispatch(cmd) {
  const log = engine.applyCommand(state, cmd, config);
  for (const line of log) console.warn("[safety]", line);
  if (cmd.action === "bpm") link.setBpm(state.bpm); // push manual/tap tempo to Link peers
  pushOutputs();
  broadcast();
}

function broadcast() {
  controlWindow?.webContents.send("show:state", state);
  projectorWindow?.webContents.send("show:state", state);
  const payload = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const response of clients) response.write(payload);
  sendAbletonFeedback();
  sendDepthFX();
}

// The remote/web surface gets a trimmed view — no laser internals, no fixtures it
// can't drive. Defense in depth; the token already gates access.
function publicState() {
  return {
    scene: state.scene, blackout: state.blackout, playing: state.playing,
    song: state.song, bpm: state.bpm, beat: state.beat, elapsed: state.elapsed,
    master: state.master, blaize: { preset: state.blaize.preset }
  };
}

// ---------------------------------------------------------------------------
// OUTPUT GATE -> hardware. deriveOutputs() has already forced everything safe if
// blackout is engaged; here we only transmit.
// ---------------------------------------------------------------------------
function pushOutputs() {
  const out = engine.deriveOutputs(state);
  // Blaize: send changed channels; always re-assert the blackout channel.
  for (const [ch, value] of Object.entries(out.blaizeChannels)) {
    const chNum = Number(ch);
    if (chNum === engine.BLAIZE_BLACKOUT_CH || lastBlaize.channels[ch] !== value) {
      sendBlaize(`C${chNum}V${value}`);
    }
  }
  if (out.blaizePreset !== null && out.blaizePreset !== lastBlaize.preset) {
    sendBlaize(`C${out.blaizePreset}V0`);
  }
  lastBlaize = { channels: { ...out.blaizeChannels }, preset: out.blaizePreset ?? lastBlaize.preset };
  // Projector blanking is driven by state.blackout in projector.js via broadcast.
  sendLaser(out.laser);
  // DMX/Art-Net for conventional fixtures (out.master) attaches here in the
  // hardware build. Until then it is modeled but not energized.
}

// ---------------------------------------------------------------------------
// LASER OUTPUT ROUTER. `laser.emit` is the single authority on whether a beam
// may energize (blackout/disarm/interlock/no-output all force it false in the
// engine gate). Every transport is driven to its SAFE state (blanked / zeros)
// whenever emit is false, and we assert the safe state on every heartbeat so a
// dropped packet self-heals.
// ---------------------------------------------------------------------------
function sendLaser(laser) {
  // Only the chosen transport goes active; the others are held safe (blanked/zero)
  // so a previously-armed transport can't stay lit. ILDA and ShowNET both drive an
  // external DAC / laser software (Showeditor / Beyond) via the bridge — Firebird
  // stays the arm + blackout master while that software renders the frames.
  const dacActive = (laser.output === "ilda" || laser.output === "shownet") && laser.emit;
  sendArtNetLaser(laser.output === "dmx" && laser.emit, laser.fx);
  sendDacBridge(dacActive, laser.fx);
}

function artnetPacket(universe, data) {
  const header = Buffer.alloc(18);
  header.write("Art-Net\0", 0, "latin1");
  header.writeUInt16LE(0x5000, 8);       // OpDmx
  header.writeUInt16BE(14, 10);          // protocol version
  header[12] = 0;                        // sequence (0 = disabled)
  header[13] = 0;                        // physical
  header.writeUInt16LE(universe, 14);    // 15-bit port address, little-endian
  header.writeUInt16BE(data.length, 16); // slot count, big-endian
  return Buffer.concat([header, data]);
}

function sendArtNetLaser(emit, fx) {
  if (!artnetSocket) return;
  const data = Buffer.alloc(512); // all zeros = blanked / shutter closed
  if (emit) {
    const base = Math.max(0, (config.LASER_DMX_ADDRESS || 1) - 1);
    (config.LASER_DMX_ARMED || []).forEach((v, i) => {
      if (base + i < 512) data[base + i] = Number(v) & 255;
    });
    // Sound-driven intensity on a configured channel (from the DS-1000RGB DMX
    // chart). 0 = unset; wire once the chart's dimmer/intensity channel is known.
    if (config.LASER_DMX_INTENSITY_CH > 0) {
      data[config.LASER_DMX_INTENSITY_CH - 1] = Math.round(Math.max(0, Math.min(100, fx || 0)) / 100 * 255);
    }
  }
  artnetSocket.send(artnetPacket(config.ARTNET_UNIVERSE, data), 6454, config.ARTNET_HOST, () => {});
}

// Drives an external ILDA DAC / laser software (Showeditor, Beyond) — used by both
// the ILDA and ShowNET output modes. emit=1 permits output; blank=1 forces blank.
function sendDacBridge(emit, fx) {
  if (!abletonOsc) return;
  const host = config.ILDA_BRIDGE_HOST;
  const port = config.ILDA_BRIDGE_PORT;
  abletonOsc.send(makeOsc("/laser/emit", "i", emit ? 1 : 0), port, host, () => {});
  abletonOsc.send(makeOsc("/laser/blank", "i", emit ? 0 : 1), port, host, () => {});
  abletonOsc.send(makeOsc("/laser/energy", "f", emit ? (fx || 0) / 100 : 0), port, host, () => {});
}

// On (re)connect to Blaize, flush the FULL desired state so the visual engine
// matches Firebird even after a mid-show restart.
function flushBlaize() {
  lastBlaize = { channels: {}, preset: null };
  pushOutputs();
}

// ---------------------------------------------------------------------------
// OSC (Ableton clock)
// ---------------------------------------------------------------------------
function oscString(value) {
  const raw = Buffer.from(`${value}\0`, "utf8");
  return Buffer.concat([raw, Buffer.alloc((4 - (raw.length % 4)) % 4)]);
}

function makeOsc(address, tag, value) {
  const parts = [oscString(address), oscString(`,${tag}`)];
  if (tag === "i") { const d = Buffer.alloc(4); d.writeInt32BE(Math.round(Number(value) || 0)); parts.push(d); }
  else if (tag === "f") { const d = Buffer.alloc(4); d.writeFloatBE(Number(value) || 0); parts.push(d); }
  else if (tag === "s") parts.push(oscString(value));
  return Buffer.concat(parts);
}

function makeOscFloats(address, values) {
  const parts = [oscString(address), oscString("," + "f".repeat(values.length))];
  for (const v of values) { const d = Buffer.alloc(4); d.writeFloatBE(Number(v) || 0); parts.push(d); }
  return Buffer.concat(parts);
}

function sendAbletonFeedback() {
  if (!abletonOsc) return;
  const host = config.OSC_FEEDBACK_HOST; // fixed by config, never learned from senders
  const port = config.OSC_FEEDBACK_PORT;
  const messages = [
    ["/firebird/status/scene", "s", state.scene],
    ["/firebird/status/blackout", "i", state.blackout ? 1 : 0],
    ["/firebird/status/playing", "i", state.playing ? 1 : 0],
    ["/firebird/status/bpm", "f", state.bpm],
    ["/firebird/status/position", "f", state.elapsed],
    ["/firebird/status/preset", "i", state.blaize.preset]
  ];
  for (const [address, tag, value] of messages) {
    abletonOsc.send(makeOsc(address, tag, value), port, host, () => {});
  }
}

// Control OSC to the Kinect depth-FX sketch (visuals/FirebirdDepthFX). Sent on
// every broadcast so blackout blanks the layer and params stay in sync. Idempotent.
function sendDepthFX() {
  if (!abletonOsc) return;
  const host = config.DEPTHFX_HOST;
  const port = config.DEPTHFX_PORT;
  const d = state.depthfx;
  const messages = [
    ["/depthfx/blackout", "i", state.blackout ? 1 : 0],
    ["/depthfx/enabled", "i", d.enabled ? 1 : 0],
    ["/depthfx/trails", "f", d.trails],
    ["/depthfx/colorspeed", "f", d.colorSpeed],
    ["/depthfx/near", "f", d.near],
    ["/depthfx/far", "f", d.far],
    ["/depthfx/mirror", "i", d.mirror ? 1 : 0]
  ];
  for (const [address, tag, value] of messages) {
    abletonOsc.send(makeOsc(address, tag, value), port, host, () => {});
  }
  // Projection-mapping link: if a mapped surface uses the Kinect depth-FX source,
  // forward its quad (normalized, TL,TR,BL,BR) so the sketch warps its silhouette
  // + tracers onto that real surface instead of filling the screen.
  const ds = (mapping.surfaces || []).find((s) => s.source === "depthfx" && s.corners && s.corners.length === 4);
  abletonOsc.send(makeOsc("/depthfx/mapped", "i", ds ? 1 : 0), port, host, () => {});
  if (ds) {
    const q = [];
    for (const c of ds.corners) q.push(c.x, c.y);
    abletonOsc.send(makeOscFloats("/depthfx/quad", q), port, host, () => {});
  }
}

function readOscString(buffer, offset = 0) {
  const end = buffer.indexOf(0, offset);
  if (end < 0) return null;
  return { value: buffer.toString("utf8", offset, end), next: Math.ceil((end + 1) / 4) * 4 };
}

function parseOsc(buffer) {
  const address = readOscString(buffer);
  if (!address) return null;
  const tags = readOscString(buffer, address.next);
  if (!tags?.value.startsWith(",")) return null;
  let offset = tags.next;
  const values = [];
  for (const tag of tags.value.slice(1)) {
    if (tag === "i" && offset + 4 <= buffer.length) { values.push(buffer.readInt32BE(offset)); offset += 4; }
    else if (tag === "f" && offset + 4 <= buffer.length) { values.push(buffer.readFloatBE(offset)); offset += 4; }
    else if (tag === "s") { const item = readOscString(buffer, offset); if (!item) break; values.push(item.value); offset = item.next; }
    else if (tag === "T") values.push(true);
    else if (tag === "F") values.push(false);
  }
  return { address: address.value, values };
}

function handleAbletonOsc(message, remote) {
  const osc = parseOsc(message);
  if (!osc) return;
  state.ableton.connected = true;
  state.ableton.host = remote.address;
  state.ableton.lastMessage = `${osc.address} ${osc.values.join(" ")}`.trim();
  state.ableton.lastSeen = Date.now();
  clearTimeout(abletonTimer);
  abletonTimer = setTimeout(() => {
    state.ableton.connected = false;
    state.ableton.lastMessage = "Ableton timed out";
    broadcast();
  }, 5000);

  const value = osc.values[0];
  const osrc = { source: "osc" };
  if (osc.address === "/note") {
    const note = Number(value);
    const velocity = Number(osc.values[1] || 0);
    if (note >= 0 && note <= 31) dispatch({ action: "visual", key: "preset", value: note, ...osrc });
    else if (note === 36) dispatch({ action: "visual", key: "multicolor", value: velocity > 64, ...osrc });
    else if (note === 37) dispatch({ action: "blackout", value: velocity > 64, ...osrc });
  } else if (osc.address === "/firebird/scene") {
    const scene = typeof value === "number" ? engine.SCENES[value] : String(value).toUpperCase();
    if (engine.SCENES.includes(scene)) dispatch({ action: "scene", value: scene, ...osrc });
  } else if (osc.address === "/firebird/blackout") {
    dispatch({ action: "blackout", value: Boolean(value), ...osrc });
  } else if (osc.address === "/firebird/bpm") {
    dispatch({ action: "bpm", value, ...osrc });
  } else if (osc.address === "/firebird/transport") {
    dispatch({ action: "transport", value: Boolean(value), ...osrc });
  } else if (osc.address === "/firebird/position") {
    // Ableton is the clock: drive elapsed/beat directly from transport position.
    state.elapsed = Math.max(0, Number(value) || 0);
    state.beat = (Math.floor(state.elapsed / (60 / state.bpm)) % 4) + 1;
    broadcast();
  } else if (osc.address === "/firebird/beat") {
    state.beat = ((Number(value) - 1) % 4 + 4) % 4 + 1;
    broadcast();
  } else if (osc.address === "/firebird/go") {
    dispatch({ action: "stepCue", value: 1, ...osrc });
  } else if (osc.address === "/firebird/back") {
    dispatch({ action: "stepCue", value: -1, ...osrc });
  } else if (osc.address === "/firebird/panic") {
    dispatch({ action: "panic", ...osrc });
  } else if (osc.address === "/firebird/song") {
    state.song = String(value || "Firebird");
    broadcast();
  } else if (osc.address === "/firebird/preset") {
    dispatch({ action: "visual", key: "preset", value, ...osrc });
  } else if (["/speed", "/size", "/brightness", "/strobing", "/shading"].includes(osc.address)) {
    const legacy = { "/speed": "speed", "/size": "size", "/brightness": "brightness", "/strobing": "strobe", "/shading": "shading" };
    dispatch({ action: "visual", key: legacy[osc.address], value: Number(value) <= 1 ? Number(value) * 100 : value, ...osrc });
  } else if (osc.address.startsWith("/firebird/visual/")) {
    dispatch({ action: "visual", key: osc.address.split("/").pop(), value, ...osrc });
  } else if (osc.address.startsWith("/firebird/depthfx/")) {
    dispatch({ action: "depthfx", key: osc.address.split("/").pop(), value, ...osrc });
  } else if (osc.address === "/firebird/obs/stream") {
    handleObs({ op: Boolean(value) ? "startStream" : "stopStream" });
  } else if (osc.address === "/firebird/obs/record") {
    handleObs({ op: Boolean(value) ? "startRecord" : "stopRecord" });
  } else if (osc.address === "/firebird/obs/scene") {
    handleObs({ op: "scene", value: String(value) });
  } else {
    broadcast();
  }
}

function startAbletonOsc() {
  abletonOsc = dgram.createSocket("udp4");
  abletonOsc.on("message", handleAbletonOsc);
  abletonOsc.on("error", (error) => {
    state.ableton.connected = false;
    state.ableton.lastMessage = `OSC error: ${error.code || error.message}`;
    broadcast();
  });
  // Bind to loopback by default (Ableton is on this machine). Set OSC_BIND to the
  // LAN IP only if Ableton runs on another host on a trusted network.
  abletonOsc.bind(config.OSC_PORT, config.OSC_BIND);
}

// ---------------------------------------------------------------------------
// Blaize TCP bridge (protocol per vendor/Blaize_V3_PWFB/tcp_notes.txt)
// ---------------------------------------------------------------------------
function sendBlaize(message) {
  if (blaizeSocket?.readyState === "open") blaizeSocket.write(`${message}\n`);
}

function connectBlaize() {
  clearTimeout(blaizeRetry);
  blaizeSocket?.destroy();
  blaizeSocket = net.createConnection({ host: config.BLAIZE_HOST, port: config.BLAIZE_PORT });
  blaizeSocket.setTimeout(3000);
  blaizeSocket.on("connect", () => {
    state.blaize.connected = true;
    blaizeSocket.setTimeout(0);
    flushBlaize(); // re-assert full desired state (incl. blackout) after reconnect
    broadcast();
  });
  const disconnected = () => {
    if (state.blaize.connected) { state.blaize.connected = false; broadcast(); }
    clearTimeout(blaizeRetry);
    blaizeRetry = setTimeout(connectBlaize, 2500);
  };
  blaizeSocket.on("error", () => {});
  blaizeSocket.on("close", disconnected);
  blaizeSocket.on("timeout", () => blaizeSocket.destroy());
}

// ---------------------------------------------------------------------------
// Control server (LAN, token-gated, DNS-rebind protected)
// ---------------------------------------------------------------------------
function serveFile(response, file, type) {
  fs.readFile(file, (error, data) => {
    if (error) { response.writeHead(404); return response.end("Not found"); }
    response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    response.end(data);
  });
}

function tokenOf(request, url) {
  return request.headers["x-firebird-token"] || url.searchParams.get("t") || "";
}

function tokenOk(request, url) {
  const provided = Buffer.from(String(tokenOf(request, url)));
  const expected = Buffer.from(CONTROL_TOKEN);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

// Reject requests whose Host header is a domain name (only bare IPs / localhost
// are legitimate for a LAN device). This blocks DNS-rebinding, where a malicious
// site resolves its own domain to this machine's IP to reach the control server.
function hostOk(request) {
  const host = String(request.headers.host || "").split(":")[0];
  return host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === "[::1]" || host === "";
}

function startControlServer() {
  server = http.createServer((request, response) => {
    if (!hostOk(request)) { response.writeHead(400); return response.end("Bad host"); }
    const url = new URL(request.url, "http://localhost");

    if (url.pathname === "/events") {
      if (!tokenOk(request, url)) { response.writeHead(401); return response.end("Unauthorized"); }
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      clients.add(response);
      response.write(`data: ${JSON.stringify(publicState())}\n\n`);
      request.on("close", () => clients.delete(response));
      return;
    }

    if (url.pathname === "/command" && request.method === "POST") {
      if (!tokenOk(request, url)) { response.writeHead(401); return response.end("Unauthorized"); }
      let body = "";
      let tooBig = false;
      request.on("data", (chunk) => {
        body += chunk;
        if (body.length > config.MAX_COMMAND_BYTES) { tooBig = true; request.destroy(); }
      });
      request.on("end", () => {
        if (tooBig) return;
        try {
          const cmd = JSON.parse(body);
          // Remote surface is a control surface, not an operator console: it may
          // never arm the laser or reach fixtures directly.
          if (cmd.action === "laser") { response.writeHead(403); return response.end(); }
          dispatch({ ...cmd, source: "remote" });
        } catch {}
        response.writeHead(204);
        response.end();
      });
      return;
    }

    // Projection mapping data (token-gated). GET returns current mapping; POST
    // (from the phone editor) replaces it and pushes to the projector.
    if (url.pathname === "/mapping") {
      if (!tokenOk(request, url)) { response.writeHead(401); return response.end("Unauthorized"); }
      if (request.method === "POST") {
        let body = "", tooBig = false;
        request.on("data", (c) => { body += c; if (body.length > 200000) { tooBig = true; request.destroy(); } });
        request.on("end", () => {
          if (tooBig) return;
          try { const next = JSON.parse(body); mapping = next && Array.isArray(next.surfaces) ? next : { surfaces: [] }; saveMapping(); pushMapping(); } catch {}
          response.writeHead(204); response.end();
        });
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return response.end(JSON.stringify(mapping));
    }

    // Static assets are UNGATED (they hold no secrets). The token gates /command
    // and /events — the real control + live-state boundaries — so loading the
    // page HTML/JS without a token reveals nothing actionable. This also lets each
    // page load its own script, and lets OBS load /stream as a Browser Source.
    if (url.pathname === "/stream" || url.pathname === "/stream.html") return serveFile(response, path.join(__dirname, "stream.html"), "text/html");
    if (url.pathname === "/stream.js") return serveFile(response, path.join(__dirname, "stream.js"), "text/javascript");
    if (url.pathname === "/map" || url.pathname === "/mapping.html") return serveFile(response, path.join(__dirname, "mapping.html"), "text/html");
    if (url.pathname === "/mapping.js") return serveFile(response, path.join(__dirname, "mapping.js"), "text/javascript");
    if (url.pathname === "/ar" || url.pathname === "/ar-filter.html") return serveFile(response, path.join(__dirname, "ar-filter.html"), "text/html");
    if (url.pathname === "/ar-filter.js") return serveFile(response, path.join(__dirname, "ar-filter.js"), "text/javascript");
    if (url.pathname === "/armap.js") return serveFile(response, path.join(__dirname, "armap.js"), "text/javascript");
    if (url.pathname === "/remote.js") return serveFile(response, path.join(__dirname, "remote.js"), "text/javascript");
    if (url.pathname === "/styles.css") return serveFile(response, path.join(__dirname, "styles.css"), "text/css");
    return serveFile(response, path.join(__dirname, "remote.html"), "text/html");
  });

  server.on("error", (error) => console.error("[control] server error:", error.message));
  server.listen(config.CONTROL_PORT, config.CONTROL_BIND, () => {
    console.log(`[control] LAN remote: ${remoteUrl()}`);
    controlWindow?.webContents.send("remote:address", remoteUrl());
  });
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function createWindows() {
  controlWindow = new BrowserWindow({
    width: 1500, height: 950, minWidth: 1160, minHeight: 760,
    backgroundColor: "#08090d",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#08090d", symbolColor: "#a9aab3", height: 38 },
    webPreferences: { preload: path.join(__dirname, "preload.js") }
  });
  controlWindow.loadFile(path.join(__dirname, "index.html"));
  controlWindow.webContents.on("did-finish-load", () => {
    controlWindow.webContents.send("show:state", state);
    if (server?.listening) controlWindow.webContents.send("remote:address", remoteUrl());
  });
}

function openProjector() {
  if (projectorWindow && !projectorWindow.isDestroyed()) return projectorWindow.focus();
  const displays = screen.getAllDisplays();
  const target = displays.find((d) => d.id !== screen.getPrimaryDisplay().id) || displays[0];
  projectorWindow = new BrowserWindow({
    x: target.bounds.x, y: target.bounds.y, width: target.bounds.width, height: target.bounds.height,
    frame: false, fullscreen: displays.length > 1, backgroundColor: "#000000",
    webPreferences: { preload: path.join(__dirname, "preload.js") }
  });
  projectorWindow.loadFile(path.join(__dirname, "projector.html"));
  projectorWindow.webContents.on("did-finish-load", () => {
    projectorWindow.webContents.send("show:state", state);
    pushMapping();
  });
  projectorWindow.on("closed", () => (projectorWindow = null));
}

function openMappingEditor() {
  if (mappingWindow && !mappingWindow.isDestroyed()) return mappingWindow.focus();
  mappingWindow = new BrowserWindow({
    width: 1180, height: 820, backgroundColor: "#0a0b0f",
    webPreferences: { preload: path.join(__dirname, "preload.js") }
  });
  mappingWindow.loadFile(path.join(__dirname, "mapping.html"));
  mappingWindow.on("closed", () => (mappingWindow = null));
}

let arFilterWindow;
function openArFilter() {
  if (arFilterWindow && !arFilterWindow.isDestroyed()) return arFilterWindow.focus();
  arFilterWindow = new BrowserWindow({
    width: 1000, height: 640, backgroundColor: "#000000",
    webPreferences: { preload: path.join(__dirname, "preload.js") }
  });
  arFilterWindow.loadFile(path.join(__dirname, "ar-filter.html"));
  arFilterWindow.on("closed", () => (arFilterWindow = null));
}

// IPC from the operator console is trusted as the LOCAL operator.
ipcMain.on("show:command", (_, patch) => dispatch({ ...patch, source: "local" }));
ipcMain.on("projector:open", openProjector);
ipcMain.on("mapping:open", openMappingEditor);
ipcMain.on("arfilter:open", openArFilter);
ipcMain.handle("show:get", () => state);
ipcMain.handle("remote:get", () => remoteUrl());
ipcMain.on("mapping:set", (_, next) => {
  mapping = next && Array.isArray(next.surfaces) ? next : { surfaces: [] };
  saveMapping();
  pushMapping();
});
ipcMain.handle("mapping:get", () => mapping);
ipcMain.on("ar:quad", (_, quad) => {
  // Live body-tracking: drive every surface flagged track:true to the tracked
  // quad and push to the projector. Not saved to disk (it's per-frame).
  if (!quad || quad.length !== 4) return;
  let changed = false;
  for (const s of mapping.surfaces || []) {
    if (s.track) { s.corners = quad.map((c) => ({ x: c.x, y: c.y })); changed = true; }
  }
  if (changed) pushMapping();
});
ipcMain.handle("show:save", async () => {
  const res = await dialog.showSaveDialog(controlWindow, {
    title: "Save show", defaultPath: path.join(__dirname, "..", "shows", `${state.song || "show"}.json`),
    filters: [{ name: "Firebird Show", extensions: ["json"] }]
  });
  if (res.canceled || !res.filePath) return null;
  try {
    fs.mkdirSync(path.dirname(res.filePath), { recursive: true });
    fs.writeFileSync(res.filePath, JSON.stringify(engine.exportShow(state), null, 2));
    return path.basename(res.filePath);
  } catch (error) { return { error: error.message }; }
});
ipcMain.handle("show:load", async () => {
  const res = await dialog.showOpenDialog(controlWindow, {
    title: "Load show", properties: ["openFile"], filters: [{ name: "Firebird Show", extensions: ["json"] }]
  });
  if (res.canceled || !res.filePaths[0]) return null;
  try {
    engine.loadShow(state, JSON.parse(fs.readFileSync(res.filePaths[0], "utf8")));
    pushOutputs();
    broadcast();
    return path.basename(res.filePaths[0]);
  } catch (error) { return { error: error.message }; }
});
ipcMain.on("sound:command", (_, cmd) => dispatch({ ...cmd, source: "sound" }));
ipcMain.on("obs:command", (_, cmd) => handleObs(cmd));
ipcMain.handle("obs:get", () => obs.getStatus());
ipcMain.handle("stream:get", () => streamUrl());
ipcMain.handle("capture", async () => { try { return await captureProjector(); } catch (error) { return null; } });

app.whenReady().then(() => {
  console.log(`\n  FIREBIRD control token: ${CONTROL_TOKEN}\n  Remote (LAN only): ${remoteUrl()}\n`);
  // Allow the operator window to use the mic/line-in for the sound-reactive engine.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "media" || permission === "midi"));
  createWindows();
  startControlServer();
  connectBlaize();
  startAbletonOsc();
  artnetSocket = dgram.createSocket("udp4");
  artnetSocket.on("error", (error) => console.error("[artnet] socket error:", error.message));
  obs.setOnStatus((s) => controlWindow?.webContents.send("obs:status", s));
  if (config.OBS_AUTOCONNECT) obs.connect(config.OBS_URL, config.OBS_PASSWORD);
  // Ableton Link (optional native): when a peer changes tempo, follow it.
  state.ableton.link = link.start(config, (bpm) => {
    state.bpm = engine.clamp(bpm, 30, 300);
    state.ableton.link = link.getStatus();
    broadcast();
  });
  pushOutputs();
  // Heartbeat: advances the internal clock ONLY in internal mode, and re-asserts
  // outputs so a dropped Blaize write / a re-latched blackout self-heals.
  setInterval(() => {
    engine.tickInternalClock(state, 0.25);
    pushOutputs();
    if (state.clockSource === "internal" && state.playing) broadcast();
  }, 250);
});

app.on("window-all-closed", () => {
  clearTimeout(blaizeRetry);
  blaizeSocket?.destroy();
  abletonOsc?.close();
  artnetSocket?.close();
  clearTimeout(abletonTimer);
  server?.close();
  app.quit();
});
