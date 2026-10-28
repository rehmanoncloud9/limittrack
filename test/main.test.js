const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const D = require("../domain");

async function harness(t, data) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "limittrack-main-"));
  t.after(() => {
    const resolved = fs.realpathSync(directory);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith("limittrack-main-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const filename = path.join(directory, "limittrack-data.json");
  fs.writeFileSync(filename, JSON.stringify(data));
  let time = Date.parse("2026-10-27T12:00:00Z");
  class Clock extends Date { static now() { return time; } }
  const windows = [], notifications = [], handlers = new Map(), dialogs = [], intervals = [];
  const app = new EventEmitter();
  Object.assign(app, { getPath: () => directory, requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), setAppUserModelId() {}, quit() { app.quitCalled = true; } });
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, { id: windows.length + 1, mainFrame: {}, setWindowOpenHandler() {}, send: (...args) => { this.sent = args; } });
      windows.push(this);
    }
    static getAllWindows() { return windows; }
    loadFile() {} show() { this.visible = true; } hide() { this.visible = false; }
    focus() {} isDestroyed() { return false; } isVisible() { return !!this.visible; }
    setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {}
    getBounds() { return this.bounds; } setBounds(bounds) { this.bounds = bounds; }
  }
  const ipcMain = new EventEmitter(); ipcMain.handle = (key, handler) => handlers.set(key, handler);
  const powerMonitor = new EventEmitter();
  const controls = { failNotification: false };
  class NativeNotification extends EventEmitter {
    constructor(options) { super(); this.options = options; notifications.push(this); }
    static isSupported() { return true; }
    show() { this.emit(controls.failNotification ? "failed" : "show"); }
  }
  class Tray extends EventEmitter { setToolTip(text) { this.text = text; } setContextMenu(menu) { this.menu = menu; } }
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const electron = { app, ipcMain, BrowserWindow: Window, Tray, Notification: NativeNotification, powerMonitor,
    Menu: { buildFromTemplate: (items) => ({ getMenuItemById: (id) => items.find((item) => item.id === id) }) },
    nativeImage: { createFromPath: () => ({ resize() { return this; } }) }, shell: { openExternal() {} },
    screen: { getDisplayNearestPoint: () => ({ workArea }), getPrimaryDisplay: () => ({ workArea }) },
    dialog: { showErrorBox: (...args) => dialogs.push(args), showMessageBox: (...args) => dialogs.push(args) },
  };
  const context = vm.createContext({ require: (name) => name === "electron" ? electron : name === "./domain" ? D : name === "./store" ? require("../store") : require(name),
    __dirname: path.resolve(__dirname, ".."), process, console, Date: Clock, setInterval: (callback) => { intervals.push(callback); return intervals.length; }, clearInterval() {}, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(require.resolve("../main"), "utf8"), context);
  await new Promise((resolve) => setImmediate(resolve));
  return { app, windows, notifications, handlers, dialogs, controls, powerMonitor, ipcMain,
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
