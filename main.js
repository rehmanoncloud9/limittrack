const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, nativeTheme, session, shell, screen, Notification, powerMonitor, dialog } = require("electron");
const path = require("path");
const os = require("os");
const Domain = require("./domain");
const { createStore } = require("./store");
const { watchDesktopVisibility } = require("./desktop-visibility");

const STORE_PATH = path.join(app.getPath("userData"), "limittrack-data.json");
const localStore = createStore(STORE_PATH);
const WIDGET_BOUNDS_KEY = "limittrack-widget-bounds";
const WIDGET_VISIBLE_KEY = "limittrack-widget-visible";
const WIDGET_PROVIDER_KEY = "limittrack-widget-provider";
const PREFERENCES_KEY = "limittrack-preferences";
const WINDOW_BOUNDS_KEY = "limittrack-window-bounds";
const TRAY_HINT_KEY = "limittrack-tray-hint-shown";
const DELIVERED_KEY = "limittrack-notified-resets";
const WIDGET_WIDTH = 304;
const WIDGET_MIN_HEIGHT = 64;
const WIDGET_MAX_HEIGHT = 560;
const WIDGET_MIN_WIDTH = 120;
const WIDGET_MAX_WIDTH = 420;
const WIDGET_LAYOUTS = ["compact", "standard", "multi"];
const WIDGET_MAX_TOOLS = 6;
// Starting window sizes (panel plus its 8px margin) so the window is about right before the page reports its real size.
const WIDGET_INITIAL_SIZE = { compact: [200, 104], standard: [304, 190], multi: [264, 150] };
const GRAPHICS_MODES = ["auto", "software", "hardware"];
const TITLEBAR_HEIGHT = 40;
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
// A second launch can arrive while this instance is still starting; a window cannot be built before
// the app is ready, so remember the request and honour it once startup finishes.
let appReady = false;
let showRequestedEarly = false;
app.on("second-instance", () => { if (appReady) showAccount(); else showRequestedEarly = true; });

// ---------- low-memory configuration ----------
// The windows show a few dozen text rows, so a small JavaScript heap is plenty. On machines with
// about 2 GB of RAM or less (or when chosen in Settings) the GPU process is skipped and the page
// is drawn in software, which costs less memory than a GPU process on weak integrated graphics.
const LOW_MEMORY_HOST = (() => { try { return os.totalmem() <= 2.2 * 1024 * 1024 * 1024; } catch { return false; } })();

function configureProcess() {
  if (!app.commandLine || typeof app.commandLine.appendSwitch !== "function") return;
  app.commandLine.appendSwitch("js-flags", "--max-old-space-size=96");
  app.commandLine.appendSwitch("disable-features", "Translate,MediaRouter,OptimizationHints");
  let mode = "auto";
  try {
    const saved = (localStore.read()[PREFERENCES_KEY] || {}).graphics;
    if (GRAPHICS_MODES.includes(saved)) mode = saved;
  } catch { /* an unreadable data file is reported once the app is ready */ }
  if ((mode === "software" || (mode === "auto" && LOW_MEMORY_HOST)) && typeof app.disableHardwareAcceleration === "function") app.disableHardwareAcceleration();
}
if (ownsInstance) configureProcess();

// ---------- data access ----------

function readStore() { return localStore.read(); } // a private copy, for code that will modify and write it
function peekStore() { return localStore.peek(); } // shared, read-only; saves a deep copy on every timer tick
function writeStore(data) { localStore.write(data); }

// Parsing and validating the account list is the costly part of every read, so keep the last result
// and reuse it until the stored text changes. The result is shared: treat it as read-only.
let stateCache = { valid: false, raw: undefined, value: null };
function cacheState(raw, value) { stateCache = { valid: true, raw, value }; }
function accountState(data = peekStore()) {
  const raw = data[Domain.STORAGE_KEY];
  if (stateCache.valid && stateCache.raw === raw) return stateCache.value;
  const value = Domain.normalizeState(raw ? JSON.parse(raw) : Domain.DEFAULT_STATE);
  cacheState(raw, value);
  return value;
}

function trustedSender(event) {
  return [mainWindow, widgetWindow].some((win) => win && !win.isDestroyed() && win.webContents === event.sender)
    && event.senderFrame === event.sender.mainFrame;
}

// Only the main window reads the account list. The desktop widget gets a small summary instead
// (see pushWidgetSummary), so it is not sent a notification for every write.
function broadcastState(senderId) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id !== senderId) mainWindow.webContents.send("storage:changed", Domain.STORAGE_KEY);
}

// ---------- main window ----------
// The window only exists while it is open. Closing it destroys its renderer process, so LimitTrack
// sitting in the tray costs little more than the main process. It is rebuilt on demand.

let mainWindow = null;
let mainLoaded = false;
let pendingMainMessages = [];

