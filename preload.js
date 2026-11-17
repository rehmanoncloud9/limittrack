const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("limittrack", {
  platform: process.platform,
  stateGet: () => ipcRenderer.invoke("state:get"),
  stateCommit: (base, next, options) => ipcRenderer.invoke("state:commit", base, next, options),
  appInfo: () => ipcRenderer.invoke("app:info"),
  notificationsTest: () => ipcRenderer.invoke("notifications:test"),
  // Fired whenever any window (main or widget) writes to the store, so the
  // other window can reload and stay in sync.
  onStorageChanged: (callback) => {
    const listener = (event, key) => callback(key);
    ipcRenderer.on("storage:changed", listener);
    return () => ipcRenderer.removeListener("storage:changed", listener);
  },
  // Floating widget window controls (no-ops if called from the main window).
  widgetResize: (size) => ipcRenderer.send("widget:resize", size),
  // The widget receives a small pre-computed summary (counts per tool) instead of the account list.
  widgetSummaryGet: () => ipcRenderer.invoke("widget:summary-get"),
  onWidgetSummary: (callback) => {
    const listener = (event, summary) => callback(summary);
    ipcRenderer.on("widget:summary", listener);
    return () => ipcRenderer.removeListener("widget:summary", listener);
  },
  widgetToolMenu: () => ipcRenderer.send("widget:tool-menu"),
  widgetContextMenu: () => ipcRenderer.send("widget:context-menu"),
  widgetHide: () => ipcRenderer.send("widget:hide"),
  widgetConfigGet: () => ipcRenderer.invoke("widget:config-get"),
  widgetConfigSet: (config) => ipcRenderer.invoke("widget:config-set", config),
  widgetOpenMain: (accountId) => ipcRenderer.send("widget:open-main", accountId),
  preferencesGet: () => ipcRenderer.invoke("preferences:get"),
  preferencesUpdate: (patch) => ipcRenderer.invoke("preferences:update", patch),
  onPreferencesChanged: (callback) => {
    const listener = (event, value) => callback(value);
    ipcRenderer.on("preferences:changed", listener);
    return () => ipcRenderer.removeListener("preferences:changed", listener);
  },
  widgetOpenSettings: () => ipcRenderer.send("widget:open-settings"),
  // Custom title bar (Windows): ask the main process to pop up a native menu under a title-bar button.
  menuOpen: (name, x, y) => ipcRenderer.send("menu:open", name, x, y),
  onMenuAction: (callback) => {
    const listener = (event, name) => callback(name);
    ipcRenderer.on("menu:action", listener);
    return () => ipcRenderer.removeListener("menu:action", listener);
  },
  relaunch: () => ipcRenderer.invoke("app:relaunch"),
  onWidgetConfigure: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("widgets:configure", listener);
    return () => ipcRenderer.removeListener("widgets:configure", listener);
  },
  onAccountReveal: (callback) => {
    const listener = (event, accountId) => callback(accountId);
    ipcRenderer.on("account:reveal", listener);
    return () => ipcRenderer.removeListener("account:reveal", listener);
  },
});
