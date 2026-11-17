const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const D = require("../domain");

async function harness(t, data, platform = process.platform, argv = [], { deferReady = false } = {}) {
  const temporaryRoot = process.env.LIMITTRACK_TEST_TMP || os.tmpdir();
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "limittrack-main-"));
  t.after(() => {
    const resolved = fs.realpathSync(directory);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(temporaryRoot).toLowerCase());
    assert.ok(path.basename(resolved).startsWith("limittrack-main-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const filename = path.join(directory, "limittrack-data.json");
  fs.writeFileSync(filename, JSON.stringify(data));
  let time = Date.parse("2026-10-27T12:00:00Z");
  class Clock extends Date { static now() { return time; } }
  const windows = [], notifications = [], handlers = new Map(), dialogs = [], intervals = [];
  const app = new EventEmitter();
  let release;
  const ready = deferReady ? new Promise((resolve) => { release = resolve; }) : Promise.resolve();
  Object.assign(app, { getPath: () => directory, requestSingleInstanceLock: () => true, whenReady: () => ready, setAppUserModelId() {}, quit() { app.quitCalled = true; } });
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.visible = options.show !== false; this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, { id: windows.length + 1, mainFrame: {}, setWindowOpenHandler() {}, send: (...args) => { this.sent = args; (this.sends ||= []).push(args); } });
      windows.push(this);
    }
    static getAllWindows() { return windows.filter((w) => !w.destroyed); }
    loadFile() { setImmediate(() => this.webContents.emit("did-finish-load")); } destroy() { this.destroyed = true; this.visible = false; this.emit("closed"); }
    show() { this.visible = true; this.activated = true; } showInactive() { this.visible = true; } hide() { this.visible = false; }
    focus() {} isDestroyed() { return !!this.destroyed; } isVisible() { return !!this.visible; }
    setAlwaysOnTop(value) { this.onTop = value; } setVisibleOnAllWorkspaces() {}
    getBounds() { return this.bounds; } setBounds(bounds) { this.bounds = bounds; }
  }
  const ipcMain = new EventEmitter(); ipcMain.handle = (key, handler) => handlers.set(key, handler);
  const powerMonitor = new EventEmitter();
  const controls = { failNotification: false, desktopActive: true };
  class NativeNotification extends EventEmitter {
    constructor(options) { super(); this.options = options; notifications.push(this); }
    static isSupported() { return true; }
    show() { this.emit(controls.failNotification ? "failed" : "show"); }
  }
  const trays = [];
  class Tray extends EventEmitter { constructor() { super(); trays.push(this); } setToolTip(text) { this.text = text; this.tooltipCalls = (this.tooltipCalls || 0) + 1; } setContextMenu(menu) { this.menu = menu; } }
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const electron = { app, ipcMain, BrowserWindow: Window, Tray, Notification: NativeNotification, powerMonitor,
    Menu: { setApplicationMenu(menu) { electron.appMenu = menu; }, buildFromTemplate: (items) => ({ items, popup(options) { electron.popups.push({ ...options, items }); }, getMenuItemById: (id) => items.find((item) => item.id === id) }) },
    popups: [],
    nativeImage: { createFromPath: () => ({ resize() { return this; } }) }, shell: { openExternal() {} },
    screen: { getDisplayNearestPoint: () => ({ workArea }), getPrimaryDisplay: () => ({ workArea }) },
    dialog: { showErrorBox: (...args) => dialogs.push(args), showMessageBox: (...args) => dialogs.push(args) },
  };
  const desktopVisibility = { watchDesktopVisibility: (_win, options) => {
    controls.desktopChanged = options.onChange;
    controls.desktopError = options.onError;
    options.onChange(controls.desktopActive);
    return () => { controls.desktopStopped = true; };
  } };
  const context = vm.createContext({ require: (name) => name === "./desktop-visibility" ? desktopVisibility : name === "electron" ? electron : name === "./domain" ? D : name === "./store" ? require("../store") : require(name),
    __dirname: path.resolve(__dirname, ".."), process: { platform, argv }, console, Date: Clock, setInterval: (callback) => { intervals.push(callback); return intervals.length; }, clearInterval() {}, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(require.resolve("../main"), "utf8"), context);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve)); // let the mock page finish loading
  return { app, trays, windows, notifications, handlers, dialogs, controls, powerMonitor, ipcMain, release, popups: electron.popups,
    widgetEvent: () => ({ sender: windows[1].webContents, senderFrame: windows[1].webContents.mainFrame }),
    advance: (milliseconds) => { time += milliseconds; }, data: () => JSON.parse(fs.readFileSync(filename, "utf8")),
    event: () => ({ sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame }) };
}
function dataWithTimer() {
  const state = D.clone(D.DEFAULT_STATE);
  state.accounts = [{ id: "one", providerId: "codex", email: "one@example.com", resetAt: "2026-10-27T12:00:01.000Z" }];
  return { [D.STORAGE_KEY]: JSON.stringify(state) };
}