function sendToMain(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // A freshly created window is not listening yet; hold messages until its page has loaded.
  if (!mainLoaded) pendingMainMessages.push([channel, payload]);
  else mainWindow.webContents.send(channel, payload);
}

function showMain() {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return true; }
  if (typeof mainWindow.isMinimized === "function" && mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return true;
}

function showAccount(accountId) {
  showMain();
  sendToMain("account:reveal", typeof accountId === "string" ? accountId : null);
}

// Links open in the user's browser, never in a new Electron window, and a
// window can never navigate away from its bundled page.
function hardenWindow(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());
}

function savedWindowBounds(data) {
  const b = data[WINDOW_BOUNDS_KEY];
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return {};
  const width = Math.min(Math.max(Math.round(b.width), 640), 4000);
  const height = Math.min(Math.max(Math.round(b.height), 480), 3000);
  const area = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
  // Only restore the position if the title bar is still reachable on a connected display.
  const reachable = b.x + width - 120 > area.x && b.x + 120 < area.x + area.width && b.y >= area.y - 8 && b.y + 48 < area.y + area.height;
  return reachable ? { x: Math.round(b.x), y: Math.round(b.y), width, height } : { width, height };
}

let boundsTimer = null;
function saveWindowBounds() {
  clearTimeout(boundsTimer);
  boundsTimer = null;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    if ((typeof mainWindow.isMinimized === "function" && mainWindow.isMinimized()) || (typeof mainWindow.isFullScreen === "function" && mainWindow.isFullScreen())) return;
    const bounds = typeof mainWindow.isMaximized === "function" && mainWindow.isMaximized() && typeof mainWindow.getNormalBounds === "function" ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    const store = readStore();
    store[WINDOW_BOUNDS_KEY] = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    writeStore(store);
  } catch (error) { console.error("Window size could not be saved:", error.message); }
}

// Closing the window hides it; without a hint, first-time users assume the app quit.
function showTrayHint() {
  try {
    const data = readStore();
    if (data[TRAY_HINT_KEY] || !Notification.isSupported()) return;
    data[TRAY_HINT_KEY] = true;
    writeStore(data);
    new Notification({
      title: "LimitTrack is still running",
      body: "It stays in your system tray so reset alerts can reach you. Use the tray menu to quit.",
      icon: path.join(__dirname, "icon.png"),
    }).show();
  } catch (error) { console.error("Tray hint could not be shown:", error.message); }
}

function getPreferences(data = peekStore()) {
  const saved = data[PREFERENCES_KEY] || {};
  const providerId = data[WIDGET_PROVIDER_KEY];
  const providerIds = new Set(accountState(data).providers.map((p) => p.id));
  return {
    theme: ["system", "light", "dark"].includes(saved.theme) ? saved.theme : "system",
    font: ["system", "inter"].includes(saved.font) ? saved.font : "system",
    notifications: saved.notifications !== false,
    privacy: saved.privacy === true,
    launchAtLogin: saved.launchAtLogin === true && loginSupported(),
    loginSupported: loginSupported(),
    graphics: GRAPHICS_MODES.includes(saved.graphics) ? saved.graphics : "auto",
    lowMemoryHost: LOW_MEMORY_HOST,
    widgetVisible: !!data[WIDGET_VISIBLE_KEY],
    widgetProviderId: providerIds.has(providerId) ? providerId : null,
    widgetLayout: WIDGET_LAYOUTS.includes(saved.widgetLayout) ? saved.widgetLayout : "standard",
    // Tools that were deleted since are dropped quietly, so a stale id can never reach the widget.
    widgetTools: Array.isArray(saved.widgetTools) ? [...new Set(saved.widgetTools.filter((id) => providerIds.has(id)))] : [],
    widgetToolCount: Number.isInteger(saved.widgetToolCount) && saved.widgetToolCount >= 1 && saved.widgetToolCount <= WIDGET_MAX_TOOLS ? saved.widgetToolCount : 3,
    widgetAlwaysOnTop: saved.widgetAlwaysOnTop === true,
    widgetError: widgetDesktopError,
  };
}

// Launching at login only makes sense for an installed app; a dev checkout
// would register the Electron binary itself. Linux has no portable API.
function loginSupported() {
  return process.platform !== "linux" && !!app.isPackaged && typeof app.setLoginItemSettings === "function";
}

function applyLoginItem(enabled) {
  if (!loginSupported()) return;
  try { app.setLoginItemSettings({ openAtLogin: !!enabled, args: enabled ? ["--hidden"] : [] }); }
  catch (error) { console.error("Launch at login could not be updated:", error.message); }
}

function startedHidden() {
  return !!(process.argv && process.argv.includes("--hidden")) || !!(typeof app.getLoginItemSettings === "function" && app.getLoginItemSettings().wasOpenedAtLogin);
}

