const STORAGE_KEY = "limittrack-state-v1";

const DEFAULT_STATE = {
  providers: [
    { id: "antigravity", name: "Antigravity", cycleDays: 7 },
    { id: "codex", name: "Codex", cycleDays: 7 },
    { id: "claude", name: "Claude Code", cycleDays: 7 },
  ],
  accounts: [],
};

let state = JSON.parse(JSON.stringify(DEFAULT_STATE));
let editingProviderId = null;
let editingCycleValue = "";
let editingResetId = null;
let editingResetValue = "";
let showAddAccount = false;
let showAddProvider = false;
let newAccountDraft = { providerId: "", email: "", cycleDays: "" };
let newProviderDraft = { name: "", cycleDays: "7" };
const prevStatus = {};

// ---------- pure helpers ----------

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function effectiveTime(acc, nowMs) {
  if (!acc.resetAt) return -1;
  const t = new Date(acc.resetAt).getTime();
  return t <= nowMs ? -1 : t;
}

function getStatus(acc, nowMs) {
  if (!acc.resetAt) return "open";
  const t = new Date(acc.resetAt).getTime();
  const diff = t - nowMs;
  if (diff <= 0) return "open";
  if (diff <= 24 * 60 * 60 * 1000) return "soon";
  return "locked";
}

function formatCountdown(acc, nowMs) {
  if (!acc.resetAt) return "OPEN NOW";
  const diff = new Date(acc.resetAt).getTime() - nowMs;
  if (diff <= 0) return "OPEN NOW";
  const totalSec = Math.floor(diff / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

function formatWhen(iso) {
  if (!iso) return "never";
  const dt = new Date(iso);
  return dt.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
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
  { label: "+1h", hours: 1 },
  { label: "+6h", hours: 6 },
  { label: "+1d", hours: 24 },
  { label: "+3d", hours: 72 },
  { label: "+7d", hours: 168 },
  { label: "+30d", hours: 720 },
];

function statusStyles(status) {
  if (status === "open") return { dot: "bg-green-500", text: "text-green-600", label: "Open now" };
  if (status === "soon") return { dot: "bg-orange-400", text: "text-orange-500", label: "Opens soon" };
  return { dot: "bg-slate-300", text: "text-slate-400", label: "Locked" };
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
};

function icon(name, size = 14) {
  return svgIcon(ICON_PATHS[name] || "", size);
}

// ---------- storage ----------

async function loadState() {
  try {
    const value = await window.limittrack.storageGet(STORAGE_KEY);
    if (value) {
      const parsed = JSON.parse(value);
      state = { providers: parsed.providers || DEFAULT_STATE.providers, accounts: parsed.accounts || [] };
    }
  } catch (e) {
    // nothing saved yet, keep defaults
  }
  render();
}

async function saveState() {
  try {
    await window.limittrack.storageSet(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error("save failed", e);
  }
}

// ---------- actions ----------

function providerCycle(providerId) {
  const p = state.providers.find((p) => p.id === providerId);
  return p ? p.cycleDays : 7;
}

function markHit(id) {
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) return;
  const cycleDays = acc.cycleDays || providerCycle(acc.providerId);
  const hitAt = new Date().toISOString();
  const resetAt = new Date(Date.now() + cycleDays * 86400000).toISOString();
  acc.lastHitAt = hitAt;
  acc.resetAt = resetAt;
  acc.history = [{ hitAt, resetAt }, ...(acc.history || [])].slice(0, 8);
  saveState();
  render();
}

function clearHit(id) {
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) return;
  acc.lastHitAt = null;
  acc.resetAt = null;
  saveState();
  render();
}

function saveCustomReset(id) {
  if (!editingResetValue) {
    editingResetId = null;
    render();
    return;
  }
  const acc = state.accounts.find((a) => a.id === id);
  if (acc) {
    acc.resetAt = new Date(editingResetValue).toISOString();
    saveState();
  }
  editingResetId = null;
  render();
}

function applyPreset(id, hours) {
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) return;
  acc.resetAt = new Date(Date.now() + hours * 3600000).toISOString();
  saveState();
  editingResetId = null;
  render();
}

function deleteAccount(id) {
  state.accounts = state.accounts.filter((a) => a.id !== id);
  saveState();
  render();
}