test("main-process notifications reconcile on resume and persist delivery across restart", async (t) => {
  const app = await harness(t, dataWithTimer());
  assert.equal(app.notifications.length, 0);
  app.advance(2000); app.powerMonitor.emit("resume");
  assert.equal(app.notifications.length, 1);
  assert.equal(app.notifications[0].options.title, "Account expected ready");
  app.powerMonitor.emit("resume");
  assert.equal(app.notifications.length, 1);
  app.notifications[0].emit("click");
  assert.equal(app.windows[0].sent[0], "account:reveal");
  assert.equal(app.windows[0].sent[1], "one");
  const restarted = await harness(t, app.data());
  restarted.advance(2000); restarted.powerMonitor.emit("resume");
  assert.equal(restarted.notifications.length, 0);
});

test("failed native notification delivery is retried without recording false success", async (t) => {
  const app = await harness(t, dataWithTimer());
  app.controls.failNotification = true; app.advance(2000); app.powerMonitor.emit("resume");
  assert.equal(app.data()["limittrack-notified-resets"], undefined);
  app.powerMonitor.emit("resume"); assert.equal(app.notifications.length, 1);
  app.controls.failNotification = false; app.advance(61000); app.powerMonitor.emit("resume");
  assert.equal(app.notifications.length, 2);
  assert.ok(app.data()["limittrack-notified-resets"].one);
});

test("state IPC validates senders, serializes commits, and rejects competing changes", async (t) => {
  const app = await harness(t, dataWithTimer());
  const get = app.handlers.get("state:get"), commit = app.handlers.get("state:commit");
  assert.throws(() => get({ sender: {}, senderFrame: {} }), /Unknown window/);
  const base = get(app.event()), next = D.clone(base);
  next.accounts[0].email = "renamed@example.com";
  commit(app.event(), base, next);
  const conflict = D.clone(base); conflict.accounts[0].email = "other@example.com";
  assert.throws(() => commit(app.event(), base, conflict), /another window/);
  assert.equal(get(app.event()).accounts[0].email, "renamed@example.com");
});

test("widget tool configuration persists, validates choices, and falls back when a tool is removed", async (t) => {
  const app = await harness(t, dataWithTimer());
  const get = app.handlers.get("widget:config-get"), set = app.handlers.get("widget:config-set");
  assert.equal(get(app.event()).providerId, null);
  assert.throws(() => set({ sender: {}, senderFrame: {} }, { providerId: "codex" }), /Unknown window/);
  assert.throws(() => set(app.event(), { providerId: "missing" }), /existing tool/);
  assert.throws(() => set(app.event(), {}), /existing tool/);
  set(app.event(), { providerId: "codex" });
  const restarted = await harness(t, app.data());
  assert.equal(restarted.handlers.get("widget:config-get")(restarted.event()).providerId, "codex");
  const base = app.handlers.get("state:get")(app.event());
  const next = D.clone(base);
  next.accounts = [];
  next.providers = next.providers.filter((p) => p.id !== "codex");
  app.handlers.get("state:commit")(app.event(), base, next);
  assert.equal(get(app.event()).providerId, null);
  set(app.event(), { providerId: "claude" });
  set(app.event(), { providerId: null });
  assert.equal(get(app.event()).providerId, null);
});

