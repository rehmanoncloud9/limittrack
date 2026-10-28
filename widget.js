// The widget shares validation and status rules with the main app.

const { STORAGE_KEY, DEFAULT_STATE, getStatus, effectiveTime } = window.LimitTrackDomain;
const dataClient = window.createLimitTrackClient(window.limittrack);
let persistenceError = "";
let configError = "";
let selectedProviderId = null;
let configSaving = false;
let renderedToolOptions = "";
const MAX_VISIBLE_ROWS = 3;

let state = JSON.parse(JSON.stringify(DEFAULT_STATE));
let renderedRowIds = null; // signature of the last row skeleton we built, to avoid unnecessary rebuilds
let undoChange = null;
let undoUntil = 0;

// ---------- pure helpers (mirrors renderer.js) ----------

function normalizeUnit(unit) {
  return unit === "hours" ? "hours" : "days";
}

function cycleToMs(value, unit) {
  const v = Number(value) || 0;
  return normalizeUnit(unit) === "hours" ? v * 3600000 : v * 86400000;
}

function formatCountdown(acc, nowMs) {
  return window.LimitTrackDomain.formatCountdown(acc, nowMs, true);
}

function providerCycle(providerId) {
  const p = state.providers.find((p) => p.id === providerId);
  return p ? { value: p.cycleValue, unit: p.cycleUnit } : { value: 7, unit: "days" };
}

function accountCycle(acc) {
  if (acc.cycleValue) return { value: acc.cycleValue, unit: acc.cycleUnit };
  return providerCycle(acc.providerId);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Deterministic color per provider, so each tool gets a stable avatar hue.
function providerHue(providerId) {
  const known = { codex: 165, claude: 24, antigravity: 220 };
  if (Object.prototype.hasOwnProperty.call(known, providerId)) return known[providerId];
  let hash = 0;
  const str = String(providerId || "");
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) % 360;
  return hash;
}

// ---------- storage ----------

async function loadState(preserveFocus = false) {
  const focusedRow = document.activeElement?.closest(".row");
  const focusedId = focusedRow?.dataset.id;
  const focusedAction = document.activeElement?.dataset.role;
  try {
    const [nextState, config] = await Promise.all([dataClient.read(), window.limittrack.widgetConfigGet()]);
    state = nextState;
    selectedProviderId = state.providers.some((p) => p.id === config.providerId) ? config.providerId : null;
    persistenceError = "";
  } catch (error) { persistenceError = error.message; }
  renderedRowIds = null; renderAll();
  if (preserveFocus && focusedId) {
    const row = [...document.querySelectorAll(".row")].find((el) => el.dataset.id === focusedId);
    const button = focusedAction === "hit" ? row?.querySelector('[data-role="hit"]') : null;
    (button && !button.hidden ? button : row?.querySelector(".row-detail"))?.focus({ preventScroll: true });
  }
}

async function saveState() {
  try {
    await dataClient.save(state);
    await loadState(true);
    return true;
  } catch (error) {
    await loadState(true);
    persistenceError = "Change was not saved. " + error.message;
    undoChange = null;
    renderedRowIds = null; renderAll();
    return false;
  }
}

// ---------- actions ----------

function scopedAccounts() {
  return selectedProviderId ? state.accounts.filter((a) => a.providerId === selectedProviderId) : state.accounts;
}

async function configureTool(providerId) {
  if (configSaving) return;
  configSaving = true;
  configError = "";
  document.getElementById("tool-select").disabled = true;
  try {
    const config = await window.limittrack.widgetConfigSet({ providerId: providerId || null });
    selectedProviderId = config.providerId;
    undoChange = null;
    renderedRowIds = null;
  } catch (error) { configError = "Tool choice was not saved. " + error.message; }
  finally { configSaving = false; renderAll(); }
}

function renderToolConfig() {
  const select = document.getElementById("tool-select");
  const signature = JSON.stringify(state.providers.map((p) => [p.id, p.name]));
  if (signature !== renderedToolOptions) {
    select.innerHTML = `<option value="">All tools</option>` + state.providers.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("");
    renderedToolOptions = signature;
  }
  select.value = selectedProviderId || "";
  select.disabled = configSaving;
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
  undoChange = { before, after: window.LimitTrackDomain.clone(acc) };
  undoUntil = Date.now() + 6000;
  saveState();
  renderAll();
}

function markAvailable(id) {
  const account = state.accounts.find((a) => a.id === id);
  if (!account) return;
  const before = window.LimitTrackDomain.clone(account);
  account.resetAt = null;
  account.confirmedAvailableAt = new Date().toISOString();
  undoChange = { before, after: window.LimitTrackDomain.clone(account) };
  undoUntil = Date.now() + 6000;
  saveState();
  renderAll();
}

