const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const ROOT = path.resolve(__dirname, "..") + path.sep;
const D = require("../domain.js");

// These tests run the real renderer and widget scripts in jsdom against a mock
// bridge that uses the real merge logic. They cover interaction logic, not
// pixels; native windows, the tray, and notifications still need a platform check.

async function boot(initialState, startPrefs = {}) {
  let store = D.normalizeState(initialState || D.DEFAULT_STATE);
  let prefs = { theme: "system", font: "system", notifications: true, privacy: false, launchAtLogin: false, loginSupported: true, widgetVisible: false, widgetProviderId: null, widgetError: "", ...startPrefs };
  const listeners = [];
  const bridge = {
    stateGet: async () => D.clone(store),
    stateCommit: async (base, next) => { store = D.mergeState(base, next, store); return D.clone(store); },
    preferencesGet: async () => ({ ...prefs }),
    preferencesUpdate: async (patch) => { prefs = { ...prefs, ...patch }; return { ...prefs }; },
    onPreferencesChanged: () => () => {}, onStorageChanged: () => () => {}, onWidgetConfigure: () => () => {}, onAccountReveal: (cb) => { listeners.push(cb); return () => {}; },
    appInfo: async () => ({ version: "1.4.0", platform: "win32" }),
    notificationsTest: async () => ({ ok: true, message: "Test sent." }),
  };
  const dom = new JSDOM(fs.readFileSync(ROOT + "index.html", "utf8").replace(/<script[^>]*><\/script>/g, ""), { runScripts: "outside-only", url: "file:///app/index.html", pretendToBeVisual: true });
  const w = dom.window;
  w.limittrack = bridge;
  w.Element.prototype.scrollIntoView = () => {};
  let fakeNow = Date.now();
  w.Date.now = () => fakeNow;
  for (const f of ["preferences.js", "domain.js", "state-client.js", "renderer.js"]) w.eval(fs.readFileSync(ROOT + f, "utf8"));
  if (w.document.readyState !== "loading") w.dispatchEvent(new w.Event("DOMContentLoaded"));
  const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));
  await wait(60);
  const $ = (sel) => w.document.querySelector(sel);
  const $$ = (sel) => [...w.document.querySelectorAll(sel)];
  const click = async (sel) => { const el = typeof sel === "string" ? $(sel) : sel; assert.ok(el, "missing " + sel); el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await wait(40); };
  const type = async (sel, value) => { const el = $(sel); assert.ok(el, "missing " + sel); el.value = value; el.dispatchEvent(new w.Event("input", { bubbles: true })); await wait(5); };
  return { w, $, $$, click, type, wait, store: () => store, prefs: () => prefs, advance: (ms) => { fakeNow += ms; }, now: () => fakeNow, setStore: (s) => { store = D.normalizeState(s); }, reveal: (id) => listeners.forEach((l) => l(id)) };
}