test("appearance settings persist, merge independent updates, and reject invalid input", async (t) => {
  const app = await harness(t, dataWithTimer());
  const get = app.handlers.get("preferences:get"), update = app.handlers.get("preferences:update");
  assert.equal(get(app.event()).theme, "system");
  assert.equal(get(app.event()).font, "system");
  const accountsBefore = app.data()[D.STORAGE_KEY];
  update(app.event(), { theme: "dark" });
  update(app.event(), { font: "inter" });
  update(app.event(), { widgetProviderId: "codex" });
  assert.equal(get(app.event()).theme, "dark");
  assert.equal(get(app.event()).font, "inter");
  assert.equal(get(app.event()).widgetProviderId, "codex");
  assert.equal(app.data()[D.STORAGE_KEY], accountsBefore);
  const saved = JSON.stringify(app.data());
  for (const patch of [{ theme: "neon" }, { font: "unknown" }, { widgetVisible: "yes" }, { widgetProviderId: "missing" }, { arbitrary: true }]) {
    assert.throws(() => update(app.event(), patch));
    assert.equal(JSON.stringify(app.data()), saved);
  }
  const restarted = await harness(t, app.data());
  assert.equal(restarted.handlers.get("preferences:get")(restarted.event()).theme, "dark");
  assert.equal(restarted.handlers.get("preferences:get")(restarted.event()).font, "inter");
});

test("widget setup controls visibility, is destroyed when switched off, and opens widget configuration", async (t) => {
  const app = await harness(t, dataWithTimer(), "win32");
  const update = app.handlers.get("preferences:update"), get = app.handlers.get("preferences:get");
  update(app.event(), { widgetVisible: true, widgetProviderId: "codex" });
  assert.equal(get(app.event()).widgetVisible, true);
  const widget = app.windows[1];
  assert.ok(widget);
  assert.equal(widget.options.alwaysOnTop, false);
  // Switching off before the page has loaded releases the window and its renderer process.
  update(app.event(), { widgetVisible: false });
  assert.equal(widget.destroyed, true, "the widget's renderer is freed while the widget is off");
  assert.equal(controlsStopped(app), true);
  update(app.event(), { widgetVisible: true });
  const second = app.windows[2];
  assert.ok(second && second !== widget, "turning it back on builds a fresh window");
  second.emit("ready-to-show");
  assert.equal(second.visible, true);
  assert.notEqual(second.activated, true, "showing the widget must not steal focus");
  app.controls.desktopChanged(false);
  assert.equal(second.visible, false, "an active app hides the desktop widget");
  app.controls.desktopChanged(true);
  assert.equal(second.visible, true, "returning to the desktop restores the widget");
  const event = { sender: second.webContents, senderFrame: second.webContents.mainFrame };
  app.ipcMain.emit("widget:open-settings", event);
  assert.equal(app.windows[0].sent[0], "widgets:configure");
  app.ipcMain.emit("widget:hide", event);
  assert.equal(get(app.event()).widgetVisible, false);
  assert.equal(second.destroyed, true);
  app.controls.desktopChanged(true);
  assert.equal(second.visible, false, "desktop changes must not bring back a switched-off widget");
});
function controlsStopped(app) { return app.controls.desktopStopped === true; }

test("desktop detection failure hides the widget and can be retried without losing the selected tool", async (t) => {
  const app = await harness(t, dataWithTimer(), "win32");
  const update = app.handlers.get("preferences:update"), get = app.handlers.get("preferences:get");
  update(app.event(), { widgetVisible: true, widgetProviderId: "codex" });
  const widget = app.windows[1];
  widget.emit("ready-to-show");
  assert.equal(widget.visible, true);
  app.controls.desktopError(new Error("Desktop detection is unavailable."));
  assert.equal(widget.visible, false);
  assert.match(get(app.event()).widgetError, /unavailable/);
  update(app.event(), { widgetVisible: false });
  update(app.event(), { widgetVisible: true });
  const retry = app.windows[2];
  retry.emit("ready-to-show");
  assert.equal(retry.visible, true);
  assert.equal(get(app.event()).widgetError, "");
  assert.equal(get(app.event()).widgetProviderId, "codex");
  retry.emit("closed");
  assert.equal(app.controls.desktopStopped, true);
});

