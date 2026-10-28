const { STORAGE_KEY, DEFAULT_STATE, getStatus, effectiveTime } = window.LimitTrackDomain;
const dataClient = window.createLimitTrackClient(window.limittrack);
let persistenceError = "";

let state = JSON.parse(JSON.stringify(DEFAULT_STATE));
let editingProviderId = null;
let editingCycleValue = "";
let editingCycleUnit = "days";
let editingResetId = null;
let editingResetValue = "";
let showAddAccount = false;
let addAccountProviderId = null;
let showAddProvider = false;
let showAbout = false;
let activeView = "accounts";
let expandedAccountId = null;
let preferences = window.LimitTrackPreferences.current();
let preferencesBusy = false;
let preferencesError = "";
let preferencesMessage = "";
let pendingImport = null;
let newAccountDraft = { providerId: "", email: "", cycleValue: "", cycleUnit: "days" };
let newProviderDraft = { name: "", cycleValue: "7", cycleUnit: "days" };
const prevStatus = {};

// safety: inline delete-confirm state, undo buffer, toast
let pendingDeleteAccountId = null;
let pendingDeleteProviderId = null;
let lastDeleted = null; // { kind: 'account'|'provider', record, index }
let toast = null; // { message }
let toastTimer = null;

// daily-use: search / sort / bulk selection
let searchQuery = "";
let statusFilter = "all";
let sortMode = "soonest"; // 'soonest' | 'alpha'
let bulkMode = false;
let selectedIds = new Set();

// accessibility: focus management for the About modal
let aboutOpenerEl = null;

// ---------- cycle unit helpers ----------
// A "cycle" is how long an account stays locked after being marked as hit.
// It can be expressed in hours (for tools with hourly limits) or days.

function normalizeUnit(unit) {
  return unit === "hours" ? "hours" : "days";
}

function cycleToMs(value, unit) {
  const v = Number(value) || 0;
  return normalizeUnit(unit) === "hours" ? v * 3600000 : v * 86400000;
}

function cycleLabel(value, unit) {
  const v = Number(value) || 0;
  const noun = normalizeUnit(unit) === "hours" ? "hour" : "day";
  return `${v}-${noun} cycle`;
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function formatCountdown(acc, nowMs) {
  return window.LimitTrackDomain.formatCountdown(acc, nowMs);
}

function formatWhen(iso) {
  if (!iso) return "never";
  const dt = new Date(iso);
  return dt.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
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
  const abs = Math.abs(diffMs);
  const totalMin = Math.floor(abs / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (d === 0 && m > 0) parts.push(`${m}m`);
  const rel = parts.length ? parts.join(" ") : "now";
  return diffMs >= 0 ? `in ${rel}` : `${rel} ago`;
}

const RESET_PRESETS = [
  { label: "+15m", hours: 0.25 },
  { label: "+30m", hours: 0.5 },
  { label: "+1h", hours: 1 },
  { label: "+6h", hours: 6 },
  { label: "+1d", hours: 24 },
  { label: "+3d", hours: 72 },
  { label: "+7d", hours: 168 },
  { label: "+30d", hours: 720 },
];

function statusStyles(status) {
  if (status === "open") return { dot: "bg-success-soft0", text: "text-success", label: "Marked available" };
  if (status === "ready") return { dot: "bg-blue-400", text: "text-accent-ink", label: "Check tool to confirm" };
  if (status === "unknown") return { dot: "bg-slate-300", text: "text-muted", label: "Status unknown" };
  if (status === "soon") return { dot: "bg-orange-400", text: "text-warning", label: "Expected soon" };
  return { dot: "bg-slate-400", text: "text-muted", label: "Waiting for reset" };
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function svgIcon(paths, size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

const ICON_PATHS = {
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="M6 6l12 12"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  checkSquare: '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  sort: '<path d="M11 5h10"/><path d="M11 9h7"/><path d="M11 13h4"/><path d="m3 17 3 3 3-3"/><path d="M6 18V4"/>',
};

function icon(name, size = 14) {
  return svgIcon(ICON_PATHS[name] || "", size);
}

// ---------- storage ----------

async function loadState(preserveFocus = false) {
  try {
    state = await dataClient.read();
    persistenceError = "";
  } catch (error) { persistenceError = error.message; }
  if (preserveFocus) rerenderPreservingFocus(); else render();
}

async function saveState(options = {}) {
  try {
    await dataClient.save(state, options);
    await loadState(true);
    return true;
  } catch (error) {
    await loadState(true);
    persistenceError = "Change was not saved. " + error.message;
    lastDeleted = null;
    toast = null;
    rerenderPreservingFocus();
    return false;
  }
}

function providerCycle(providerId) {
  const p = state.providers.find((p) => p.id === providerId);
  return p ? { value: p.cycleValue, unit: p.cycleUnit } : { value: 7, unit: "days" };
}

function accountCycle(acc) {
  if (acc.cycleValue) return { value: acc.cycleValue, unit: acc.cycleUnit };
  return providerCycle(acc.providerId);
}

function markHit(id) {
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) return;
  const before = window.LimitTrackDomain.clone(acc);
  const { value, unit } = accountCycle(acc);
  const hitAt = new Date().toISOString();
  const resetAt = new Date(Date.now() + cycleToMs(value, unit)).toISOString();
  acc.lastHitAt = hitAt;
  acc.resetAt = resetAt;
  acc.confirmedAvailableAt = null;
  acc.resetSource = "estimate";
  acc.history = [{ hitAt, resetAt }, ...(acc.history || [])].slice(0, 8);
  finishAccountChange(acc, before, "Limit logged. Reset time is an estimate.");
}

function finishAccountChange(account, before, message) {
  lastDeleted = { kind: "account-change", record: before, after: window.LimitTrackDomain.clone(account) };
  saveState();
  showToast(message, true);
}

function clearHit(id) {
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) return;
  const before = window.LimitTrackDomain.clone(acc);
  acc.resetAt = null;
  acc.confirmedAvailableAt = new Date().toISOString();
  finishAccountChange(acc, before, "Account marked available.");
}

function saveCustomReset(id) {
  if (!editingResetValue) {
    editingResetId = null;
    render();
    return;
  }
  const acc = state.accounts.find((a) => a.id === id);
  if (acc) {
    const before = window.LimitTrackDomain.clone(acc);
    acc.resetAt = new Date(editingResetValue).toISOString();
    acc.resetSource = "exact";
    acc.confirmedAvailableAt = null;
    finishAccountChange(acc, before, "Reset time updated.");
  }
  editingResetId = null;
  render();
}

function applyPreset(id, hours) {
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) return;
  const before = window.LimitTrackDomain.clone(acc);
  acc.resetAt = new Date(Date.now() + hours * 3600000).toISOString();
  acc.resetSource = "estimate";
  acc.confirmedAvailableAt = null;
  editingResetId = null;
  finishAccountChange(acc, before, "Estimated reset updated.");
}

function deleteAccount(id) {
  const idx = state.accounts.findIndex((a) => a.id === id);
  if (idx === -1) return;
  lastDeleted = { kind: "account", record: state.accounts[idx], index: idx };
  const label = state.accounts[idx].email;
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
    const idx = Math.min(lastDeleted.index, state.accounts.length);
    state.accounts.splice(idx, 0, lastDeleted.record);
  } else if (lastDeleted.kind === "provider") {
    const idx = Math.min(lastDeleted.index, state.providers.length);
    state.providers.splice(idx, 0, lastDeleted.record);
  } else if (lastDeleted.kind === "account-change") {
    const idx = state.accounts.findIndex((a) => a.id === lastDeleted.record.id);
    if (idx < 0 || JSON.stringify(state.accounts[idx]) !== JSON.stringify(lastDeleted.after)) {
      showToast("This account changed again. Undo was not applied.");
      return;
    }
    state.accounts[idx] = lastDeleted.record;
  }
  lastDeleted = null;
  saveState();
  hideToast();
  render();
}

