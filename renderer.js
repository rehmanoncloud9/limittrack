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
  if (aboutOpenerEl && document.body.contains(aboutOpenerEl)) aboutOpenerEl.focus();
  aboutOpenerEl = null;
}

// ---------- event delegation ----------

function attachEvents() {
  const app = document.getElementById("app");

  app.addEventListener("click", async (e) => {
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
      case "toggle-add-account":
        if (showAddAccount && !addAccountProviderId) closeAccountForm();
        else openAccountForm();
        break;
      case "add-account-to-provider":
        openAccountForm(id);
        break;
      case "toggle-add-provider":
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
    if (showAbout || showAddAccount || showAddProvider) return;
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

  app.addEventListener("change", (e) => {
    if (e.target.id === "import-file-input") {
      const file = e.target.files && e.target.files[0];
      if (file) importBackup(file);
      e.target.value = "";
    }
  });
}

// ---------- render ----------

function renderAccountForm(provider = null) {
  const providerOptions = state.providers
    .map((p) => `<option value="${p.id}" ${newAccountDraft.providerId === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`)
    .join("");

  return `<div class="account-composer ${provider ? "border-b border-line bg-canvas/60" : "rounded-2xl bg-surface border border-line"} p-4 sm:p-5">
                <div class="mb-4"><h3 class="text-base font-semibold text-ink">Add account${provider ? ` to ${escapeHtml(provider.name)}` : ""}</h3><p class="mt-1 text-xs text-muted">${provider ? `Uses this tool's configured ${cycleLabel(provider.cycleValue, provider.cycleUnit)} for estimates. Adjust it to match your plan.` : "Choose a tool and enter the account email. Status starts as not checked."}</p></div>
                <div class="grid gap-3 sm:grid-cols-2">
                  ${provider ? `<div class="flex items-center gap-2 text-sm text-ink px-1">${icon("check", 14)} ${escapeHtml(provider.name)}</div>` : `<select required aria-label="Tool" data-field="new-account-provider" class="bg-surface border border-line rounded-xl px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-blue-400 transition">
                    <option value="">Select tool</option>
                    ${providerOptions}
                  </select>`}
                  <input type="email" required aria-label="Account email" placeholder="you@example.com" data-field="new-account-email" value="${escapeHtml(newAccountDraft.email)}" class="bg-surface border border-line rounded-xl px-3 py-2 text-sm text-ink placeholder-muted focus:outline-none focus:ring-2 focus:ring-blue-400 transition" />
                </div>
                <div class="grid gap-3 sm:grid-cols-2 mt-3">
                  <div class="flex items-center gap-2">
                    <input type="number" min="0.01" max="100000" step="any" placeholder="Custom duration" aria-label="Custom reset duration (optional)" data-field="new-account-cycle" value="${escapeHtml(newAccountDraft.cycleValue)}" class="w-full bg-surface border border-line rounded-xl px-3 py-2 text-sm text-ink placeholder-muted focus:outline-none focus:ring-2 focus:ring-blue-400 transition" />
                    <select data-field="new-account-cycle-unit" class="bg-surface border border-line rounded-xl px-2 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-blue-400 transition">
                      <option value="days" ${newAccountDraft.cycleUnit === "days" ? "selected" : ""}>days</option>
                      <option value="hours" ${newAccountDraft.cycleUnit === "hours" ? "selected" : ""}>hours</option>
                    </select>
                  </div>
                  <div class="text-xs text-muted flex items-center px-1">Optional. Leave blank to use the tool’s default reset cycle.</div>
                </div>
                <div class="flex flex-wrap gap-2 mt-4">
                  <button data-action="save-add-account" class="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white text-sm font-medium px-4 py-2 shadow-sm shadow-blue-500/30 transition-all active:scale-95">${icon("check", 14)} Add account</button>
                  <button data-action="save-add-another-account" class="rounded-full bg-accent-soft hover:bg-accent-soft text-accent-ink text-sm font-medium px-4 py-2 transition-colors">Add &amp; add another</button>
                  <button data-action="cancel-add-account" class="inline-flex items-center gap-1.5 rounded-full bg-surface border border-line hover:bg-canvas text-muted text-sm px-4 py-2 transition-all active:scale-95">${icon("x", 14)} Cancel</button>
                </div>
              </div>`;
}

function render() {
  const now = new Date();
  const nowMs = now.getTime();
  const totalAccounts = state.accounts.length;
  const openAccounts = state.accounts.filter((a) => getStatus(a, nowMs) === "open").length;
  const next = state.accounts.filter((a) => ["locked", "soon"].includes(getStatus(a, nowMs)))
    .sort((a, b) => effectiveTime(a, nowMs) - effectiveTime(b, nowMs))[0];
  const nextProvider = next && state.providers.find((p) => p.id === next.providerId);

  const providerSections = state.providers
    .map((provider) => {
      const query = searchQuery.trim().toLowerCase();
      const accounts = state.accounts
        .filter((a) => a.providerId === provider.id)
        .filter((a) => !query || a.email.toLowerCase().includes(query) || provider.name.toLowerCase().includes(query))
        .filter((a) => statusFilter === "all" || (statusFilter === "waiting" ? ["locked", "soon"].includes(getStatus(a, nowMs)) : getStatus(a, nowMs) === statusFilter))
        .sort((a, b) => {
          if (sortMode === "alpha") return a.email.localeCompare(b.email);
          const ea = effectiveTime(a, nowMs);
          const eb = effectiveTime(b, nowMs);
          if (ea === -1 && eb === -1) return a.email.localeCompare(b.email);
          return ea === eb ? a.email.localeCompare(b.email) : ea - eb;
        });
      const allAccountsForProvider = state.accounts.filter((a) => a.providerId === provider.id);
      const openCount = allAccountsForProvider.filter((a) => getStatus(a, nowMs) === "open").length;

      const cycleBadge =
        editingProviderId === provider.id
          ? `<span class="flex items-center gap-1">
               <input type="number" min="0.01" max="100000" step="any" value="${escapeHtml(editingCycleValue)}" data-field="editing-cycle-value" aria-label="Cycle length" class="w-14 bg-surface border border-line rounded-lg px-1.5 py-0.5 text-xs text-ink" />
               <select data-field="editing-cycle-unit" aria-label="Cycle unit" class="bg-surface border border-line rounded-lg px-1.5 py-0.5 text-xs text-ink">
                 <option value="days" ${editingCycleUnit === "days" ? "selected" : ""}>days</option>
                 <option value="hours" ${editingCycleUnit === "hours" ? "selected" : ""}>hours</option>
               </select>
               <button data-action="save-cycle" data-id="${provider.id}" aria-label="Save cycle" class="text-success">${icon("check", 13)}</button>
             </span>`
          : `<button data-action="edit-cycle" data-id="${provider.id}" aria-label="Edit ${escapeHtml(provider.name)} reset cycle" class="inline-flex items-center gap-1 text-xs text-muted hover:text-ink bg-subtle/80 hover:bg-line/80 rounded-full px-2.5 py-1 transition-colors">
               ${cycleLabel(provider.cycleValue, provider.cycleUnit)} ${icon("pencil", 10)}
             </button>`;

      const noMatch = allAccountsForProvider.length > 0 && accounts.length === 0;
      const accountRows =
        allAccountsForProvider.length === 0
          ? `<div class="px-5 py-4 text-sm text-muted">No accounts added for ${escapeHtml(provider.name)} yet.</div>`
          : noMatch
          ? `<div class="px-5 py-4 text-sm text-muted">No accounts match the current search and status filter.</div>`
          : accounts
              .map((acc) => {
                const status = getStatus(acc, nowMs);
                const styles = statusStyles(status);
                const progress = cycleProgress(acc, nowMs);
                const isPendingDelete = pendingDeleteAccountId === acc.id;
                const resetEditPanel =
                  editingResetId === acc.id
                    ? `<div class="border-t border-line/60 bg-canvas/60 px-5 py-3">
                         <div class="flex flex-wrap items-center gap-1.5 mb-2.5">
                           ${RESET_PRESETS.map(
                             (p) =>
                               `<button data-action="apply-preset" data-id="${acc.id}" data-hours="${p.hours}" class="rounded-full bg-surface hover:bg-accent-soft border border-line hover:border-blue-200 text-muted hover:text-accent-ink text-xs font-medium px-3 py-1 transition-all active:scale-95">${p.label}</button>`
                           ).join("")}
                         </div>
                         <div class="flex flex-wrap items-center gap-2">
                           <label class="text-xs text-muted">or pick exactly</label>
                           <input type="datetime-local" data-field="editing-reset-value" value="${escapeHtml(editingResetValue)}" class="bg-surface border border-line rounded-xl px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-blue-400 transition" />
                           <span id="reset-preview" class="text-xs font-medium text-accent-ink">${formatRelativePreview(editingResetValue)}</span>
                           <button data-action="save-reset" data-id="${acc.id}" class="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-blue-500 to-indigo-500 text-white text-xs font-medium px-3 py-1.5 shadow-sm shadow-blue-500/30 transition-all active:scale-95">${icon("check", 13)} Save</button>
                           <button data-action="cancel-reset-edit" data-id="${acc.id}" class="inline-flex items-center gap-1 rounded-full bg-surface border border-line hover:bg-canvas text-muted text-xs px-3 py-1.5 transition-all active:scale-95">${icon("x", 13)} Cancel</button>
                         </div>
                       </div>`
                    : "";
                const actionButtons = isPendingDelete
                  ? `<div class="flex items-center gap-1.5 bg-danger-soft rounded-full pl-3 pr-1.5 py-1">
                       <span class="text-xs text-danger font-medium">Remove?</span>
                       <button data-action="confirm-delete-account" data-id="${acc.id}" aria-label="Confirm remove account" class="p-1 rounded-full bg-danger-soft0 hover:bg-red-600 text-white transition-colors">${icon("check", 12)}</button>
                       <button data-action="cancel-delete-account" data-id="${acc.id}" aria-label="Cancel remove account" class="p-1 rounded-full bg-surface hover:bg-subtle text-muted transition-colors">${icon("x", 12)}</button>
                     </div>`
                  : `${status === "unknown" || status === "ready" ? `<button data-action="clear-hit" data-id="${acc.id}" class="rounded-full bg-success-soft hover:bg-success-soft text-success text-xs font-medium px-3 py-1.5">Mark available</button>` : ""}<button data-action="mark-hit" data-id="${acc.id}" class="inline-flex items-center gap-1 rounded-full bg-accent-soft hover:bg-accent-soft border border-blue-100 text-accent-ink text-xs font-medium px-3 py-1.5 transition-all active:scale-95" title="Estimate the reset from now using the configured cycle">${icon("clock", 12)} Log limit</button>
                     <button data-action="toggle-reset-edit" data-id="${acc.id}" aria-label="Set exact reset time for ${escapeHtml(acc.email)}" class="p-1.5 rounded-full hover:bg-subtle transition-colors ${editingResetId === acc.id ? "text-blue-500" : "text-muted hover:text-blue-500"}" title="Set an exact reset date & time">${icon("calendar", 14)}</button>
                     ${status === "locked" || status === "soon" ? `<button data-action="clear-hit" data-id="${acc.id}" aria-label="Mark ${escapeHtml(acc.email)} available" class="p-1.5 rounded-full text-muted hover:text-success hover:bg-success-soft transition-colors" title="Mark available and clear the timer">${icon("check", 13)}</button>` : ""}
                     <button data-action="request-delete-account" data-id="${acc.id}" aria-label="Remove account ${escapeHtml(acc.email)}" class="p-1.5 rounded-full text-muted hover:text-red-500 hover:bg-danger-soft transition-colors" title="Remove account">${icon("trash", 13)}</button>`;
                return `
                  <div data-account-row="${escapeHtml(acc.id)}" tabindex="-1">
                    <div class="flex items-center justify-between gap-3 border-t border-line/60 px-5 py-3.5 flex-wrap hover:bg-surface/40 transition-colors">
                      <div class="flex items-center gap-3 min-w-0">
                        ${
                          bulkMode
                            ? `<input type="checkbox" data-action="toggle-select" data-id="${acc.id}" ${selectedIds.has(acc.id) ? "checked" : ""} aria-label="Select ${escapeHtml(acc.email)}" class="h-4 w-4 rounded border-line text-accent-ink focus:ring-blue-400 flex-shrink-0" />`
                            : `<span id="dot-${acc.id}" class="h-2.5 w-2.5 rounded-full flex-shrink-0 ${styles.dot}"></span>`
                        }
                        <div class="min-w-0">
                          <div class="text-sm font-medium text-ink truncate">${escapeHtml(acc.email)}</div>
                          <div class="text-xs text-muted">
                            Limit logged ${formatWhen(acc.lastHitAt)}
                            ${acc.cycleValue ? `<span class="ml-1 text-muted">&middot; custom ${cycleLabel(acc.cycleValue, acc.cycleUnit)}</span>` : ""}
                          </div>
                          ${acc.resetAt ? `<div class="text-xs text-muted mt-1">${acc.resetSource === "exact" ? "Recorded reset" : "Estimated reset"} · ${escapeHtml(formatWhen(acc.resetAt))}</div>` : ""}
                          ${
                            progress !== null
                              ? `<div class="mt-1.5 h-1 w-32 max-w-full rounded-full bg-line overflow-hidden">
                                   <div id="progress-${acc.id}" class="h-full rounded-full ${status === "soon" ? "bg-orange-400" : "bg-slate-400"} transition-all" style="width:${progress.toFixed(1)}%"></div>
                                 </div>`
                              : ""
                          }
                        </div>
                      </div>
                      <div class="flex items-center gap-2 flex-shrink-0">
                        <div class="text-right mr-1">
                          <div id="countdown-${acc.id}" class="font-sans text-sm font-semibold tabular-nums ${styles.text}">${formatCountdown(acc, nowMs)}</div>
                          <div id="label-${acc.id}" class="text-xs ${styles.text}">${styles.label}</div>
                        </div>
                        ${actionButtons}
                      </div>
                    </div>
                    ${resetEditPanel}
                  </div>
                `;
              })
              .join("");

      const isPendingProviderDelete = pendingDeleteProviderId === provider.id;
      const providerDeleteControl =
        allAccountsForProvider.length === 0
          ? isPendingProviderDelete
            ? `<span class="flex items-center gap-1">
                 <span class="text-xs text-danger font-medium">Remove tool?</span>
                 <button data-action="confirm-delete-provider" data-id="${provider.id}" aria-label="Confirm remove ${escapeHtml(provider.name)}" class="p-1 rounded-full bg-danger-soft0 hover:bg-red-600 text-white transition-colors">${icon("check", 12)}</button>
                 <button data-action="cancel-delete-provider" data-id="${provider.id}" aria-label="Cancel remove ${escapeHtml(provider.name)}" class="p-1 rounded-full bg-surface hover:bg-subtle text-muted transition-colors">${icon("x", 12)}</button>
               </span>`
            : `<button data-action="request-delete-provider" data-id="${provider.id}" aria-label="Remove tool ${escapeHtml(provider.name)}" class="p-1 rounded-full text-muted hover:text-red-500 hover:bg-danger-soft transition-colors" title="Remove tool">${icon("trash", 13)}</button>`
          : "";

      return `
        <div class="rounded-3xl bg-surface/80 ring-1 ring-line shadow-sm overflow-hidden">
          <div class="flex items-center justify-between gap-2 bg-surface/40 border-b border-line/60 px-5 py-3.5 flex-wrap">
            <div class="flex items-center gap-3">
              <span class="text-section font-semibold text-ink">${escapeHtml(provider.name)}</span>
              ${cycleBadge}
            </div>
            <div class="flex items-center gap-3">
              <span id="provider-count-${provider.id}" class="text-xs text-muted">${allAccountsForProvider.length === 0 ? "no accounts" : `${openCount}/${allAccountsForProvider.length} marked available`}</span>
              <button data-action="add-account-to-provider" data-id="${escapeHtml(provider.id)}" aria-label="Add account to ${escapeHtml(provider.name)}" aria-expanded="${showAddAccount && addAccountProviderId === provider.id}" class="inline-flex items-center gap-1.5 rounded-full bg-accent-soft hover:bg-accent-soft text-accent-ink text-xs font-medium px-3 py-2 transition-colors">${icon("plus", 14)} Add account</button>
              ${providerDeleteControl}
            </div>
          </div>
          ${showAddAccount && addAccountProviderId === provider.id ? renderAccountForm(provider) : ""}
          ${accountRows}
        </div>
      `;
    })
    .join("");

  document.getElementById("app").innerHTML = `
    <div class="relative min-h-screen overflow-hidden bg-canvas p-4 sm:p-8">
      <div class="relative z-10 max-w-3xl mx-auto">
        ${persistenceError ? `<div role="alert" class="mb-4 rounded-2xl bg-danger-soft border border-danger text-danger p-4 text-sm">${escapeHtml(persistenceError)}</div>` : ""}
        <div class="flex items-start justify-between gap-4 pb-6 mb-6 border-b border-line/70 flex-wrap">
          <div class="flex items-center gap-3">
            <div class="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-lg shadow-blue-500/30 text-white">${icon("clock", 20)}</div>
            <div>
              <h1 class="text-2xl font-semibold tracking-tight text-ink">LimitTrack</h1>
              <p id="summary-text" class="text-sm text-muted mt-0.5">${totalAccounts === 0 ? "Your next session, a little clearer." : `${openAccounts} of ${totalAccounts} marked available`}</p>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <div class="rounded-2xl bg-surface/60 backdrop-blur-md px-4 py-2.5 shadow-sm ring-1 ring-line text-right">
              <div class="text-xs text-muted">Next reset</div>
              <div id="next-reset-countdown" class="text-xl font-semibold tabular-nums text-ink">${next ? formatCountdown(next, nowMs) : "No active timers"}</div>
              <div id="next-reset-tool" class="text-xs text-muted">${next ? escapeHtml(nextProvider ? nextProvider.name : "Account") : "Recorded locally"}</div>
            </div>
            <button data-action="toggle-about" aria-label="About LimitTrack" aria-haspopup="dialog" class="h-9 w-9 flex items-center justify-center rounded-full bg-surface/60 backdrop-blur-md hover:bg-surface text-muted hover:text-blue-500 shadow-sm ring-1 ring-line transition-colors" title="About LimitTrack">${icon("info", 16)}</button>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2 mb-4">
          <button data-action="toggle-add-account" class="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white text-sm font-medium px-4 py-2 shadow-md shadow-blue-500/30 transition-all active:scale-95">${icon("plus", 16)} Add account</button>
          <button data-action="toggle-add-provider" class="inline-flex items-center gap-1.5 rounded-full bg-surface/70 backdrop-blur-md hover:bg-surface text-ink text-sm font-medium px-4 py-2 shadow-sm ring-1 ring-line transition-all active:scale-95">${icon("plus", 16)} Add tool</button>
          <button data-action="toggle-bulk-mode" aria-pressed="${bulkMode}" class="inline-flex items-center gap-1.5 rounded-full ${bulkMode ? "bg-accent-soft text-accent-ink ring-1 ring-blue-200" : "bg-surface/70 backdrop-blur-md hover:bg-surface text-ink ring-1 ring-line"} text-sm font-medium px-4 py-2 shadow-sm transition-all active:scale-95">${icon("checkSquare", 16)} ${bulkMode ? "Cancel select" : "Select"}</button>
          <div class="flex-1"></div>
          <button data-action="toggle-sort" title="Toggle sort order" aria-label="Sort accounts by ${sortMode === "soonest" ? "email A-Z" : "soonest reset"}" class="inline-flex items-center gap-1.5 rounded-full bg-surface/70 backdrop-blur-md hover:bg-surface text-muted text-xs font-medium px-3 py-2 shadow-sm ring-1 ring-line transition-all active:scale-95">${icon("sort", 14)} ${sortMode === "soonest" ? "Soonest first" : "A–Z"}</button>
          <div class="relative">
            <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">${icon("search", 14)}</span>
            <input type="text" data-field="search-query" value="${escapeHtml(searchQuery)}" placeholder="Search accounts... (/)" aria-label="Search accounts" class="w-44 sm:w-56 bg-surface/70 backdrop-blur-md border border-line rounded-full pl-9 pr-3 py-2 text-sm text-ink placeholder-muted focus:outline-none focus:ring-2 focus:ring-blue-400 transition" />
          </div>
          <select data-field="status-filter" aria-label="Filter by status" class="bg-surface border border-line rounded-full px-3 py-2 text-xs text-ink">
            ${[["all", "All statuses"], ["open", "Marked available"], ["waiting", "Waiting"], ["ready", "Expected ready"], ["unknown", "Not checked"]].map(([value, label]) => `<option value="${value}" ${statusFilter === value ? "selected" : ""}>${label}</option>`).join("")}
          </select>
        </div>

        ${
          bulkMode
            ? `<div class="mb-6 flex flex-wrap items-center gap-3 rounded-2xl bg-accent-soft/80 ring-1 ring-blue-100 px-4 py-2.5">
                 <span class="text-sm text-accent-ink">${selectedIds.size} selected</span>
                 <button data-action="bulk-mark-hit" ${selectedIds.size === 0 ? "disabled" : ""} class="inline-flex items-center gap-1.5 rounded-full bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium px-3 py-1.5 transition-all active:scale-95">${icon("clock", 12)} Log limit for selected</button>
               </div>`
            : ""
        }

        ${showAddAccount && !addAccountProviderId ? `<div class="mb-6">${renderAccountForm()}</div>` : ""}

        ${
          showAddProvider
            ? `<div class="mb-6 rounded-2xl bg-surface/70 backdrop-blur-xl ring-1 ring-line shadow-lg p-4 sm:p-5">
                <div class="grid gap-3 sm:grid-cols-2">
                  <input type="text" placeholder="tool name (e.g. Cursor)" data-field="new-provider-name" value="${escapeHtml(newProviderDraft.name)}" class="bg-surface border border-line rounded-xl px-3 py-2 text-sm text-ink placeholder-muted focus:outline-none focus:ring-2 focus:ring-blue-400 transition" />
                  <div class="flex items-center gap-2">
                    <input type="number" min="0.01" max="100000" step="any" placeholder="reset cycle" data-field="new-provider-cycle" value="${escapeHtml(newProviderDraft.cycleValue)}" class="w-full bg-surface border border-line rounded-xl px-3 py-2 text-sm text-ink placeholder-muted focus:outline-none focus:ring-2 focus:ring-blue-400 transition" />
                    <select data-field="new-provider-cycle-unit" class="bg-surface border border-line rounded-xl px-2 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-blue-400 transition">
                      <option value="days" ${newProviderDraft.cycleUnit === "days" ? "selected" : ""}>days</option>
                      <option value="hours" ${newProviderDraft.cycleUnit === "hours" ? "selected" : ""}>hours</option>
                    </select>
                  </div>
                </div>
                <div class="flex gap-2 mt-3">
                  <button data-action="save-add-provider" class="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white text-sm font-medium px-4 py-2 shadow-sm shadow-blue-500/30 transition-all active:scale-95">${icon("check", 14)} Save</button>
                  <button data-action="cancel-add-provider" class="inline-flex items-center gap-1.5 rounded-full bg-surface border border-line hover:bg-canvas text-muted text-sm px-4 py-2 transition-all active:scale-95">${icon("x", 14)} Cancel</button>
                </div>
              </div>`
            : ""
        }

        <div class="space-y-6">
          ${providerSections}
        </div>
      </div>

      ${
        showAbout
          ? `<div data-action="close-about" style="position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,0.4);backdrop-filter:blur(4px);padding:1rem;">
              <div id="about-modal" role="dialog" aria-modal="true" aria-labelledby="about-modal-title" style="max-width:24rem;width:100%;border-radius:24px;background:rgb(var(--surface) / 0.98);box-shadow:0 25px 50px -12px rgba(0,0,0,0.25);padding:1.5rem;">
                <div class="flex items-center gap-3 mb-4">
                  <div class="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-lg shadow-blue-500/30">${icon("clock", 22)}</div>
                  <div>
                    <div id="about-modal-title" class="text-lg font-semibold text-ink">LimitTrack</div>
                    <div class="text-xs text-muted">Version 1.2.0</div>
                  </div>
                </div>
                <p class="text-sm text-muted mb-5">Tracks reset times for rate-limited AI coding tool accounts (Antigravity, Codex, Claude Code, and more) across multiple emails, so you never have to check manually again.</p>
                <div class="border-t border-line/70 pt-4 pb-4">
                  <div class="text-xs uppercase tracking-wide text-muted mb-2">Data</div>
                  <div class="flex flex-wrap gap-2">
                    <button data-action="export-backup" class="inline-flex items-center gap-1.5 rounded-full bg-subtle hover:bg-line text-ink text-xs font-medium px-3 py-1.5 transition-colors">${icon("download", 13)} Export backup</button>
                    <button data-action="trigger-import" class="inline-flex items-center gap-1.5 rounded-full bg-subtle hover:bg-line text-ink text-xs font-medium px-3 py-1.5 transition-colors">${icon("upload", 13)} Import backup</button>
                    <input type="file" id="import-file-input" accept="application/json,.json" style="display:none;" />
                  </div>
                  ${pendingImport ? `<div class="mt-3 rounded-xl bg-accent-soft p-3 text-sm text-ink"><p>Replace your current ${state.accounts.length} accounts with ${pendingImport.accounts.length} accounts across ${pendingImport.providers.length} tools? A local recovery copy will be saved first.</p><div class="flex gap-2 mt-3"><button data-action="confirm-import" class="rounded-full bg-blue-600 text-white px-3 py-2 text-xs font-medium">Replace accounts</button><button data-action="cancel-import" class="rounded-full bg-surface border border-line px-3 py-2 text-xs">Cancel import</button></div></div>` : ""}
                </div>
                <div class="border-t border-line/70 pt-4">
                  <div class="text-xs uppercase tracking-wide text-muted mb-2">Built by</div>
                  <div class="text-sm font-medium text-ink">Abdul Rehman</div>
                  <div class="text-xs text-muted mb-3">Founder &amp; CEO of Stayza · CS student at NUST</div>
                  <div class="flex flex-wrap gap-2">
                    <a href="https://iamabdulrehman.vercel.app" target="_blank" class="rounded-full bg-accent-soft hover:bg-accent-soft border border-blue-100 text-accent-ink text-xs font-medium px-3 py-1.5 transition-colors">Portfolio</a>
                    <a href="https://github.com/rehmanoncloud9" target="_blank" class="rounded-full bg-subtle hover:bg-line text-ink text-xs font-medium px-3 py-1.5 transition-colors">GitHub</a>
                    <a href="https://www.linkedin.com/in/arehman-builds" target="_blank" class="rounded-full bg-subtle hover:bg-line text-ink text-xs font-medium px-3 py-1.5 transition-colors">LinkedIn</a>
                    <a href="mailto:relentlessrehman@gmail.com" class="rounded-full bg-subtle hover:bg-line text-ink text-xs font-medium px-3 py-1.5 transition-colors">Email</a>
                  </div>
                </div>
                <button data-action="close-about" class="mt-5 w-full rounded-full bg-subtle hover:bg-line text-muted text-sm font-medium py-2 transition-all active:scale-95">Close</button>
              </div>
            </div>`
          : ""
      }

      ${
        toast
          ? `<div role="status" aria-live="polite" style="position:fixed;left:50%;bottom:1.5rem;transform:translateX(-50%);z-index:60;" class="flex items-center gap-3 rounded-full bg-slate-900 text-white text-sm px-4 py-2.5 shadow-xl">
               <span>${escapeHtml(toast.message)}</span>
               ${
                 lastDeleted
                   ? `<button data-action="toast-undo" class="inline-flex items-center gap-1 rounded-full bg-surface/15 hover:bg-surface/25 text-white text-xs font-medium px-2.5 py-1 transition-colors">${icon("undo", 12)} Undo</button>`
                   : ""
               }
             </div>`
          : ""
      }
    </div>
  `;
}

// ---------- live tick (lightweight DOM patch, preserves input focus) ----------

function tick() {
  const now = new Date();
  const nowMs = now.getTime();

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
      countdownEl.className = `font-sans text-sm font-semibold tabular-nums ${styles.text}`;
    }
    if (labelEl) {
      labelEl.textContent = styles.label;
      labelEl.className = `text-xs ${styles.text}`;
    }
    if (dotEl) {
      dotEl.className = `h-2.5 w-2.5 rounded-full flex-shrink-0 ${styles.dot}`;
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
    summaryEl.textContent = state.accounts.length === 0 ? "Your next session, a little clearer." : `${openCount} of ${state.accounts.length} marked available`;
  }

  state.providers.forEach((p) => {
    const accts = state.accounts.filter((a) => a.providerId === p.id);
    const oc = accts.filter((a) => newStatuses[a.id] === "open").length;
    const el = document.getElementById(`provider-count-${p.id}`);
    if (el) el.textContent = accts.length === 0 ? "no accounts" : `${oc}/${accts.length} marked available`;
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
  if (window.limittrack.onStorageChanged) {
    window.limittrack.onStorageChanged((key) => {
      if (key === STORAGE_KEY) loadState(true);
    });
  }
  if (window.limittrack.onAccountReveal) {
    window.limittrack.onAccountReveal(async (accountId) => {
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
