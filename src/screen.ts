import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * A picture of this Mac's screen, for Jarvis to look at when asked: macOS's own
 * screencapture, made at most 1280 pixels wide with sips, as a JPEG data URL.
 * It needs the app's Screen Recording permission; Jarvis's own banner is left
 * out of it (src/computer.ts). Null when it could not be taken.
 */
export async function screenshot(): Promise<string | null> {
  const file = join(tmpdir(), `jarvis-screen-${randomBytes(6).toString("hex")}.jpg`);
  try {
    await run("/usr/sbin/screencapture", ["-x", "-t", "jpg", file], { timeout: 10_000 });
    await run("/usr/bin/sips", ["-Z", "1280", "-s", "formatOptions", "60", file], { timeout: 10_000 });
    return `data:image/jpeg;base64,${(await readFile(file)).toString("base64")}`;
  } catch {
    return null;
  } finally {
    await rm(file, { force: true });
  }
}