function showToast(message, allowUndo) {
  clearTimeout(toastTimer);
  if (!allowUndo) lastDeleted = null;
  toast = { message };
  toastTimer = setTimeout(() => {
    toast = null;
    lastDeleted = null;
    render();
  }, 6000);
  render();
}

function hideToast() {
  clearTimeout(toastTimer);
  toast = null;
}

// Progress through the current cooldown, 0-100, or null if the account
// isn't currently cooling down (never hit, or already open).
function cycleProgress(acc, nowMs) {
  if (!acc.resetAt || !acc.lastHitAt) return null;
  const start = new Date(acc.lastHitAt).getTime();
  const end = new Date(acc.resetAt).getTime();
  if (end <= start || nowMs >= end) return null;
  return Math.max(0, Math.min(100, ((nowMs - start) / (end - start)) * 100));
}

function openAccountForm(providerId = null) {
  activeView = "accounts";
  if (providerId && !state.providers.some((p) => p.id === providerId)) return;
  addAccountProviderId = providerId;
  if (providerId) newAccountDraft.providerId = providerId;
  showAddAccount = true;
  showAddProvider = false;
  render();
  const field = document.querySelector(providerId || newAccountDraft.providerId
    ? '[data-field="new-account-email"]'
    : '[data-field="new-account-provider"]');
  if (field) {
    field.focus();
    field.scrollIntoView({ block: "nearest", behavior: "auto" });
  }
}

function closeAccountForm() {
  const providerId = addAccountProviderId;
  showAddAccount = false;
  addAccountProviderId = null;
  render();
  const opener = [...document.querySelectorAll('[data-action="add-account-to-provider"]')]
    .find((button) => button.dataset.id === providerId);
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
    id: genId(),
    providerId: newAccountDraft.providerId,
    email: newAccountDraft.email.trim(),
    cycleValue: cycleValue && cycleValue > 0 ? cycleValue : null,
    cycleUnit: normalizeUnit(newAccountDraft.cycleUnit),
    lastHitAt: null,
    resetAt: null,
    history: [],
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
  const cycleValue = parseFloat(newProviderDraft.cycleValue) || 7;
  state.providers.push({ id: genId(), name, cycleValue, cycleUnit: normalizeUnit(newProviderDraft.cycleUnit) });
  newProviderDraft = { name: "", cycleValue: "7", cycleUnit: "days" };
  showAddProvider = false;
  saveState();
  render();
}

function deleteProvider(id) {
  const hasAccounts = state.accounts.some((a) => a.providerId === id);
  if (hasAccounts) return;
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
  editingCycleValue = String(p.cycleValue);
  editingCycleUnit = normalizeUnit(p.cycleUnit);
  render();
}

function saveEditCycle(id) {
  if (!document.querySelector('[data-field="editing-cycle-value"]')?.reportValidity()) return;
  const val = parseFloat(editingCycleValue);
  if (val && val > 0) {
    const p = state.providers.find((p) => p.id === id);
    if (p) {
      p.cycleValue = val;
      p.cycleUnit = normalizeUnit(editingCycleUnit);
    }
    saveState();
  }
  editingProviderId = null;
  render();
}

function markHitBulk(ids) {
  ids.forEach((id) => {
    const acc = state.accounts.find((a) => a.id === id);
    if (!acc) return;
    const { value, unit } = accountCycle(acc);
    const hitAt = new Date().toISOString();
    const resetAt = new Date(Date.now() + cycleToMs(value, unit)).toISOString();
    acc.lastHitAt = hitAt;
    acc.resetAt = resetAt;
    acc.confirmedAvailableAt = null;
    acc.resetSource = "estimate";
    acc.history = [{ hitAt, resetAt }, ...(acc.history || [])].slice(0, 8);
  });
  saveState();
  selectedIds.clear();
  bulkMode = false;
  render();
}

