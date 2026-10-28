const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("limittrack", {
  stateGet: () => ipcRenderer.invoke("state:get"),
  stateCommit: (base, next, options) => ipcRenderer.invoke("state:commit", base, next, options),
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
  widgetConfigGet: () => ipcRenderer.invoke("widget:config-get"),
  widgetConfigSet: (config) => ipcRenderer.invoke("widget:config-set", config),
  widgetOpenMain: (accountId) => ipcRenderer.send("widget:open-main", accountId),
  onAccountReveal: (callback) => {
    const listener = (event, accountId) => callback(accountId);
    ipcRenderer.on("account:reveal", listener);
    return () => ipcRenderer.removeListener("account:reveal", listener);
  },
});