function isDark() {
  const theme = getPreferences().theme;
  return theme === "dark" || (theme === "system" && !!(nativeTheme && nativeTheme.shouldUseDarkColors));
}

function windowBackground() { return isDark() ? "#181a1e" : "#f7f8fa"; }

// Windows draws its own minimize/maximize/close buttons over our title bar; keep them in the theme's colours.
function titleBarOverlay() {
  return isDark()
    ? { color: "#161a23", symbolColor: "#ecf0f7", height: TITLEBAR_HEIGHT }
    : { color: "#e6eeff", symbolColor: "#101828", height: TITLEBAR_HEIGHT };
}

function applyTitleBarOverlay() {
  if (process.platform !== "win32" || !mainWindow || mainWindow.isDestroyed() || typeof mainWindow.setTitleBarOverlay !== "function") return;
  try { mainWindow.setTitleBarOverlay(titleBarOverlay()); } catch (error) { console.error("Title bar colours could not be updated:", error.message); }
}

function broadcastPreferences() {
  const preferences = getPreferences();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("preferences:changed", preferences);
  }
}

function trayText(state, nowMs) {
  if (state.accounts.length === 0) return "LimitTrack: no accounts yet";
  const available = state.accounts.filter((a) => Domain.getStatus(a, nowMs) === "open").length;
  const next = state.accounts.filter((a) => ["soon", "locked"].includes(Domain.getStatus(a, nowMs)))
    .sort((a, b) => Date.parse(a.resetAt) - Date.parse(b.resetAt))[0];
  const provider = next && state.providers.find((p) => p.id === next.providerId);
  return `LimitTrack: ${available} marked available${next ? ` · ${provider ? provider.name : "Next reset"} in ${Domain.formatApprox(next, nowMs)}` : " · No active timers"}`;
}

// ---------- reset alerts ----------

// Remember which reset times have been announced (or deliberately skipped) so
// they are never announced twice, even across restarts.
function recordDelivered(due) {
  const latest = readStore();
  const latestState = accountState(latest);
  const nextDelivered = {};
  const previous = latest[DELIVERED_KEY] || {};
  for (const account of latestState.accounts) {
    if (account.resetAt && previous[account.id] === account.resetAt) nextDelivered[account.id] = account.resetAt;
    if (due.some((d) => d.id === account.id && d.resetAt === account.resetAt)) nextDelivered[account.id] = account.resetAt;
  }
  latest[DELIVERED_KEY] = nextDelivered;
  writeStore(latest);
}

// Instead of polling every few seconds, sleep until the next reset time (or a minute, whichever
// is sooner: the tray tooltip is minute-level). A sleeping timer costs nothing.
let reconcileTimer = null;
function scheduleReconcile() {
  clearTimeout(reconcileTimer);
  let delay = 60000;
  try {
    const now = Date.now();
    for (const account of accountState().accounts) {
      const at = Date.parse(account.resetAt);
      if (Number.isFinite(at) && at > now) delay = Math.min(delay, at - now + 250);
    }
  } catch { /* the data file is reported elsewhere; try again in a minute */ }
  reconcileTimer = setTimeout(reconcileResets, Math.max(1000, delay));
  if (reconcileTimer && typeof reconcileTimer.unref === "function") reconcileTimer.unref();
}

