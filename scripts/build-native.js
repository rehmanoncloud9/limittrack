const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

if (process.platform === "win32") {
  const root = path.resolve(__dirname, "..");
  const source = path.join(root, "native", "desktop-observer.cs");
  const output = path.join(root, "native", "build", "desktop-observer.exe");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const compiler = path.join(process.env.SystemRoot || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  if (!fs.existsSync(output) || fs.statSync(output).mtimeMs < fs.statSync(source).mtimeMs) {
    execFileSync(compiler, ["/nologo", "/optimize+", "/target:exe", "/platform:anycpu", `/out:${output}`, source], { stdio: "inherit", windowsHide: true });
  }
  // Compile and load the native helper in CI without inspecting the host UI.
  execFileSync(output, ["0"], { windowsHide: true, timeout: 5000 });
}