function addAccount() {
  if (!newAccountDraft.providerId || !newAccountDraft.email.trim()) return;
  const cycleDays = newAccountDraft.cycleDays ? parseInt(newAccountDraft.cycleDays, 10) : null;
  state.accounts.push({
    id: genId(),
    providerId: newAccountDraft.providerId,
    email: newAccountDraft.email.trim(),
    cycleDays: cycleDays && cycleDays > 0 ? cycleDays : null,
    lastHitAt: null,
    resetAt: null,
    history: [],
  });
  newAccountDraft = { providerId: "", email: "", cycleDays: "" };
  showAddAccount = false;
  saveState();
  render();
}

function addProvider() {
  const name = newProviderDraft.name.trim();
  if (!name) return;
  const cycleDays = parseInt(newProviderDraft.cycleDays, 10) || 7;
  state.providers.push({ id: genId(), name, cycleDays });
  newProviderDraft = { name: "", cycleDays: "7" };
  showAddProvider = false;
  saveState();
  render();
}

function deleteProvider(id) {
  const hasAccounts = state.accounts.some((a) => a.providerId === id);
  if (hasAccounts) return;
  state.providers = state.providers.filter((p) => p.id !== id);
  saveState();
  render();
}

function startEditCycle(id) {
  const p = state.providers.find((p) => p.id === id);
  if (!p) return;
  editingProviderId = id;
  editingCycleValue = String(p.cycleDays);
  render();
}

function saveEditCycle(id) {
  const val = parseInt(editingCycleValue, 10);
  if (val && val > 0) {
    const p = state.providers.find((p) => p.id === id);
    if (p) p.cycleDays = val;
    saveState();
  }
  editingProviderId = null;
  render();
}

// ---------- event delegation ----------

function attachEvents() {
  const app = document.getElementById("app");

  app.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    switch (action) {
      case "toggle-add-account":
        showAddAccount = !showAddAccount;
        showAddProvider = false;
        render();
        break;
      case "toggle-add-provider":
        showAddProvider = !showAddProvider;
        showAddAccount = false;
        render();
        break;
      case "cancel-add-account":
        showAddAccount = false;
        render();
        break;
      case "cancel-add-provider":
        showAddProvider = false;
        render();
        break;
      case "save-add-account":
        addAccount();
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
        applyPreset(id, parseInt(btn.dataset.hours, 10));
        break;
      case "cancel-reset-edit":
        editingResetId = null;
        render();
        break;
      case "clear-hit":
        clearHit(id);
        break;
      case "delete-account":
        deleteAccount(id);
        break;
      case "delete-provider":
        deleteProvider(id);
        break;
      case "edit-cycle":
        startEditCycle(id);
        break;
      case "save-cycle":
        saveEditCycle(id);
        break;
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
        newAccountDraft.cycleDays = e.target.value;
        break;
      case "new-provider-name":
        newProviderDraft.name = e.target.value;
        break;
      case "new-provider-cycle":
        newProviderDraft.cycleDays = e.target.value;
        break;
      case "editing-cycle-value":
        editingCycleValue = e.target.value;
        break;
      case "editing-reset-value":
        editingResetValue = e.target.value;
        const previewEl = document.getElementById("reset-preview");
        if (previewEl) previewEl.textContent = formatRelativePreview(editingResetValue);
        break;
    }
  });
}

// ---------- render ----------

