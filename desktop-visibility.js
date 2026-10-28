const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");

// Windows has no Electron desktop window type. Observe desktop activation
// without reparenting windows into Explorer or altering the user's shell.
function watchDesktopVisibility(win, { helperPath, onChange, onError, launch = spawn } = {}) {
  const handle = win.getNativeWindowHandle();
  const value = handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
  let stopped = false;
  let watchdog;
  let child;
  let lines;
  function stop() {
    stopped = true;
    clearTimeout(watchdog);
    lines?.close();
    child?.kill();
  }
  function fail() {
    if (stopped) return;
    stop();
    onChange(false);
    onError(new Error("Desktop detection is unavailable. Turn the widget off and on to retry."));
  }
  function heartbeat() {
    clearTimeout(watchdog);
    watchdog = setTimeout(fail, 10000);
    watchdog.unref?.();
  }
  try {
    child = launch(helperPath, [value.toString()], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", fail);
    child.on("exit", fail);
    child.stderr.resume();
    lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (stopped || !["desktop", "other"].includes(line)) return;
      heartbeat();
      onChange(line === "desktop");
    });
    heartbeat();
  } catch { fail(); }
  return stop;
}

module.exports = { watchDesktopVisibility };