function reconcileResets() {
  try {
    const data = peekStore();
    const state = accountState(data);
    const preferences = getPreferences(data);
    setTrayText(trayText(state, Date.now()));
    pushWidgetSummary(); // a reset time passing changes "expected ready" and the next-reset countdown
    const delivered = data[DELIVERED_KEY] || {};
    const due = Domain.dueResets(state, delivered, Date.now()).filter((a) => !pendingNotificationIds.has(a.id));
    if (!due.length) return;
    // Alerts are off: mark these resets as handled so turning alerts back on
    // later does not replay old events.
    if (!preferences.notifications) { recordDelivered(due); return; }
    if (Date.now() < notificationRetryAfter || !Notification.isSupported()) return;
    const first = due[0];
    const provider = state.providers.find((p) => p.id === first.providerId);
    const notification = new Notification({
      title: due.length === 1 ? "Account expected ready" : `${due.length} accounts expected ready`,
      body: due.length === 1 ? `${provider ? provider.name : "Account"} · ${Domain.displayEmail(first.email, preferences.privacy)}. Check the tool to confirm.` : "Recorded reset times have passed. Open LimitTrack to review your accounts.",
      icon: path.join(__dirname, "icon.png"),
    });
    activeNotifications.add(notification);
    // Some systems never report a toast being dismissed; keep only the most recent ones so the set cannot grow forever.
    while (activeNotifications.size > 20) activeNotifications.delete(activeNotifications.values().next().value);
    due.forEach((account) => pendingNotificationIds.add(account.id));
    const clearPending = () => due.forEach((account) => pendingNotificationIds.delete(account.id));
    notification.once("show", () => {
      try { recordDelivered(due); }
      catch (error) { notificationRetryAfter = Date.now() + 60000; console.error(error.message); }
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
  } finally {
    scheduleReconcile();
  }
}

let tray;
let trayTooltip = "";
// The tooltip is refreshed every minute, but it only changes now and then; skip the system call when it did not.
function setTrayText(text) {
  if (!tray || text === trayTooltip) return;
  trayTooltip = text;
  tray.setToolTip(text);
}
let widgetWindow = null;
let widgetOnTop = false; // whether the current widget window was built as always-on-top
let widgetVisible = false;
let widgetMenuItem = null;
let widgetReady = false;
let widgetDesktopAllowed = process.platform !== "win32";
let widgetDesktopError = "";
let stopDesktopMonitor = null;
const activeNotifications = new Set();
const pendingNotificationIds = new Set();
let notificationRetryAfter = 0;

// ---------- menus ----------
// Windows draws a custom title bar, so its menu is popped up from HTML buttons. macOS and Linux
// keep the system frame and get the same entries as an ordinary application menu.

function menuSections() {
  const act = (name) => () => { showMain(); sendToMain("menu:action", name); };
  return {
    file: [
      { label: "New account", click: act("new-account") },
      { label: "Export backup…", click: act("export-backup") },
      { type: "separator" },
      { label: "Quit LimitTrack", click: quitApp },
    ],
    edit: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }],
    view: [
      { label: "Accounts", click: act("view:accounts") },
      { label: "Widgets", click: act("view:widgets") },
      { label: "Settings", click: act("view:settings") },
      ...(app.isPackaged ? [] : [{ type: "separator" }, { role: "toggleDevTools" }]),
    ],
    window: [{ role: "minimize" }, { label: "Close window", click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close(); } }],
    help: [
      { label: "About LimitTrack", click: act("about") },
      { label: "Project on GitHub", click: () => shell.openExternal("https://github.com/rehmanoncloud9/limittrack") },
    ],
  };
}

