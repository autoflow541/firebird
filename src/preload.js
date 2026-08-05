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
  getMapping: () => ipcRenderer.invoke("mapping:get")
});
