const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("showControl", {
  command: (patch) => ipcRenderer.send("show:command", patch),
  openProjector: () => ipcRenderer.send("projector:open"),
  onState: (callback) => ipcRenderer.on("show:state", (_, state) => callback(state)),
  onRemoteAddress: (callback) => ipcRenderer.on("remote:address", (_, address) => callback(address)),
  getState: () => ipcRenderer.invoke("show:get"),
  saveShow: () => ipcRenderer.invoke("show:save"),
  loadShow: () => ipcRenderer.invoke("show:load"),
  // Projection mapping (projector receives; operator/editor sets).
  onMapping: (callback) => ipcRenderer.on("show:mapping", (_, mapping) => callback(mapping)),
  setMapping: (mapping) => ipcRenderer.send("mapping:set", mapping),
  getMapping: () => ipcRenderer.invoke("mapping:get"),
  openMapping: () => ipcRenderer.send("mapping:open"),
  openArFilter: () => ipcRenderer.send("arfilter:open"),
  // AR: live body-tracked quad drives any surface flagged track:true.
  arQuad: (quad) => ipcRenderer.send("ar:quad", quad),
  // Sound-reactive engine (operator window emits audio-driven commands).
  sound: (cmd) => ipcRenderer.send("sound:command", cmd),
  // Clip deck (layers x columns). The operator edits/triggers; the projector renders.
  deckOp: (op) => ipcRenderer.send("deck:op", op),
  getDeck: () => ipcRenderer.invoke("deck:get"),
  onDeck: (callback) => ipcRenderer.on("show:deck", (_, deck) => callback(deck)),
  // Audio features for the compositor (operator -> main -> projector). Visual only.
  audio: (features) => ipcRenderer.send("deck:audio", features),
  onAudio: (callback) => ipcRenderer.on("show:audio", (_, features) => callback(features)),
  // Absolute path of a file chosen in an <input type=file> (Electron >= 32).
  pathForFile: (file) => webUtils.getPathForFile(file),
  // DMX interface + audience-light patch helpers (local operator).
  getDmx: () => ipcRenderer.invoke("dmx:get"),
  setDmx: (prefs) => ipcRenderer.invoke("dmx:set", prefs),
  identifyFixture: (id) => ipcRenderer.send("dmx:identify", id),
  // Streaming / OBS + captures.
  obs: (cmd) => ipcRenderer.send("obs:command", cmd),
  onObsStatus: (callback) => ipcRenderer.on("obs:status", (_, s) => callback(s)),
  getObsStatus: () => ipcRenderer.invoke("obs:get"),
  getStreamUrl: () => ipcRenderer.invoke("stream:get"),
  capture: () => ipcRenderer.invoke("capture")
});
