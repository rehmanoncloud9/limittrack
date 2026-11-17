// LimitTrack main window.
//
// Rendering is split into independent regions so that nothing rebuilds more than it must:
//   #content       the active page (Accounts / Widgets / Settings)
//   #tool-list     only the tool cards, inside the Accounts page; search and filters re-render just this
//   #popover-root  the "..." menus      #toast-root  toasts      #modal-root  the About dialog
// The one-second timer only patches text in existing nodes and stops while the window is hidden.

const { STORAGE_KEY, DEFAULT_STATE, getStatus, effectiveTime } = window.LimitTrackDomain;
const Domain = window.LimitTrackDomain;
const dataClient = window.createLimitTrackClient(window.limittrack);
let persistenceError = "";

let state = JSON.parse(JSON.stringify(DEFAULT_STATE));
let editingProviderId = null;
let editingCycleValue = "";
let editingCycleUnit = "days";
let editingResetId = null;
let editingResetValue = "";
let editingResetError = "";
let editingProviderName = "";
let editingAccountId = null;
let accountDraft = { email: "", cycleValue: "", cycleUnit: "days" };
let accountEditError = "";
let appVersion = "";
let notificationMessage = "";
let showAddAccount = false;
let addAccountProviderId = null;
let showAddProvider = false;
let showAbout = false;
let activeView = "accounts";
let mountedView = null; // which page currently owns #content
let expandedAccountId = null;
let preferences = window.LimitTrackPreferences.current();
let preferencesBusy = false;
let preferencesError = "";
let preferencesMessage = "";
let pendingImport = null;
let restartNeeded = false;
let newAccountDraft = { providerId: "", email: "", cycleValue: "", cycleUnit: "days" };
let newProviderDraft = { name: "", cycleValue: "7", cycleUnit: "days" };
let prevStatus = new Map();
let rowRefs = [];
let accountById = new Map();

// safety: inline delete-confirm state, undo buffer, toast
let pendingDeleteAccountId = null;
let pendingDeleteProviderId = null;
let lastDeleted = null; // { kind: 'account'|'provider'|'account-change'|'bulk-change', ... }
let toast = null; // { message }
let toastTimer = null;

// daily use: search / filter / sort / bulk selection
let searchQuery = "";
let statusFilter = "all";
let sortMode = "soonest"; // 'soonest' | 'alpha'
let bulkMode = false;
let selectedIds = new Set();

let popover = null; // { anchor, kind, id }
let aboutOpenerEl = null;
let tickTimer = null;

const $ = (id) => document.getElementById(id);

// ---------- small helpers ----------

function normalizeUnit(unit) { return unit === "hours" ? "hours" : "days"; }
function cycleLabel(value, unit) { return `${Number(value) || 0}-${normalizeUnit(unit) === "hours" ? "hour" : "day"} cycle`; }
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function formatCountdown(acc, nowMs) { return Domain.formatCountdown(acc, nowMs); }
function isWaiting(status) { return status === "locked" || status === "soon"; }

function formatWhen(iso) {
  if (!iso) return "never";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
}

function toLocalInputValue(iso) {
  const d = iso ? new Date(iso) : new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatRelativePreview(localValue) {
  if (!localValue) return "";
  const target = new Date(localValue);
  if (isNaN(target.getTime())) return "";
  const diffMs = target.getTime() - Date.now();
  const totalMin = Math.floor(Math.abs(diffMs) / 60000);
  const d = Math.floor(totalMin / 1440), h = Math.floor((totalMin % 1440) / 60), m = totalMin % 60;
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (d === 0 && m > 0) parts.push(`${m}m`);
  const rel = parts.length ? parts.join(" ") : "now";
  return diffMs >= 0 ? `in ${rel}` : `${rel} ago`;
}

const RESET_PRESETS = [
  { label: "+15m", hours: 0.25 }, { label: "+30m", hours: 0.5 }, { label: "+1h", hours: 1 }, { label: "+6h", hours: 6 },
  { label: "+1d", hours: 24 }, { label: "+3d", hours: 72 }, { label: "+7d", hours: 168 }, { label: "+30d", hours: 720 },
];

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(str) { return String(str).replace(/[&<>"']/g, (c) => ESCAPES[c]); }
function icon(name, size = 16) { return `<svg class="ic" width="${size}" height="${size}" aria-hidden="true"><use href="#i-${name}"/></svg>`; }

// Emails are masked everywhere in the UI when privacy mode is on.
function shown(email) { return Domain.displayEmail(email, preferences.privacy); }
function accountCycle(acc) { return Domain.cycleFor(acc, state.providers); }

// Statuses are computed once per pass and shared by filtering, sorting and drawing.
function statusContext(nowMs) {
  const cache = new Map();
  return { now: nowMs, status(a) { let s = cache.get(a.id); if (!s) { s = getStatus(a, nowMs); cache.set(a.id, s); } return s; } };
}

// ---------- storage ----------

async function loadState() {
  try {
    state = await dataClient.read();
    persistenceError = "";
  } catch (error) { persistenceError = error.message; }
  render();
}

async function saveState(options = {}) {
  try {
    await dataClient.save(state, options);
    await loadState();
    return true;
  } catch (error) {
    await loadState();
    persistenceError = "Change was not saved. " + error.message;
    lastDeleted = null;
    toast = null;
    paintToast();
    render();
    return false;
  }
}

// ---------- account actions ----------

function finishAccountChange(account, before, message) {
  lastDeleted = { kind: "account-change", record: before, after: Domain.clone(account) };
  saveState();
  showToast(message, true);
  render();
}

function markHit(id) {
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) return;
  const before = Domain.clone(acc);
  Domain.logLimit(acc, state.providers, Date.now());
  finishAccountChange(acc, before, "Limit logged. Reset time is an estimate.");
}

function clearHit(id) {
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) return;
  const before = Domain.clone(acc);
  Domain.markAvailable(acc, Date.now());
  finishAccountChange(acc, before, "Account marked available.");
}

function saveCustomReset(id) {
  const parsed = Domain.parseResetInput(editingResetValue, Date.now());
  if (parsed.error) { editingResetError = parsed.error; render(); return; }
  const acc = state.accounts.find((a) => a.id === id);
  editingResetId = null;
  editingResetError = "";
  if (acc) {
    const before = Domain.clone(acc);
    Domain.setReset(acc, parsed.iso, "exact", Date.now());
    finishAccountChange(acc, before, "Reset time updated.");
  } else render();
}

function applyPreset(id, hours) {
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) return;
  const before = Domain.clone(acc);
  Domain.setReset(acc, new Date(Date.now() + hours * 3600000).toISOString(), "estimate", Date.now());
  editingResetId = null;
  editingResetError = "";
  finishAccountChange(acc, before, "Estimated reset updated.");
}

function saveAccountEdit(id) {
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) { editingAccountId = null; render(); return; }
  if (!document.querySelector('[data-field="editing-account-email"]')?.reportValidity()) return;
  if (!document.querySelector('[data-field="editing-account-cycle"]')?.reportValidity()) return;
  const email = accountDraft.email.trim();
  if (state.accounts.some((a) => a.id !== id && a.providerId === acc.providerId && a.email.toLowerCase() === email.toLowerCase())) {
    accountEditError = "Another account in this tool already uses that email.";
    render();
    return;
  }
  const before = Domain.clone(acc);
  const cycleValue = accountDraft.cycleValue ? parseFloat(accountDraft.cycleValue) : null;
  acc.email = email;
  acc.cycleValue = cycleValue && cycleValue > 0 ? cycleValue : null;
  acc.cycleUnit = normalizeUnit(accountDraft.cycleUnit);
  editingAccountId = null;
  accountEditError = "";
  if (JSON.stringify(before) === JSON.stringify(acc)) { render(); return; }
  finishAccountChange(acc, before, "Account updated. Existing timers keep their reset times.");
}

function deleteAccount(id) {
  const idx = state.accounts.findIndex((a) => a.id === id);
  if (idx === -1) return;
  lastDeleted = { kind: "account", record: state.accounts[idx], index: idx };
  const label = shown(state.accounts[idx].email);
  state.accounts.splice(idx, 1);
  selectedIds.delete(id);
  pendingDeleteAccountId = null;
  saveState();
  showToast(`Removed ${label}`, true);
  render();
}

