const { test } = require("node:test");
const assert = require("node:assert/strict");
const D = require("../domain");
const now = Date.parse("2026-10-27T12:00:00Z");
const iso = (offset) => new Date(now + offset).toISOString();
function fixture() {
  return D.normalizeState({ providers: [{ id: "tool", name: "Tool", cycleDays: 7 }], accounts: [
    { id: "one", providerId: "tool", email: "one@example.com" },
    { id: "two", providerId: "tool", email: "two@example.com" },
  ] });
}

test("legacy migration preserves account IDs and reset history without asserting availability", () => {
  const input = fixture();
  input.accounts[0].history = [{ hitAt: iso(-86400000), resetAt: iso(86400000) }];
  const result = D.normalizeState(input);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.providers[0].cycleValue, 7);
  assert.equal(result.accounts[0].id, "one");
  assert.deepEqual(result.accounts[0].history, input.accounts[0].history);
  assert.equal(D.getStatus(result.accounts[0], now), "unknown");
});

test("availability distinguishes unknown, confirmed, waiting, and elapsed estimates", () => {
  const account = fixture().accounts[0];
  assert.equal(D.getStatus(account, now), "unknown");
  account.confirmedAvailableAt = iso(-1000);
  assert.equal(D.getStatus(account, now), "open");
  account.lastHitAt = iso(-500);
  account.resetAt = iso(7200000);
  assert.equal(D.getStatus(account, now), "locked");
  assert.equal(D.getStatus(account, now + 7100000), "soon");
  assert.equal(D.getStatus(account, now + 7200000), "ready");
  assert.equal(D.formatCountdown(account, now + 7200000), "Expected ready");
  assert.equal(D.getStatus({ ...account, resetAt: null, confirmedAvailableAt: iso(1000) }, now), "unknown");
});

test("short limits use relative urgency and countdowns never display zero prematurely", () => {
  const account = { ...fixture().accounts[0], lastHitAt: iso(0), resetAt: iso(300000) };
  assert.equal(D.getStatus(account, now + 1000), "locked");
  assert.equal(D.getStatus(account, now + 241000), "soon");
  assert.equal(D.formatCountdown(account, now + 299999), "0m 1s");
});

test("validation rejects malformed imports before any state replacement", () => {
  const invalid = [
    (s) => { s.accounts[0].resetAt = "not-a-date"; },
    (s) => { s.accounts[0].providerId = "missing"; },
    (s) => { s.providers[0].cycleValue = -1; },
    (s) => { s.accounts[0].cycleValue = 0; },
    (s) => { s.accounts.push({ ...s.accounts[0] }); },
    (s) => { s.providers[0].id = '<img src=x>'; },
    (s) => { s.schemaVersion = 99; },
  ];
  for (const change of invalid) { const state = fixture(); change(state); assert.throws(() => D.normalizeState(state)); }
});

test("simultaneous changes to different accounts survive both commits", () => {
  const base = fixture(), first = D.clone(base), second = D.clone(base);
  first.accounts[0].resetAt = iso(3600000);
  second.accounts[1].confirmedAvailableAt = iso(-1000);
  const current = D.mergeState(base, first, base);
  const result = D.mergeState(base, second, current);
  assert.equal(result.accounts[0].resetAt, iso(3600000));
  assert.equal(result.accounts[1].confirmedAvailableAt, iso(-1000));
  assert.deepEqual(base, fixture());
});

test("conflicting edits and deletion of a concurrently referenced tool are rejected", () => {
  const base = fixture(), first = D.clone(base), second = D.clone(base);
  first.accounts[0].resetAt = iso(3600000);
  second.accounts[0].resetAt = iso(7200000);
  assert.throws(() => D.mergeState(base, second, D.mergeState(base, first, base)), /another window/);
  const empty = D.normalizeState({ providers: base.providers, accounts: [] });
  const removed = D.normalizeState({ providers: [], accounts: [] });
  assert.throws(() => D.mergeState(empty, removed, base), /unknown tool/);
});

test("notifications reconcile expired timers once, including after restart", () => {
  const state = fixture();
  state.accounts[0].resetAt = iso(-1000);
  state.accounts[1].resetAt = iso(1000);
  assert.deepEqual(D.dueResets(state, {}, now).map((a) => a.id), ["one"]);
  const delivered = { one: state.accounts[0].resetAt };
  assert.deepEqual(D.dueResets(state, delivered, now), []);
  assert.deepEqual(D.dueResets(state, delivered, now + 2000).map((a) => a.id), ["two"]);
  state.accounts[0].resetAt = iso(-500);
  assert.deepEqual(D.dueResets(state, delivered, now).map((a) => a.id), ["one"]);
  state.accounts[0].confirmedAvailableAt = iso(-1);
  assert.deepEqual(D.dueResets(state, delivered, now), []);
});
