(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LimitTrackDomain = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const STORAGE_KEY = "limittrack-state-v1";
  const DEFAULT_STATE = {
    schemaVersion: 2,
    providers: [
      { id: "antigravity", name: "Antigravity", cycleValue: 7, cycleUnit: "days" },
      { id: "codex", name: "Codex", cycleValue: 7, cycleUnit: "days" },
      { id: "claude", name: "Claude Code", cycleValue: 7, cycleUnit: "days" },
    ],
    accounts: [],
  };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  function record(value) { return value && typeof value === "object" && !Array.isArray(value); }
  function id(value) {
    if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid record ID.");
    return value;
  }
  function text(value, max) {
    if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Missing or invalid name.");
    return value.trim();
  }
  function date(value) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("Invalid reset date.");
    return new Date(value).toISOString();
  }
  function duration(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0 || number > 100000) throw new Error("Reset duration must be positive and at most 100,000.");
    return number;
  }
  function unit(value) {
    if (value === undefined || value === null || value === "days") return "days";
    if (value === "hours") return "hours";
    throw new Error("Reset duration must use hours or days.");
  }
  function normalizeState(value) {
    if (!record(value) || (value.schemaVersion !== undefined && value.schemaVersion !== 1 && value.schemaVersion !== 2)) throw new Error("Unsupported backup version.");
    if (!Array.isArray(value.providers) || !Array.isArray(value.accounts) || value.providers.length > 500 || value.accounts.length > 10000) throw new Error("Invalid account data.");
    const providerIds = new Set();
    const providers = value.providers.map((p) => {
      if (!record(p)) throw new Error("Invalid tool.");
      const provider = { id: id(p.id), name: text(p.name, 200), cycleValue: duration(p.cycleValue ?? p.cycleDays ?? 7), cycleUnit: unit(p.cycleUnit) };
      if (providerIds.has(provider.id)) throw new Error("Duplicate tool ID.");
      providerIds.add(provider.id);
      return provider;
    });
    const accountIds = new Set();
    const accounts = value.accounts.map((a) => {
      if (!record(a) || !providerIds.has(a.providerId)) throw new Error("An account refers to an unknown tool.");
      if (accountIds.has(id(a.id))) throw new Error("Duplicate account ID.");
      accountIds.add(a.id);
      if (a.history !== undefined && (!Array.isArray(a.history) || a.history.length > 1000)) throw new Error("Invalid account history.");
      return {
        id: a.id, providerId: a.providerId, email: text(a.email, 320),
        cycleValue: a.cycleValue !== undefined && a.cycleValue !== null ? duration(a.cycleValue) : a.cycleDays !== undefined && a.cycleDays !== null ? duration(a.cycleDays) : null,
        cycleUnit: unit(a.cycleUnit),
        lastHitAt: date(a.lastHitAt), resetAt: date(a.resetAt),
        confirmedAvailableAt: date(a.confirmedAvailableAt),
        resetSource: a.resetSource === "exact" ? "exact" : "estimate",
        history: (a.history || []).map((event) => {
          if (!record(event) || !event.hitAt || !event.resetAt) throw new Error("Invalid history event.");
          return { hitAt: date(event.hitAt), resetAt: date(event.resetAt) };
        }),
      };
    });
    return { schemaVersion: 2, providers, accounts };
  }
  function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  // Apply only records changed by the initiating window. Unrelated updates
  // from another window survive; competing edits to one record are rejected.
  function mergeState(baseValue, nextValue, currentValue) {
    const base = normalizeState(baseValue), next = normalizeState(nextValue), current = normalizeState(currentValue);
    const result = clone(current);
    for (const collection of ["providers", "accounts"]) {
      const before = new Map(base[collection].map((item) => [item.id, item]));
      const after = new Map(next[collection].map((item) => [item.id, item]));
      const latest = new Map(current[collection].map((item) => [item.id, item]));
      for (const key of new Set([...before.keys(), ...after.keys()])) {
        if (equal(before.get(key), after.get(key))) continue;
        if (!equal(latest.get(key), before.get(key)) && !equal(latest.get(key), after.get(key))) {
          throw new Error("This account or tool changed in another window. Review the latest version and try again.");
        }
        if (after.has(key)) latest.set(key, after.get(key));
        else latest.delete(key);
      }
      result[collection] = [...latest.values()];
    }
    return normalizeState(result);
  }
  function getStatus(account, nowMs) {
    const reset = account.resetAt ? Date.parse(account.resetAt) : NaN;
    if (Number.isFinite(reset) && reset > nowMs) {
      const start = Date.parse(account.lastHitAt);
      const threshold = Number.isFinite(start) && reset > start ? Math.min(3600000, (reset - start) * 0.2) : 3600000;
      return reset - nowMs <= threshold ? "soon" : "locked";
    }
    const confirmed = Date.parse(account.confirmedAvailableAt);
    if (Number.isFinite(confirmed) && confirmed <= nowMs && (!account.lastHitAt || confirmed >= Date.parse(account.lastHitAt)) && (!Number.isFinite(reset) || confirmed >= reset)) return "open";
    if (Number.isFinite(reset)) return "ready";
    return "unknown";
  }
  // Pass an already-computed status to avoid recomputing it when sorting many accounts.
  function effectiveTime(account, nowMs, knownStatus) {
    const status = knownStatus || getStatus(account, nowMs);
    if (status === "open") return -2;
    if (status === "ready") return -1;
    if (status === "unknown") return Infinity;
    return Date.parse(account.resetAt);
  }
  function formatCountdown(account, nowMs, compact = false) {
    const status = getStatus(account, nowMs);
    if (status === "open") return "Available";
    if (status === "ready") return "Expected ready";
    if (status === "unknown") return "Not checked";
    const seconds = Math.max(0, Math.ceil((Date.parse(account.resetAt) - nowMs) / 1000));
    const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
    if (d) return compact ? `${d}d ${h}h` : `${d}d ${h}h ${m}m`;
    if (h) return compact ? `${h}h ${m}m` : `${h}h ${m}m ${s}s`;
    return `${m}m ${s}s`;
  }
  function cycleToMs(value, unit) {
    return (Number(value) || 0) * (unit === "hours" ? 3600000 : 86400000);
  }
  // An account's own cycle wins; otherwise its tool's; otherwise a 7-day default.
  function cycleFor(account, providers) {
    if (account.cycleValue) return { value: account.cycleValue, unit: account.cycleUnit };
    const provider = providers.find((p) => p.id === account.providerId);
    return provider ? { value: provider.cycleValue, unit: provider.cycleUnit } : { value: 7, unit: "days" };
  }
  // Mutating helpers shared by the app window, bulk actions and the widget.
  function logLimit(account, providers, nowMs) {
    const { value, unit } = cycleFor(account, providers);
    const hitAt = new Date(nowMs).toISOString();
    const resetAt = new Date(nowMs + cycleToMs(value, unit)).toISOString();
    account.lastHitAt = hitAt;
    account.resetAt = resetAt;
    account.confirmedAvailableAt = null;
    account.resetSource = "estimate";
    account.history = [{ hitAt, resetAt }, ...(account.history || [])].slice(0, 8);
    return account;
  }
  function markAvailable(account, nowMs) {
    account.resetAt = null;
    account.confirmedAvailableAt = new Date(nowMs).toISOString();
    return account;
  }
  function setReset(account, resetAtIso, source, nowMs) {
    account.resetAt = resetAtIso;
    account.resetSource = source === "exact" ? "exact" : "estimate";
    account.confirmedAvailableAt = null;
    // An exact reset with no recorded hit still implies a limit was reached.
    if (!account.lastHitAt) account.lastHitAt = new Date(nowMs).toISOString();
    return account;
  }
  // Validates a <input type="datetime-local"> value for a reset time.
  function parseResetInput(localValue, nowMs) {
    if (!localValue) return { error: "Choose a date and time." };
    const ms = new Date(localValue).getTime();
    if (!Number.isFinite(ms)) return { error: "That date and time isn't valid." };
    if (ms <= nowMs) return { error: "Choose a time in the future, or use Mark available." };
    if (ms - nowMs > 400 * 86400000) return { error: "That is more than a year away. Check the date." };
    return { iso: new Date(ms).toISOString() };
  }
  // "3d 4h", "2h 5m" or "12m" for a span of milliseconds (minute resolution, never below 1m).
  function formatMinutes(ms) {
    const minutes = Math.max(1, Math.ceil(ms / 60000));
    const d = Math.floor(minutes / 1440), h = Math.floor(minutes % 1440 / 60), m = minutes % 60;
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  }
  // Minute-level text for places that cannot tick every second (tray tooltip, desktop widget).
  function formatApprox(account, nowMs) {
    const status = getStatus(account, nowMs);
    if (status === "open") return "available";
    if (status === "ready") return "expected ready";
    if (status === "unknown") return "not checked";
    return formatMinutes(Date.parse(account.resetAt) - nowMs);
  }
  // One pass over the accounts: per-tool counts used by the desktop widget. "Available" means
  // exactly what the app means by it (status "open"); the next reset only considers future resets.
  function summarizeProviders(state, nowMs) {
    const rows = new Map(state.providers.map((p) => [p.id, { id: p.id, name: p.name, available: 0, ready: 0, tracked: 0, nextResetAt: null }]));
    for (const account of state.accounts) {
      const row = rows.get(account.providerId);
      if (!row) continue;
      row.tracked++;
      const status = getStatus(account, nowMs);
      if (status === "open") row.available++;
      else if (status === "ready") row.ready++;
      else if (status === "soon" || status === "locked") {
        const at = Date.parse(account.resetAt);
        if (row.nextResetAt === null || at < row.nextResetAt) row.nextResetAt = at;
      }
    }
    return [...rows.values()];
  }
  // Folds per-tool rows into one "All tools" row.
  function combineSummaries(rows) {
    const total = { id: null, name: "All tools", available: 0, ready: 0, tracked: 0, nextResetAt: null };
    for (const row of rows) {
      total.available += row.available; total.ready += row.ready; total.tracked += row.tracked;
      if (row.nextResetAt !== null && (total.nextResetAt === null || row.nextResetAt < total.nextResetAt)) total.nextResetAt = row.nextResetAt;
    }
    return total;
  }
  // Keeps the first letters and the domain so work and personal accounts stay distinguishable.
  function maskEmail(value) {
    const text = String(value ?? "");
    const at = text.lastIndexOf("@");
    if (at < 1) return text.length > 1 ? text[0] + "•••" : "•••";
    return text.slice(0, Math.min(2, at)) + "•••" + text.slice(at);
  }
  function displayEmail(value, privacy) { return privacy ? maskEmail(value) : String(value ?? ""); }
  function dueResets(state, delivered, nowMs) {
    return state.accounts.filter((a) => a.resetAt && Date.parse(a.resetAt) <= nowMs && getStatus(a, nowMs) === "ready" && delivered[a.id] !== a.resetAt);
  }
  return { STORAGE_KEY, DEFAULT_STATE, clone, normalizeState, mergeState, getStatus, effectiveTime, formatCountdown, formatApprox, formatMinutes, summarizeProviders, combineSummaries, dueResets,
    cycleToMs, cycleFor, logLimit, markAvailable, setReset, parseResetInput, maskEmail, displayEmail };
});