function undoLastDelete() {
  if (!lastDeleted) return;
  if (lastDeleted.kind === "account") {
    state.accounts.splice(Math.min(lastDeleted.index, state.accounts.length), 0, lastDeleted.record);
  } else if (lastDeleted.kind === "provider") {
    state.providers.splice(Math.min(lastDeleted.index, state.providers.length), 0, lastDeleted.record);
  } else if (lastDeleted.kind === "account-change") {
    const idx = state.accounts.findIndex((a) => a.id === lastDeleted.record.id);
    if (idx < 0 || JSON.stringify(state.accounts[idx]) !== JSON.stringify(lastDeleted.after)) {
      showToast("This account changed again. Undo was not applied.");
      return;
    }
    state.accounts[idx] = lastDeleted.record;
  } else if (lastDeleted.kind === "bulk-change") {
    const indexes = lastDeleted.records.map((record) => state.accounts.findIndex((a) => a.id === record.id));
    const untouched = indexes.every((idx, i) => idx >= 0 && JSON.stringify(state.accounts[idx]) === JSON.stringify(lastDeleted.afters[i]));
    if (!untouched) {
      showToast("Some of these accounts changed again. Undo was not applied.");
      return;
    }
    indexes.forEach((idx, i) => { state.accounts[idx] = lastDeleted.records[i]; });
  }
  lastDeleted = null;
  saveState();
  hideToast();
  render();
}

// ---------- toast ----------
// Toasts live in their own region: showing or expiring one never rebuilds the page,
// so it cannot close an open menu or steal focus from a field.

function paintToast() {
  $("toast-root").innerHTML = toast
    ? `<div class="toast"><span>${escapeHtml(toast.message)}</span>${lastDeleted ? '<button data-action="toast-undo">Undo</button>' : ""}</div>`
    : "";
}

function showToast(message, allowUndo) {
  clearTimeout(toastTimer);
  if (!allowUndo) lastDeleted = null;
  toast = { message };
  paintToast();
  toastTimer = setTimeout(() => { toast = null; lastDeleted = null; paintToast(); }, 6000);
}

function hideToast() {
  clearTimeout(toastTimer);
  toast = null;
  paintToast();
}

// ---------- forms ----------

function openAccountForm(providerId = null) {
  activeView = "accounts";
  if (providerId && !state.providers.some((p) => p.id === providerId)) return;
  addAccountProviderId = providerId;
  if (providerId) newAccountDraft.providerId = providerId;
  showAddAccount = true;
  showAddProvider = false;
  render();
  const field = document.querySelector(providerId || newAccountDraft.providerId ? '[data-field="new-account-email"]' : '[data-field="new-account-provider"]');
  if (field) { field.focus(); field.scrollIntoView({ block: "nearest", behavior: "auto" }); }
}

function closeAccountForm() {
  const providerId = addAccountProviderId;
  showAddAccount = false;
  addAccountProviderId = null;
  render();
  const opener = [...document.querySelectorAll('[data-action="add-account-to-provider"]')].find((button) => button.dataset.id === providerId);
  (opener || document.querySelector('[data-action="toggle-add-account"]'))?.focus();
}

function addAccount(keepAdding = false) {
  if (!state.providers.some((p) => p.id === newAccountDraft.providerId)) {
    document.querySelector('[data-field="new-account-provider"]')?.reportValidity();
    return;
  }
  const emailInput = document.querySelector('[data-field="new-account-email"]');
  if (!emailInput || !emailInput.reportValidity()) return;
  if (!document.querySelector('[data-field="new-account-cycle"]')?.reportValidity()) return;
  if (state.accounts.some((a) => a.providerId === newAccountDraft.providerId && a.email.toLowerCase() === newAccountDraft.email.trim().toLowerCase())) {
    showToast("This account is already in this tool.");
    document.querySelector('[data-field="new-account-email"]')?.focus();
    return;
  }
  const cycleValue = newAccountDraft.cycleValue ? parseFloat(newAccountDraft.cycleValue) : null;
  state.accounts.push({
    id: genId(), providerId: newAccountDraft.providerId, email: newAccountDraft.email.trim(),
    cycleValue: cycleValue && cycleValue > 0 ? cycleValue : null, cycleUnit: normalizeUnit(newAccountDraft.cycleUnit),
    lastHitAt: null, resetAt: null, history: [],
  });
  const providerId = newAccountDraft.providerId;
  newAccountDraft = { providerId, email: "", cycleValue: "", cycleUnit: "days" };
  saveState();
  if (keepAdding) openAccountForm(addAccountProviderId);
  else closeAccountForm();
}

function addProvider() {
  const name = newProviderDraft.name.trim();
  if (!name) return;
  if (!document.querySelector('[data-field="new-provider-cycle"]')?.reportValidity()) return;
  if (state.providers.some((p) => p.name.trim().toLowerCase() === name.toLowerCase())) {
    showToast("A tool with that name already exists.");
    document.querySelector('[data-field="new-provider-name"]')?.focus();
    return;
  }
  const cycleValue = parseFloat(newProviderDraft.cycleValue) || 7;
  state.providers.push({ id: genId(), name, cycleValue, cycleUnit: normalizeUnit(newProviderDraft.cycleUnit) });
  newProviderDraft = { name: "", cycleValue: "7", cycleUnit: "days" };
  showAddProvider = false;
  saveState();
  render();
}

function deleteProvider(id) {
  if (state.accounts.some((a) => a.providerId === id)) return;
  const idx = state.providers.findIndex((p) => p.id === id);
  if (idx === -1) return;
  lastDeleted = { kind: "provider", record: state.providers[idx], index: idx };
  const label = state.providers[idx].name;
  state.providers.splice(idx, 1);
  pendingDeleteProviderId = null;
  saveState();
  showToast(`Removed ${label}`, true);
  render();
}

function startEditCycle(id) {
  const p = state.providers.find((p) => p.id === id);
  if (!p) return;
  editingProviderId = id;
  editingProviderName = p.name;
  editingCycleValue = String(p.cycleValue);
  editingCycleUnit = normalizeUnit(p.cycleUnit);
  render();
  document.querySelector('[data-field="editing-provider-name"]')?.focus();
}

function saveEditCycle(id) {
  if (!document.querySelector('[data-field="editing-provider-name"]')?.reportValidity()) return;
  if (!document.querySelector('[data-field="editing-cycle-value"]')?.reportValidity()) return;
  const name = editingProviderName.trim();
  if (state.providers.some((p) => p.id !== id && p.name.trim().toLowerCase() === name.toLowerCase())) {
    showToast("A tool with that name already exists.");
    return;
  }
  const val = parseFloat(editingCycleValue);
  if (name && val && val > 0) {
    const p = state.providers.find((p) => p.id === id);
    if (p) { p.name = name; p.cycleValue = val; p.cycleUnit = normalizeUnit(editingCycleUnit); }
    saveState();
  }
  editingProviderId = null;
  render();
}

function markHitBulk(ids) {
  const now = Date.now(), records = [], afters = [];
  ids.forEach((id) => {
    const acc = state.accounts.find((a) => a.id === id);
    if (!acc) return;
    records.push(Domain.clone(acc));
    Domain.logLimit(acc, state.providers, now);
    afters.push(Domain.clone(acc));
  });
  selectedIds.clear();
  bulkMode = false;
  if (!records.length) { render(); return; }
  lastDeleted = { kind: "bulk-change", records, afters };
  saveState();
  showToast(`Limit logged for ${records.length} ${records.length === 1 ? "account" : "accounts"}. Reset times are estimates.`, true);
  render();
}