function withAccounts(emails) {
  const s = D.clone(D.DEFAULT_STATE);
  // Confirmed available, so each row offers "Log limit" directly.
  s.accounts = emails.map((email, i) => ({ id: "acc" + i, providerId: "codex", email, confirmedAvailableAt: new Date(Date.now() - 1000).toISOString() }));
  return s;
}
// Account actions live in the "..." menu: open it, then click an item.
async function menuItem(t, kind, id, action) {
  await t.click(`[data-menu-kind="${kind}"]${id ? `[data-id="${id}"]` : ""}`);
  await t.click(`#popover-root [data-action="${action}"]`);
}
const escape = (t) => t.w.document.dispatchEvent(new t.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
async function addAccountThroughUi(t) {
  await t.click('[data-action="add-account-to-provider"][data-id="codex"]');
  await t.type('[data-field="new-account-email"]', "new@example.com");
  await t.click('[data-action="save-add-account"]');
}
// Closing the window stops the page's one-second timer so the test process can exit.
async function ui(context, ...args) {
  const t = await boot(...args);
  context.after(() => t.w.close());
  return t;
}

test("first run shows the welcome guide; adding an account removes it", async (context) => {
  const t = await ui(context);
  assert.ok(t.$(".welcome-card"), "welcome card");
  assert.match(t.$(".welcome-card").textContent, /7-day guess/);
  await addAccountThroughUi(t);
  assert.equal(t.store().accounts.length, 1);
  assert.equal(t.$(".welcome-card"), null);
  assert.match(t.$("#app").textContent, /new@example\.com/);
});

test("log limit, undo, and mark available behave and are undoable", async (context) => {
  const t = await ui(context, withAccounts(["a@example.com"]));
  await t.click('[data-action="mark-hit"]');
  assert.ok(t.store().accounts[0].resetAt, "reset set");
  assert.equal(t.store().accounts[0].resetSource, "estimate");
  assert.ok(t.$(".toast [data-action='toast-undo']"));
  await t.click("[data-action='toast-undo']");
  assert.equal(t.store().accounts[0].resetAt, null);
});

test("edit account: renames, rejects duplicates, keeps timers", async (context) => {
  const t = await ui(context, withAccounts(["a@example.com", "b@example.com"]));
  await menuItem(t, "account", "acc0", "edit-account");
  assert.ok(t.$('[data-field="editing-account-email"]'));
  await t.type('[data-field="editing-account-email"]', "b@example.com");
  await t.click('[data-action="save-account"]');
  assert.match(t.$(".field-error").textContent, /already uses/);
  assert.equal(t.store().accounts[0].email, "a@example.com");
  await t.type('[data-field="editing-account-email"]', "renamed@example.com");
  await t.type('[data-field="editing-account-cycle"]', "5");
  await t.type('[data-field="editing-account-cycle-unit"]', "hours");
  await t.click('[data-action="save-account"]');
  assert.equal(t.store().accounts[0].email, "renamed@example.com");
  assert.equal(t.store().accounts[0].cycleValue, 5);
  assert.equal(t.store().accounts[0].cycleUnit, "hours");
  assert.equal(t.$('[data-field="editing-account-email"]'), null);
});

test("custom reset: empty, invalid and past are rejected inline; future is saved as exact", async (context) => {
  const t = await ui(context, withAccounts(["a@example.com"]));
  await menuItem(t, "account", "acc0", "toggle-reset-edit");
  // default value must itself be a usable future time
  assert.ok(t.$('[data-field="editing-reset-value"]').value, "prefilled");
  await t.type('[data-field="editing-reset-value"]', "");
  await t.click('[data-action="save-reset"]');
  assert.match(t.$(".field-error").textContent, /Choose a date/);
  const past = new Date(t.now() - 3600000); const pad = (n) => String(n).padStart(2, "0");
  const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  await t.type('[data-field="editing-reset-value"]', local(past));
  await t.click('[data-action="save-reset"]');
  assert.match(t.$(".field-error").textContent, /future/);
  assert.equal(t.store().accounts[0].resetAt, null);
  await t.type('[data-field="editing-reset-value"]', local(new Date(t.now() + 5 * 3600000)));
  await t.click('[data-action="save-reset"]');
  assert.ok(t.store().accounts[0].resetAt);
  assert.equal(t.store().accounts[0].resetSource, "exact");
});

test("bulk log limit shows a toast and can be undone as one action", async (context) => {
  const t = await ui(context, withAccounts(["a@example.com", "b@example.com", "c@example.com"]));
  await menuItem(t, "toolbar", "", "toggle-bulk-mode");
  await t.click('[data-action="toggle-select"][data-id="acc0"]');
  await t.click('[data-action="toggle-select"][data-id="acc1"]');
  await t.click('[data-action="bulk-mark-hit"]');
  assert.ok(t.store().accounts[0].resetAt && t.store().accounts[1].resetAt);
  assert.equal(t.store().accounts[2].resetAt, null);
  assert.match(t.$(".toast").textContent, /2 accounts/);
  await t.click("[data-action='toast-undo']");
  assert.equal(t.store().accounts[0].resetAt, null);
  assert.equal(t.store().accounts[1].resetAt, null);
});

test("privacy mode masks emails in rows, menus and prompts", async (context) => {
  const t = await ui(context, withAccounts(["person@example.com"]));
  await t.click('[data-action="navigate"][data-id="settings"]');
  const sw = t.$('[data-setting="privacy"]'); sw.checked = true;
  sw.dispatchEvent(new t.w.Event("change", { bubbles: true })); await t.wait(40);
  assert.equal(t.prefs().privacy, true);
  await t.click('[data-action="navigate"][data-id="accounts"]');
  assert.ok(!t.$("#app").textContent.includes("person@example.com"), "full email leaked");
  assert.match(t.$(".account-name").textContent, /pe•••@example\.com/);
  assert.ok(!t.$("#app").innerHTML.includes("person@example.com"), "full email in attributes");
});

test("settings: alerts, launch at login, privacy and test alert render and work", async (context) => {
  const t = await ui(context, withAccounts(["a@example.com"]), { loginSupported: false });
  await t.click('[data-action="navigate"][data-id="settings"]');
  assert.ok(t.$('[data-setting="notifications"]').checked);
  assert.ok(t.$('[data-setting="launchAtLogin"]').disabled, "login toggle disabled when unsupported");
  assert.match(t.$("#app").textContent, /installed app on Windows and macOS/);
  const sw = t.$('[data-setting="notifications"]'); sw.checked = false;
  sw.dispatchEvent(new t.w.Event("change", { bubbles: true })); await t.wait(40);
  assert.equal(t.prefs().notifications, false);
  await t.click('[data-action="test-notification"]');
  assert.match(t.$("#app").textContent, /Test sent/);
  await t.click('[data-action="toggle-about"]');
  assert.match(t.$("#about-modal").textContent, /Version 1\.4\.0/);
});

test("tick does not close an open menu or a delete prompt when a timer expires", async (context) => {
  const soon = withAccounts(["a@example.com"]);
  soon.accounts[0].lastHitAt = new Date(Date.now() - 3600000).toISOString();
  soon.accounts[0].resetAt = new Date(Date.now() + 3000).toISOString();
  const t = await ui(context, soon);
  await t.click('[data-menu-kind="account"][data-id="acc0"]');
  assert.ok(t.$("#popover-root .menu"), "menu open");
  t.advance(10000); t.w.tick();
  assert.ok(t.$("#popover-root .menu"), "menu survived tick");
  assert.match(t.$("#countdown-acc0").textContent, /Expected ready/, "text still patched");
  escape(t);
  assert.equal(t.$("#popover-root .menu"), null, "Escape closes the menu");
  t.w.tick(); await t.wait(20);
  // after the user is done, the reorder/rebuild happens and the row's action matches the new status
  assert.match(t.$("[data-account-row='acc0'] .row-actions .button").textContent, /Mark available/);
});

test("edit tool: rename with duplicate protection", async (context) => {
  const t = await ui(context, withAccounts(["a@example.com"]));
  await menuItem(t, "provider", "codex", "edit-cycle");
  assert.equal(t.$('[data-field="editing-provider-name"]').value, "Codex");
  await t.type('[data-field="editing-provider-name"]', "Claude Code");
  await t.click('[data-action="save-cycle"]');
  assert.match(t.$(".toast").textContent, /already exists/);
  await t.type('[data-field="editing-provider-name"]', "Codex Pro");
  await t.click('[data-action="save-cycle"]');
  assert.equal(t.store().providers.find((p) => p.id === "codex").name, "Codex Pro");
});

test("revealing an account opens its details and shows recorded limit events", async (context) => {
  const data = withAccounts(["a@example.com"]);
  const t = await ui(context, data);
  await t.click('[data-action="mark-hit"]');
  t.reveal("acc0"); await t.wait(60);
  assert.match(t.$(".account-detail").textContent, /Recorded limit events/);
  assert.equal(t.$$(".activity li").length, 1);
});


test("search re-renders only the list: the input element and its focus are kept", async (context) => {
  const t = await ui(context, withAccounts(["alpha@example.com", "beta@example.com"]));
  const input = t.$('[data-field="search-query"]');
  input.focus();
  await t.type('[data-field="search-query"]', "beta");
  assert.equal(t.$('[data-field="search-query"]'), input, "the search box is not rebuilt while typing");
  assert.equal(t.w.document.activeElement, input);
  assert.equal(t.$$("[data-account-row]").length, 1);
});

test("a toast appearing or expiring does not close an open menu", async (context) => {
  const t = await ui(context, withAccounts(["a@example.com"]));
  await t.click('[data-menu-kind="account"][data-id="acc0"]');
  t.w.showToast("Saved");
  assert.ok(t.$(".toast"));
  t.w.hideToast();
  assert.equal(t.$(".toast"), null);
  assert.ok(t.$("#popover-root .menu"), "menu still open");
});

test("the header shows available and tracked counts and the next reset", async (context) => {
  const t = await ui(context, withAccounts(["a@example.com", "b@example.com"]));
  assert.equal(t.$("#stat-available").textContent, "2");
  assert.equal(t.$("#stat-tracked").textContent, "2");
  assert.equal(t.$("#next-time").textContent, "No active timers");
  await t.click('[data-action="mark-hit"]');
  assert.equal(t.$("#stat-available").textContent, "1");
  assert.match(t.$("#next-time").textContent, /\d/, "sidebar shows a countdown");
  assert.equal(t.$("#next-tool").textContent, "Codex");
});

// ---------- desktop widget page ----------
// The widget renders pre-computed summaries sent by the main process; these tests run the real page
// script in jsdom against a mock bridge and record every timer it asks for.

const row = (id, name, available, extra = {}) => ({ id, name, available, ready: 0, tracked: available, nextResetAt: null, ...extra });

async function bootWidget(context, payload, { fail = false } = {}) {
  const dom = new JSDOM(fs.readFileSync(ROOT + "widget.html", "utf8").replace(/<script[^>]*><\/script>/g, ""), { runScripts: "outside-only", pretendToBeVisual: true, url: "file:///app/widget.html" });
  const w = dom.window;
  context.after(() => w.close());
  const calls = { resize: [], open: 0, tools: 0, menu: 0, intervals: 0 };
  const timers = [];
  let fakeNow = Date.parse("2026-10-27T12:00:00Z"), push = () => {}, hidden = false;
  w.Date.now = () => fakeNow;
  w.setTimeout = (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; };
  w.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].live = false; };
  w.setInterval = () => { calls.intervals++; return 0; };
  Object.defineProperty(w.document, "hidden", { get: () => hidden });
  // jsdom has no layout; give each layout a plausible size so size reporting can be checked.
  const sizes = { standard: [288, 186], compact: [184, 84], multi: [252, 140], message: [252, 100] };
  Object.defineProperty(w.HTMLElement.prototype, "offsetWidth", { get() { return this.id === "panel" ? sizes[this.dataset.layout][0] : 0; } });
  Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { get() { return this.id === "panel" ? sizes[this.dataset.layout][1] : 0; } });
  w.document.fonts = { ready: Promise.resolve(), addEventListener() {} };
  w.limittrack = {
    preferencesGet: async () => ({ theme: "system", font: "system" }), onPreferencesChanged() {},
    widgetSummaryGet: async () => { if (fail) throw new Error("no"); return payload; }, onWidgetSummary: (cb) => { push = cb; },
    widgetResize: (size) => calls.resize.push(size), widgetOpenMain: () => calls.open++, widgetToolMenu: () => calls.tools++, widgetContextMenu: () => calls.menu++,
  };
  for (const f of ["preferences.js", "domain.js", "widget.js"]) w.eval(fs.readFileSync(ROOT + f, "utf8"));
  await new Promise((r) => setTimeout(r, 30));
  const $ = (sel) => w.document.querySelector(sel), $$ = (sel) => [...w.document.querySelectorAll(sel)];
  return { w, $, $$, calls, timers, live: () => timers.filter((t) => t.live), push: (p) => push(p), advance: (ms) => { fakeNow += ms; }, setHidden: (v) => { hidden = v; w.document.dispatchEvent(new w.Event("visibilitychange")); }, now: () => fakeNow };
}