function render() {
  const now = new Date();
  const nowMs = now.getTime();
  const totalAccounts = state.accounts.length;
  const openAccounts = state.accounts.filter((a) => getStatus(a, nowMs) === "open").length;

  const providerOptions = state.providers
    .map((p) => `<option value="${p.id}" ${newAccountDraft.providerId === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`)
    .join("");

  const providerSections = state.providers
    .map((provider) => {
      const accounts = state.accounts
        .filter((a) => a.providerId === provider.id)
        .sort((a, b) => {
          const ea = effectiveTime(a, nowMs);
          const eb = effectiveTime(b, nowMs);
          if (ea === -1 && eb === -1) return a.email.localeCompare(b.email);
          return ea - eb;
        });
      const openCount = accounts.filter((a) => getStatus(a, nowMs) === "open").length;

      const cycleBadge =
        editingProviderId === provider.id
          ? `<span class="flex items-center gap-1">
               <input type="number" min="1" value="${escapeHtml(editingCycleValue)}" data-field="editing-cycle-value" class="w-14 bg-white border border-slate-300 rounded-lg px-1.5 py-0.5 text-xs text-slate-800" />
               <button data-action="save-cycle" data-id="${provider.id}" class="text-green-600">${icon("check", 13)}</button>
             </span>`
          : `<button data-action="edit-cycle" data-id="${provider.id}" class="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 bg-slate-100/80 hover:bg-slate-200/80 rounded-full px-2.5 py-1 transition-colors">
               ${provider.cycleDays}-day cycle ${icon("pencil", 10)}
             </button>`;

      const accountRows =
        accounts.length === 0
          ? `<div class="px-5 py-4 text-sm text-slate-400">No accounts added for ${escapeHtml(provider.name)} yet.</div>`
          : accounts
              .map((acc) => {
                const status = getStatus(acc, nowMs);
                const styles = statusStyles(status);
                const resetEditPanel =
                  editingResetId === acc.id
                    ? `<div class="border-t border-slate-200/60 bg-slate-50/60 px-5 py-3">
                         <div class="flex flex-wrap items-center gap-1.5 mb-2.5">
                           ${RESET_PRESETS.map(
                             (p) =>
                               `<button data-action="apply-preset" data-id="${acc.id}" data-hours="${p.hours}" class="rounded-full bg-white hover:bg-blue-50 border border-slate-200 hover:border-blue-200 text-slate-600 hover:text-blue-700 text-xs font-medium px-3 py-1 transition-all active:scale-95">${p.label}</button>`
                           ).join("")}
                         </div>
                         <div class="flex flex-wrap items-center gap-2">
                           <label class="text-xs text-slate-400">or pick exactly</label>
                           <input type="datetime-local" data-field="editing-reset-value" value="${escapeHtml(editingResetValue)}" class="bg-white border border-slate-200 rounded-xl px-2 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-400 transition" />
                           <span id="reset-preview" class="text-xs font-medium text-blue-600">${formatRelativePreview(editingResetValue)}</span>
                           <button data-action="save-reset" data-id="${acc.id}" class="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-blue-500 to-indigo-500 text-white text-xs font-medium px-3 py-1.5 shadow-sm shadow-blue-500/30 transition-all active:scale-95">${icon("check", 13)} Save</button>
                           <button data-action="cancel-reset-edit" data-id="${acc.id}" class="inline-flex items-center gap-1 rounded-full bg-white border border-slate-200 hover:bg-slate-50 text-slate-500 text-xs px-3 py-1.5 transition-all active:scale-95">${icon("x", 13)} Cancel</button>
                         </div>
                       </div>`
                    : "";
                return `
                  <div>
                    <div class="flex items-center justify-between gap-3 border-t border-slate-200/60 px-5 py-3.5 flex-wrap hover:bg-white/40 transition-colors">
                      <div class="flex items-center gap-3 min-w-0">
                        <span id="dot-${acc.id}" class="h-2.5 w-2.5 rounded-full flex-shrink-0 ${styles.dot}"></span>
                        <div class="min-w-0">
                          <div class="text-sm font-medium text-slate-900 truncate">${escapeHtml(acc.email)}</div>
                          <div class="text-xs text-slate-400">Last used ${formatWhen(acc.lastHitAt)}</div>
                        </div>
                      </div>
                      <div class="flex items-center gap-2 flex-shrink-0">
                        <div class="text-right mr-1">
                          <div id="countdown-${acc.id}" class="font-mono text-sm font-semibold tabular-nums ${styles.text}">${formatCountdown(acc, nowMs)}</div>
                          <div id="label-${acc.id}" class="text-xs ${styles.text}">${styles.label}</div>
                        </div>
                        <button data-action="mark-hit" data-id="${acc.id}" class="inline-flex items-center gap-1 rounded-full bg-blue-50 hover:bg-blue-100 border border-blue-100 text-blue-700 text-xs font-medium px-3 py-1.5 transition-all active:scale-95" title="Start the reset countdown from now">${icon("clock", 12)} Log hit</button>
                        <button data-action="toggle-reset-edit" data-id="${acc.id}" class="p-1.5 rounded-full hover:bg-slate-100 transition-colors ${editingResetId === acc.id ? "text-blue-500" : "text-slate-400 hover:text-blue-500"}" title="Set an exact reset date & time">${icon("calendar", 14)}</button>
                        ${acc.resetAt ? `<button data-action="clear-hit" data-id="${acc.id}" class="p-1.5 rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors" title="Clear cooldown (undo)">${icon("x", 13)}</button>` : ""}
                        <button data-action="delete-account" data-id="${acc.id}" class="p-1.5 rounded-full text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors" title="Remove account">${icon("trash", 13)}</button>
                      </div>
                    </div>
                    ${resetEditPanel}
                  </div>
                `;
              })
              .join("");

      return `
        <div class="rounded-3xl bg-white/60 backdrop-blur-xl ring-1 ring-black/5 shadow-lg overflow-hidden">
          <div class="flex items-center justify-between gap-2 bg-white/40 border-b border-slate-200/60 px-5 py-3.5 flex-wrap">
            <div class="flex items-center gap-3">
              <span class="text-base font-semibold text-slate-800">${escapeHtml(provider.name)}</span>
              ${cycleBadge}
            </div>
            <div class="flex items-center gap-3">
              <span id="provider-count-${provider.id}" class="text-xs text-slate-400">${accounts.length === 0 ? "no accounts" : `${openCount}/${accounts.length} open`}</span>
              ${accounts.length === 0 ? `<button data-action="delete-provider" data-id="${provider.id}" class="p-1 rounded-full text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors" title="Remove tool">${icon("trash", 13)}</button>` : ""}
            </div>
          </div>
          ${accountRows}
        </div>
      `;
    })
    .join("");

  document.getElementById("app").innerHTML = `
    <div class="relative min-h-screen overflow-hidden bg-gradient-to-br from-blue-50 via-white to-purple-50 p-4 sm:p-8">
      <div class="pointer-events-none absolute -top-24 -left-24 h-96 w-96 rounded-full bg-blue-300/30 blur-3xl"></div>
      <div class="pointer-events-none absolute -bottom-24 -right-24 h-96 w-96 rounded-full bg-purple-300/30 blur-3xl"></div>
      <div class="pointer-events-none absolute top-1/3 right-0 h-72 w-72 rounded-full bg-pink-200/30 blur-3xl"></div>

      <div class="relative z-10 max-w-3xl mx-auto">
        <div class="flex items-start justify-between gap-4 pb-6 mb-6 border-b border-slate-200/70 flex-wrap">
          <div class="flex items-center gap-3">
            <div class="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-lg shadow-blue-500/30 text-white">${icon("clock", 20)}</div>
            <div>
              <h1 class="text-2xl font-semibold tracking-tight text-slate-900">LimitTrack</h1>
              <p id="summary-text" class="text-sm text-slate-500 mt-0.5">${totalAccounts === 0 ? "No accounts yet" : `${openAccounts} of ${totalAccounts} open now`}</p>
            </div>
          </div>
          <div class="rounded-2xl bg-white/60 backdrop-blur-md px-4 py-2.5 shadow-sm ring-1 ring-black/5 text-right">
            <div id="clock-time" class="font-mono text-xl font-semibold tabular-nums text-slate-900">${now.toLocaleTimeString(undefined, { hour12: false })}</div>
            <div id="clock-date" class="text-xs text-slate-500">${now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</div>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2 mb-6">
          <button data-action="toggle-add-account" class="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white text-sm font-medium px-4 py-2 shadow-md shadow-blue-500/30 transition-all active:scale-95">${icon("plus", 16)} Add account</button>
          <button data-action="toggle-add-provider" class="inline-flex items-center gap-1.5 rounded-full bg-white/70 backdrop-blur-md hover:bg-white text-slate-700 text-sm font-medium px-4 py-2 shadow-sm ring-1 ring-black/5 transition-all active:scale-95">${icon("plus", 16)} Add tool</button>
        </div>

        ${
          showAddAccount
            ? `<div class="mb-6 rounded-2xl bg-white/70 backdrop-blur-xl ring-1 ring-black/5 shadow-lg p-4 sm:p-5">
                <div class="grid gap-3 sm:grid-cols-3">
                  <select data-field="new-account-provider" class="bg-white border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-400 transition">
                    <option value="">Select tool</option>
                    ${providerOptions}
                  </select>
                  <input type="email" placeholder="account email" data-field="new-account-email" value="${escapeHtml(newAccountDraft.email)}" class="bg-white border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-400 transition" />
                  <input type="number" min="1" placeholder="override cycle (days)" data-field="new-account-cycle" value="${escapeHtml(newAccountDraft.cycleDays)}" class="bg-white border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-400 transition" />
                </div>
                <div class="flex gap-2 mt-3">
                  <button data-action="save-add-account" class="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white text-sm font-medium px-4 py-2 shadow-sm shadow-blue-500/30 transition-all active:scale-95">${icon("check", 14)} Save</button>
                  <button data-action="cancel-add-account" class="inline-flex items-center gap-1.5 rounded-full bg-white border border-slate-200 hover:bg-slate-50 text-slate-500 text-sm px-4 py-2 transition-all active:scale-95">${icon("x", 14)} Cancel</button>
                </div>
              </div>`
            : ""
        }

        ${
          showAddProvider
            ? `<div class="mb-6 rounded-2xl bg-white/70 backdrop-blur-xl ring-1 ring-black/5 shadow-lg p-4 sm:p-5">
                <div class="grid gap-3 sm:grid-cols-2">
                  <input type="text" placeholder="tool name (e.g. Cursor)" data-field="new-provider-name" value="${escapeHtml(newProviderDraft.name)}" class="bg-white border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-400 transition" />
                  <input type="number" min="1" placeholder="reset cycle in days" data-field="new-provider-cycle" value="${escapeHtml(newProviderDraft.cycleDays)}" class="bg-white border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-400 transition" />
                </div>
                <div class="flex gap-2 mt-3">
                  <button data-action="save-add-provider" class="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white text-sm font-medium px-4 py-2 shadow-sm shadow-blue-500/30 transition-all active:scale-95">${icon("check", 14)} Save</button>
                  <button data-action="cancel-add-provider" class="inline-flex items-center gap-1.5 rounded-full bg-white border border-slate-200 hover:bg-slate-50 text-slate-500 text-sm px-4 py-2 transition-all active:scale-95">${icon("x", 14)} Cancel</button>
                </div>
              </div>`
            : ""
        }

        <div class="space-y-6">
          ${providerSections}
        </div>
      </div>
    </div>
  `;
}

