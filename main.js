const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, screen } = require("electron");
const path = require("path");
const fs = require("fs");

const STORE_PATH = path.join(app.getPath("userData"), "limittrack-data.json");
const WIDGET_BOUNDS_KEY = "limittrack-widget-bounds";
const WIDGET_VISIBLE_KEY = "limittrack-widget-visible";
const WIDGET_WIDTH = 304;
const WIDGET_MIN_HEIGHT = 88;
const WIDGET_MAX_HEIGHT = 560;

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
let widgetWindow = null;
let widgetVisible = false;
let widgetMenuItem = null;

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
      id: "widget-toggle",
      label: "Floating Widget",
      type: "checkbox",
      checked: widgetVisible,
      click: (menuItem) => setWidgetVisible(menuItem.checked),
    },
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
  widgetMenuItem = menu.getMenuItemById("widget-toggle");
  tray.on("click", () => mainWindow.show());
}

// ---------- floating widget window ----------
// A small always-on-top, frameless "Live Activity"-style panel that mirrors
// the main window's data. It's a fully separate BrowserWindow/renderer, so
// it never touches mainWindow's state directly - the two stay in sync purely
// through the shared local JSON store (see the storage:changed broadcast below).

function clampToWorkArea(x, y, width, height) {
  const display = screen.getDisplayNearestPoint({ x, y });
  const area = display.workArea;
  const clampedX = Math.min(Math.max(x, area.x), Math.max(area.x, area.x + area.width - width));
  const clampedY = Math.min(Math.max(y, area.y), Math.max(area.y, area.y + area.height - height));
  return { x: Math.round(clampedX), y: Math.round(clampedY) };
}

function createWidgetWindow() {
  if (widgetWindow) return;

  const data = readStore();
  const saved = data[WIDGET_BOUNDS_KEY];
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  const width = WIDGET_WIDTH;
  const height = saved && saved.height ? Math.min(WIDGET_MAX_HEIGHT, Math.max(WIDGET_MIN_HEIGHT, saved.height)) : 220;
  const defaultX = area.x + area.width - width - 24;
  const defaultY = area.y + 24;
  const rawX = saved && typeof saved.x === "number" ? saved.x : defaultX;
  const rawY = saved && typeof saved.y === "number" ? saved.y : defaultY;
  const pos = clampToWorkArea(rawX, rawY, width, height);

  widgetWindow = new BrowserWindow({
    width,
    height,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: "#00000000",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  widgetWindow.setAlwaysOnTop(true, "floating");
  if (process.platform === "darwin") {
    widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  widgetWindow.loadFile("widget.html");

  widgetWindow.once("ready-to-show", () => {
    if (widgetVisible) widgetWindow.show();
  });

  let moveSaveTimer = null;
  widgetWindow.on("move", () => {
    clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(() => {
      if (!widgetWindow) return;
      const b = widgetWindow.getBounds();
      const store = readStore();
      store[WIDGET_BOUNDS_KEY] = { x: b.x, y: b.y, height: b.height };
      writeStore(store);
    }, 400);
  });

  widgetWindow.on("closed", () => {
    widgetWindow = null;
  });
}

function setWidgetVisible(visible) {
  widgetVisible = visible;
  const store = readStore();
  store[WIDGET_VISIBLE_KEY] = visible;
  writeStore(store);

  if (visible) {
    if (!widgetWindow) {
      createWidgetWindow();
      // If the window was already ready (unlikely on first create) show now;
      // otherwise the ready-to-show handler above will show it.
      if (widgetWindow && !widgetWindow.isVisible()) {
        widgetWindow.webContents.once("did-finish-load", () => {
          if (widgetWindow) widgetWindow.show();
        });
      }
    } else {
      widgetWindow.show();
    }
  } else if (widgetWindow) {
    widgetWindow.hide();
  }

  if (widgetMenuItem) widgetMenuItem.checked = visible;
}

app.whenReady().then(() => {
  const store = readStore();
  widgetVisible = !!store[WIDGET_VISIBLE_KEY];

  createWindow();
  createTray();
  if (widgetVisible) createWidgetWindow();

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
  // Keep every open window (main + widget) in sync: whichever window didn't
  // originate the write just reloads its copy of the state from disk.
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send("storage:changed", key);
  });
  return true;
});

// Live tray tooltip, updated once a second by the renderer's tick loop so
// people can see "what's next" without opening the window.
ipcMain.on("tray:update", (event, text) => {
  if (tray && typeof text === "string") {
    tray.setToolTip(text.slice(0, 250));
  }
});

// ---------- widget IPC ----------

ipcMain.on("widget:resize", (event, height) => {
  if (!widgetWindow) return;
  const b = widgetWindow.getBounds();
  const clampedHeight = Math.max(WIDGET_MIN_HEIGHT, Math.min(WIDGET_MAX_HEIGHT, Math.round(height)));
  if (clampedHeight === b.height) return;
  widgetWindow.setBounds({ x: b.x, y: b.y, width: b.width, height: clampedHeight }, false);
  const store = readStore();
  store[WIDGET_BOUNDS_KEY] = { x: b.x, y: b.y, height: clampedHeight };
  writeStore(store);
});

ipcMain.on("widget:hide", () => {
  setWidgetVisible(false);
});

ipcMain.on("widget:open-main", () => {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
});