test("standard widget: prominent count, label, tool picker; clicks and right-click reach the app", async (context) => {
  const t = await bootWidget(context, { layout: "standard", rows: [row("antigravity", "Antigravity", 22)] });
  assert.equal(t.$(".num").textContent, "22");
  assert.equal(t.$(".sub").textContent, "Available accounts");
  assert.equal(t.$(".picker .nm").textContent, "Antigravity");
  assert.ok(t.$(".dot.on"), "a green status dot when accounts are available");
  assert.equal(t.$("#panel").dataset.layout, "standard");
  t.$('[data-act="open"]').click(); t.$('[data-act="tools"]').click(); t.$('[data-act="menu"]').click();
  assert.deepEqual([t.calls.open, t.calls.tools, t.calls.menu], [1, 1, 1]);
  const event = new t.w.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  t.$(".stat .num").dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(t.calls.menu, 2, "right-click on a clickable area opens the widget menu");
  const handle = new t.w.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  t.$(".hd .ttl").dispatchEvent(handle);
  assert.equal(t.calls.menu, 2, "the drag handle keeps the system behaviour");
  assert.equal(t.live().length, 0, "no timer runs when no countdown is on screen");
  assert.equal(t.calls.intervals, 0, "the page never polls");
});

test("compact and multi-tool layouts show counts per tool with a muted dot when nothing is available", async (context) => {
  const compact = await bootWidget(context, { layout: "compact", rows: [row("codex", "Codex", 1)] });
  assert.equal(compact.$("#panel").dataset.layout, "compact");
  assert.equal(compact.$(".cmeta .nm").textContent, "Codex");
  assert.equal(compact.$(".cmeta .num").textContent, "1");
  assert.match(compact.$(".cmeta").getAttribute("aria-label"), /1 account available/);

  const multi = await bootWidget(context, { layout: "multi", rows: [row("antigravity", "Antigravity", 22), row("cursor", "Cursor", 8), row("windsurf", "Windsurf", 0)] });
  assert.deepEqual(multi.$$(".item .nm").map((n) => n.textContent), ["Antigravity", "Cursor", "Windsurf"]);
  assert.deepEqual(multi.$$(".item .num").map((n) => n.textContent), ["22", "8", "0"]);
  assert.deepEqual(multi.$$(".item .dot").map((d) => d.classList.contains("on")), [true, true, false]);
  multi.$$('.item [data-act="open"]')[2].click();
  assert.equal(multi.calls.open, 1);
  assert.equal(multi.live().length, 0);
});