test("the widget position is saved once movement settles, not on every event", async (t) => {
  const app = await harness(t, dataWithTimer());
  app.handlers.get("preferences:update")(app.event(), { widgetVisible: true });
  const widget = app.windows[1];
  widget.emit("ready-to-show");
  for (let i = 0; i < 20; i++) { widget.bounds = { ...widget.bounds, x: 100 + i, y: 50 }; widget.emit("move"); }
  assert.equal(app.data()["limittrack-widget-bounds"], undefined, "nothing is written while the widget is being dragged");
  app.app.emit("before-quit");
  assert.deepEqual({ x: app.data()["limittrack-widget-bounds"].x, y: app.data()["limittrack-widget-bounds"].y }, { x: 119, y: 50 });
});

for (const platform of ["darwin", "linux"]) {
  test(`${platform} widget uses a desktop window without activating or covering apps`, async (t) => {
    const app = await harness(t, dataWithTimer(), platform);
    app.handlers.get("preferences:update")(app.event(), { widgetVisible: true });
    const widget = app.windows[1];
    widget.emit("ready-to-show");
    assert.equal(widget.options.type, "desktop");
    assert.equal(widget.options.alwaysOnTop, false);
    assert.equal(widget.visible, true);
    assert.notEqual(widget.activated, true);
  });
}

test("turning notifications off skips alerts without replaying old resets when turned back on", async (t) => {
  const app = await harness(t, dataWithTimer());
  const update = app.handlers.get("preferences:update");
  assert.equal(app.handlers.get("preferences:get")(app.event()).notifications, true);
  update(app.event(), { notifications: false });
  app.advance(2000); app.powerMonitor.emit("resume");
  assert.equal(app.notifications.length, 0);
  assert.ok(app.data()["limittrack-notified-resets"].one, "the skipped reset is recorded as handled");
  update(app.event(), { notifications: true });
  app.powerMonitor.emit("resume");
  assert.equal(app.notifications.length, 0, "old resets are not replayed");
});

test("privacy mode masks the email in native notifications", async (t) => {
  const app = await harness(t, dataWithTimer());
  app.handlers.get("preferences:update")(app.event(), { privacy: true });
  app.advance(2000); app.powerMonitor.emit("resume");
  assert.equal(app.notifications.length, 1);
  assert.ok(!app.notifications[0].options.body.includes("one@example.com"));
  assert.match(app.notifications[0].options.body, /on•••@example\.com/);
});

test("new preferences validate input and launch at login is guarded to installed apps", async (t) => {
  const app = await harness(t, dataWithTimer(), "win32");
  const get = app.handlers.get("preferences:get"), update = app.handlers.get("preferences:update");
  assert.equal(get(app.event()).loginSupported, false);
  assert.throws(() => update(app.event(), { launchAtLogin: true }), /installed app/);
  for (const patch of [{ privacy: "yes" }, { notifications: 1 }, { launchAtLogin: "true" }]) assert.throws(() => update(app.event(), patch), /Invalid setting value/);
  const calls = [];
  app.app.isPackaged = true; app.app.setLoginItemSettings = (value) => calls.push(value);
  assert.equal(get(app.event()).loginSupported, true);
  update(app.event(), { launchAtLogin: true });
  assert.equal(JSON.stringify(calls.at(-1)), JSON.stringify({ openAtLogin: true, args: ["--hidden"] }));
  assert.equal(get(app.event()).launchAtLogin, true);
  update(app.event(), { launchAtLogin: false });
  assert.equal(JSON.stringify(calls.at(-1)), JSON.stringify({ openAtLogin: false, args: [] }));
  const linux = await harness(t, dataWithTimer(), "linux");
  linux.app.isPackaged = true; linux.app.setLoginItemSettings = () => {};
  assert.equal(linux.handlers.get("preferences:get")(linux.event()).loginSupported, false);
});

test("app info and test notification are available only to trusted windows", async (t) => {
  const app = await harness(t, dataWithTimer());
  app.app.getVersion = () => "9.9.9";
  assert.equal(app.handlers.get("app:info")(app.event()).version, "9.9.9");
  assert.throws(() => app.handlers.get("app:info")({ sender: {}, senderFrame: {} }), /Unknown window/);
  assert.throws(() => app.handlers.get("notifications:test")({ sender: {}, senderFrame: {} }), /Unknown window/);
  const result = app.handlers.get("notifications:test")(app.event());
  assert.equal(result.ok, true);
  assert.equal(app.notifications.at(-1).options.title, "LimitTrack test");
});