function undoLastChange() {
  if (!undoChange || Date.now() >= undoUntil) return;
  const index = state.accounts.findIndex((a) => a.id === undoChange.before.id);
  if (index < 0 || JSON.stringify(state.accounts[index]) !== JSON.stringify(undoChange.after)) {
    persistenceError = "This account changed again. Undo was not applied.";
  } else {
    state.accounts[index] = undoChange.before;
    saveState();
  }
  undoChange = null;
  renderAll();
}

// ---------- rendering ----------

function visibleAccounts(nowMs) {
  // Don't move the item someone is using when a timer changes its status.
  const rows = document.getElementById("rows");
  if ((rows.contains(document.activeElement) || rows.matches(":hover")) && renderedRowIds) {
    const ids = renderedRowIds.split(",");
    return ids.map((id) => scopedAccounts().find((a) => a.id === id)).filter(Boolean);
  }
  return [...scopedAccounts()]
    .sort((a, b) => {
      const ea = effectiveTime(a, nowMs);
      const eb = effectiveTime(b, nowMs);
      if (ea === -1 && eb === -1) return a.email.localeCompare(b.email);
      return ea === eb ? a.email.localeCompare(b.email) : ea - eb;
    })
    .slice(0, MAX_VISIBLE_ROWS);
}

function rowSkeleton(acc, provider) {
  const hue = providerHue(acc.providerId);
  const initial = (provider ? provider.name : "?").trim().charAt(0).toUpperCase() || "?";
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.id = acc.id;
  row.innerHTML = `
    <button class="row-detail" aria-label="View ${escapeHtml(provider ? provider.name : "Account")} — ${escapeHtml(acc.email)}">
    <div class="avatar" style="background: hsl(${hue} 70% 45%)">
      ${escapeHtml(initial)}
      <span class="status-dot" data-role="dot"></span>
    </div>
    <div class="row-text">
      <div class="row-name">${escapeHtml(provider ? provider.name : "Unknown")}</div>
      <div class="row-sub">${escapeHtml(acc.email)}</div>
    </div>
    </button>
    <div class="row-right" data-role="right">
      <button class="hit-btn" data-role="hit">Log limit</button>
      <span class="countdown" data-role="countdown"></span>
    </div>
  `;
  row.querySelector(".row-detail").addEventListener("click", () => {
    window.limittrack.widgetOpenMain(acc.id);
  });
  row.querySelector('[data-role="hit"]').addEventListener("click", () => {
    const status = getStatus(state.accounts.find((a) => a.id === acc.id) || acc, Date.now());
    if (status === "unknown" || status === "ready") markAvailable(acc.id);
    else markHit(acc.id);
  });
  return row;
}

