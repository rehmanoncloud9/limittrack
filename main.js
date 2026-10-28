const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, screen, Notification, powerMonitor, dialog } = require("electron");
const path = require("path");
const Domain = require("./domain");
const { createStore } = require("./store");

const STORE_PATH = path.join(app.getPath("userData"), "limittrack-data.json");
const localStore = createStore(STORE_PATH);
const WIDGET_BOUNDS_KEY = "limittrack-widget-bounds";
const WIDGET_VISIBLE_KEY = "limittrack-widget-visible";
const WIDGET_PROVIDER_KEY = "limittrack-widget-provider";
const PREFERENCES_KEY = "limittrack-preferences";
const WIDGET_WIDTH = 304;
const WIDGET_MIN_HEIGHT = 88;
const WIDGET_MAX_HEIGHT = 560;
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on("second-instance", () => showAccount());

function readStore() {
  return localStore.read();
}

function writeStore(data) {
  localStore.write(data);
}

function accountState(data = readStore()) {
  return Domain.normalizeState(data[Domain.STORAGE_KEY] ? JSON.parse(data[Domain.STORAGE_KEY]) : Domain.DEFAULT_STATE);
}

function trustedSender(event) {
  return [mainWindow, widgetWindow].some((win) => win && !win.isDestroyed() && win.webContents === event.sender)
    && event.senderFrame === event.sender.mainFrame;
}

function broadcastState(senderId) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.webContents.id !== senderId) win.webContents.send("storage:changed", Domain.STORAGE_KEY);
  }
}

function showAccount(accountId) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send("account:reveal", typeof accountId === "string" ? accountId : null);
}

function getPreferences(data = readStore()) {
  const saved = data[PREFERENCES_KEY] || {};
  const providerId = data[WIDGET_PROVIDER_KEY];
  return {
    theme: ["system", "light", "dark"].includes(saved.theme) ? saved.theme : "system",
    font: ["system", "inter"].includes(saved.font) ? saved.font : "system",
    widgetVisible: !!data[WIDGET_VISIBLE_KEY],
    widgetProviderId: accountState(data).providers.some((p) => p.id === providerId) ? providerId : null,
  };
}

function broadcastPreferences() {
  const preferences = getPreferences();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("preferences:changed", preferences);
  }
}

function reconcileResets() {
  try {
    const data = readStore();
    const state = accountState(data);
    const available = state.accounts.filter((a) => Domain.getStatus(a, Date.now()) === "open").length;
    const waiting = state.accounts.filter((a) => ["soon", "locked"].includes(Domain.getStatus(a, Date.now())))
      .sort((a, b) => Date.parse(a.resetAt) - Date.parse(b.resetAt));
    if (tray) tray.setToolTip(`LimitTrack: ${available} marked available${waiting.length ? ` · Next reset ${Domain.formatCountdown(waiting[0], Date.now(), true)}` : " · No active timers"}`);
    const delivered = data["limittrack-notified-resets"] || {};
    const due = Domain.dueResets(state, delivered, Date.now()).filter((a) => !pendingNotificationIds.has(a.id));
    if (!due.length || Date.now() < notificationRetryAfter || !Notification.isSupported()) return;
    const first = due[0];
    const provider = state.providers.find((p) => p.id === first.providerId);
    const notification = new Notification({
      title: due.length === 1 ? "Account expected ready" : `${due.length} accounts expected ready`,
      body: due.length === 1 ? `${provider ? provider.name : "Account"} · ${first.email}. Check the tool to confirm.` : "Recorded reset times have passed. Open LimitTrack to review your accounts.",
      icon: path.join(__dirname, "icon.png"),
    });
    activeNotifications.add(notification);
    due.forEach((account) => pendingNotificationIds.add(account.id));
    const clearPending = () => due.forEach((account) => pendingNotificationIds.delete(account.id));
    notification.once("show", () => {
      try {
        const latest = readStore();
        const latestState = accountState(latest);
        const nextDelivered = {};
        const previous = latest["limittrack-notified-resets"] || {};
        for (const account of latestState.accounts) {
          if (account.resetAt && previous[account.id] === account.resetAt) nextDelivered[account.id] = account.resetAt;
          if (due.some((d) => d.id === account.id && d.resetAt === account.resetAt)) nextDelivered[account.id] = account.resetAt;
        }
        latest["limittrack-notified-resets"] = nextDelivered;
        writeStore(latest);
      } catch (error) { notificationRetryAfter = Date.now() + 60000; console.error(error.message); }
      clearPending();
    });
    notification.once("failed", () => {
      clearPending();
      activeNotifications.delete(notification);
      notificationRetryAfter = Date.now() + 60000;
    });
    notification.once("close", () => { clearPending(); activeNotifications.delete(notification); });
    notification.on("click", () => showAccount(due.length === 1 ? first.id : undefined));
    try { notification.show(); }
    catch (error) { clearPending(); activeNotifications.delete(notification); throw error; }
  } catch (error) {
    console.error("Reset notification could not be scheduled:", error.message);
  }
}