test("closing the window frees it, explains the tray once, remembers size, and reopens on demand", async (t) => {
  const app = await harness(t, dataWithTimer());
  const first = app.windows[0];
  first.bounds = { x: 120, y: 80, width: 1000, height: 700 };
  first.emit("close", { preventDefault() { assert.fail("the window should really close so its renderer is released"); } });
  first.emit("closed");
  assert.equal(app.notifications.length, 1);
  assert.equal(app.notifications[0].options.title, "LimitTrack is still running");
  // Reopening from the tray builds a new window (with the saved size) and queues the reveal until it has loaded.
  app.trays[0].emit("click");
  const second = app.windows[1];
  assert.ok(second && second !== first);
  assert.equal(second.options.width, 1000);
  second.bounds = { x: 120, y: 80, width: 1000, height: 700 };
  second.emit("close", {}); second.emit("closed");
  assert.equal(app.notifications.length, 1, "the hint appears only once");
  app.advance(2000); app.powerMonitor.emit("resume");
  app.notifications[1].emit("click");
  const third = app.windows[2];
  assert.ok(third, "a notification click reopens the window");
  assert.equal(third.sent, undefined, "nothing is sent before the page has loaded");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(third.sent[0], "account:reveal");
  const restarted = await harness(t, app.data());
  assert.deepEqual({ x: restarted.windows[0].options.x, y: restarted.windows[0].options.y, width: restarted.windows[0].options.width, height: restarted.windows[0].options.height }, { x: 120, y: 80, width: 1000, height: 700 });
  const offscreen = app.data(); offscreen["limittrack-window-bounds"] = { x: 9000, y: 9000, width: 1000, height: 700 };
  const recovered = await harness(t, offscreen);
  assert.equal(recovered.windows[0].options.x, undefined, "an unreachable saved position is ignored");
  assert.equal(recovered.windows[0].options.width, 1000);
});

test("closing every window does not quit the app", async (t) => {
  const app = await harness(t, dataWithTimer());
  app.windows[0].emit("closed");
  app.app.emit("window-all-closed");
  assert.notEqual(app.app.quitCalled, true);
});

test("Windows gets a custom title bar with a native-menu popup; other platforms keep the system frame", async (t) => {
  const win = await harness(t, dataWithTimer(), "win32");
  assert.equal(win.windows[0].options.titleBarStyle, "hidden");
  assert.equal(win.windows[0].options.titleBarOverlay.height, 40);
  const bridge = { electron: null };
  win.ipcMain.emit("menu:open", win.event(), "file", 20, 40);
  win.ipcMain.emit("menu:open", win.event(), "bogus", 20, 40);
  win.ipcMain.emit("menu:open", { sender: {}, senderFrame: {} }, "file", 20, 40);
  assert.equal(bridge.electron, null);
  const mac = await harness(t, dataWithTimer(), "darwin");
  assert.equal(mac.windows[0].options.titleBarStyle, undefined);
});

test("started at login, no window is built until the user asks for one", async (t) => {
  const app = await harness(t, dataWithTimer(), process.platform, ["--hidden"]);
  assert.equal(app.windows.length, 0);
  app.trays[0].emit("click");
  assert.equal(app.windows.length, 1);
});

test("the tray tooltip has a single owner and reports minute-level timing", async (t) => {
  const state = D.clone(D.DEFAULT_STATE);
  state.accounts = [{ id: "one", providerId: "codex", email: "one@example.com", lastHitAt: "2026-10-27T11:00:00.000Z", resetAt: "2026-10-27T14:30:00.000Z" }];
  const app = await harness(t, { [D.STORAGE_KEY]: JSON.stringify(state) });
  assert.equal(app.ipcMain.listenerCount("tray:update"), 0);
  app.powerMonitor.emit("resume");
  assert.equal(app.trays[0].text, "LimitTrack: 0 marked available · Codex in 2h 30m");
  app.advance(31 * 60000); app.powerMonitor.emit("resume");
  assert.equal(app.trays[0].text, "LimitTrack: 0 marked available · Codex in 1h 59m");
});

