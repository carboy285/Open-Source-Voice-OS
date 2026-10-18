// Sandboxed preload (must be CommonJS). Exposes only the few channels the recorder and overlay pages need.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("voiceos", {
  onRecorderStart: (callback) => ipcRenderer.on("recorder:start", () => callback()),
  onRecorderStop: (callback) => ipcRenderer.on("recorder:stop", () => callback()),
  onRecorderCancel: (callback) => ipcRenderer.on("recorder:cancel", () => callback()),
  sendAudio: (samples, sampleRate) => ipcRenderer.send("recorder:audio", { samples, sampleRate }),
  sendRecorderError: (message) => ipcRenderer.send("recorder:error", message),
  onOverlay: (callback) => ipcRenderer.on("overlay:update", (_event, update) => callback(update)),
});