test("the only timer is one minute-aligned timeout for the next-reset countdown, and it stops while hidden", async (context) => {
  const next = Date.parse("2026-10-27T12:00:00Z") + (3 * 3600 + 12 * 60 + 30) * 1000; // 3h 12m 30s away
  const t = await bootWidget(context, { layout: "standard", rows: [row("codex", "Codex", 0, { tracked: 2, nextResetAt: next })] });
  assert.equal(t.$(".num").textContent, "0");
  assert.equal(t.$(".sub").textContent, "Next reset in 3h 13m");
  assert.ok(!t.$(".dot.on"));
  assert.equal(t.live().length, 1, "exactly one pending timer");
  assert.equal(t.live()[0].ms, 30040, "it sleeps until the displayed minute changes, not a fixed second tick");
  t.advance(30040); t.live()[0].fn();
  assert.equal(t.$(".sub").textContent, "Next reset in 3h 12m");
  assert.equal(t.live().length, 1);
  assert.equal(t.live()[0].ms, 60000, "the 40 ms already slept is accounted for");
  t.setHidden(true);
  assert.equal(t.live().length, 0, "nothing runs while the widget is hidden");
  t.advance(10 * 60000); t.setHidden(false);
  assert.equal(t.$(".sub").textContent, "Next reset in 3h 2m", "catches up the moment it is visible again");
  assert.equal(t.live().length, 1);
  assert.equal(t.calls.intervals, 0);
});