test("both windows are sandboxed", async (t) => {
  const app = await harness(t, dataWithTimer());
  app.handlers.get("preferences:update")(app.event(), { widgetVisible: true });
  for (const win of app.windows) assert.equal(win.options.webPreferences.sandbox, true);
  assert.equal(app.windows.length, 2);
});

// ---------- desktop widget: summaries, layouts, always-on-top, menus ----------
// main.js runs in its own vm realm, so compare plain copies (deepStrictEqual also checks prototypes).
const plain = (value) => JSON.parse(JSON.stringify(value));

function widgetData() {
  const state = D.clone(D.DEFAULT_STATE);
  state.accounts = [
    { id: "a1", providerId: "antigravity", email: "a1@example.com", confirmedAvailableAt: "2026-10-27T11:59:00.000Z" },
    { id: "a2", providerId: "antigravity", email: "a2@example.com", confirmedAvailableAt: "2026-10-27T11:59:00.000Z" },
    { id: "a3", providerId: "antigravity", email: "a3@example.com", lastHitAt: "2026-10-27T10:00:00.000Z", resetAt: "2026-10-27T15:00:00.000Z" },
    { id: "c1", providerId: "codex", email: "c1@example.com", lastHitAt: "2026-10-27T09:00:00.000Z", resetAt: "2026-10-27T11:00:00.000Z" },
    { id: "c2", providerId: "codex", email: "c2@example.com", lastHitAt: "2026-10-27T11:00:00.000Z", resetAt: "2026-10-27T18:00:00.000Z" },
  ];
  return { [D.STORAGE_KEY]: JSON.stringify(state) };
}
const summaries = (app) => (app.windows[1].sends || []).filter((s) => s[0] === "widget:summary").map((s) => s[1]);

test("the widget summary uses the app's availability rules and never includes account details", async (t) => {
  const app = await harness(t, widgetData());
  const get = app.handlers.get("widget:summary-get"), update = app.handlers.get("preferences:update");
  update(app.event(), { widgetVisible: true });
  const summary = get(app.widgetEvent());
  assert.equal(summary.layout, "standard");
  assert.deepEqual(plain(summary.rows), [{ id: null, name: "All tools", available: 2, ready: 1, tracked: 5, nextResetAt: Date.parse("2026-10-27T15:00:00Z") }]);
  assert.ok(!JSON.stringify(summary).includes("@"), "no email address ever reaches the widget");
  assert.throws(() => get(app.event()) && get({ sender: {}, senderFrame: {} }), /Unknown window/);

  update(app.event(), { widgetLayout: "compact", widgetProviderId: "codex" });
  assert.deepEqual(plain(get(app.widgetEvent()).rows), [{ id: "codex", name: "Codex", available: 0, ready: 1, tracked: 2, nextResetAt: Date.parse("2026-10-27T18:00:00Z") }]);

  update(app.event(), { widgetLayout: "multi", widgetTools: ["codex", "antigravity"], widgetToolCount: 3 });
  assert.deepEqual(plain(get(app.widgetEvent()).rows.map((r) => [r.id, r.available])), [["antigravity", 2], ["codex", 0]], "tools follow the app's order");
  update(app.event(), { widgetToolCount: 1 });
  assert.equal(get(app.widgetEvent()).rows.length, 1, "the tool count caps the rows");
  update(app.event(), { widgetTools: [], widgetToolCount: 3 });
  assert.deepEqual(plain(get(app.widgetEvent()).rows.map((r) => r.id)), ["antigravity", "codex", "claude"], "no selection means every tool");
});