// ---------- live tick (lightweight DOM patch, preserves input focus) ----------

function tick() {
  const now = new Date();
  const nowMs = now.getTime();

  const clockEl = document.getElementById("clock-time");
  if (clockEl) clockEl.textContent = now.toLocaleTimeString(undefined, { hour12: false });
  const dateEl = document.getElementById("clock-date");
  if (dateEl) dateEl.textContent = now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

  let needsReorder = false;
  const newStatuses = {};
  state.accounts.forEach((acc) => {
    const status = getStatus(acc, nowMs);
    newStatuses[acc.id] = status;
    const prev = prevStatus[acc.id];
    if (prev !== undefined && prev !== status) needsReorder = true;
    if ((prev === "locked" || prev === "soon") && status === "open") {
      const provider = state.providers.find((p) => p.id === acc.providerId);
      try {
        new Notification(`${acc.email} is open`, {
          body: `${provider ? provider.name : "Account"} limit has reset.`,
        });
      } catch (e) {
        // notifications unavailable on this platform
      }
    }
  });

  const editingOpen = Boolean(editingResetId || editingProviderId || showAddAccount || showAddProvider);

  Object.assign(prevStatus, newStatuses);

  if (needsReorder && !editingOpen) {
    render();
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
      countdownEl.className = `font-mono text-sm font-semibold tabular-nums ${styles.text}`;
    }
    if (labelEl) {
      labelEl.textContent = styles.label;
      labelEl.className = `text-xs ${styles.text}`;
    }
    if (dotEl) {
      dotEl.className = `h-2.5 w-2.5 rounded-full flex-shrink-0 ${styles.dot}`;
    }
  });

  const summaryEl = document.getElementById("summary-text");
  if (summaryEl) {
    const openCount = state.accounts.filter((a) => newStatuses[a.id] === "open").length;
    summaryEl.textContent = state.accounts.length === 0 ? "No accounts yet" : `${openCount} of ${state.accounts.length} open now`;
  }

  state.providers.forEach((p) => {
    const accts = state.accounts.filter((a) => a.providerId === p.id);
    const oc = accts.filter((a) => newStatuses[a.id] === "open").length;
    const el = document.getElementById(`provider-count-${p.id}`);
    if (el) el.textContent = accts.length === 0 ? "no accounts" : `${oc}/${accts.length} open`;
  });
}

// ---------- init ----------

window.addEventListener("DOMContentLoaded", () => {
  attachEvents();
  render();
  loadState();
  setInterval(tick, 1000);
});