function exportBackup() {
  try {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `limittrack-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("Backup exported");
  } catch (e) {
    showToast("Export failed");
  }
}

function importBackup(file) {
  if (file.size > 20 * 1024 * 1024) { showToast("Backup is too large (maximum 20 MB)."); return; }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      pendingImport = window.LimitTrackDomain.normalizeState(JSON.parse(reader.result));
      render();
    } catch (e) {
      showToast("Could not import backup: " + e.message);
    }
  };
  reader.onerror = () => showToast("Couldn't read that file");
  reader.readAsText(file);
}

// Re-render while keeping focus + text selection on whichever data-field
// input triggered it (used for the live search box, so typing doesn't
// lose cursor position on every keystroke).
function rerenderPreservingFocus() {
  const active = document.activeElement;
  const field = active && active.dataset ? active.dataset.field : null;
  const action = active?.dataset.action;
  const id = active?.dataset.id;
  const accountRow = active?.dataset.accountRow;
  const setting = active?.dataset.setting;
  const selStart = active && typeof active.selectionStart === "number" ? active.selectionStart : null;
  const selEnd = active && typeof active.selectionEnd === "number" ? active.selectionEnd : null;
  render();
  if (field) {
    const el = document.querySelector(`[data-field="${field}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      if (selStart !== null && el.setSelectionRange) {
        try {
          el.setSelectionRange(selStart, selEnd);
        } catch (e) {
          // some input types don't support selection ranges
        }
      }
    }
  } else if (setting) {
    [...document.querySelectorAll("[data-setting]")].find((el) => el.dataset.setting === setting)?.focus({ preventScroll: true });
  } else if (action) {
    [...document.querySelectorAll("[data-action]")].find((el) => el.dataset.action === action && el.dataset.id === id)?.focus({ preventScroll: true });
  } else if (accountRow) {
    [...document.querySelectorAll("[data-account-row]")].find((el) => el.dataset.accountRow === accountRow)?.focus({ preventScroll: true });
  }
}

// ---------- About modal focus management ----------

function getModalFocusable() {
  const modal = document.getElementById("about-modal");
  if (!modal) return [];
  return Array.from(modal.querySelectorAll('a[href], button, input, select, [tabindex]:not([tabindex="-1"])')).filter(
    (el) => !el.disabled && el.offsetParent !== null
  );
}

function focusFirstInModal() {
  const focusable = getModalFocusable();
  if (focusable.length) focusable[0].focus();
}

function closeAbout() {
  pendingImport = null;
  showAbout = false;
  render();
  document.querySelector('[data-action="toggle-about"]')?.focus();
  aboutOpenerEl = null;
}

async function savePreferences(patch) {
  if (preferencesBusy) return;
  preferencesBusy = true;
  preferencesError = "";
  preferencesMessage = "Saving…";
  const focused = document.activeElement;
  // Keep the active control in place until the asynchronous save completes.
  document.querySelectorAll("[data-setting], [data-action='set-theme']").forEach((el) => { el.disabled = true; });
  try {
    preferences = await window.LimitTrackPreferences.update(patch);
    preferencesMessage = "Saved";
  } catch (error) {
    preferencesError = "Settings were not saved. " + error.message;
    preferencesMessage = "";
  } finally {
    preferencesBusy = false;
    const setting = focused?.dataset.setting, action = focused?.dataset.action, id = focused?.dataset.id;
    render();
    if (setting) document.querySelector(`[data-setting="${setting}"]`)?.focus({ preventScroll: true });
    else if (action) [...document.querySelectorAll("[data-action]")].find((el) => el.dataset.action === action && el.dataset.id === id)?.focus({ preventScroll: true });
  }
}

// ---------- event delegation ----------