test("widget layout, tool and always-on-top settings are validated, persisted, and pruned when a tool is deleted", async (t) => {
  const app = await harness(t, widgetData());
  const update = app.handlers.get("preferences:update"), get = app.handlers.get("preferences:get");
  const ev = app.event();
  assert.throws(() => update(ev, { widgetLayout: "wide" }), /Compact, Standard/);
  for (const bad of [0, 7, 2.5, "3", null]) assert.throws(() => update(ev, { widgetToolCount: bad }), /between 1 and 6/);
  assert.throws(() => update(ev, { widgetTools: ["missing"] }), /existing tools/);
  assert.throws(() => update(ev, { widgetTools: "codex" }), /existing tools/);
  assert.throws(() => update(ev, { widgetAlwaysOnTop: "yes" }), /Invalid setting value/);
  assert.deepEqual(plain({ l: get(ev).widgetLayout, c: get(ev).widgetToolCount, o: get(ev).widgetAlwaysOnTop, t: get(ev).widgetTools }), { l: "standard", c: 3, o: false, t: [] }, "defaults");
  update(ev, { widgetLayout: "multi", widgetTools: ["codex", "codex", "claude"], widgetToolCount: 2, widgetAlwaysOnTop: true });
  const restarted = await harness(t, app.data());
  const saved = restarted.handlers.get("preferences:get")(restarted.event());
  assert.deepEqual(plain({ l: saved.widgetLayout, c: saved.widgetToolCount, o: saved.widgetAlwaysOnTop, t: saved.widgetTools }), { l: "multi", c: 2, o: true, t: ["codex", "claude"] });
  const base = app.handlers.get("state:get")(ev), next = D.clone(base);
  next.accounts = next.accounts.filter((a) => a.providerId !== "codex");
  next.providers = next.providers.filter((p) => p.id !== "codex");
  app.handlers.get("state:commit")(ev, base, next);
  assert.deepEqual(plain(get(ev).widgetTools), ["claude"], "a deleted tool leaves the selection");
});

test("the widget is told only about changes that alter what it shows, and never gets storage notifications", async (t) => {
  const app = await harness(t, widgetData());
  const update = app.handlers.get("preferences:update"), get = app.handlers.get("widget:summary-get");
  update(app.event(), { widgetVisible: true });
  const widget = app.windows[1];
  get(app.widgetEvent()); // the page's first pull is the baseline
  app.powerMonitor.emit("resume"); app.powerMonitor.emit("resume");
  assert.equal(summaries(app).length, 0, "nothing changed, nothing sent");

  const base = app.handlers.get("state:get")(app.event()), next = D.clone(base);
  next.accounts = next.accounts.filter((a) => a.id !== "a1");
  app.handlers.get("state:commit")(app.event(), base, next);
  assert.equal(summaries(app).length, 1);
  assert.equal(summaries(app)[0].rows[0].available, 1);
  assert.ok(!(widget.sends || []).some((s) => s[0] === "storage:changed"), "the widget does not reload accounts on every write");

  app.advance(3 * 3600e3 + 1000); // the 15:00 reset passes: the account becomes "expected ready" with no user action
  app.powerMonitor.emit("resume");
  assert.equal(summaries(app).length, 2);
  assert.equal(summaries(app)[1].rows[0].ready, 2);
  update(app.event(), { privacy: true });
  assert.equal(summaries(app).length, 2, "an unrelated setting does not wake the widget");
});

test("always on top builds a floating window, skips the desktop helper on Windows, and can be turned off again", async (t) => {
  const linux = await harness(t, widgetData(), "linux");
  const update = linux.handlers.get("preferences:update");
  update(linux.event(), { widgetVisible: true });
  const first = linux.windows[1];
  assert.deepEqual(plain({ onTop: first.options.alwaysOnTop, type: first.options.type }), { onTop: false, type: "desktop" });
  update(linux.event(), { widgetAlwaysOnTop: true });
  assert.equal(first.destroyed, true, "the old window is released");
  const second = linux.windows[2];
  second.emit("ready-to-show");
  assert.deepEqual({ onTop: second.options.alwaysOnTop, type: second.options.type, floating: second.onTop, visible: second.visible }, { onTop: true, type: undefined, floating: true, visible: true });
  assert.notEqual(second.activated, true, "floating never steals focus");
  update(linux.event(), { widgetAlwaysOnTop: true });
  assert.equal(linux.windows.length, 3, "setting the same value builds nothing");
  update(linux.event(), { widgetAlwaysOnTop: false });
  assert.equal(linux.windows[3].options.type, "desktop");

  const win = await harness(t, widgetData(), "win32");
  win.controls.desktopActive = false; // another app is in front
  win.handlers.get("preferences:update")(win.event(), { widgetAlwaysOnTop: true, widgetVisible: true });
  const floating = win.windows[1];
  floating.emit("ready-to-show");
  assert.equal(win.controls.desktopChanged, undefined, "no native helper process is started");
  assert.equal(floating.visible, true, "visible even though another app is active");
  win.handlers.get("preferences:update")(win.event(), { widgetAlwaysOnTop: false });
  const desktop = win.windows[2];
  desktop.emit("ready-to-show");
  assert.equal(typeof win.controls.desktopChanged, "function", "the helper returns for the desktop-only behaviour");
  assert.equal(desktop.visible, false, "and the widget hides while another app is active");
});