let mainWindow;
let tray;
let widgetWindow = null;
let widgetVisible = false;
let widgetMenuItem = null;
const activeNotifications = new Set();
const pendingNotificationIds = new Set();
let notificationRetryAfter = 0;

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
    if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());

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
      try {
        const store = readStore();
        store[WIDGET_BOUNDS_KEY] = { x: b.x, y: b.y, height: b.height };
        writeStore(store);
      } catch (error) { console.error("Widget position could not be saved:", error.message); }
    }, 400);
  });

  widgetWindow.on("closed", () => {
    widgetWindow = null;
  });
}

function setWidgetVisible(visible, persist = true) {
  try {
    if (persist) {
      const store = readStore();
      store[WIDGET_VISIBLE_KEY] = visible;
      writeStore(store);
    }
    widgetVisible = visible;
  } catch (error) {
    if (widgetMenuItem) widgetMenuItem.checked = widgetVisible;
    dialog.showMessageBox(mainWindow, { type: "error", message: "Widget preference could not be saved.", detail: error.message });
    return;
  }

  if (visible) {
    if (!widgetWindow) {
      createWidgetWindow();
      // If the window was already ready (unlikely on first create) show now;
      // otherwise the ready-to-show handler above will show it.
      if (widgetWindow && !widgetWindow.isVisible()) {
        widgetWindow.webContents.once("did-finish-load", () => {
          if (widgetWindow && widgetVisible) widgetWindow.show();
        });
      }
    } else {
      widgetWindow.show();
    }
  } else if (widgetWindow) {
    widgetWindow.hide();
  }

  if (widgetMenuItem) widgetMenuItem.checked = visible;
  broadcastPreferences();
}

