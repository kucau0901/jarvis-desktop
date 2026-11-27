// Builds the Swift helper (native/jarvis-control.swift) into build/native/jarvis-control, for both
// kinds of Mac in one file, which the app is packaged with (package.json build.mac.extraResources).
// Nothing on Windows or Linux: there the app has no control of the computer.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

if (process.platform !== "darwin") process.exit(0);
const out = join(import.meta.dirname, "..", "build", "native");
const src = join(import.meta.dirname, "..", "native", "jarvis-control.swift");
mkdirSync(out, { recursive: true });
const parts = ["arm64", "x86_64"].map((arch) => {
  const file = join(out, `jarvis-control-${arch}`);
  execFileSync("xcrun", ["swiftc", "-O", "-target", `${arch}-apple-macos13`, src, "-o", file], { stdio: "inherit" });
  return file;
});
execFileSync("lipo", ["-create", ...parts, "-output", join(out, "jarvis-control")], { stdio: "inherit" });
for (const p of parts) rmSync(p);