function installApplicationMenu() {
  if (typeof Menu.setApplicationMenu !== "function") return;
  if (process.platform === "win32") { Menu.setApplicationMenu(null); return; }
  const s = menuSections();
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { label: "File", submenu: s.file }, { label: "Edit", submenu: s.edit }, { label: "View", submenu: s.view },
    { label: "Window", submenu: s.window }, { label: "Help", submenu: s.help },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function quitApp() {
  app.isQuitting = true;
  app.quit();
}

function createWindow() {
  const customChrome = process.platform === "win32";
  mainLoaded = false;
  pendingMainMessages = [];
  const win = new BrowserWindow({
    width: 920,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    ...savedWindowBounds(readStore()),
    show: true,
    title: "LimitTrack",
    icon: path.join(__dirname, "icon.png"),
    backgroundColor: windowBackground(),
    ...(customChrome ? { titleBarStyle: "hidden", titleBarOverlay: titleBarOverlay() } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  mainWindow = win;

  win.loadFile("index.html");
  hardenWindow(win);
  win.webContents.once("did-finish-load", () => {
    if (mainWindow !== win) return;
    mainLoaded = true;
    for (const [channel, payload] of pendingMainMessages) win.webContents.send(channel, payload);
    pendingMainMessages = [];
  });
  const scheduleBoundsSave = () => { clearTimeout(boundsTimer); boundsTimer = setTimeout(saveWindowBounds, 600); };
  win.on("resize", scheduleBoundsSave);
  win.on("move", scheduleBoundsSave);

  // Closing the window leaves LimitTrack running in the tray (so it can still notify you) and frees
  // the window's renderer process; the window is built again the next time it is opened.
  win.on("close", () => {
    saveWindowBounds();
    if (!app.isQuitting) showTrayHint();
  });
  win.on("closed", () => {
    clearTimeout(boundsTimer);
    boundsTimer = null;
    if (mainWindow === win) { mainWindow = null; mainLoaded = false; pendingMainMessages = []; }
  });
  return win;
}

function createTray() {
  const size = process.platform === "win32" ? 32 : 16; // Windows scales a 32px image down crisply on high-DPI screens
  const trayIcon = nativeImage.createFromPath(path.join(__dirname, "icon.png")).resize({ width: size, height: size });
  tray = new Tray(trayIcon);
  tray.setToolTip("LimitTrack");
  const menu = Menu.buildFromTemplate([
    { label: "Open LimitTrack", click: () => showMain() },
    { type: "separator" },
    {
      id: "widget-toggle",
      label: "Floating Widget",
      type: "checkbox",
      checked: widgetVisible,
      click: (menuItem) => setWidgetVisible(menuItem.checked),
    },
    { type: "separator" },
    { label: "Quit", click: quitApp },
  ]);
  tray.setContextMenu(menu);
  widgetMenuItem = menu.getMenuItemById("widget-toggle");
  tray.on("click", () => showMain());
}

// ---------- desktop widget window ----------
// Never take focus or float over applications. Windows desktop activation is
// observed separately; macOS/Linux use their native desktop window type.
// The widget has its own renderer process, so it is destroyed when switched off and only built when needed.

function syncWidgetVisibility() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const show = widgetVisible && widgetReady && widgetDesktopAllowed;
  if (show && !widgetWindow.isVisible()) widgetWindow.showInactive();
  else if (!show && widgetWindow.isVisible()) widgetWindow.hide();
}

function startDesktopMonitor() {
  if (process.platform !== "win32" || stopDesktopMonitor || !widgetWindow) return;
  // An always-on-top widget is shown whatever is in front, so the helper process is not started at all.
  if (widgetOnTop) { widgetDesktopAllowed = true; widgetDesktopError = ""; return; }
  widgetDesktopAllowed = false;
  widgetDesktopError = "";
  stopDesktopMonitor = watchDesktopVisibility(widgetWindow, {
    helperPath: app.isPackaged ? path.join(process.resourcesPath, "native", "desktop-observer.exe") : path.join(__dirname, "native", "build", "desktop-observer.exe"),
    onChange: (allowed) => { widgetDesktopAllowed = allowed; syncWidgetVisibility(); },
    onError: (error) => { widgetDesktopAllowed = false; widgetDesktopError = error.message; syncWidgetVisibility(); broadcastPreferences(); },
  });
}

function clampToWorkArea(x, y, width, height) {
  const display = screen.getDisplayNearestPoint({ x, y });
  const area = display.workArea;
  const clampedX = Math.min(Math.max(x, area.x), Math.max(area.x, area.x + area.width - width));
  const clampedY = Math.min(Math.max(y, area.y), Math.max(area.y, area.y + area.height - height));
  return { x: Math.round(clampedX), y: Math.round(clampedY) };
}

// Moving or resizing fires many events; write the position once things settle, not on every one.
let widgetBoundsTimer = null;
let widgetBoundsPending = null;
function queueWidgetBounds(bounds) {
  widgetBoundsPending = bounds;
  clearTimeout(widgetBoundsTimer);
  widgetBoundsTimer = setTimeout(flushWidgetBounds, 800);
  if (widgetBoundsTimer && typeof widgetBoundsTimer.unref === "function") widgetBoundsTimer.unref();
}
function flushWidgetBounds() {
  clearTimeout(widgetBoundsTimer);
  widgetBoundsTimer = null;
  if (!widgetBoundsPending) return;
  const bounds = widgetBoundsPending;
  widgetBoundsPending = null;
  try {
    const store = readStore();
    store[WIDGET_BOUNDS_KEY] = bounds;
    writeStore(store);
  } catch (error) { console.error("Widget position could not be saved:", error.message); }
}

// ---------- widget content ----------
// The widget shows counts, not accounts. Main works them out from the account list it already holds
// (same availability rules as the app) and sends the page a few numbers per tool. The page never
// receives, parses or validates the account list, and is only sent something when it would look different.

function widgetPayload(data = peekStore(), nowMs = Date.now()) {
  const state = accountState(data);
  const preferences = getPreferences(data);
  const summary = Domain.summarizeProviders(state, nowMs);
  let rows;
  if (preferences.widgetLayout === "multi") {
    const chosen = preferences.widgetTools.length ? summary.filter((row) => preferences.widgetTools.includes(row.id)) : summary;
    rows = chosen.slice(0, preferences.widgetToolCount);
  } else if (preferences.widgetProviderId) rows = summary.filter((row) => row.id === preferences.widgetProviderId);
  else rows = summary.length ? [Domain.combineSummaries(summary)] : [];
  return { layout: preferences.widgetLayout, rows };
}

let lastWidgetPayload = "";
let widgetPageReady = false; // set when the page has asked for its first summary; anything sent earlier would be dropped
function pushWidgetSummary() {
  if (!widgetWindow || widgetWindow.isDestroyed() || !widgetPageReady) return;
  try {
    const payload = widgetPayload();
    const text = JSON.stringify(payload);
    if (text === lastWidgetPayload) return;
    lastWidgetPayload = text;
    widgetWindow.webContents.send("widget:summary", payload);
  } catch (error) { console.error("Widget could not be updated:", error.message); }
}

function applyWidgetPreference(patch) {
  try { updatePreferences(patch); }
  catch (error) { console.error("Widget setting could not be changed:", error.message); }
}

function popupWidgetMenu(template) {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  Menu.buildFromTemplate(template).popup({ window: widgetWindow });
}

function widgetToolMenu() {
  const preferences = getPreferences();
  popupWidgetMenu([
    { label: "All tools", type: "radio", checked: preferences.widgetProviderId === null, click: () => applyWidgetPreference({ widgetProviderId: null }) },
    { type: "separator" },
    ...accountState().providers.map((p) => ({ label: p.name, type: "radio", checked: preferences.widgetProviderId === p.id, click: () => applyWidgetPreference({ widgetProviderId: p.id }) })),
  ]);
}

function widgetContextMenu() {
  const preferences = getPreferences();
  const layouts = [["compact", "Compact"], ["standard", "Standard"], ["multi", "Multi-tool"]];
  popupWidgetMenu([
    { label: "Layout", submenu: layouts.map(([value, label]) => ({ label, type: "radio", checked: preferences.widgetLayout === value, click: () => applyWidgetPreference({ widgetLayout: value }) })) },
    { label: "Always on top", type: "checkbox", checked: preferences.widgetAlwaysOnTop, click: (item) => applyWidgetPreference({ widgetAlwaysOnTop: item.checked }) },
    { type: "separator" },
    { label: "Widget settings…", click: () => { showMain(); sendToMain("widgets:configure"); } },
    { label: "Open LimitTrack", click: () => showMain() },
    { label: "Hide widget", click: () => setWidgetVisible(false) },
  ]);
}

// The window type (desktop vs. floating) is fixed when a window is created, so changing
// "always on top" builds a fresh window; that costs nothing noticeable and leaves no old one behind.
function rebuildWidgetWindow() {
  destroyWidgetWindow();
  widgetDesktopAllowed = process.platform !== "win32";
  if (widgetVisible) { createWidgetWindow(); syncWidgetVisibility(); }
}

function createWidgetWindow() {
  if (widgetWindow) return;

  const data = peekStore();
  const saved = data[WIDGET_BOUNDS_KEY];
  const preferences = getPreferences(data);
  widgetOnTop = preferences.widgetAlwaysOnTop;
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  // Only the position is remembered; the size follows the chosen layout and is corrected by the page once it has rendered.
  const [width, height] = WIDGET_INITIAL_SIZE[preferences.widgetLayout];
  const defaultX = area.x + area.width - width - 24;
  const defaultY = area.y + 24;
  const rawX = saved && typeof saved.x === "number" ? saved.x : defaultX;
  const rawY = saved && typeof saved.y === "number" ? saved.y : defaultY;
  const pos = clampToWorkArea(rawX, rawY, width, height);

  const win = new BrowserWindow({
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
    alwaysOnTop: widgetOnTop,
    // The desktop window type cannot float above other windows, so it is only used for the default behaviour.
    ...(process.platform !== "win32" && !widgetOnTop ? { type: "desktop" } : {}),
    show: false,
    backgroundColor: "#00000000",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  widgetWindow = win;
  hardenWindow(win);
  if (widgetOnTop) {
    if (typeof win.setAlwaysOnTop === "function") win.setAlwaysOnTop(true, "floating");
    if (process.platform === "darwin" && typeof win.setVisibleOnAllWorkspaces === "function") win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  }

  widgetReady = false;
  startDesktopMonitor();
  win.loadFile("widget.html");

  win.once("ready-to-show", () => {
    if (widgetWindow !== win) return;
    widgetReady = true;
    syncWidgetVisibility();
  });

  win.on("move", () => {
    if (widgetWindow !== win) return;
    const b = win.getBounds();
    queueWidgetBounds({ x: b.x, y: b.y });
  });

  win.on("closed", () => {
    if (widgetWindow !== win) return;
    stopDesktopMonitor?.();
    stopDesktopMonitor = null;
    widgetReady = false;
    widgetWindow = null;
    lastWidgetPayload = "";
    widgetPageReady = false;
  });
}

function destroyWidgetWindow() {
  stopDesktopMonitor?.();
  stopDesktopMonitor = null;
  flushWidgetBounds();
  const win = widgetWindow;
  widgetWindow = null;
  widgetReady = false;
  lastWidgetPayload = "";
  widgetPageReady = false;
  if (win && !win.isDestroyed()) {
    if (typeof win.destroy === "function") win.destroy();
    else win.close();
  }
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
    if (!widgetWindow) createWidgetWindow();
    else startDesktopMonitor();
  } else {
    destroyWidgetWindow();
    widgetDesktopAllowed = process.platform !== "win32";
    widgetDesktopError = "";
  }
  syncWidgetVisibility();

  if (widgetMenuItem) widgetMenuItem.checked = visible;
  broadcastPreferences();
}

// ---------- app lifecycle ----------

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
  // This app has no need for camera, location, or any other web permission.
  if (session && session.defaultSession) {
    if (session.defaultSession.setPermissionRequestHandler) session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    if (session.defaultSession.setPermissionCheckHandler) session.defaultSession.setPermissionCheckHandler(() => false);
  }
  applyLoginItem(getPreferences(store).launchAtLogin);
  installApplicationMenu();
  if (nativeTheme && typeof nativeTheme.on === "function") nativeTheme.on("updated", applyTitleBarOverlay);

  // Started at login: stay in the tray and build no window until the user asks for one.
  appReady = true;
  if (!startedHidden() || showRequestedEarly) createWindow();
  createTray();
  if (widgetVisible) createWidgetWindow();
  if (localStore.notice() && mainWindow) dialog.showMessageBox(mainWindow, { type: "warning", message: localStore.notice() });
  reconcileResets();
  powerMonitor.on("resume", reconcileResets);

  app.on("activate", () => showMain());
});

app.on("before-quit", () => {
  app.isQuitting = true;
  saveWindowBounds();
  flushWidgetBounds();
  clearTimeout(reconcileTimer);
  stopDesktopMonitor?.();
});

// Closing every window must not quit: LimitTrack keeps running in the tray. Quit comes from the tray menu.
app.on("window-all-closed", () => {});

// ---------- IPC ----------
// Validated, synchronous transactions serialize updates from both windows.
ipcMain.handle("state:get", (event) => {
  if (!trustedSender(event)) throw new Error("Unknown window.");
  return accountState();
});
ipcMain.handle("state:commit", (event, base, next, options) => {
  if (!trustedSender(event)) throw new Error("Unknown window.");
  const data = readStore();
  const merged = Domain.mergeState(base, next, accountState(data));
  let providerReset = false;
  if (data[WIDGET_PROVIDER_KEY] && !merged.providers.some((p) => p.id === data[WIDGET_PROVIDER_KEY])) { data[WIDGET_PROVIDER_KEY] = null; providerReset = true; }
  if (options?.backup === true) localStore.checkpoint();
  const raw = JSON.stringify(merged);
  data[Domain.STORAGE_KEY] = raw;
  writeStore(data);
  cacheState(raw, merged);
  broadcastState(event.sender.id);
  if (providerReset) broadcastPreferences();
  reconcileResets();
  return merged;
});

ipcMain.handle("widget:config-get", (event) => {
  if (!trustedSender(event)) throw new Error("Unknown window.");
  const data = peekStore();
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
  pushWidgetSummary();
  return { providerId };
});

ipcMain.handle("preferences:get", (event) => {
  if (!trustedSender(event)) throw new Error("Unknown window.");
  return getPreferences();
});

ipcMain.handle("app:info", (event) => {
  if (!trustedSender(event)) throw new Error("Unknown window.");
  return { version: typeof app.getVersion === "function" ? app.getVersion() : "", platform: process.platform };
});

ipcMain.handle("app:relaunch", (event) => {
  if (!trustedSender(event)) throw new Error("Unknown window.");
  app.isQuitting = true;
  if (typeof app.relaunch === "function") app.relaunch();
  app.quit();
  return true;
});

ipcMain.handle("notifications:test", (event) => {
  if (!trustedSender(event)) throw new Error("Unknown window.");
  if (!Notification.isSupported()) return { ok: false, message: "This system does not support desktop notifications." };
  try {
    new Notification({ title: "LimitTrack test", body: "If you can see this, reset alerts can reach you while LimitTrack is running.", icon: path.join(__dirname, "icon.png") }).show();
    return { ok: true, message: "Test sent. If nothing appeared, check your system notification or Focus settings." };
  } catch (error) { return { ok: false, message: "The test could not be shown: " + error.message }; }
});

const PREFERENCE_KEYS = ["theme", "font", "graphics", "widgetVisible", "widgetProviderId", "notifications", "privacy", "launchAtLogin", "widgetLayout", "widgetTools", "widgetToolCount", "widgetAlwaysOnTop"];

function updatePreferences(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some((key) => !PREFERENCE_KEYS.includes(key))) throw new Error("Invalid settings.");
  for (const key of ["notifications", "privacy", "launchAtLogin", "widgetAlwaysOnTop"]) if (key in patch && typeof patch[key] !== "boolean") throw new Error("Invalid setting value.");
  if (patch.launchAtLogin === true && !loginSupported()) throw new Error("Launch at login is available in the installed app on Windows and macOS.");
  if ("theme" in patch && !["system", "light", "dark"].includes(patch.theme)) throw new Error("Choose System, Light, or Dark.");
  if ("font" in patch && !["system", "inter"].includes(patch.font)) throw new Error("Choose System or Inter.");
  if ("graphics" in patch && !GRAPHICS_MODES.includes(patch.graphics)) throw new Error("Choose Automatic, Low memory, or Hardware.");
  if ("widgetVisible" in patch && typeof patch.widgetVisible !== "boolean") throw new Error("Invalid widget visibility.");
  if ("widgetLayout" in patch && !WIDGET_LAYOUTS.includes(patch.widgetLayout)) throw new Error("Choose Compact, Standard, or Multi-tool.");
  if ("widgetToolCount" in patch && !(Number.isInteger(patch.widgetToolCount) && patch.widgetToolCount >= 1 && patch.widgetToolCount <= WIDGET_MAX_TOOLS)) throw new Error(`Choose between 1 and ${WIDGET_MAX_TOOLS} tools.`);
  const data = readStore();
  const providers = accountState(data).providers;
  if ("widgetProviderId" in patch && patch.widgetProviderId !== null && !providers.some((p) => p.id === patch.widgetProviderId)) throw new Error("Choose an existing tool or All tools.");
  if ("widgetTools" in patch && (!Array.isArray(patch.widgetTools) || patch.widgetTools.length > 500 || patch.widgetTools.some((id) => !providers.some((p) => p.id === id)))) throw new Error("Choose existing tools.");
  const before = getPreferences(data);
  const next = { ...before, ...patch };
  data[PREFERENCES_KEY] = {
    theme: next.theme, font: next.font, graphics: next.graphics, notifications: next.notifications, privacy: next.privacy, launchAtLogin: next.launchAtLogin,
    widgetLayout: next.widgetLayout, widgetTools: [...new Set(next.widgetTools)], widgetToolCount: next.widgetToolCount, widgetAlwaysOnTop: next.widgetAlwaysOnTop,
  };
  data[WIDGET_PROVIDER_KEY] = next.widgetProviderId;
  data[WIDGET_VISIBLE_KEY] = next.widgetVisible;
  writeStore(data);
  if ("launchAtLogin" in patch) applyLoginItem(next.launchAtLogin);
  if ("theme" in patch) applyTitleBarOverlay();
  if ("widgetVisible" in patch) setWidgetVisible(next.widgetVisible, false);
  else if (next.widgetAlwaysOnTop !== before.widgetAlwaysOnTop && widgetWindow) { rebuildWidgetWindow(); broadcastPreferences(); }
  else broadcastPreferences();
  pushWidgetSummary();
  return getPreferences();
}

ipcMain.handle("preferences:update", (event, patch) => {
  if (!trustedSender(event)) throw new Error("Unknown window.");
  return updatePreferences(patch);
});

ipcMain.on("menu:open", (event, name, x, y) => {
  if (!trustedSender(event)) return;
  const section = menuSections()[name];
  if (!section || !Number.isFinite(x) || !Number.isFinite(y)) return;
  Menu.buildFromTemplate(section).popup({ window: mainWindow, x: Math.round(x), y: Math.round(y) });
});

// ---------- widget IPC ----------

ipcMain.handle("widget:summary-get", (event) => {
  if (!trustedSender(event)) throw new Error("Unknown window.");
  const payload = widgetPayload();
  lastWidgetPayload = JSON.stringify(payload);
  widgetPageReady = true;
  return payload;
});

ipcMain.on("widget:tool-menu", (event) => {
  if (widgetWindow && event.sender === widgetWindow.webContents && trustedSender(event)) widgetToolMenu();
});

ipcMain.on("widget:context-menu", (event) => {
  if (widgetWindow && event.sender === widgetWindow.webContents && trustedSender(event)) widgetContextMenu();
});

// The page measures its own panel and says how big the window must be (a bare number still means height).
ipcMain.on("widget:resize", (event, size) => {
  if (!widgetWindow || event.sender !== widgetWindow.webContents) return;
  const wanted = typeof size === "number" ? { height: size } : size;
  if (!wanted || !Number.isFinite(wanted.height)) return;
  const b = widgetWindow.getBounds();
  const height = Math.max(WIDGET_MIN_HEIGHT, Math.min(WIDGET_MAX_HEIGHT, Math.round(wanted.height)));
  const width = Number.isFinite(wanted.width) ? Math.max(WIDGET_MIN_WIDTH, Math.min(WIDGET_MAX_WIDTH, Math.round(wanted.width))) : b.width;
  if (height === b.height && width === b.width) return;
  const pos = clampToWorkArea(b.x, b.y, width, height);
  widgetWindow.setBounds({ ...pos, width, height }, false);
  queueWidgetBounds({ ...pos });
});

ipcMain.on("widget:hide", (event) => {
  if (trustedSender(event)) setWidgetVisible(false);
});

ipcMain.on("widget:open-main", (event, accountId) => {
  if (trustedSender(event)) showAccount(accountId);
});

ipcMain.on("widget:open-settings", (event) => {
  if (!trustedSender(event)) return;
  showMain();
  sendToMain("widgets:configure");
});
