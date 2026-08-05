const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("showControl", {
  command: (patch) => ipcRenderer.send("show:command", patch),
  openProjector: () => ipcRenderer.send("projector:open"),
  onState: (callback) => ipcRenderer.on("show:state", (_, state) => callback(state)),
  onRemoteAddress: (callback) => ipcRenderer.on("remote:address", (_, address) => callback(address)),
  getState: () => ipcRenderer.invoke("show:get"),
  // Projection mapping (projector receives; operator/editor sets).
  onMapping: (callback) => ipcRenderer.on("show:mapping", (_, mapping) => callback(mapping)),
  setMapping: (mapping) => ipcRenderer.send("mapping:set", mapping),
  getMapping: () => ipcRenderer.invoke("mapping:get"),
  openMapping: () => ipcRenderer.send("mapping:open"),
  // AR: live body-tracked quad drives any surface flagged track:true.
  arQuad: (quad) => ipcRenderer.send("ar:quad", quad),
  // Sound-reactive engine (operator window emits audio-driven commands).
  sound: (cmd) => ipcRenderer.send("sound:command", cmd),
  // Streaming / OBS + captures.
  obs: (cmd) => ipcRenderer.send("obs:command", cmd),
  onObsStatus: (callback) => ipcRenderer.on("obs:status", (_, s) => callback(s)),
  getObsStatus: () => ipcRenderer.invoke("obs:get"),
  getStreamUrl: () => ipcRenderer.invoke("stream:get"),
  capture: () => ipcRenderer.invoke("capture")
});
