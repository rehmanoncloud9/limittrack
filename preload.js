const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("limittrack", {
  storageGet: (key) => ipcRenderer.invoke("storage:get", key),
  storageSet: (key, value) => ipcRenderer.invoke("storage:set", key, value),
  trayUpdate: (text) => ipcRenderer.send("tray:update", text),
  // Fired whenever any window (main or widget) writes to the store, so the
  // other window can reload and stay in sync.
  onStorageChanged: (callback) => {
    const listener = (event, key) => callback(key);
    ipcRenderer.on("storage:changed", listener);
    return () => ipcRenderer.removeListener("storage:changed", listener);
  },
  // Floating widget window controls (no-ops if called from the main window).
  widgetResize: (height) => ipcRenderer.send("widget:resize", height),
  widgetHide: () => ipcRenderer.send("widget:hide"),
  widgetOpenMain: () => ipcRenderer.send("widget:open-main"),
});