function attachEvents() {
  const app = document.getElementById("app");

  app.addEventListener("click", async (e) => {
    const clickedMenu = e.target.closest("details[data-menu]");
    document.querySelectorAll("details[data-menu][open]").forEach((item) => { if (item !== clickedMenu) item.open = false; });
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;

    // Any click that isn't part of an inline delete-confirm exchange
    // cancels a pending confirmation, so it can't be left dangling.
    const deleteActions = ["request-delete-account", "confirm-delete-account", "cancel-delete-account"];
    if (!deleteActions.includes(action)) pendingDeleteAccountId = null;
    const providerDeleteActions = ["request-delete-provider", "confirm-delete-provider", "cancel-delete-provider"];
    if (!providerDeleteActions.includes(action)) pendingDeleteProviderId = null;

    switch (action) {
      case "navigate":
        activeView = ["accounts", "widgets", "settings"].includes(id) ? id : "accounts";
        preferencesMessage = "";
        render();
        document.querySelector(`[data-action="navigate"][data-id="${activeView}"]`)?.focus();
        break;
      case "set-theme":
        await savePreferences({ theme: id });
        break;
      case "toggle-account-details":
        expandedAccountId = expandedAccountId === id ? null : id;
        render();
        [...document.querySelectorAll("[data-account-row]")].find((el) => el.dataset.accountRow === id)?.focus({ preventScroll: true });
        break;
      case "cancel-edit-cycle":
        editingProviderId = null;
        render();
        break;
      case "toggle-add-account":
        if (showAddAccount && !addAccountProviderId) closeAccountForm();
        else openAccountForm();
        break;
      case "add-account-to-provider":
        openAccountForm(id);
        break;
      case "toggle-add-provider":
        activeView = "accounts";
        showAddProvider = !showAddProvider;
        showAddAccount = false;
        render();
        break;
      case "cancel-add-account":
        closeAccountForm();
        break;
      case "cancel-add-provider":
        showAddProvider = false;
        render();
        break;
      case "save-add-account":
        addAccount();
        break;
      case "save-add-another-account":
        addAccount(true);
        break;
      case "save-add-provider":
        addProvider();
        break;
      case "mark-hit":
        markHit(id);
        break;
      case "toggle-reset-edit": {
        editingResetId = editingResetId === id ? null : id;
        if (editingResetId) {
          const acc = state.accounts.find((a) => a.id === id);
          editingResetValue = toLocalInputValue(acc ? acc.resetAt : null);
        }
        render();
        if (editingResetId) document.querySelector('[data-field="editing-reset-value"]')?.focus();
        break;
      }
      case "save-reset":
        saveCustomReset(id);
        break;
      case "apply-preset":
        applyPreset(id, parseFloat(btn.dataset.hours));
        break;
      case "cancel-reset-edit":
        editingResetId = null;
        render();
        break;
      case "clear-hit":
        clearHit(id);
        break;
      case "request-delete-account":
        pendingDeleteAccountId = id;
        render();
        break;
      case "confirm-delete-account":
        deleteAccount(id);
        break;
      case "cancel-delete-account":
        pendingDeleteAccountId = null;
        render();
        break;
      case "request-delete-provider":
        pendingDeleteProviderId = id;
        render();
        break;
      case "confirm-delete-provider":
        deleteProvider(id);
        break;
      case "cancel-delete-provider":
        pendingDeleteProviderId = null;
        render();
        break;
      case "edit-cycle":
        startEditCycle(id);
        break;
      case "save-cycle":
        saveEditCycle(id);
        break;
      case "toggle-about":
        aboutOpenerEl = btn;
        showAbout = true;
        render();
        focusFirstInModal();
        break;
      case "close-about":
        // Only close when the click landed directly on the backdrop (or the
        // Close button itself), not when it merely bubbled up from content
        // inside the modal, like the links in the "Built by" section.
        if (e.target === btn) closeAbout();
        break;
      case "toast-undo":
        undoLastDelete();
        break;
      case "toggle-sort":
        sortMode = sortMode === "soonest" ? "alpha" : "soonest";
        render();
        break;
      case "toggle-bulk-mode":
        bulkMode = !bulkMode;
        selectedIds.clear();
        render();
        break;
      case "toggle-select":
        if (selectedIds.has(id)) selectedIds.delete(id);
        else selectedIds.add(id);
        render();
        break;
      case "bulk-mark-hit":
        markHitBulk(Array.from(selectedIds));
        break;
      case "export-backup":
        exportBackup();
        break;
      case "trigger-import": {
        const input = document.getElementById("import-file-input");
        if (input) input.click();
        break;
      }
      case "cancel-import":
        pendingImport = null;
        render();
        break;
      case "confirm-import":
        if (pendingImport) {
          state = pendingImport;
          pendingImport = null;
          if (await saveState({ backup: true })) {
            showAbout = false;
            showToast("Backup imported. Previous data saved locally.");
          }
        }
        break;
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const openMenu = document.querySelector("details[data-menu][open]");
      if (openMenu && !showAbout) { openMenu.open = false; openMenu.querySelector("summary").focus(); return; }
      if (showAbout) {
        closeAbout();
      } else if (editingResetId) {
        editingResetId = null;
        render();
      } else if (showAddAccount) {
        closeAccountForm();
      } else if (showAddProvider) {
        showAddProvider = false;
        render();
      } else if (editingProviderId) {
        editingProviderId = null;
        render();
      } else if (bulkMode) {
        bulkMode = false;
        selectedIds.clear();
        render();
      }
      return;
    }

    // Trap Tab focus inside the About modal while it's open.
    if (showAbout && e.key === "Tab") {
      const focusable = getModalFocusable();
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }

    // Global shortcuts, ignored while the user is typing in a field or a
    // modal/panel is already open (so "n" doesn't fire while naming a tool).
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
    if (activeView !== "accounts" || showAbout || showAddAccount || showAddProvider) return;
    if (!typing && e.key === "n") {
      e.preventDefault();
      openAccountForm();
    } else if (!typing && e.key === "/") {
      e.preventDefault();
      const search = document.querySelector('[data-field="search-query"]');
      if (search) search.focus();
    }
  });

  app.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const field = e.target.dataset.field;
    if (!field) return;
    if (field.startsWith("new-account") && e.target.tagName !== "SELECT") {
      e.preventDefault();
      addAccount();
    } else if (field.startsWith("new-provider") && e.target.tagName !== "SELECT") {
      e.preventDefault();
      addProvider();
    }
  });

  app.addEventListener("input", (e) => {
    const field = e.target.dataset.field;
    if (!field) return;
    switch (field) {
      case "new-account-provider":
        newAccountDraft.providerId = e.target.value;
        break;
      case "new-account-email":
        newAccountDraft.email = e.target.value;
        break;
      case "new-account-cycle":
        newAccountDraft.cycleValue = e.target.value;
        break;
      case "new-provider-name":
        newProviderDraft.name = e.target.value;
        break;
      case "new-provider-cycle":
        newProviderDraft.cycleValue = e.target.value;
        break;
      case "editing-cycle-value":
        editingCycleValue = e.target.value;
        break;
      case "new-account-cycle-unit":
        newAccountDraft.cycleUnit = e.target.value;
        break;
      case "new-provider-cycle-unit":
        newProviderDraft.cycleUnit = e.target.value;
        break;
      case "editing-cycle-unit":
        editingCycleUnit = e.target.value;
        break;
      case "editing-reset-value":
        editingResetValue = e.target.value;
        const previewEl = document.getElementById("reset-preview");
        if (previewEl) previewEl.textContent = formatRelativePreview(editingResetValue);
        break;
      case "search-query":
        searchQuery = e.target.value;
        rerenderPreservingFocus();
        break;
      case "status-filter":
        statusFilter = e.target.value;
        rerenderPreservingFocus();
        break;
    }
  });

  app.addEventListener("change", async (e) => {
    const setting = e.target.dataset.setting;
    if (setting) {
      const value = setting === "widgetVisible" ? e.target.checked : setting === "widgetProviderId" ? e.target.value || null : e.target.value;
      await savePreferences({ [setting]: value });
      return;
    }
    if (e.target.dataset.field === "reset-preset" && e.target.value) {
      applyPreset(e.target.dataset.id, Number(e.target.value));
      return;
    }
    if (e.target.id === "import-file-input") {
      const file = e.target.files && e.target.files[0];
      if (file) importBackup(file);
      e.target.value = "";
    }
  });
}

