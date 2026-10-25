const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("voiceos", {
  onRecorderRequest: (callback) => ipcRenderer.on("recorder:request", (_event, request) => callback(request)),
  recorderReply: (reply) => ipcRenderer.send("recorder:reply", reply),
  onOverlay: (callback) => ipcRenderer.on("overlay:update", (_event, update) => callback(update)),
  overlaySize: (height) => ipcRenderer.send("overlay:size", height),
  overlayHover: (hovering) => ipcRenderer.send("overlay:hover", hovering),
  overlayAction: (name) => ipcRenderer.send("overlay:action", name),
  onPanel: (callback) => ipcRenderer.on("panel:update", (_event, update) => callback(update)),
  panel: (action, value) => ipcRenderer.invoke("panel:action", action, value),
});