function updateHero(nowMs) {
  const hero = document.getElementById("hero");
  const accounts = scopedAccounts();
  hero.hidden = accounts.length === 0;
  if (hero.hidden) return;
  const next = accounts.filter((a) => Number.isFinite(new Date(a.resetAt).getTime()) && new Date(a.resetAt).getTime() > nowMs)
    .sort((a, b) => new Date(a.resetAt) - new Date(b.resetAt))[0];
  const available = accounts.filter((a) => getStatus(a, nowMs) === "open").length;
  const expected = accounts.filter((a) => getStatus(a, nowMs) === "ready").length;
  document.getElementById("hero-label").textContent = next ? (next.resetSource === "exact" ? "Next recorded reset" : "Next estimated reset") : "Account status";
  document.getElementById("hero-value").textContent = next ? formatCountdown(next, nowMs) : available ? `${available} available` : expected ? "Check status" : "Not checked";
  const provider = next && state.providers.find((p) => p.id === next.providerId);
  document.getElementById("hero-detail").textContent = next
    ? `${provider ? provider.name : "Account"} · ${next.email}`
    : expected ? `${expected} reset times passed. Check the tool, then confirm.` : available ? "Marked available by you. No active timers." : "Check your tool, then mark an account available.";
  document.getElementById("hero-time").textContent = next
    ? new Date(next.resetAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" })
    : "";
}

function renderAll() {
  const nowMs = Date.now();
  const accounts = scopedAccounts();
  renderToolConfig();
  const rowsEl = document.getElementById("rows");
  const footerEl = document.getElementById("footer");
  const emptyEl = document.getElementById("empty");
  const summaryEl = document.getElementById("summary-text");
  const errorEl = document.getElementById("save-error");
  errorEl.hidden = !persistenceError && !configError;
  errorEl.textContent = [persistenceError, configError].filter(Boolean).join(" ");
  document.getElementById("undo-change").hidden = !undoChange || nowMs >= undoUntil;
  updateHero(nowMs);

  if (accounts.length === 0) {
    rowsEl.style.display = "none";
    footerEl.style.display = "none";
    emptyEl.style.display = "block";
    emptyEl.innerHTML = `
      <div class="emoji">📭</div>
      <div class="msg">${selectedProviderId ? `No accounts for ${escapeHtml(state.providers.find((p) => p.id === selectedProviderId)?.name || "this tool")} yet.` : "No accounts tracked yet."}<br />Add one in LimitTrack to see live countdowns here.</div>
      <button id="empty-open-btn">Open LimitTrack</button>
    `;
    document.getElementById("empty-open-btn").addEventListener("click", () => window.limittrack.widgetOpenMain());
    summaryEl.textContent = "";
    requestResize();
    return;
  }

  emptyEl.style.display = "none";
  rowsEl.style.display = "flex";

  const openCount = accounts.filter((a) => getStatus(a, nowMs) === "open").length;
  summaryEl.textContent = `${openCount} available`;

  const visible = visibleAccounts(nowMs);
  const signature = visible.map((a) => a.id).join(",");

  if (signature !== renderedRowIds) {
    rowsEl.innerHTML = "";
    visible.forEach((acc) => {
      const provider = state.providers.find((p) => p.id === acc.providerId);
      rowsEl.appendChild(rowSkeleton(acc, provider));
    });
    renderedRowIds = signature;
  }

  const remaining = accounts.length - visible.length;
  footerEl.style.display = remaining > 0 ? "block" : "none";
  if (remaining > 0) {
    footerEl.innerHTML = `<button id="more-btn">+${remaining} more in LimitTrack</button>`;
    document.getElementById("more-btn").addEventListener("click", () => window.limittrack.widgetOpenMain());
  }

  updateTick(nowMs, visible);
  requestResize();
}

// Runs every second: only touches text/class of existing nodes so hover
// states and keyboard focus never get interrupted by countdown updates.
function updateTick(nowMs, visible) {
  const list = visible || visibleAccounts(nowMs);
  list.forEach((acc) => {
    const row = [...document.querySelectorAll(".row")].find((el) => el.dataset.id === acc.id);
    if (!row) return;
    const status = getStatus(acc, nowMs);
    row.classList.toggle("is-open", status === "open");

    const dot = row.querySelector('[data-role="dot"]');
    if (dot) dot.className = `status-dot ${status}`;

    const right = row.querySelector('[data-role="right"]');
    if (right) {
      const button = right.querySelector('[data-role="hit"]');
      const countdown = right.querySelector('[data-role="countdown"]');
      const canAct = status === "open" || status === "ready" || status === "unknown";
      if (!canAct && document.activeElement === button) row.querySelector(".row-detail").focus();
      button.hidden = !canAct;
      button.textContent = status === "open" ? "Log limit" : "Confirm";
      button.title = status === "open" ? "Estimate a reset using the configured cycle" : "Mark available after checking the tool";
      countdown.hidden = canAct;
      countdown.className = `countdown ${status}`;
      countdown.textContent = formatCountdown(acc, nowMs);
    }
  });
}

function tick() {
  const nowMs = Date.now();
  const accounts = scopedAccounts();
  updateHero(nowMs);
  const undoButton = document.getElementById("undo-change");
  if (undoChange && nowMs >= undoUntil) {
    undoChange = null;
    if (document.activeElement === undoButton) document.getElementById("open-main-btn").focus();
    undoButton.hidden = true;
  }
  requestResize();
  if (accounts.length === 0) return;
  const openCount = accounts.filter((a) => getStatus(a, nowMs) === "open").length;
  const summaryEl = document.getElementById("summary-text");
  if (summaryEl) summaryEl.textContent = `${openCount} available`;

  const visible = visibleAccounts(nowMs);
  const signature = visible.map((a) => a.id).join(",");
  if (signature !== renderedRowIds) {
    renderAll();
    return;
  }
  updateTick(nowMs, visible);
}

// ---------- window sizing ----------
// The widget hugs its own content: tell main.js how tall the panel wants to
// be, and it resizes the (fixed-width) BrowserWindow to match.

let resizeRaf = null;
function requestResize() {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    const panel = document.getElementById("panel");
    if (!panel || !window.limittrack || !window.limittrack.widgetResize) return;
    const height = Math.ceil(panel.getBoundingClientRect().height) + 16; // body padding
    window.limittrack.widgetResize(height);
  });
}

// ---------- init ----------

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("open-main-btn").addEventListener("click", () => window.limittrack.widgetOpenMain());
  document.getElementById("hide-widget-btn").addEventListener("click", () => window.limittrack.widgetHide());
  document.getElementById("undo-change").addEventListener("click", undoLastChange);
  document.getElementById("tool-select").addEventListener("change", (event) => configureTool(event.target.value));

  if (window.limittrack && window.limittrack.onStorageChanged) {
    window.limittrack.onStorageChanged((key) => {
      if (key === STORAGE_KEY) loadState();
    });
  }

  loadState();
  document.fonts.ready.then(requestResize);
  setInterval(tick, 1000);
});