function exportBackup() {
  try {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `limittrack-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("Backup exported");
  } catch (e) { showToast("Export failed"); }
}

function importBackup(file) {
  if (file.size > 20 * 1024 * 1024) { showToast("Backup is too large (maximum 20 MB)."); return; }
  const reader = new FileReader();
  reader.onload = () => {
    try { pendingImport = Domain.normalizeState(JSON.parse(reader.result)); render(); }
    catch (e) { showToast("Could not import backup: " + e.message); }
  };
  reader.onerror = () => showToast("Couldn't read that file");
  reader.readAsText(file);
}

async function savePreferences(patch) {
  if (preferencesBusy) return;
  preferencesBusy = true;
  preferencesError = "";
  preferencesMessage = "Saving…";
  const focused = document.activeElement;
  // Keep the active control in place until the asynchronous save completes.
  document.querySelectorAll("[data-setting], [data-widget-tool], [data-action='set-theme'], [data-action='set-widget-layout']").forEach((el) => { el.disabled = true; });
  try {
    preferences = await window.LimitTrackPreferences.update(patch);
    preferencesMessage = "Saved";
  } catch (error) {
    preferencesError = "Settings were not saved. " + error.message;
    preferencesMessage = "";
  } finally {
    preferencesBusy = false;
    const setting = focused?.dataset?.setting, action = focused?.dataset?.action, id = focused?.dataset?.id;
    render();
    if (setting) document.querySelector(`[data-setting="${setting}"]`)?.focus({ preventScroll: true });
    else if (action) [...document.querySelectorAll("[data-action]")].find((el) => el.dataset.action === action && el.dataset.id === id)?.focus({ preventScroll: true });
  }
}

// ---------- "..." menus ----------

function menuHtml(kind, id) {
  const item = (action, label, extra = "") => `<button role="menuitem" data-action="${action}" data-id="${escapeHtml(id)}" ${extra}>${label}</button>`;
  if (kind === "toolbar") {
    return `${item("toggle-add-provider", "Add tool")}${item("toggle-bulk-mode", bulkMode ? "Stop selecting" : "Select accounts")}${item("toggle-sort", `Sort ${sortMode === "soonest" ? "A–Z" : "by next reset"}`)}`;
  }
  if (kind === "provider") {
    const empty = !state.accounts.some((a) => a.providerId === id);
    return `${item("edit-cycle", "Edit tool name &amp; cycle")}${empty ? item("request-delete-provider", "Remove tool", 'class="destructive"') : ""}`;
  }
  const account = accountById.get(id);
  if (!account) return "";
  const status = getStatus(account, Date.now());
  const primary = status === "open" ? "mark-hit" : isWaiting(status) ? "toggle-reset-edit" : "clear-hit";
  return `${item("toggle-account-details", "Account details")}${item("edit-account", "Edit account")}
    ${primary !== "mark-hit" ? item("mark-hit", "Log limit") : ""}
    ${primary !== "toggle-reset-edit" ? item("toggle-reset-edit", "Set reset time") : ""}
    ${isWaiting(status) ? item("clear-hit", "Mark available") : ""}
    ${item("request-delete-account", "Remove account", 'class="destructive"')}`;
}

function openMenu(anchor) {
  if (popover && popover.anchor === anchor) { closeMenu(true); return; }
  closeMenu();
  const kind = anchor.dataset.menuKind, id = anchor.dataset.id || "";
  const root = $("popover-root");
  root.innerHTML = `<div class="menu" role="menu" aria-label="${escapeHtml(anchor.getAttribute("aria-label") || "Actions")}">${menuHtml(kind, id)}</div>`;
  const menu = root.firstElementChild;
  anchor.setAttribute("aria-expanded", "true");
  popover = { anchor, kind, id };
  positionMenu(menu, anchor);
  menu.querySelector("button")?.focus({ preventScroll: true });
}

function positionMenu(menu, anchor) {
  const a = anchor.getBoundingClientRect(), m = menu.getBoundingClientRect();
  let top = a.bottom + 6;
  if (top + m.height > window.innerHeight - 8) top = Math.max(8, a.top - m.height - 6);
  const left = Math.min(Math.max(8, a.right - m.width), Math.max(8, window.innerWidth - m.width - 8));
  menu.style.top = Math.round(top) + "px";
  menu.style.left = Math.round(left) + "px";
}

function closeMenu(restoreFocus = false) {
  if (!popover) return;
  const { anchor } = popover;
  popover = null;
  $("popover-root").innerHTML = "";
  anchor.setAttribute("aria-expanded", "false");
  if (restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
}

// A re-render replaces the button the menu belongs to; re-attach to the new one, or close.
function reconcileMenu() {
  if (!popover || popover.anchor.isConnected) return;
  const next = [...document.querySelectorAll("[data-menu-kind]")].find((el) => el.dataset.menuKind === popover.kind && (el.dataset.id || "") === popover.id);
  if (!next) { closeMenu(); return; }
  popover.anchor = next;
  next.setAttribute("aria-expanded", "true");
}

// ---------- About dialog ----------

function paintModal() {
  $("modal-root").innerHTML = showAbout
    ? `<div class="modal-backdrop" data-action="close-about"><div class="about-dialog" id="about-modal" role="dialog" aria-modal="true" aria-labelledby="about-modal-title"><h2 id="about-modal-title">LimitTrack</h2><p>${appVersion ? `Version ${escapeHtml(appVersion)}` : "Version unavailable"}</p><p>Recorded reset times for your AI coding accounts.</p><p>Built by Abdul Rehman.</p><p><a href="https://github.com/rehmanoncloud9/limittrack" target="_blank" rel="noreferrer">View project on GitHub</a></p><div class="button-row"><button class="button" data-action="close-about">Close</button></div></div></div>`
    : "";
}

function getModalFocusable() {
  const modal = $("about-modal");
  if (!modal) return [];
  return Array.from(modal.querySelectorAll('a[href], button, input, select, [tabindex]:not([tabindex="-1"])')).filter((el) => !el.disabled);
}

function openAbout(opener) {
  aboutOpenerEl = opener || document.activeElement;
  showAbout = true;
  paintModal();
  getModalFocusable()[0]?.focus();
}

function closeAbout() {
  pendingImport = null;
  showAbout = false;
  paintModal();
  const opener = aboutOpenerEl && aboutOpenerEl.isConnected ? aboutOpenerEl : document.querySelector('[data-action="toggle-about"]');
  opener?.focus();
  aboutOpenerEl = null;
}

// ---------- event delegation ----------

function attachEvents() {
  const app = $("app");

  app.addEventListener("click", async (e) => {
    const menuBtn = e.target.closest("[data-menu-kind]");
    if (menuBtn) { openMenu(menuBtn); return; }
    const inMenu = e.target.closest("#popover-root");
    if (!inMenu) closeMenu();
    const titlebarBtn = e.target.closest("[data-titlebar-menu]");
    if (titlebarBtn) {
      const r = titlebarBtn.getBoundingClientRect();
      window.limittrack.menuOpen?.(titlebarBtn.dataset.titlebarMenu, Math.round(r.left), Math.round(r.bottom));
      return;
    }
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    if (inMenu) closeMenu();

    // Any click that isn't part of an inline delete-confirm exchange cancels a pending confirmation.
    if (!["request-delete-account", "confirm-delete-account", "cancel-delete-account"].includes(action)) pendingDeleteAccountId = null;
    if (!["request-delete-provider", "confirm-delete-provider", "cancel-delete-provider"].includes(action)) pendingDeleteProviderId = null;

    switch (action) {
      case "navigate":
        activeView = ["accounts", "widgets", "settings"].includes(id) ? id : "accounts";
        preferencesMessage = "";
        render();
        document.querySelector(`[data-action="navigate"][data-id="${activeView}"]`)?.focus();
        break;
      case "set-theme": await savePreferences({ theme: id }); break;
      case "set-widget-layout": await savePreferences({ widgetLayout: id }); break;
      case "toggle-account-details":
        expandedAccountId = expandedAccountId === id ? null : id;
        render();
        [...document.querySelectorAll("[data-account-row]")].find((el) => el.dataset.accountRow === id)?.focus({ preventScroll: true });
        break;
      case "cancel-edit-cycle": editingProviderId = null; render(); break;
      case "toggle-add-account":
        if (showAddAccount && !addAccountProviderId) closeAccountForm();
        else openAccountForm();
        break;
      case "add-account-to-provider": openAccountForm(id); break;
      case "toggle-add-provider":
        activeView = "accounts";
        showAddProvider = !showAddProvider;
        showAddAccount = false;
        render();
        document.querySelector('[data-field="new-provider-name"]')?.focus();
        break;
      case "cancel-add-account": closeAccountForm(); break;
      case "cancel-add-provider": showAddProvider = false; render(); break;
      case "save-add-account": addAccount(); break;
      case "save-add-another-account": addAccount(true); break;
      case "save-add-provider": addProvider(); break;
      case "mark-hit": markHit(id); break;
      case "toggle-reset-edit": {
        editingResetId = editingResetId === id ? null : id;
        editingResetError = "";
        if (editingResetId) {
          const acc = state.accounts.find((a) => a.id === id);
          const future = acc && acc.resetAt && Date.parse(acc.resetAt) > Date.now();
          editingResetValue = toLocalInputValue(future ? acc.resetAt : new Date(Date.now() + 3600000).toISOString());
        }
        render();
        if (editingResetId) document.querySelector('[data-field="editing-reset-value"]')?.focus();
        break;
      }
      case "save-reset": saveCustomReset(id); break;
      case "apply-preset": applyPreset(id, parseFloat(btn.dataset.hours)); break;
      case "cancel-reset-edit": editingResetId = null; editingResetError = ""; render(); break;
      case "edit-account": {
        const acc = state.accounts.find((a) => a.id === id);
        if (!acc) break;
        editingAccountId = id;
        accountEditError = "";
        accountDraft = { email: acc.email, cycleValue: acc.cycleValue ? String(acc.cycleValue) : "", cycleUnit: normalizeUnit(acc.cycleUnit) };
        render();
        document.querySelector('[data-field="editing-account-email"]')?.focus();
        break;
      }
      case "save-account": saveAccountEdit(id); break;
      case "cancel-account-edit": editingAccountId = null; accountEditError = ""; render(); break;
      case "test-notification": {
        notificationMessage = "Sending test…";
        render();
        try { notificationMessage = (await window.limittrack.notificationsTest()).message; }
        catch (error) { notificationMessage = "The test could not be sent. " + error.message; }
        render();
        document.querySelector('[data-action="test-notification"]')?.focus({ preventScroll: true });
        break;
      }
      case "clear-hit": clearHit(id); break;
      case "request-delete-account": pendingDeleteAccountId = id; render(); break;
      case "confirm-delete-account": deleteAccount(id); break;
      case "cancel-delete-account": pendingDeleteAccountId = null; render(); break;
      case "request-delete-provider": pendingDeleteProviderId = id; render(); break;
      case "confirm-delete-provider": deleteProvider(id); break;
      case "cancel-delete-provider": pendingDeleteProviderId = null; render(); break;
      case "edit-cycle": startEditCycle(id); break;
      case "save-cycle": saveEditCycle(id); break;
      case "toggle-about": openAbout(btn); break;
      case "close-about":
        // Only close when the click landed on the backdrop or the Close button itself,
        // not when it bubbled up from content such as the GitHub link.
        if (e.target === btn) closeAbout();
        break;
      case "toast-undo": undoLastDelete(); break;
      case "relaunch": window.limittrack.relaunch?.(); break;
      case "toggle-sort": sortMode = sortMode === "soonest" ? "alpha" : "soonest"; render(); break;
      case "toggle-bulk-mode": bulkMode = !bulkMode; selectedIds.clear(); render(); break;
      case "toggle-select":
        if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
        render();
        break;
      case "bulk-mark-hit": markHitBulk(Array.from(selectedIds)); break;
      case "export-backup": exportBackup(); break;
      case "trigger-import": $("import-file-input")?.click(); break;
      case "cancel-import": pendingImport = null; render(); break;
      case "confirm-import":
        if (pendingImport) {
          state = pendingImport;
          pendingImport = null;
          if (await saveState({ backup: true })) { showAbout = false; paintModal(); showToast("Backup imported. Previous data saved locally."); }
        }
        break;
    }
  });

  // Close an open menu when the user presses anywhere outside it (even on non-button areas).
  document.addEventListener("pointerdown", (e) => {
    if (popover && !e.target.closest("#popover-root") && !e.target.closest("[data-menu-kind]")) closeMenu();
  }, true);
  window.addEventListener("blur", () => closeMenu());
  window.addEventListener("resize", () => closeMenu());
  $("content").addEventListener("scroll", () => { if (popover) closeMenu(); }, { passive: true });

  $("popover-root").addEventListener("keydown", (e) => {
    const items = [...$("popover-root").querySelectorAll("button")];
    const at = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(at + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); items[items.length - 1]?.focus(); }
    else if (e.key === "Tab") closeMenu(true);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (popover) { closeMenu(true); return; }
      if (showAbout) closeAbout();
      else if (editingResetId) { editingResetId = null; editingResetError = ""; render(); }
      else if (editingAccountId) { editingAccountId = null; accountEditError = ""; render(); }
      else if (showAddAccount) closeAccountForm();
      else if (showAddProvider) { showAddProvider = false; render(); }
      else if (editingProviderId) { editingProviderId = null; render(); }
      else if (bulkMode) { bulkMode = false; selectedIds.clear(); render(); }
      return;
    }

    // Keep Tab focus inside the About dialog while it is open.
    if (showAbout && e.key === "Tab") {
      const focusable = getModalFocusable();
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      return;
    }

    // Global shortcuts are ignored while typing or while a form/dialog is open.
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
    if (activeView !== "accounts" || showAbout || showAddAccount || showAddProvider || editingAccountId || editingResetId) return;
    if (!typing && e.key === "n") { e.preventDefault(); openAccountForm(); }
    else if (!typing && e.key === "/") { e.preventDefault(); document.querySelector('[data-field="search-query"]')?.focus(); }
  });

  app.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const field = e.target.dataset.field;
    if (!field) return;
    if (field.startsWith("new-account") && e.target.tagName !== "SELECT") { e.preventDefault(); addAccount(); }
    else if (field.startsWith("new-provider") && e.target.tagName !== "SELECT") { e.preventDefault(); addProvider(); }
    else if (field.startsWith("editing-account") && e.target.tagName !== "SELECT" && editingAccountId) { e.preventDefault(); saveAccountEdit(editingAccountId); }
    else if ((field === "editing-provider-name" || field === "editing-cycle-value") && editingProviderId) { e.preventDefault(); saveEditCycle(editingProviderId); }
  });

  const draftFields = {
    "new-account-provider": (v) => { newAccountDraft.providerId = v; },
    "new-account-email": (v) => { newAccountDraft.email = v; },
    "new-account-cycle": (v) => { newAccountDraft.cycleValue = v; },
    "new-account-cycle-unit": (v) => { newAccountDraft.cycleUnit = v; },
    "new-provider-name": (v) => { newProviderDraft.name = v; },
    "new-provider-cycle": (v) => { newProviderDraft.cycleValue = v; },
    "new-provider-cycle-unit": (v) => { newProviderDraft.cycleUnit = v; },
    "editing-cycle-value": (v) => { editingCycleValue = v; },
    "editing-cycle-unit": (v) => { editingCycleUnit = v; },
    "editing-provider-name": (v) => { editingProviderName = v; },
    "editing-account-email": (v) => { accountDraft.email = v; },
    "editing-account-cycle": (v) => { accountDraft.cycleValue = v; },
    "editing-account-cycle-unit": (v) => { accountDraft.cycleUnit = v; },
  };

  app.addEventListener("input", (e) => {
    const field = e.target.dataset.field;
    if (!field) return;
    if (draftFields[field]) { draftFields[field](e.target.value); return; }
    if (field === "editing-reset-value") {
      editingResetValue = e.target.value;
      const previewEl = $("reset-preview");
      if (previewEl) previewEl.textContent = formatRelativePreview(editingResetValue);
    } else if (field === "search-query") {
      searchQuery = e.target.value;
      renderList(); // the search box itself is never re-rendered, so typing and IME input are undisturbed
    } else if (field === "status-filter") {
      statusFilter = e.target.value;
      renderList();
    }
  });

  app.addEventListener("change", async (e) => {
    if (e.target.dataset.widgetTool !== undefined) {
      const chosen = [...document.querySelectorAll("[data-widget-tool]")].filter((box) => box.checked).map((box) => box.dataset.widgetTool);
      await savePreferences({ widgetTools: chosen });
      return;
    }
    const setting = e.target.dataset.setting;
    if (setting) {
      const value = e.target.type === "checkbox" ? e.target.checked : setting === "widgetProviderId" ? e.target.value || null : setting === "widgetToolCount" ? Number(e.target.value) : e.target.value;
      await savePreferences({ [setting]: value });
      if (setting === "graphics" && !preferencesError) { restartNeeded = true; render(); }
      return;
    }
    if (e.target.dataset.field === "reset-preset" && e.target.value) { applyPreset(e.target.dataset.id, Number(e.target.value)); return; }
    if (e.target.id === "import-file-input") {
      const file = e.target.files && e.target.files[0];
      if (file) importBackup(file);
      e.target.value = "";
    }
  });
}

// ---------- page rendering ----------

function statusNote(account, status) {
  return isWaiting(status) ? (account.resetSource === "exact" ? "Recorded reset" : "Estimated reset") : "";
}

function renderAccountForm(provider = null) {
  return `<div class="composer">
    <h3>Add account${provider ? ` to ${escapeHtml(provider.name)}` : ""}</h3>
    <p class="help">${provider ? "The tool is already selected." : "Choose a tool for this account."}</p>
    <div class="form-grid">
      ${provider ? "" : `<label class="field">Tool<select required aria-label="Tool" data-field="new-account-provider"><option value="">Select a tool</option>${state.providers.map((p) => `<option value="${escapeHtml(p.id)}" ${newAccountDraft.providerId === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}</select></label>`}
      <label class="field">Account email<input type="email" required aria-label="Account email" data-field="new-account-email" placeholder="you@example.com" value="${escapeHtml(newAccountDraft.email)}" /></label>
    </div>
    <details class="advanced-fields"><summary>Custom reset cycle (optional)</summary><div class="form-grid"><label class="field">Duration<input type="number" min="0.01" max="100000" step="any" aria-label="Custom reset duration (optional)" data-field="new-account-cycle" value="${escapeHtml(newAccountDraft.cycleValue)}" placeholder="Use tool default" /></label><label class="field">Unit<select aria-label="Reset cycle unit" data-field="new-account-cycle-unit"><option value="days" ${newAccountDraft.cycleUnit === "days" ? "selected" : ""}>Days</option><option value="hours" ${newAccountDraft.cycleUnit === "hours" ? "selected" : ""}>Hours</option></select></label></div><p class="help">${provider ? `Default: ${cycleLabel(provider.cycleValue, provider.cycleUnit)}.` : "Leave blank to use the tool's cycle."} Calculated resets are estimates.</p></details>
    <div class="button-row"><button class="button primary" data-action="save-add-account">Add account</button><button class="button" data-action="save-add-another-account">Add &amp; add another</button><button class="button quiet" data-action="cancel-add-account">Cancel</button></div>
  </div>`;
}

function renderResetEditor(account) {
  return `<div class="reset-editor"><div class="form-grid"><label class="field">Reset date and time<input type="datetime-local" aria-label="Reset date and time" data-field="editing-reset-value" value="${escapeHtml(editingResetValue)}" /></label><label class="field">Or reset in<select aria-label="Reset in" data-field="reset-preset" data-id="${escapeHtml(account.id)}"><option value="">Choose a duration</option>${RESET_PRESETS.map((p) => `<option value="${p.hours}">${p.label}</option>`).join("")}</select></label></div><div class="help" id="reset-preview">${formatRelativePreview(editingResetValue)}</div>${editingResetError ? `<p class="field-error" role="alert">${escapeHtml(editingResetError)}</p>` : ""}<div class="button-row"><button class="button primary small" data-action="save-reset" data-id="${escapeHtml(account.id)}">Save reset</button><button class="button quiet small" data-action="cancel-reset-edit">Cancel</button></div></div>`;
}

function renderAccountEditor(account) {
  const unit = accountDraft.cycleUnit;
  return `<div class="reset-editor"><h4 class="editor-title">Edit account</h4><div class="form-grid"><label class="field">Account email<input type="email" required aria-label="Account email" data-field="editing-account-email" value="${escapeHtml(accountDraft.email)}" /></label><label class="field">Custom reset cycle (optional)<div class="field-pair"><input type="number" min="0.01" max="100000" step="any" aria-label="Custom reset duration (optional)" data-field="editing-account-cycle" value="${escapeHtml(accountDraft.cycleValue)}" placeholder="Use tool default" /><select aria-label="Reset cycle unit" data-field="editing-account-cycle-unit"><option value="days" ${unit === "days" ? "selected" : ""}>Days</option><option value="hours" ${unit === "hours" ? "selected" : ""}>Hours</option></select></div></label></div>${accountEditError ? `<p class="field-error" role="alert">${escapeHtml(accountEditError)}</p>` : ""}<p class="help">A new cycle applies to future limit logs. Existing timers keep their reset times.</p><div class="button-row"><button class="button primary small" data-action="save-account" data-id="${escapeHtml(account.id)}">Save changes</button><button class="button quiet small" data-action="cancel-account-edit">Cancel</button></div></div>`;
}

function renderActivity(account) {
  const events = (account.history || []).slice(0, 5);
  return `<div class="activity"><h4>Recorded limit events</h4>${events.length ? `<ul>${events.map((event) => `<li>Logged ${escapeHtml(formatWhen(event.hitAt))} · reset set for ${escapeHtml(formatWhen(event.resetAt))}</li>`).join("")}</ul>` : `<p class="help">None yet.</p>`}<p class="help">These are reset times as recorded when you logged each limit, not measured usage.</p></div>`;
}

function renderAccount(account, ctx) {
  const id = escapeHtml(account.id), status = ctx.status(account), name = shown(account.email);
  const primaryAction = status === "open" ? "mark-hit" : isWaiting(status) ? "toggle-reset-edit" : "clear-hit";
  const primaryLabel = status === "open" ? "Log limit" : isWaiting(status) ? "Edit reset" : "Mark available";
  const cycle = accountCycle(account);
  return `<div data-account-row="${id}" tabindex="-1">
    <div class="account-row">
      <div class="account-identity">${bulkMode ? `<input type="checkbox" aria-label="Select ${escapeHtml(name)}" data-action="toggle-select" data-id="${id}" ${selectedIds.has(account.id) ? "checked" : ""} />` : `<span class="status-dot status-${status}" id="dot-${id}" aria-hidden="true"></span>`}<span class="account-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span></div>
      <div class="account-status-block"><div class="st st-${status}" id="countdown-${id}">${formatCountdown(account, ctx.now)}</div><div class="account-status-note" id="label-${id}">${statusNote(account, status)}</div></div>
      <div class="row-actions"><button class="button small" data-action="${primaryAction}" data-id="${id}">${primaryLabel}</button><button class="button quiet icon-button" data-menu-kind="account" data-id="${id}" aria-haspopup="menu" aria-expanded="false" aria-label="More actions for ${escapeHtml(name)}" title="More actions">${icon("more", 18)}</button></div>
    </div>
    ${pendingDeleteAccountId === account.id ? `<div class="delete-prompt">Remove ${escapeHtml(name)}?<button class="button danger small" data-action="confirm-delete-account" data-id="${id}">Remove</button><button class="button quiet small" data-action="cancel-delete-account">Cancel</button></div>` : ""}
    ${expandedAccountId === account.id ? `<div class="account-detail"><dl class="meta-grid"><div><dt>Limit logged</dt><dd>${account.lastHitAt ? formatWhen(account.lastHitAt) : "No limit recorded"}</dd></div><div><dt>${account.resetSource === "exact" ? "Recorded reset" : "Estimated reset"}</dt><dd>${account.resetAt ? formatWhen(account.resetAt) : "No active timer"}</dd></div><div><dt>Availability confirmed</dt><dd>${account.confirmedAvailableAt ? formatWhen(account.confirmedAvailableAt) : "Not confirmed"}</dd></div><div><dt>Reset cycle</dt><dd>${cycleLabel(cycle.value, cycle.unit)}${account.cycleValue ? " (custom)" : ""}</dd></div></dl>${renderActivity(account)}</div>` : ""}
    ${editingAccountId === account.id ? renderAccountEditor(account) : ""}
    ${editingResetId === account.id ? renderResetEditor(account) : ""}
  </div>`;
}

function countOpen(list, ctx) { return list.reduce((n, a) => n + (ctx.status(a) === "open" ? 1 : 0), 0); }
function availablePill(providerId, count) {
  return `<span class="avail-pill${count ? "" : " none"}" data-avail="${escapeHtml(providerId)}">${count} available</span>`;
}

function renderProvider(provider, ctx, query) {
  const id = escapeHtml(provider.id);
  const all = state.accounts.filter((a) => a.providerId === provider.id);
  const keyed = [];
  for (const a of all) {
    const status = ctx.status(a);
    if (query && !a.email.toLowerCase().includes(query) && !provider.name.toLowerCase().includes(query)) continue;
    if (statusFilter !== "all" && !(statusFilter === "waiting" ? isWaiting(status) : status === statusFilter)) continue;
    keyed.push({ a, t: sortMode === "alpha" ? 0 : effectiveTime(a, ctx.now, status) });
  }
  keyed.sort((x, y) => (x.t === y.t ? x.a.email.localeCompare(y.a.email) : x.t - y.t));
  const formOpen = showAddAccount && addAccountProviderId === provider.id;
  return `<section class="tool-card" aria-label="${escapeHtml(provider.name)} accounts">
    <header class="tool-heading"><span class="tool-ic">${icon("layers", 20)}</span><div class="tool-identity"><h2>${escapeHtml(provider.name)}</h2><span class="tool-count">${all.length} ${all.length === 1 ? "account" : "accounts"}</span>${availablePill(provider.id, countOpen(all, ctx))}</div><div class="row-actions"><button class="button small" data-action="add-account-to-provider" data-id="${id}" aria-label="Add account to ${escapeHtml(provider.name)}">${icon("plus", 15)} Add account</button><button class="button quiet icon-button" data-menu-kind="provider" data-id="${id}" aria-haspopup="menu" aria-expanded="false" aria-label="${escapeHtml(provider.name)} options" title="Tool options">${icon("more", 18)}</button></div></header>
    ${editingProviderId === provider.id ? `<div class="cycle-editor"><label class="field wide">Tool name<input type="text" required maxlength="200" aria-label="Tool name" data-field="editing-provider-name" value="${escapeHtml(editingProviderName)}" /></label><p class="help">The cycle estimates resets when you log a limit. Match it to your plan; it is a guess, not a provider rule.</p><div class="form-grid"><label class="field">Duration<input type="number" min="0.01" max="100000" step="any" aria-label="Cycle length" data-field="editing-cycle-value" value="${escapeHtml(editingCycleValue)}" /></label><label class="field">Unit<select aria-label="Cycle unit" data-field="editing-cycle-unit"><option value="days" ${editingCycleUnit === "days" ? "selected" : ""}>Days</option><option value="hours" ${editingCycleUnit === "hours" ? "selected" : ""}>Hours</option></select></label></div><div class="button-row"><button class="button primary small" data-action="save-cycle" data-id="${id}">Save cycle</button><button class="button quiet small" data-action="cancel-edit-cycle">Cancel</button></div></div>` : ""}
    ${pendingDeleteProviderId === provider.id ? `<div class="delete-prompt">Remove this empty tool?<button class="button danger small" data-action="confirm-delete-provider" data-id="${id}">Remove</button><button class="button quiet small" data-action="cancel-delete-provider">Cancel</button></div>` : ""}
    ${formOpen ? renderAccountForm(provider) : ""}
    ${keyed.map(({ a }) => renderAccount(a, ctx)).join("")}
    ${keyed.length === 0 && !formOpen ? `<p class="empty-copy">${all.length ? "No accounts match your filters." : "No accounts yet."}</p>` : ""}
  </section>`;
}

function renderAddTool() {
  return `<section class="tool-card composer"><h3>Add tool</h3><div class="form-grid"><label class="field">Tool name<input type="text" required data-field="new-provider-name" placeholder="For example, Cursor" value="${escapeHtml(newProviderDraft.name)}" /></label><label class="field">Estimated reset cycle<div class="field-pair"><input type="number" min="0.01" max="100000" step="any" data-field="new-provider-cycle" aria-label="Reset duration" value="${escapeHtml(newProviderDraft.cycleValue)}" /><select aria-label="Reset unit" data-field="new-provider-cycle-unit"><option value="days" ${newProviderDraft.cycleUnit === "days" ? "selected" : ""}>Days</option><option value="hours" ${newProviderDraft.cycleUnit === "hours" ? "selected" : ""}>Hours</option></select></div></label></div><div class="button-row"><button class="button primary" data-action="save-add-provider">Add tool</button><button class="button quiet" data-action="cancel-add-provider">Cancel</button></div></section>`;
}

function renderWelcome() {
  return `<section class="welcome-card" aria-label="Getting started"><h3>Welcome to LimitTrack</h3><p class="help">Know which AI coding account to use next, without logging in everywhere to check.</p><ol class="welcome-steps"><li><strong>Add your accounts.</strong> Use Add account inside each tool below.</li><li><strong>Log a limit when you hit one.</strong> LimitTrack estimates the reset from the tool's cycle. The built-in tools start with a 7-day guess, so open a tool's ⋯ menu, choose Edit tool, and match the cycle to your plan.</li><li><strong>Get an alert, then confirm.</strong> When a timer ends the account shows Expected ready. Check the tool yourself, then choose Mark available.</li></ol><div class="button-row"><button class="button primary" data-action="toggle-add-account">${icon("plus", 16)} Add your first account</button></div></section>`;
}

function accountsShell() {
  const statuses = [["all", "All statuses"], ["open", "Available"], ["waiting", "Waiting"], ["ready", "Expected ready"], ["unknown", "Not checked"]];
  return `<div class="page">
    <header class="page-head"><h1>Accounts</h1><p class="subtitle">Manage your accounts and usage limits in one place.</p></header>
    <div class="stat-row">
      <div class="stat"><span class="stat-ic">${icon("layers", 24)}</span><div><div class="stat-num" id="stat-available">0</div><div class="stat-label">Available accounts</div></div></div>
      <div class="stat"><span class="stat-ic">${icon("bars", 24)}</span><div><div class="stat-num" id="stat-tracked">0</div><div class="stat-label">Tracked accounts</div></div></div>
      <button class="button primary lg add-btn" data-action="toggle-add-account" title="Add account (N)">${icon("plus", 18)} Add account</button>
    </div>
    <div class="toolbar">
      <label class="search">${icon("search", 18)}<input data-field="search-query" aria-label="Search accounts" title="Press / to search" placeholder="Search accounts or tools…" value="${escapeHtml(searchQuery)}" /></label>
      <div class="select-wrap"><select aria-label="Filter by status" data-field="status-filter">${statuses.map(([value, label]) => `<option value="${value}" ${statusFilter === value ? "selected" : ""}>${label}</option>`).join("")}</select>${icon("chevron", 16)}</div>
      <button class="button icon-square" data-menu-kind="toolbar" aria-haspopup="menu" aria-expanded="false" aria-label="More account options" title="More options">${icon("more", 20)}</button>
    </div>
    <div id="bulk-slot"></div>
    <div id="tool-list" class="tool-list"></div>
  </div>`;
}

function renderWidgets() {
  const busy = preferencesBusy ? "disabled" : "";
  const layouts = [["compact", "Compact"], ["standard", "Standard"], ["multi", "Multi-tool"]];
  const layoutHelp = { compact: "One tool and its available count, in the smallest space.", standard: "A larger card with the count, the next reset, and a tool picker.", multi: "A short list with one available count per tool." };
  const single = preferences.widgetLayout !== "multi";
  const toolRow = single
    ? `<div class="setting-row"><div><div class="setting-label">Tool to show</div><p class="help">Track one tool, or add up all of them. You can also change it from the widget itself.</p></div><select aria-label="Widget tool" data-setting="widgetProviderId" ${busy}><option value="">All tools</option>${state.providers.map((p) => `<option value="${escapeHtml(p.id)}" ${preferences.widgetProviderId === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}</select></div>`
    : `<div class="setting-row"><div><div class="setting-label">Tools to show</div><p class="help">Leave all unticked to show every tool.</p></div><div role="group" aria-label="Tools to show">${state.providers.map((p) => `<label class="toggle-label"><input type="checkbox" data-widget-tool="${escapeHtml(p.id)}" aria-label="${escapeHtml(p.name)}" ${preferences.widgetTools.includes(p.id) ? "checked" : ""} ${busy} /><span>${escapeHtml(p.name)}</span></label>`).join("")}</div></div>
    <div class="setting-row"><div><div class="setting-label">Number of tools</div><p class="help">The most rows the widget will show.</p></div><select aria-label="Number of tools" data-setting="widgetToolCount" ${busy}>${[1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${preferences.widgetToolCount === n ? "selected" : ""}>${n}</option>`).join("")}</select></div>`;
  return `<div class="page"><header class="page-head"><h1>Widgets</h1><p class="subtitle">See how many accounts are available without opening the app.</p></header><div class="settings-stack"><section class="settings-card" id="widget-settings"><h3>Desktop widget</h3>${preferences.widgetError ? `<p class="alert" role="alert">${escapeHtml(preferences.widgetError)}</p>` : ""}
    <div class="setting-row"><div><label class="toggle-label"><input type="checkbox" role="switch" aria-label="Show desktop widget" data-setting="widgetVisible" ${preferences.widgetVisible ? "checked" : ""} ${busy} /><span class="setting-label">Show desktop widget</span></label><p class="help toggle-help">${preferences.widgetVisible ? "On — return to your desktop to see the widget." : "Off — enable it to place the widget on your desktop. It uses no memory while off."}</p></div></div>
    <div class="setting-row"><div><div class="setting-label">Layout</div><p class="help">${layoutHelp[preferences.widgetLayout]}</p></div><div class="segmented" role="group" aria-label="Widget layout">${layouts.map(([value, label]) => `<button data-action="set-widget-layout" data-id="${value}" aria-pressed="${preferences.widgetLayout === value}" ${busy}>${label}</button>`).join("")}</div></div>
    ${toolRow}
    <div class="setting-row"><div><label class="toggle-label"><input type="checkbox" role="switch" aria-label="Keep widget on top" data-setting="widgetAlwaysOnTop" ${preferences.widgetAlwaysOnTop ? "checked" : ""} ${busy} /><span class="setting-label">Keep on top of other windows</span></label><p class="help toggle-help">${preferences.widgetAlwaysOnTop ? "On — the widget stays visible above your apps." : "Off — the widget lives on your desktop and appears when you return to it."}</p></div></div>
    <p class="setup-note">Drag the widget by its header or icon to move it. Click the count to open LimitTrack; right-click it for layout and other options. Closing the widget turns it off; you can turn it back on here. Theme and font follow Settings.</p>
    <div class="settings-feedback" role="status">${preferencesBusy ? "Saving…" : preferencesMessage}</div>
  </section></div></div>`;
}

function renderBackupSettings() {
  return `<section class="settings-card"><h3>Backup &amp; restore</h3><p class="help">Your accounts stay on this device. Export a copy before moving computers.</p><div class="button-row"><button class="button" data-action="export-backup">Export backup</button><button class="button" data-action="trigger-import">Import backup</button><input type="file" hidden id="import-file-input" accept="application/json,.json" /></div>${pendingImport ? `<div class="import-preview"><p>Replace ${state.accounts.length} accounts with ${pendingImport.accounts.length} accounts from this backup? A recovery copy is saved first.</p><div class="button-row"><button class="button primary" data-action="confirm-import">Replace accounts</button><button class="button quiet" data-action="cancel-import">Cancel import</button></div></div>` : ""}</section>`;
}

function renderAlertSettings() {
  const loginHelp = preferences.loginSupported ? "Start quietly in the tray when you sign in, so alerts keep working after a restart." : "Available in the installed app on Windows and macOS.";
  return `<section class="settings-card"><h3>Alerts &amp; startup</h3>
    <div class="setting-row"><div><label class="toggle-label"><input type="checkbox" role="switch" aria-label="Reset alerts" data-setting="notifications" ${preferences.notifications ? "checked" : ""} ${preferencesBusy ? "disabled" : ""} /><span class="setting-label">Reset alerts</span></label><p class="help toggle-help">Notify me when a recorded reset time passes. Alerts only appear while LimitTrack is running, including in the tray after you close the window.</p></div><button class="button small" data-action="test-notification">Send test alert</button></div>
    ${notificationMessage ? `<div class="settings-feedback" role="status">${escapeHtml(notificationMessage)}</div>` : ""}
    <div class="setting-row"><div><label class="toggle-label"><input type="checkbox" role="switch" aria-label="Launch at login" data-setting="launchAtLogin" ${preferences.launchAtLogin ? "checked" : ""} ${preferencesBusy || !preferences.loginSupported ? "disabled" : ""} /><span class="setting-label">Launch at login</span></label><p class="help toggle-help">${loginHelp}</p></div></div></section>`;
}

function renderPerformanceSettings() {
  const auto = preferences.lowMemoryHost ? "Automatic (low memory on this computer)" : "Automatic";
  return `<section class="settings-card"><h3>Performance</h3><div class="setting-row"><div><div class="setting-label">Graphics</div><p class="help">Low memory draws the window in software and skips the graphics process, which saves memory on older computers. Automatic chooses it on computers with about 2 GB of RAM or less. Applies after a restart.</p></div><select aria-label="Graphics mode" data-setting="graphics" ${preferencesBusy ? "disabled" : ""}><option value="auto" ${preferences.graphics === "auto" ? "selected" : ""}>${auto}</option><option value="software" ${preferences.graphics === "software" ? "selected" : ""}>Low memory</option><option value="hardware" ${preferences.graphics === "hardware" ? "selected" : ""}>Hardware accelerated</option></select></div>${restartNeeded ? `<div class="button-row"><span class="help">Restart LimitTrack to apply this.</span><button class="button small" data-action="relaunch">Restart now</button></div>` : ""}</section>`;
}

function renderPrivacySettings() {
  return `<section class="settings-card"><h3>Privacy</h3><div class="setting-row"><div><label class="toggle-label"><input type="checkbox" role="switch" aria-label="Hide email addresses" data-setting="privacy" ${preferences.privacy ? "checked" : ""} ${preferencesBusy ? "disabled" : ""} /><span class="setting-label">Hide email addresses</span></label><p class="help toggle-help">Shows partial addresses such as ab•••@gmail.com in the app, the widget, and alerts. Useful when sharing your screen. Editing an account still shows the full address.</p></div></div></section>`;
}

function renderSettings() {
  return `<div class="page"><header class="page-head"><h1>Settings</h1><p class="subtitle">Make LimitTrack comfortable to use.</p></header><div class="settings-feedback" role="status">${preferencesBusy ? "Saving…" : preferencesMessage}</div><div class="settings-stack" style="margin-top:0"><section class="settings-card"><h3>Appearance</h3>
    <div class="setting-row"><div><div class="setting-label">Theme</div><p class="help">Applies to the app and desktop widget.</p></div><div class="segmented" role="group" aria-label="Theme">${[["system", "System"], ["light", "Light"], ["dark", "Dark"]].map(([value, label]) => `<button data-action="set-theme" data-id="${value}" aria-pressed="${preferences.theme === value}" ${preferencesBusy ? "disabled" : ""}>${label}</button>`).join("")}</div></div>
    <div class="setting-row"><div><div class="setting-label">Font</div><p class="help">System uses your device's native interface font and the least memory.</p></div><select aria-label="Interface font" data-setting="font" ${preferencesBusy ? "disabled" : ""}><option value="system" ${preferences.font === "system" ? "selected" : ""}>System (default)</option><option value="inter" ${preferences.font === "inter" ? "selected" : ""}>Inter</option></select></div>
    </section>${renderAlertSettings()}${renderPrivacySettings()}${renderPerformanceSettings()}${renderBackupSettings()}<div class="settings-footer"><span>LimitTrack · Local storage</span><button class="button quiet small" data-action="toggle-about" aria-haspopup="dialog">About</button></div></div></div>`;
}

// ---------- render orchestration ----------

// Remember which control had focus (and its caret) so a re-render can put it back.
function captureFocus() {
  const el = document.activeElement;
  if (!el || !el.dataset || !$("content").contains(el)) return null;
  return {
    field: el.dataset.field, setting: el.dataset.setting, action: el.dataset.action, id: el.dataset.id, row: el.dataset.accountRow,
    start: typeof el.selectionStart === "number" ? el.selectionStart : null, end: typeof el.selectionEnd === "number" ? el.selectionEnd : null,
  };
}

function restoreFocus(f) {
  if (!f) return;
  let el = null;
  if (f.field) el = document.querySelector(`[data-field="${f.field}"]`);
  else if (f.setting) el = document.querySelector(`[data-setting="${f.setting}"]`);
  else if (f.action) el = [...document.querySelectorAll("[data-action]")].find((n) => n.dataset.action === f.action && n.dataset.id === f.id);
  else if (f.row) el = [...document.querySelectorAll("[data-account-row]")].find((n) => n.dataset.accountRow === f.row);
  if (!el) return;
  el.focus({ preventScroll: true });
  if (f.start !== null && el.setSelectionRange) { try { el.setSelectionRange(f.start, f.end); } catch (e) { /* not supported by this input type */ } }
}

function syncNav() {
  document.querySelectorAll('[data-action="navigate"]').forEach((el) => {
    if (el.dataset.id === activeView) el.setAttribute("aria-current", "page"); else el.removeAttribute("aria-current");
  });
}

function renderBulkBar() {
  const slot = $("bulk-slot");
  if (!slot) return;
  slot.innerHTML = bulkMode ? `<div class="bulk-bar"><span>${selectedIds.size} selected</span><button class="button small" data-action="bulk-mark-hit" ${selectedIds.size ? "" : "disabled"}>Log limit for selected</button><button class="button quiet small" data-action="toggle-bulk-mode">Cancel</button></div>` : "";
}

function renderList() {
  const list = $("tool-list");
  if (!list) return;
  const focus = captureFocus();
  const ctx = statusContext(Date.now());
  accountById = new Map(state.accounts.map((a) => [a.id, a]));
  const query = searchQuery.trim().toLowerCase();
  list.innerHTML = `${showAddAccount && !addAccountProviderId ? `<section class="tool-card">${renderAccountForm()}</section>` : ""}${showAddProvider ? renderAddTool() : ""}${state.accounts.length === 0 && !showAddAccount && !showAddProvider ? renderWelcome() : ""}${state.providers.map((p) => renderProvider(p, ctx, query)).join("")}${state.providers.length === 0 ? `<section class="settings-card"><h3>Add your first tool</h3><p class="help">Start with the coding tool you use most.</p><div class="button-row"><button class="button" data-action="toggle-add-provider">Add tool</button></div></section>` : ""}`;
  renderBulkBar();
  prevStatus = new Map(state.accounts.map((a) => [a.id, ctx.status(a)]));
  rowRefs = [...list.querySelectorAll("[data-account-row]")].map((row) => ({
    id: row.dataset.accountRow, status: ctx.status(accountById.get(row.dataset.accountRow) || {}), text: null,
    count: row.querySelector(".st"), note: row.querySelector(".account-status-note"), dot: row.querySelector(".status-dot"),
  }));
  updateStats(ctx);
  reconcileMenu();
  restoreFocus(focus);
}

function updateStats(ctx) {
  const available = state.accounts.reduce((n, a) => n + (ctx.status(a) === "open" ? 1 : 0), 0);
  // Keep each tool's "N available" pill current as timers run out.
  document.querySelectorAll("[data-avail]").forEach((el) => {
    const n = countOpen(state.accounts.filter((x) => x.providerId === el.dataset.avail), ctx);
    const text = `${n} available`;
    if (el.textContent !== text) { el.textContent = text; el.classList.toggle("none", n === 0); }
  });
  const a = $("stat-available"), t = $("stat-tracked");
  if (a && a.textContent !== String(available)) a.textContent = String(available);
  if (t && t.textContent !== String(state.accounts.length)) t.textContent = String(state.accounts.length);
}

function updateNextCard(nowMs, ctx) {
  let next = null, nextAt = Infinity;
  for (const a of state.accounts) {
    if (!isWaiting(ctx.status(a))) continue;
    const t = Date.parse(a.resetAt);
    if (t < nextAt) { nextAt = t; next = a; }
  }
  const timeEl = $("next-time"), toolEl = $("next-tool");
  const time = next ? formatCountdown(next, nowMs) : "No active timers";
  const provider = next ? state.providers.find((p) => p.id === next.providerId) : null;
  const tool = next ? (provider ? provider.name : "Account") : state.accounts.length ? "Log a limit to start one" : "";
  if (timeEl.textContent !== time) timeEl.textContent = time;
  if (toolEl.textContent !== tool) toolEl.textContent = tool;
}

function render() {
  const nowMs = Date.now();
  syncNav();
  updateNextCard(nowMs, statusContext(nowMs));
  const content = $("content");
  const alerts = `${persistenceError ? `<div role="alert" class="alert">${escapeHtml(persistenceError)}</div>` : ""}${preferencesError ? `<div role="alert" class="alert">${escapeHtml(preferencesError)}</div>` : ""}`;
  if (activeView === "accounts" && mountedView === "accounts" && content.querySelector("#tool-list")) {
    // Same page: refresh only the list region, keep the toolbar (and the search box's caret) untouched.
    const slot = content.querySelector("#alert-slot");
    if (slot && slot.innerHTML !== alerts) slot.innerHTML = alerts;
    // Filters can be reset from outside (revealing an account), so keep the toolbar in step.
    const search = content.querySelector('[data-field="search-query"]');
    if (search && search.value !== searchQuery) search.value = searchQuery;
    const filter = content.querySelector('[data-field="status-filter"]');
    if (filter && filter.value !== statusFilter) filter.value = statusFilter;
    renderList();
    return;
  }
  const focus = captureFocus();
  const viewChanged = mountedView !== activeView;
  const scrollTop = content.scrollTop;
  content.innerHTML = `<div id="alert-slot">${alerts}</div>${activeView === "widgets" ? renderWidgets() : activeView === "settings" ? renderSettings() : accountsShell()}`;
  mountedView = activeView;
  if (activeView === "accounts") renderList();
  else { rowRefs = []; prevStatus = new Map(); restoreFocus(focus); }
  // A new page starts at the top; re-rendering the same page (saving a setting) keeps the scroll position.
  content.scrollTop = viewChanged ? 0 : scrollTop;
}

// ---------- live tick ----------
// Runs once a second while the window is visible. It reads each account once, writes only text
// that actually changed, and never rebuilds the page unless a status change requires re-sorting.

function tick() {
  const nowMs = Date.now();
  const ctx = statusContext(nowMs);
  let changed = false;
  for (const a of state.accounts) {
    const prev = prevStatus.get(a.id);
    if (prev !== undefined && prev !== ctx.status(a)) changed = true;
  }
  updateNextCard(nowMs, ctx);
  if (activeView !== "accounts") return;

  // Re-sorting rebuilds the list, which would close an open menu, a delete confirmation, or an
  // editor under the user's pointer. Wait until they finish; the remembered previous statuses
  // make the rebuild happen on a later tick.
  const busy = Boolean(popover || editingResetId || editingProviderId || editingAccountId || showAddAccount || showAddProvider || pendingDeleteAccountId || pendingDeleteProviderId);
  if (changed && !busy) { render(); return; }

  for (const ref of rowRefs) {
    const acc = accountById.get(ref.id);
    if (!acc) continue;
    const status = ctx.status(acc);
    const text = formatCountdown(acc, nowMs);
    if (ref.text !== text && ref.count) { ref.count.textContent = text; ref.text = text; }
    if (ref.status !== status) {
      ref.status = status;
      if (ref.count) ref.count.className = `st st-${status}`;
      if (ref.dot) ref.dot.className = `status-dot status-${status}`;
      if (ref.note) ref.note.textContent = statusNote(acc, status);
    }
  }
  if (!changed) prevStatus = new Map(state.accounts.map((a) => [a.id, ctx.status(a)]));
  updateStats(ctx);
}

// Stop ticking while the window is hidden or minimized, and catch up the moment it returns.
function scheduleTick() {
  clearTimeout(tickTimer);
  tickTimer = null;
  if (document.hidden) return;
  tickTimer = setTimeout(() => { tick(); scheduleTick(); }, 1000 - (Date.now() % 1000) + 8);
}

// ---------- init ----------

window.addEventListener("DOMContentLoaded", () => {
  if (window.limittrack.platform === "win32") {
    document.body.dataset.chrome = "custom";
    $("titlebar").hidden = false;
    // The system draws the window buttons at the right edge; leave room for them.
    $("titlebar").style.setProperty("--tb-right", "calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - 140px)))");
  }
  attachEvents();
  window.LimitTrackPreferences.subscribe((value) => {
    const privacyChanged = value.privacy !== preferences.privacy;
    preferences = value;
    if (preferencesBusy) return;
    if (activeView !== "accounts" || privacyChanged) render();
  });
  window.LimitTrackPreferences.ready.then((value) => {
    preferences = value;
    render();
  }).catch((error) => { preferencesError = "Settings could not be loaded. " + error.message; render(); });
  if (window.limittrack.appInfo) {
    window.limittrack.appInfo().then((info) => { appVersion = info.version || ""; if (showAbout) paintModal(); }).catch(() => {});
  }
  window.limittrack.onWidgetConfigure(() => {
    activeView = "widgets";
    render();
    document.querySelector('[data-action="navigate"][data-id="widgets"]')?.focus();
  });
  window.limittrack.onMenuAction?.((name) => {
    if (name === "new-account") openAccountForm();
    else if (name === "export-backup") exportBackup();
    else if (name === "about") openAbout(null);
    else if (name.startsWith("view:")) { activeView = ["accounts", "widgets", "settings"].includes(name.slice(5)) ? name.slice(5) : "accounts"; render(); }
  });
  window.limittrack.onStorageChanged?.((key) => { if (key === STORAGE_KEY) loadState(); });
  window.limittrack.onAccountReveal?.(async (accountId) => {
    activeView = "accounts";
    // A bare "open the app" (second launch, grouped alert) keeps the user's filters.
    if (accountId) { searchQuery = ""; statusFilter = "all"; expandedAccountId = accountId; }
    await loadState();
    const row = [...document.querySelectorAll("[data-account-row]")].find((el) => el.dataset.accountRow === accountId);
    if (row) { row.focus({ preventScroll: true }); row.scrollIntoView({ block: "center", behavior: "auto" }); }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearTimeout(tickTimer); tickTimer = null; }
    else { tick(); scheduleTick(); }
  });
  render();
  loadState();
  scheduleTick();
});