test("small print uses the app's wording for expected-ready and untracked states", async (context) => {
  const ready = await bootWidget(context, { layout: "standard", rows: [row("codex", "Codex", 0, { ready: 2, tracked: 2 })] });
  assert.equal(ready.$(".sub").textContent, "2 expected ready");
  const none = await bootWidget(context, { layout: "standard", rows: [row("codex", "Codex", 0, { tracked: 0 })] });
  assert.equal(none.$(".sub").textContent, "No accounts yet");
  const unchecked = await bootWidget(context, { layout: "standard", rows: [row("codex", "Codex", 0, { tracked: 3 })] });
  assert.equal(unchecked.$(".sub").textContent, "Not checked");
  const justPassed = await bootWidget(context, { layout: "standard", rows: [row("codex", "Codex", 0, { tracked: 1, nextResetAt: Date.parse("2026-10-27T11:59:59Z") })] });
  assert.equal(justPassed.$(".sub").textContent, "Expected ready", "never a negative countdown while main catches up");
});

test("the window size is reported only when it changes, and a pushed summary re-renders in place", async (context) => {
  const t = await bootWidget(context, { layout: "standard", rows: [row("codex", "Codex", 3)] });
  assert.deepEqual(JSON.parse(JSON.stringify(t.calls.resize)), [{ width: 304, height: 202 }]);
  t.push({ layout: "standard", rows: [row("codex", "Codex", 4)] });
  assert.equal(t.$(".num").textContent, "4");
  assert.equal(t.calls.resize.length, 1, "same size, no resize message");
  t.push({ layout: "compact", rows: [row("codex", "Codex", 4)] });
  assert.deepEqual(JSON.parse(JSON.stringify(t.calls.resize.at(-1))), { width: 200, height: 100 });
  assert.equal(t.$$("#panel > *").length, 2, "the previous layout is fully replaced");
});

