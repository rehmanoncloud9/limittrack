const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { watchDesktopVisibility } = require("../desktop-visibility");

test("desktop observer parses native reports, runs hidden, and stops cleanly", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; };
  const handle = Buffer.alloc(8); handle.writeBigUInt64LE(1234n);
  const changes = [], errors = [];
  const stop = watchDesktopVisibility({ getNativeWindowHandle: () => handle }, {
    helperPath: "C:\\app with spaces\\desktop-observer.exe",
    onChange: (value) => changes.push(value), onError: (error) => errors.push(error),
    launch: (_command, args, options) => {
      assert.equal(options.windowsHide, true);
      assert.equal(args.length, 1);
      assert.equal(args.at(-1), "1234");
      assert.equal(_command, "C:\\app with spaces\\desktop-observer.exe");
      return child;
    },
  });
  child.stdout.write("desk"); child.stdout.write("top\nother\ndesktop\n");
  assert.deepEqual(changes, [true, false, true]);
  child.emit("exit", 1);
  assert.deepEqual(changes, [true, false, true, false]);
  assert.equal(errors.length, 1);
  assert.equal(child.killed, true);
  stop();
});

test("missing desktop observer fails closed instead of showing an overlay", () => {
  const handle = Buffer.alloc(4); handle.writeUInt32LE(1234);
  const changes = [], errors = [];
  watchDesktopVisibility({ getNativeWindowHandle: () => handle }, {
    helperPath: "missing", onChange: (value) => changes.push(value), onError: (error) => errors.push(error),
    launch: () => { throw new Error("Launch failed"); },
  });
  assert.deepEqual(changes, [false]);
  assert.equal(errors.length, 1);
});
