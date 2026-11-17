const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStore } = require("../store");

function temporary(t) {
  const temporaryRoot = process.env.LIMITTRACK_TEST_TMP || os.tmpdir();
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "limittrack-store-"));
  t.after(() => {
    const resolved = fs.realpathSync(directory);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(temporaryRoot).toLowerCase());
    assert.ok(path.basename(resolved).startsWith("limittrack-store-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return path.join(directory, "data.json");
}

test("atomic writes preserve the previous valid store and leave no temporary primary file", (t) => {
  const filename = temporary(t), store = createStore(filename);
  store.write({ accounts: ["first"] });
  store.write({ accounts: ["second"] });
  assert.deepEqual(createStore(filename).read(), { accounts: ["second"] });
  assert.deepEqual(JSON.parse(fs.readFileSync(filename + ".bak")), { accounts: ["first"] });
  assert.equal(fs.existsSync(filename + ".tmp"), false);
});

test("corrupt primary recovers from backup and preserves the damaged file", (t) => {
  const filename = temporary(t), store = createStore(filename);
  store.write({ value: 1 }); store.write({ value: 2 });
  fs.writeFileSync(filename, "{broken");
  const recovered = createStore(filename);
  assert.deepEqual(recovered.read(), { value: 1 });
  assert.match(recovered.notice(), /Recovered/);
  assert.ok(fs.readdirSync(path.dirname(filename)).some((name) => name.includes(".corrupt-")));
  recovered.write({ value: 3 });
  assert.deepEqual(createStore(filename).read(), { value: 3 });
});

test("unrecoverable corruption blocks writes instead of replacing accounts with defaults", (t) => {
  const filename = temporary(t);
  fs.writeFileSync(filename, "broken");
  const store = createStore(filename);
  assert.throws(() => store.read(), /preserved/);
  assert.throws(() => store.write({}), /preserved/);
  assert.equal(fs.readFileSync(filename, "utf8"), "broken");
});

test("import recovery copy survives subsequent normal writes", (t) => {
  const filename = temporary(t), store = createStore(filename);
  store.write({ value: "before" }); store.checkpoint();
  store.write({ value: "imported" }); store.write({ value: "later" });
  assert.deepEqual(JSON.parse(fs.readFileSync(filename + ".before-import")), { value: "before" });
});

test("saving unchanged data does not rewrite the file or rotate the backup", (t) => {
  const filename = temporary(t), store = createStore(filename);
  store.write({ value: 1 }); store.write({ value: 2 });
  const before = fs.statSync(filename).mtimeMs, backup = fs.readFileSync(filename + ".bak", "utf8");
  store.write({ value: 2 });
  assert.equal(fs.statSync(filename).mtimeMs, before);
  assert.equal(fs.readFileSync(filename + ".bak", "utf8"), backup, "the backup still holds the previous version");
});

test("after recovering from a corrupt file, saving the recovered data still repairs the primary file", (t) => {
  const filename = temporary(t), store = createStore(filename);
  store.write({ value: 1 }); store.write({ value: 2 });
  fs.writeFileSync(filename, "{broken");
  const recovered = createStore(filename);
  assert.deepEqual(recovered.read(), { value: 1 });
  recovered.write({ value: 1 }); // identical to the recovered copy, but not to what is on disk
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, "utf8")), { value: 1 });
});