// ---------- render ----------

function menu(label, contents) {
  return `<details class="action-menu" data-menu><summary class="button quiet icon-button" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">⋯</summary><div class="menu-panel">${contents}</div></details>`;
}

function statusNote(account, status) {
  return status === "locked" || status === "soon" ? account.resetSource === "exact" ? "Recorded reset" : "Estimated reset" : "";
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
  return `<div class="reset-editor"><div class="form-grid"><label class="field">Reset date and time<input type="datetime-local" aria-label="Reset date and time" data-field="editing-reset-value" value="${escapeHtml(editingResetValue)}" /></label><label class="field">Or reset in<select aria-label="Reset in" data-field="reset-preset" data-id="${escapeHtml(account.id)}"><option value="">Choose a duration</option>${RESET_PRESETS.map((p) => `<option value="${p.hours}">${p.label}</option>`).join("")}</select></label></div><div class="help" id="reset-preview">${formatRelativePreview(editingResetValue)}</div><div class="button-row"><button class="button primary small" data-action="save-reset" data-id="${escapeHtml(account.id)}">Save reset</button><button class="button quiet small" data-action="cancel-reset-edit">Cancel</button></div></div>`;
}

function renderAccount(account, nowMs) {
  const id = escapeHtml(account.id), status = getStatus(account, nowMs);
  const primaryAction = status === "open" ? "mark-hit" : status === "locked" || status === "soon" ? "toggle-reset-edit" : "clear-hit";
  const primaryLabel = status === "open" ? "Log limit" : status === "locked" || status === "soon" ? "Edit reset" : "Mark available";
  const items = `<button data-action="toggle-account-details" data-id="${id}">Account details</button>
    ${primaryAction !== "mark-hit" ? `<button data-action="mark-hit" data-id="${id}">Log limit</button>` : ""}
    ${primaryAction !== "toggle-reset-edit" ? `<button data-action="toggle-reset-edit" data-id="${id}">Set reset time</button>` : ""}
    ${status === "locked" || status === "soon" ? `<button data-action="clear-hit" data-id="${id}">Mark available</button>` : ""}
    <button class="destructive" data-action="request-delete-account" data-id="${id}">Remove account</button>`;
  return `<div data-account-row="${id}" tabindex="-1">
    <div class="account-row">
      <div class="account-identity">${bulkMode ? `<input type="checkbox" aria-label="Select ${escapeHtml(account.email)}" data-action="toggle-select" data-id="${id}" ${selectedIds.has(account.id) ? "checked" : ""} />` : `<span class="status-dot status-${status}" id="dot-${id}" aria-hidden="true"></span>`}<div class="account-name" title="${escapeHtml(account.email)}">${escapeHtml(account.email)}</div></div>
      <div class="account-status-block"><div class="account-status status-${status}" id="countdown-${id}">${formatCountdown(account, nowMs)}</div><div class="account-status-note" id="label-${id}">${statusNote(account, status)}</div></div>
      <div class="row-actions"><button class="button small" data-action="${primaryAction}" data-id="${id}">${primaryLabel}</button>${menu(`More actions for ${account.email}`, items)}</div>
    </div>
    ${pendingDeleteAccountId === account.id ? `<div class="delete-prompt">Remove ${escapeHtml(account.email)}?<button class="button danger small" data-action="confirm-delete-account" data-id="${id}">Remove</button><button class="button quiet small" data-action="cancel-delete-account">Cancel</button></div>` : ""}
    ${expandedAccountId === account.id ? `<div class="account-detail"><dl class="meta-grid"><div><dt>Limit logged</dt><dd>${account.lastHitAt ? formatWhen(account.lastHitAt) : "No limit recorded"}</dd></div><div><dt>${account.resetSource === "exact" ? "Recorded reset" : "Estimated reset"}</dt><dd>${account.resetAt ? formatWhen(account.resetAt) : "No active timer"}</dd></div><div><dt>Availability confirmed</dt><dd>${account.confirmedAvailableAt ? formatWhen(account.confirmedAvailableAt) : "Not confirmed"}</dd></div><div><dt>Reset cycle</dt><dd>${cycleLabel(accountCycle(account).value, accountCycle(account).unit)}</dd></div></dl></div>` : ""}
    ${editingResetId === account.id ? renderResetEditor(account) : ""}
  </div>`;
}

