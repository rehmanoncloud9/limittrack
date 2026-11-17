const fs = require("node:fs");
const path = require("node:path");

// Keep the last valid store if a write is interrupted. A corrupt primary file
// is never treated as a fresh installation and never silently overwritten.
function createStore(filename) {
  let cache;
  let cacheText; // the serialized form of `cache`, reused for the backup so a write serializes only once
  let primaryText; // what the primary file on disk is known to contain (unset when it is missing or was corrupt)
  let recoveryNotice = null;
  function parse(file) {
    const text = fs.readFileSync(file, "utf8");
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid store.");
    cacheText = text;
    if (file === filename) primaryText = text;
    return value;
  }
  function read() {
    if (cache) return structuredClone(cache);
    try { cache = parse(filename); }
    catch (error) {
      if (error.code === "ENOENT" && !fs.existsSync(filename + ".bak")) cache = {};
      else {
        try {
          cache = parse(filename + ".bak");
          if (fs.existsSync(filename)) fs.copyFileSync(filename, filename + ".corrupt-" + Date.now());
          recoveryNotice = "Recovered your last valid local backup. Recent changes may be missing.";
        } catch {
          throw new Error("Your account file could not be read. It has been preserved. Restore a valid backup before making changes.");
        }
      }
    }
    return structuredClone(cache);
  }
  function write(value) {
    // Force a successful read before any write, including window preferences.
    read();
    const text = JSON.stringify(value, null, 2);
    // Saving identical data (a window "moved" to where it already was, a setting set to its current
    // value) would rewrite the file and rotate the backup for nothing.
    if (text === primaryText) { cache = structuredClone(value); return; }
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temp = filename + ".tmp";
    let descriptor;
    try {
      descriptor = fs.openSync(temp, "w", 0o600);
      fs.writeFileSync(descriptor, text, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      // Back up the known-good cache, never a potentially corrupt disk file.
      fs.writeFileSync(filename + ".bak.tmp", cacheText ?? JSON.stringify(cache, null, 2), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(filename + ".bak.tmp", filename + ".bak");
      fs.renameSync(temp, filename);
      cache = structuredClone(value);
      cacheText = primaryText = text;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
  function checkpoint() {
    const value = read();
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename + ".before-import.tmp", JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(filename + ".before-import.tmp", filename + ".before-import");
  }
  // Read-only view of the cached data with no copy. Callers must not modify it.
  function peek() { if (!cache) read(); return cache; }
  return { read, peek, write, checkpoint, notice: () => recoveryNotice };
}
module.exports = { createStore };
