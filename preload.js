const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("limittrack", {
  storageGet: (key) => ipcRenderer.invoke("storage:get", key),
  storageSet: (key, value) => ipcRenderer.invoke("storage:set", key, value),
  trayUpdate: (text) => ipcRenderer.send("tray:update", text),
});