function renderProvider(provider, nowMs) {
  const id = escapeHtml(provider.id), query = searchQuery.trim().toLowerCase();
  const all = state.accounts.filter((a) => a.providerId === provider.id);
  const accounts = all.filter((a) => !query || a.email.toLowerCase().includes(query) || provider.name.toLowerCase().includes(query))
    .filter((a) => statusFilter === "all" || (statusFilter === "waiting" ? ["locked", "soon"].includes(getStatus(a, nowMs)) : getStatus(a, nowMs) === statusFilter))
    .sort((a, b) => {
      if (sortMode === "alpha") return a.email.localeCompare(b.email);
      const first = effectiveTime(a, nowMs), second = effectiveTime(b, nowMs);
      return first === second ? a.email.localeCompare(b.email) : first - second;
    });
  const items = `<button data-action="edit-cycle" data-id="${id}">Edit reset cycle</button>${all.length === 0 ? `<button class="destructive" data-action="request-delete-provider" data-id="${id}">Remove tool</button>` : ""}`;
  return `<section class="tool-card" aria-label="${escapeHtml(provider.name)} accounts">
    <header class="tool-heading"><div class="tool-identity"><h3>${escapeHtml(provider.name)}</h3><span class="tool-count" id="provider-count-${id}">${all.length} ${all.length === 1 ? "account" : "accounts"}</span></div><div class="row-actions"><button class="button quiet small" data-action="add-account-to-provider" data-id="${id}" aria-label="Add account to ${escapeHtml(provider.name)}">${icon("plus", 14)} Add account</button>${menu(`${provider.name} options`, items)}</div></header>
    ${editingProviderId === provider.id ? `<div class="cycle-editor"><p class="help">Used to estimate resets when you log a limit. Match this to your plan.</p><div class="form-grid"><label class="field">Duration<input type="number" min="0.01" max="100000" step="any" aria-label="Cycle length" data-field="editing-cycle-value" value="${escapeHtml(editingCycleValue)}" /></label><label class="field">Unit<select aria-label="Cycle unit" data-field="editing-cycle-unit"><option value="days" ${editingCycleUnit === "days" ? "selected" : ""}>Days</option><option value="hours" ${editingCycleUnit === "hours" ? "selected" : ""}>Hours</option></select></label></div><div class="button-row"><button class="button primary small" data-action="save-cycle" data-id="${id}">Save cycle</button><button class="button quiet small" data-action="cancel-edit-cycle">Cancel</button></div></div>` : ""}
    ${pendingDeleteProviderId === provider.id ? `<div class="delete-prompt">Remove this empty tool?<button class="button danger small" data-action="confirm-delete-provider" data-id="${id}">Remove</button><button class="button quiet small" data-action="cancel-delete-provider">Cancel</button></div>` : ""}
    ${showAddAccount && addAccountProviderId === provider.id ? renderAccountForm(provider) : ""}
    ${accounts.map((account) => renderAccount(account, nowMs)).join("")}
    ${accounts.length === 0 && !(showAddAccount && addAccountProviderId === provider.id) ? `<p class="empty-copy">${all.length ? "No accounts match your filters." : "No accounts yet."}</p>` : ""}
  </section>`;
}

function renderAddTool() {
  return `<section class="tool-card composer"><h3>Add tool</h3><div class="form-grid"><label class="field">Tool name<input type="text" required data-field="new-provider-name" placeholder="For example, Cursor" value="${escapeHtml(newProviderDraft.name)}" /></label><label class="field">Estimated reset cycle<div class="field-pair"><input type="number" min="0.01" max="100000" step="any" data-field="new-provider-cycle" aria-label="Reset duration" value="${escapeHtml(newProviderDraft.cycleValue)}" /><select aria-label="Reset unit" data-field="new-provider-cycle-unit"><option value="days" ${newProviderDraft.cycleUnit === "days" ? "selected" : ""}>Days</option><option value="hours" ${newProviderDraft.cycleUnit === "hours" ? "selected" : ""}>Hours</option></select></div></label></div><div class="button-row"><button class="button primary" data-action="save-add-provider">Add tool</button><button class="button quiet" data-action="cancel-add-provider">Cancel</button></div></section>`;
}

function renderAccounts(nowMs) {
  const available = state.accounts.filter((a) => getStatus(a, nowMs) === "open").length;
  const next = state.accounts.filter((a) => ["locked", "soon"].includes(getStatus(a, nowMs))).sort((a, b) => effectiveTime(a, nowMs) - effectiveTime(b, nowMs))[0];
  return `<div class="page-heading"><div><h2>Accounts</h2><p class="help" id="summary-text">${available} available · ${state.accounts.length} tracked</p></div><button class="button primary" data-action="toggle-add-account">${icon("plus", 16)} Add account</button></div>
    <div class="toolbar"><input class="search-field" data-field="search-query" aria-label="Search accounts" placeholder="Search accounts or tools" value="${escapeHtml(searchQuery)}" /><select aria-label="Filter by status" data-field="status-filter">${[["all", "All statuses"], ["open", "Available"], ["waiting", "Waiting"], ["ready", "Expected ready"], ["unknown", "Not checked"]].map(([value, label]) => `<option value="${value}" ${statusFilter === value ? "selected" : ""}>${label}</option>`).join("")}</select>${menu("More account options", `<button data-action="toggle-add-provider">Add tool</button><button data-action="toggle-bulk-mode">${bulkMode ? "Stop selecting" : "Select accounts"}</button><button data-action="toggle-sort">Sort ${sortMode === "soonest" ? "A–Z" : "by next reset"}</button>`)}</div>
    ${next ? `<p class="help" style="margin:0 0 18px">Next reset in <span id="next-reset-countdown">${formatCountdown(next, nowMs)}</span> · <span id="next-reset-tool">${escapeHtml(state.providers.find((p) => p.id === next.providerId)?.name || "Account")}</span></p>` : ""}
    ${bulkMode ? `<div class="bulk-bar"><span>${selectedIds.size} selected</span><button class="button small" data-action="bulk-mark-hit" ${selectedIds.size ? "" : "disabled"}>Log limit for selected</button><button class="button quiet small" data-action="toggle-bulk-mode">Cancel</button></div>` : ""}
    <div class="tool-list">${showAddAccount && !addAccountProviderId ? `<section class="tool-card">${renderAccountForm()}</section>` : ""}${showAddProvider ? renderAddTool() : ""}${state.providers.map((p) => renderProvider(p, nowMs)).join("")}${state.providers.length === 0 ? `<section class="settings-card"><h3>Add your first tool</h3><p class="help">Start with the coding tool you use most.</p><div class="button-row"><button class="button" data-action="toggle-add-provider">Add tool</button></div></section>` : ""}</div>`;
}

