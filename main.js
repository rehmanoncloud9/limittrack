const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require("electron");
const path = require("path");
const fs = require("fs");

const STORE_PATH = path.join(app.getPath("userData"), "limittrack-data.json");

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
  } catch (e) {
    return {};
  }
}

function writeStore(data) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

let mainWindow;
let tray;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    title: "LimitTrack",
    icon: path.join(__dirname, "icon.png"),
    backgroundColor: "#eff6ff",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile("index.html");

  // Links (e.g. the About modal) should open in the user's real browser,
  // not spawn a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Closing the window minimizes to tray instead of quitting,
  // so LimitTrack keeps tracking (and can still notify you) in the background.
  mainWindow.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const trayIcon = nativeImage.createFromPath(path.join(__dirname, "icon.png")).resize({ width: 16, height: 16 });
  tray = new Tray(trayIcon);
  tray.setToolTip("LimitTrack");
  const menu = Menu.buildFromTemplate([
    { label: "Open LimitTrack", click: () => mainWindow.show() },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => mainWindow.show());
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow.show();
  });
});

app.on("before-quit", () => {
  app.isQuitting = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Simple local JSON storage, exposed to the renderer via preload.js
ipcMain.handle("storage:get", (event, key) => {
  const data = readStore();
  return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
});

ipcMain.handle("storage:set", (event, key, value) => {
  const data = readStore();
  data[key] = value;
  writeStore(data);
  return true;
});

// Live tray tooltip, updated once a second by the renderer's tick loop so
// people can see "what's next" without opening the window.
ipcMain.on("tray:update", (event, text) => {
  if (tray && typeof text === "string") {
    tray.setToolTip(text.slice(0, 250));
  }
});
