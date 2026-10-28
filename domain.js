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
  function effectiveTime(account, nowMs) {
    const status = getStatus(account, nowMs);
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
  function dueResets(state, delivered, nowMs) {
    return state.accounts.filter((a) => a.resetAt && Date.parse(a.resetAt) <= nowMs && getStatus(a, nowMs) === "ready" && delivered[a.id] !== a.resetAt);
  }
  return { STORAGE_KEY, DEFAULT_STATE, clone, normalizeState, mergeState, getStatus, effectiveTime, formatCountdown, dueResets };
});
