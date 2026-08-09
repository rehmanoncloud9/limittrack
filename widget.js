// LimitTrack floating widget
//
// This is a deliberately self-contained sibling to renderer.js rather than a
// shared module: it runs in its own BrowserWindow/renderer process, reads the
// exact same on-disk store (STORAGE_KEY below must match renderer.js), and
// stays live-synced with the main window purely through the
// "storage:changed" broadcast in main.js. Duplicating the small set of pure
// helpers it needs keeps this file safe to edit without any risk of breaking
// the main app.

const STORAGE_KEY = "limittrack-state-v1";
const MAX_VISIBLE_ROWS = 3;

const DEFAULT_STATE = {
  providers: [
    { id: "antigravity", name: "Antigravity", cycleValue: 7, cycleUnit: "days" },
    { id: "codex", name: "Codex", cycleValue: 7, cycleUnit: "days" },
    { id: "claude", name: "Claude Code", cycleValue: 7, cycleUnit: "days" },
  ],
  accounts: [],
};

let state = JSON.parse(JSON.stringify(DEFAULT_STATE));
let renderedRowIds = null; // signature of the last row skeleton we built, to avoid unnecessary rebuilds

// ---------- pure helpers (mirrors renderer.js) ----------

function normalizeUnit(unit) {
  return unit === "hours" ? "hours" : "days";
}

function cycleToMs(value, unit) {
  const v = Number(value) || 0;
  return normalizeUnit(unit) === "hours" ? v * 3600000 : v * 86400000;
}

function migrateProvider(p) {
  if (p && typeof p.cycleValue !== "undefined") return { ...p, cycleUnit: normalizeUnit(p.cycleUnit) };
  return { ...p, cycleValue: p && p.cycleDays ? p.cycleDays : 7, cycleUnit: "days" };
}

function migrateAccount(a) {
  if (!a) return a;
  if (typeof a.cycleValue !== "undefined") return { ...a, cycleUnit: a.cycleValue ? normalizeUnit(a.cycleUnit) : a.cycleUnit };
  if (a.cycleDays) return { ...a, cycleValue: a.cycleDays, cycleUnit: "days" };
  return { ...a, cycleValue: null, cycleUnit: "days" };
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
  if (!acc.resetAt) return "OPEN";
  const diff = new Date(acc.resetAt).getTime() - nowMs;
  if (diff <= 0) return "OPEN";
  const totalSec = Math.floor(diff / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
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
  let hash = 0;
  const str = String(providerId || "");
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) % 360;
  return hash;
}

// ---------- storage ----------

async function loadState() {
  try {
    const value = await window.limittrack.storageGet(STORAGE_KEY);
    if (value) {
      const parsed = JSON.parse(value);
      state = {
        providers: (parsed.providers || DEFAULT_STATE.providers).map(migrateProvider),
        accounts: (parsed.accounts || []).map(migrateAccount),
      };
    } else {
      state = JSON.parse(JSON.stringify(DEFAULT_STATE));
    }
  } catch (e) {
    // keep whatever we already had
  }
  renderedRowIds = null;
  renderAll();
}

async function saveState() {
  try {
    await window.limittrack.storageSet(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error("widget save failed", e);
  }
}

// ---------- actions ----------

function markHit(id) {
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) return;
  const { value, unit } = accountCycle(acc);
  const hitAt = new Date().toISOString();
  const resetAt = new Date(Date.now() + cycleToMs(value, unit)).toISOString();
  acc.lastHitAt = hitAt;
  acc.resetAt = resetAt;
  acc.history = [{ hitAt, resetAt }, ...(acc.history || [])].slice(0, 8);
  saveState();
  renderedRowIds = null;
  renderAll();
}

// ---------- rendering ----------

function visibleAccounts(nowMs) {
  return [...state.accounts]
    .sort((a, b) => {
      const ea = effectiveTime(a, nowMs);
      const eb = effectiveTime(b, nowMs);
      if (ea === -1 && eb === -1) return a.email.localeCompare(b.email);
      return ea - eb;
    })
    .slice(0, MAX_VISIBLE_ROWS);
}