app.whenReady().then(() => {
  if (!ownsInstance) return;
  if (process.platform === "win32") app.setAppUserModelId("com.yourname.limittrack");
  let store;
  try { store = readStore(); accountState(store); }
  catch (error) {
    dialog.showErrorBox("LimitTrack data needs attention", `${error.message}\n\nLocal file: ${STORE_PATH}`);
    app.quit();
    return;
  }
  widgetVisible = !!store[WIDGET_VISIBLE_KEY];

  createWindow();
  createTray();
  if (widgetVisible) createWidgetWindow();
  if (localStore.notice()) dialog.showMessageBox(mainWindow, { type: "warning", message: localStore.notice() });
  reconcileResets();
  const notificationTimer = setInterval(reconcileResets, 15000);
  powerMonitor.on("resume", reconcileResets);
  app.once("before-quit", () => clearInterval(notificationTimer));

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

// Validated, synchronous transactions serialize updates from both windows.
ipcMain.handle("state:get", (event) => {
  if (!trustedSender(event)) throw new Error("Unknown window.");
  return accountState();
});
ipcMain.handle("state:commit", (event, base, next, options) => {
  if (!trustedSender(event)) throw new Error("Unknown window.");
  const data = readStore();
  const merged = Domain.mergeState(base, next, accountState(data));
  if (data[WIDGET_PROVIDER_KEY] && !merged.providers.some((p) => p.id === data[WIDGET_PROVIDER_KEY])) data[WIDGET_PROVIDER_KEY] = null;
  if (options?.backup === true) localStore.checkpoint();
  data[Domain.STORAGE_KEY] = JSON.stringify(merged);
  writeStore(data);
  broadcastState(event.sender.id);
  broadcastPreferences();
  reconcileResets();
  return merged;
});

ipcMain.handle("widget:config-get", (event) => {
  if (!trustedSender(event)) throw new Error("Unknown window.");
  const data = readStore();
  const providerId = data[WIDGET_PROVIDER_KEY];
  return { providerId: accountState(data).providers.some((p) => p.id === providerId) ? providerId : null };
});

ipcMain.handle("widget:config-set", (event, config) => {
  if (!trustedSender(event)) throw new Error("Unknown window.");
  const data = readStore();
  const providerId = config?.providerId;
  if (providerId !== null && (typeof providerId !== "string" || !accountState(data).providers.some((p) => p.id === providerId))) {
    throw new Error("Choose an existing tool or All tools.");
  }
  data[WIDGET_PROVIDER_KEY] = providerId;
  writeStore(data);
  broadcastPreferences();
  return { providerId };
});

ipcMain.handle("preferences:get", (event) => {
  if (!trustedSender(event)) throw new Error("Unknown window.");
  return getPreferences();
});

ipcMain.handle("preferences:update", (event, patch) => {
  if (!trustedSender(event)) throw new Error("Unknown window.");
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some((key) => !["theme", "font", "widgetVisible", "widgetProviderId"].includes(key))) throw new Error("Invalid settings.");
  if ("theme" in patch && !["system", "light", "dark"].includes(patch.theme)) throw new Error("Choose System, Light, or Dark.");
  if ("font" in patch && !["system", "inter"].includes(patch.font)) throw new Error("Choose System or Inter.");
  if ("widgetVisible" in patch && typeof patch.widgetVisible !== "boolean") throw new Error("Invalid widget visibility.");
  const data = readStore();
  if ("widgetProviderId" in patch && patch.widgetProviderId !== null && !accountState(data).providers.some((p) => p.id === patch.widgetProviderId)) throw new Error("Choose an existing tool or All tools.");
  const next = { ...getPreferences(data), ...patch };
  data[PREFERENCES_KEY] = { theme: next.theme, font: next.font };
  data[WIDGET_PROVIDER_KEY] = next.widgetProviderId;
  data[WIDGET_VISIBLE_KEY] = next.widgetVisible;
  writeStore(data);
  if ("widgetVisible" in patch) setWidgetVisible(next.widgetVisible, false);
  else broadcastPreferences();
  return getPreferences();
});

// Live tray tooltip, updated once a second by the renderer's tick loop so
// people can see "what's next" without opening the window.
ipcMain.on("tray:update", (event, text) => {
  if (trustedSender(event) && tray && typeof text === "string") {
    tray.setToolTip(text.slice(0, 250));
  }
});

// ---------- widget IPC ----------

ipcMain.on("widget:resize", (event, height) => {
  if (!widgetWindow || event.sender !== widgetWindow.webContents || !Number.isFinite(height)) return;
  const b = widgetWindow.getBounds();
  const clampedHeight = Math.max(WIDGET_MIN_HEIGHT, Math.min(WIDGET_MAX_HEIGHT, Math.round(height)));
  if (clampedHeight === b.height) return;
  const pos = clampToWorkArea(b.x, b.y, b.width, clampedHeight);
  widgetWindow.setBounds({ ...pos, width: b.width, height: clampedHeight }, false);
  try {
    const store = readStore();
    store[WIDGET_BOUNDS_KEY] = { ...pos, height: clampedHeight };
    writeStore(store);
  } catch (error) { console.error("Widget size could not be saved:", error.message); }
});

ipcMain.on("widget:hide", (event) => {
  if (trustedSender(event)) setWidgetVisible(false);
});

ipcMain.on("widget:open-main", (event, accountId) => {
  if (trustedSender(event)) showAccount(accountId);
});

ipcMain.on("widget:open-settings", (event) => {
  if (!trustedSender(event)) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send("widgets:configure");
});