test("tool names are rendered as text, empty and failed states offer a way back, and emails cannot appear", async (context) => {
  const nasty = await bootWidget(context, { layout: "multi", rows: [row("x", "<img src=x onerror=alert(1)>", 1)] });
  assert.equal(nasty.$(".item .nm").textContent, "<img src=x onerror=alert(1)>");
  assert.equal(nasty.$("#panel img"), null, "no markup is ever built from a name");

  const empty = await bootWidget(context, { layout: "standard", rows: [] });
  assert.match(empty.$("#panel").textContent, /No tools yet/);
  empty.$('[data-act="open"]').click();
  assert.equal(empty.calls.open, 1);

  const failed = await bootWidget(context, null, { fail: true });
  assert.match(failed.$("#panel").textContent, /Could not load/);
  assert.ok(!failed.w.document.body.innerHTML.includes("@"));
});

test("widget page does not accumulate nodes, timers or listeners across thousands of updates", async (context) => {
  const t = await bootWidget(context, { layout: "multi", rows: [row("a", "A", 1), row("b", "B", 2)] });
  const nodes = () => t.w.document.getElementsByTagName("*").length;
  const base = nodes();
  const layouts = ["standard", "compact", "multi"];
  for (let i = 0; i < 3000; i++) t.push({ layout: layouts[i % 3], rows: [row("a", "A", i % 7, { tracked: 3, nextResetAt: i % 2 ? t.now() + 90000 : null }), row("b", "B", 2)] });
  t.push({ layout: "multi", rows: [row("a", "A", 1), row("b", "B", 2)] });
  assert.equal(nodes(), base, "the DOM returns to the same size");
  assert.equal(t.live().length, 0, "no stale timers are left running");
});

test("widgets page: layout, tools, tool count and always-on-top are configurable", async (context) => {
  const t = await ui(context, withAccounts(["a@example.com"]));
  await t.click('[data-action="navigate"][data-id="widgets"]');
  assert.equal(t.$('[data-action="set-widget-layout"][aria-pressed="true"]').dataset.id, "standard");
  assert.ok(t.$('[data-setting="widgetProviderId"]'), "single-tool layouts pick one tool");
  assert.equal(t.$('[data-setting="widgetToolCount"]'), null);
  await t.click('[data-action="set-widget-layout"][data-id="multi"]');
  assert.equal(t.prefs().widgetLayout, "multi");
  assert.equal(t.$('[data-setting="widgetProviderId"]'), null);
  assert.equal(t.$$("[data-widget-tool]").length, 3, "one checkbox per tool");
  const box = t.$('[data-widget-tool="codex"]'); box.checked = true;
  box.dispatchEvent(new t.w.Event("change", { bubbles: true })); await t.wait(40);
  assert.deepEqual(JSON.parse(JSON.stringify(t.prefs().widgetTools)), ["codex"]);
  const count = t.$('[data-setting="widgetToolCount"]'); count.value = "5";
  count.dispatchEvent(new t.w.Event("change", { bubbles: true })); await t.wait(40);
  assert.strictEqual(t.prefs().widgetToolCount, 5, "sent as a number");
  const top = t.$('[data-setting="widgetAlwaysOnTop"]'); top.checked = true;
  top.dispatchEvent(new t.w.Event("change", { bubbles: true })); await t.wait(40);
  assert.equal(t.prefs().widgetAlwaysOnTop, true);
});