test("the widget window follows the size its page reports, within limits, and ignores other senders", async (t) => {
  const app = await harness(t, widgetData());
  app.handlers.get("preferences:update")(app.event(), { widgetVisible: true });
  const widget = app.windows[1];
  widget.bounds = { x: 100, y: 100, width: 304, height: 190 };
  app.ipcMain.emit("widget:resize", app.widgetEvent(), { width: 200, height: 104 });
  assert.deepEqual(plain([widget.bounds.width, widget.bounds.height]), [200, 104]);
  app.ipcMain.emit("widget:resize", app.widgetEvent(), { width: 9999, height: 9999 });
  assert.deepEqual(plain([widget.bounds.width, widget.bounds.height]), [420, 560]);
  app.ipcMain.emit("widget:resize", app.widgetEvent(), 300);
  assert.deepEqual(plain([widget.bounds.width, widget.bounds.height]), [420, 300], "a bare number still means height");
  const before = plain(widget.bounds);
  app.ipcMain.emit("widget:resize", app.event(), { width: 150, height: 150 });
  app.ipcMain.emit("widget:resize", app.widgetEvent(), { width: 150, height: NaN });
  assert.deepEqual(plain(widget.bounds), before);
});

test("native widget menus change the tool and layout through the same validated path", async (t) => {
  const app = await harness(t, widgetData());
  const get = app.handlers.get("preferences:get");
  app.handlers.get("preferences:update")(app.event(), { widgetVisible: true });
  app.ipcMain.emit("widget:tool-menu", app.event());
  assert.equal(app.popups.length, 0, "only the widget itself can open its menus");
  app.ipcMain.emit("widget:tool-menu", app.widgetEvent());
  const tools = app.popups.at(-1).items;
  assert.deepEqual(plain(tools.filter((i) => i.type !== "separator").map((i) => [i.label, i.checked])), [["All tools", true], ["Antigravity", false], ["Codex", false], ["Claude Code", false]]);
  tools.find((i) => i.label === "Codex").click();
  assert.equal(get(app.event()).widgetProviderId, "codex");

  app.ipcMain.emit("widget:context-menu", app.widgetEvent());
  const items = app.popups.at(-1).items;
  items.find((i) => i.label === "Layout").submenu.find((i) => i.label === "Compact").click();
  assert.equal(get(app.event()).widgetLayout, "compact");
  items.find((i) => i.label === "Always on top").click({ checked: true });
  assert.equal(get(app.event()).widgetAlwaysOnTop, true);
  const widget = app.windows.at(-1);
  items.find((i) => i.label === "Widget settings…").click();
  assert.equal(app.windows[0].sent[0], "widgets:configure");
  items.find((i) => i.label === "Hide widget").click();
  assert.equal(get(app.event()).widgetVisible, false);
  assert.equal(widget.destroyed, true);
});

test("a second launch during startup opens the window once the app is ready instead of failing", async (t) => {
  const app = await harness(t, widgetData(), "linux", ["--hidden"], { deferReady: true });
  assert.doesNotThrow(() => app.app.emit("second-instance"));
  assert.equal(app.windows.length, 0, "no window can be built before ready");
  app.release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.windows.length, 1);
});

test("the tray tooltip is only set again when its text changes", async (t) => {
  const app = await harness(t, dataWithTimer());
  const calls = () => app.trays[0].tooltipCalls;
  const first = calls();
  app.powerMonitor.emit("resume"); app.powerMonitor.emit("resume");
  assert.equal(calls(), first, "same text, no system call");
  app.advance(3000); app.powerMonitor.emit("resume");
  assert.equal(calls(), first + 1, "changed text is applied");
});