function rowSkeleton(acc, provider) {
  const hue = providerHue(acc.providerId);
  const initial = (provider ? provider.name : "?").trim().charAt(0).toUpperCase() || "?";
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.id = acc.id;
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  row.setAttribute("aria-label", `${provider ? provider.name : "Account"} - ${escapeHtml(acc.email)}`);
  row.innerHTML = `
    <div class="avatar" style="background: hsl(${hue} 70% 45%)">
      ${initial}
      <span class="status-dot" data-role="dot"></span>
    </div>
    <div class="row-text">
      <div class="row-name">${escapeHtml(provider ? provider.name : "Unknown")}</div>
      <div class="row-sub">${escapeHtml(acc.email)}</div>
    </div>
    <div class="row-right" data-role="right"></div>
  `;
  row.addEventListener("click", (e) => {
    if (e.target.closest("[data-role='right'] button")) return;
    window.limittrack.widgetOpenMain();
  });
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      window.limittrack.widgetOpenMain();
    }
  });
  return row;
}

function renderAll() {
  const nowMs = Date.now();
  const rowsEl = document.getElementById("rows");
  const footerEl = document.getElementById("footer");
  const emptyEl = document.getElementById("empty");
  const summaryEl = document.getElementById("summary-text");

  if (state.accounts.length === 0) {
    rowsEl.style.display = "none";
    footerEl.style.display = "none";
    emptyEl.style.display = "block";
    emptyEl.innerHTML = `
      <div class="emoji">📭</div>
      <div class="msg">No accounts tracked yet.<br />Add one in LimitTrack to see live countdowns here.</div>
      <button id="empty-open-btn">Open LimitTrack</button>
    `;
    document.getElementById("empty-open-btn").addEventListener("click", () => window.limittrack.widgetOpenMain());
    summaryEl.textContent = "";
    requestResize();
    return;
  }

  emptyEl.style.display = "none";
  rowsEl.style.display = "flex";

  const openCount = state.accounts.filter((a) => getStatus(a, nowMs) === "open").length;
  summaryEl.textContent = `${openCount}/${state.accounts.length} open`;

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

  const remaining = state.accounts.length - visible.length;
  footerEl.style.display = remaining > 0 ? "block" : "none";
  if (remaining > 0) {
    footerEl.innerHTML = `<button id="more-btn">+${remaining} more in LimitTrack</button>`;
    document.getElementById("more-btn").addEventListener("click", () => window.limittrack.widgetOpenMain());
  }

  updateTick(nowMs, visible);
  requestResize();
}

// Runs every second: only touches text/class of existing nodes so hover
// states and the reveal-highlight animation never get interrupted.
function updateTick(nowMs, visible) {
  const list = visible || visibleAccounts(nowMs);
  list.forEach((acc) => {
    const row = document.querySelector(`.row[data-id="${acc.id}"]`);
    if (!row) return;
    const status = getStatus(acc, nowMs);
    row.classList.toggle("is-open", status === "open");

    const dot = row.querySelector('[data-role="dot"]');
    if (dot) dot.className = `status-dot ${status}`;

    const right = row.querySelector('[data-role="right"]');
    if (right) {
      if (status === "open") {
        right.innerHTML = `<button class="hit-btn" data-role="hit">Log hit</button>`;
        const btn = right.querySelector('[data-role="hit"]');
        if (btn) btn.addEventListener("click", (e) => { e.stopPropagation(); markHit(acc.id); });
      } else {
        right.innerHTML = `<span class="countdown ${status}">${formatCountdown(acc, nowMs)}</span>`;
      }
    }
  });
}

function tick() {
  const nowMs = Date.now();
  if (state.accounts.length === 0) return;
  const openCount = state.accounts.filter((a) => getStatus(a, nowMs) === "open").length;
  const summaryEl = document.getElementById("summary-text");
  if (summaryEl) summaryEl.textContent = `${openCount}/${state.accounts.length} open`;

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

// ---------- Fluent reveal-highlight ----------

function attachRevealEffect() {
  const panel = document.getElementById("panel");
  if (!panel) return;
  panel.addEventListener("mousemove", (e) => {
    const rect = panel.getBoundingClientRect();
    panel.style.setProperty("--mx", `${e.clientX - rect.left}px`);
    panel.style.setProperty("--my", `${e.clientY - rect.top}px`);
    panel.classList.add("reveal");
  });
  panel.addEventListener("mouseleave", () => panel.classList.remove("reveal"));
}

// ---------- init ----------

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("open-main-btn").addEventListener("click", () => window.limittrack.widgetOpenMain());
  document.getElementById("hide-widget-btn").addEventListener("click", () => window.limittrack.widgetHide());
  attachRevealEffect();

  if (window.limittrack && window.limittrack.onStorageChanged) {
    window.limittrack.onStorageChanged((key) => {
      if (key === STORAGE_KEY) loadState();
    });
  }

  loadState();
  setInterval(tick, 1000);
});