function renderWidgets() {
  return `<div class="page-heading"><div><h2>Widgets</h2><p class="help">Keep your accounts in view while you work.</p></div></div><div class="settings-stack"><section class="settings-card" id="widget-settings"><h3>Desktop widget</h3>
    <div class="setting-row"><div><div class="setting-label">Tool to show</div><p class="help">Track one tool, or see all accounts together.</p></div><select aria-label="Widget tool" data-setting="widgetProviderId" ${preferencesBusy ? "disabled" : ""}><option value="">All tools</option>${state.providers.map((p) => `<option value="${escapeHtml(p.id)}" ${preferences.widgetProviderId === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}</select></div>
    <div class="setting-row"><div><label class="toggle-label"><input type="checkbox" role="switch" aria-label="Show desktop widget" data-setting="widgetVisible" ${preferences.widgetVisible ? "checked" : ""} ${preferencesBusy ? "disabled" : ""} /><span class="setting-label">Show desktop widget</span></label><p class="help" style="margin-left:27px">${preferences.widgetVisible ? "On — the widget appears above your other windows." : "Off — enable it to place the widget on your desktop."}</p></div></div>
    <p class="setup-note">Choose a tool, turn on the widget, then drag its header to move it. Closing the widget hides it; you can turn it back on here. Theme and font follow Settings.</p>
    <div class="settings-feedback" role="status">${preferencesBusy ? "Saving…" : preferencesMessage}</div>
  </section></div>`;
}

function renderBackupSettings() {
  return `<section class="settings-card"><h3>Backup &amp; restore</h3><p class="help">Your accounts stay on this device. Export a copy before moving computers.</p><div class="button-row"><button class="button" data-action="export-backup">Export backup</button><button class="button" data-action="trigger-import">Import backup</button><input type="file" hidden id="import-file-input" accept="application/json,.json" /></div>${pendingImport ? `<div class="import-preview"><p>Replace ${state.accounts.length} accounts with ${pendingImport.accounts.length} accounts from this backup? A recovery copy is saved first.</p><div class="button-row"><button class="button primary" data-action="confirm-import">Replace accounts</button><button class="button quiet" data-action="cancel-import">Cancel import</button></div></div>` : ""}</section>`;
}

function renderSettings() {
  return `<div class="page-heading"><div><h2>Settings</h2><p class="help">Make LimitTrack comfortable to use.</p></div></div><div class="settings-stack"><section class="settings-card"><h3>Appearance</h3>
    <div class="setting-row"><div><div class="setting-label">Theme</div><p class="help">Applies to the app and desktop widget.</p></div><div class="segmented" role="group" aria-label="Theme">${[["system", "System"], ["light", "Light"], ["dark", "Dark"]].map(([value, label]) => `<button data-action="set-theme" data-id="${value}" aria-pressed="${preferences.theme === value}" ${preferencesBusy ? "disabled" : ""}>${label}</button>`).join("")}</div></div>
    <div class="setting-row"><div><div class="setting-label">Font</div><p class="help">System uses your device's native interface font.</p></div><select aria-label="Interface font" data-setting="font" ${preferencesBusy ? "disabled" : ""}><option value="system" ${preferences.font === "system" ? "selected" : ""}>System (default)</option><option value="inter" ${preferences.font === "inter" ? "selected" : ""}>Inter</option></select></div>
    <div class="settings-feedback" role="status">${preferencesBusy ? "Saving…" : preferencesMessage}</div>
    </section>${renderBackupSettings()}<div class="settings-footer"><span>LimitTrack · Local storage</span><button class="button quiet small" data-action="toggle-about" aria-haspopup="dialog">About</button></div></div>`;
}

function render() {
  const nowMs = Date.now();
  document.getElementById("app").innerHTML = `<div class="app-shell"><header class="topbar"><div class="brand"><img src="icon.png" alt="" /><h1>LimitTrack</h1></div><span class="local-note">Your tools, at a glance</span></header>
    <nav class="app-nav" aria-label="Main navigation">${[["accounts", "Accounts"], ["widgets", "Widgets"], ["settings", "Settings"]].map(([value, label]) => `<button data-action="navigate" data-id="${value}" ${activeView === value ? 'aria-current="page"' : ""}>${label}</button>`).join("")}</nav>
    ${persistenceError ? `<div role="alert" class="alert">${escapeHtml(persistenceError)}</div>` : ""}${preferencesError ? `<div role="alert" class="alert">${escapeHtml(preferencesError)}</div>` : ""}
    <main>${activeView === "widgets" ? renderWidgets() : activeView === "settings" ? renderSettings() : renderAccounts(nowMs)}</main>
    ${toast ? `<div role="status" aria-live="polite" class="toast"><span>${escapeHtml(toast.message)}</span>${lastDeleted ? '<button data-action="toast-undo">Undo</button>' : ""}</div>` : ""}
    ${showAbout ? `<div class="modal-backdrop" data-action="close-about"><div class="about-dialog" id="about-modal" role="dialog" aria-modal="true" aria-labelledby="about-modal-title"><h2 id="about-modal-title">LimitTrack</h2><p>Version 1.2.1</p><p>Recorded reset times for your AI coding accounts.</p><p>Built by Abdul Rehman.</p><p><a href="https://github.com/rehmanoncloud9/limittrack" target="_blank" rel="noreferrer">View project on GitHub</a></p><div class="button-row"><button class="button" data-action="close-about">Close</button></div></div></div>` : ""}
  </div>`;
}


// ---------- live tick (lightweight DOM patch, preserves input focus) ----------

function tick() {
  const now = new Date();
  const nowMs = now.getTime();
  if (activeView !== "accounts") {
    const statuses = Object.fromEntries(state.accounts.map((a) => [a.id, getStatus(a, nowMs)]));
    Object.assign(prevStatus, statuses);
    updateTrayTooltip(nowMs, statuses);
    return;
  }

  const next = state.accounts.filter((a) => ["locked", "soon"].includes(getStatus(a, nowMs)))
    .sort((a, b) => effectiveTime(a, nowMs) - effectiveTime(b, nowMs))[0];
  const provider = next && state.providers.find((p) => p.id === next.providerId);
  const nextEl = document.getElementById("next-reset-countdown");
  if (nextEl) nextEl.textContent = next ? formatCountdown(next, nowMs) : "No active timers";
  const nextToolEl = document.getElementById("next-reset-tool");
  if (nextToolEl) nextToolEl.textContent = next ? (provider ? provider.name : "Account") : "Recorded locally";

  let needsReorder = false;
  const newStatuses = {};
  state.accounts.forEach((acc) => {
    const status = getStatus(acc, nowMs);
    newStatuses[acc.id] = status;
    const prev = prevStatus[acc.id];
    if (prev !== undefined && prev !== status) needsReorder = true;
  });

  const editingOpen = Boolean(editingResetId || editingProviderId || showAddAccount || showAddProvider);

  Object.assign(prevStatus, newStatuses);

  if (needsReorder && !editingOpen) {
    render();
    updateTrayTooltip(nowMs, newStatuses);
    return;
  }

  state.accounts.forEach((acc) => {
    const status = newStatuses[acc.id];
    const styles = statusStyles(status);
    const countdownEl = document.getElementById(`countdown-${acc.id}`);
    const labelEl = document.getElementById(`label-${acc.id}`);
    const dotEl = document.getElementById(`dot-${acc.id}`);
    if (countdownEl) {
      countdownEl.textContent = formatCountdown(acc, nowMs);
      countdownEl.className = `account-status status-${status}`;
    }
    if (labelEl) {
      labelEl.textContent = statusNote(acc, status);
      labelEl.className = "account-status-note";
    }
    if (dotEl) {
      dotEl.className = `status-dot status-${status}`;
    }
    const progressEl = document.getElementById(`progress-${acc.id}`);
    if (progressEl) {
      const progress = cycleProgress(acc, nowMs);
      if (progress !== null) progressEl.style.width = `${progress.toFixed(1)}%`;
    }
  });

  const summaryEl = document.getElementById("summary-text");
  if (summaryEl) {
    const openCount = state.accounts.filter((a) => newStatuses[a.id] === "open").length;
    summaryEl.textContent = `${openCount} available · ${state.accounts.length} tracked`;
  }

  state.providers.forEach((p) => {
    const accts = state.accounts.filter((a) => a.providerId === p.id);
    const oc = accts.filter((a) => newStatuses[a.id] === "open").length;
    const el = document.getElementById(`provider-count-${p.id}`);
    if (el) el.textContent = `${accts.length} ${accts.length === 1 ? "account" : "accounts"}`;
  });

  updateTrayTooltip(nowMs, newStatuses);
}

// Keep the OS tray icon's tooltip showing a live "what's next" summary,
// so the person can check status without opening the window.
function updateTrayTooltip(nowMs, statuses) {
  if (!window.limittrack || !window.limittrack.trayUpdate) return;
  let text;
  if (state.accounts.length === 0) {
    text = "LimitTrack: no accounts yet";
  } else {
    const openCount = state.accounts.filter((a) => statuses[a.id] === "open").length;
    const waiting = state.accounts
      .filter((a) => ["locked", "soon"].includes(statuses[a.id]))
      .sort((a, b) => effectiveTime(a, nowMs) - effectiveTime(b, nowMs));
    if (waiting.length === 0) {
      text = `LimitTrack: ${openCount} marked available · No active timers`;
    } else {
      const next = waiting[0];
      const provider = state.providers.find((p) => p.id === next.providerId);
      text = `LimitTrack: ${openCount} marked available · ${provider ? provider.name : "Next reset"} in ${formatCountdown(next, nowMs)}`;
    }
  }
  window.limittrack.trayUpdate(text);
}

// ---------- init ----------

window.addEventListener("DOMContentLoaded", () => {
  attachEvents();
  window.LimitTrackPreferences.subscribe((value) => {
    preferences = value;
    if (activeView !== "accounts" && !preferencesBusy) rerenderPreservingFocus();
  });
  window.LimitTrackPreferences.ready.then((value) => {
    preferences = value;
    if (activeView !== "accounts") rerenderPreservingFocus();
  }).catch((error) => { preferencesError = "Settings could not be loaded. " + error.message; render(); });
  window.limittrack.onWidgetConfigure(() => {
    activeView = "widgets";
    render();
    document.querySelector('[data-action="navigate"][data-id="widgets"]')?.focus();
  });
  if (window.limittrack.onStorageChanged) {
    window.limittrack.onStorageChanged((key) => {
      if (key === STORAGE_KEY) loadState(true);
    });
  }
  if (window.limittrack.onAccountReveal) {
    window.limittrack.onAccountReveal(async (accountId) => {
      activeView = "accounts";
      searchQuery = "";
      statusFilter = "all";
      await loadState();
      const row = [...document.querySelectorAll("[data-account-row]")]
        .find((el) => el.dataset.accountRow === accountId);
      if (row) {
        row.focus({ preventScroll: true });
        row.scrollIntoView({ block: "center", behavior: "auto" });
      }
    });
  }
  render();
  loadState();
  setInterval(tick, 1000);
});
