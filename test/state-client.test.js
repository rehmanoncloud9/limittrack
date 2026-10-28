const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const D = require("../domain");
function setup(bridge) {
  const context = vm.createContext({ LimitTrackDomain: D });
  vm.runInContext(fs.readFileSync(require.resolve("../state-client"), "utf8"), context);
  return context.createLimitTrackClient(bridge);
}
test("rapid local changes are serialized while remote account changes are preserved", async () => {
  let current = D.clone(D.DEFAULT_STATE), calls = 0;
  const client = setup({ stateGet: async () => current, stateCommit: async (base, next) => { calls++; current = D.mergeState(base, next, current); return current; } });
  const base = await client.read();
  base.accounts.push({ id: "first", providerId: "codex", email: "first@example.com" });
  const first = client.save(base);
  base.accounts.push({ id: "second", providerId: "codex", email: "second@example.com" });
  const second = client.save(base);
  await Promise.all([first, second]);
  assert.equal(calls, 2);
  assert.equal((await client.read()).accounts.length, 2);
});
test("a failed save cancels queued dependent saves and can recover by reloading", async () => {
  let current = D.clone(D.DEFAULT_STATE), failing = true, calls = 0;
  const client = setup({ stateGet: async () => current, stateCommit: async (base, next) => { calls++; if (failing) throw new Error("Disk full"); current = D.mergeState(base, next, current); return current; } });
  const state = await client.read(); state.providers[0].name = "Changed";
  const first = client.save(state); state.providers[1].name = "Also changed";
  const second = client.save(state);
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.every((result) => result.status === "rejected"), true);
  assert.equal(calls, 1);
  failing = false;
  const recovered = await client.read(); recovered.providers[0].name = "Recovered";
  await client.save(recovered);
  assert.equal(current.providers[0].name, "Recovered");
  assert.equal(current.providers[1].name, "Codex");
});
