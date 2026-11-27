import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BUILD_MAX_BYTES, BUILD_PROMPT, buildSettings, pickFiles, type BuildEntry, type BuildRequest } from "./rules.ts";

/**
 * A build for Claude Code on this Mac (src/computer.ts), started by its
 * person's tap on a card in Jarvis (jarvis-voice-agent lib/mac-build.ts).
 *
 * It runs in a new folder of its own, outside the home folder, under the
 * settings that folder holds (rules.ts buildSettings): in Claude Code's
 * sandbox, writing only there, reading nothing in the home folder, reaching
 * only npm's registry, with no web tools. It starts with a clean environment,
 * so nothing this Mac keeps in its own reaches it, and no keyboard. It has
 * its time and no more, and Stop ends it, with everything it started that did
 * not detach itself. What goes back is its plain files alone (rules.ts
 * pickFiles), zipped from a list, never by following a link; then the folder
 * is gone. No Electron here: Node tests it.
 */

export interface Built {
  ok: boolean;
  /** Claude Code's last words, or why it was not built. */
  said: string;
  zip: Buffer | null;
}

/** How much of what Claude Code said goes back. */
const SAID_MAX = 2_000;

const running = new Set<ChildProcess>();
const stopped = new WeakSet<ChildProcess>();

function end(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** Stop: every build running here ends now. */
export function stopBuilds(): void {
  for (const c of running) {
    stopped.add(c);
    end(c);
  }
}

/** Where Claude Code is on this Mac, where its installer and Homebrew put it; null when it is not. */
export function findClaude(home: string): string | null {
  return [join(home, ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"].find((p) => existsSync(p)) ?? null;
}

/** Only what Claude Code and its tools need to run: none of this Mac's own settings or secrets. */
function cleanEnv(home: string, folder: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: `${join(home, ".local", "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    // npm's cache and logs in the folder, the one place it may write.
    npm_config_cache: join(folder, ".npm-cache"),
  };
  for (const k of ["USER", "LOGNAME", "SHELL", "TMPDIR", "LANG"]) if (process.env[k]) env[k] = process.env[k];
  return env;
}

/** Everything in a folder, as lstat sees it: a link is a link, never what it names. */
async function entriesOf(root: string, at = ""): Promise<BuildEntry[]> {
  const out: BuildEntry[] = [];
  for (const name of await readdir(join(root, at))) {
    const path = at ? `${at}/${name}` : name;
    const st = await lstat(join(root, path));
    const kind = st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
    out.push({ path, kind, links: st.nlink, size: st.size });
    if (kind === "dir" && !name.startsWith(".") && name !== "node_modules") out.push(...(await entriesOf(root, path)));
  }
  return out;
}

/** Exactly these files of `root`, zipped: a link is stored as a link (-y), never followed. */
function zipList(root: string, files: readonly string[], out: string): Promise<boolean> {
  return new Promise((resolve) => {
    const z = spawn("/usr/bin/zip", ["-X", "-y", "-q", out, "-@"], { cwd: root, stdio: ["pipe", "ignore", "ignore"] });
    z.on("error", () => resolve(false));
    z.on("close", (code) => resolve(code === 0));
    z.stdin.end(files.join("\n"));
  });
}

/** Claude Code run once in `folder`, in its sandbox: how it ended, and the last of what it said. */
function runClaude(claude: string, folder: string, home: string, ms: number): Promise<{ code: number | null; said: string; timedOut: boolean; stopped: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(claude, ["-p", BUILD_PROMPT, "--permission-mode", "acceptEdits", "--setting-sources", "project", "--strict-mcp-config"], {
      cwd: folder,
      env: cleanEnv(home, folder),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    running.add(child);
    let said = "";
    const take = (b: Buffer) => void (said = (said + b.toString("utf8")).slice(-SAID_MAX));
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      end(child);
    }, ms);
    const done = (code: number | null) => {
      clearTimeout(timer);
      running.delete(child);
      // What it left running goes with it: nothing of the build outlives it.
      end(child);
      resolve({ code, said: said.trim(), timedOut, stopped: stopped.has(child) });
    };
    child.on("error", (e) => {
      take(Buffer.from(e.message));
      done(null);
    });
    child.on("close", (code) => done(code));
  });
}

/**
 * Build `b` with Claude Code at `claude` (findClaude; null when it is not
 * installed), in a folder under `temp`, kept from `home`. What came of it,
 * with its files zipped when there are any.
 */
export async function runBuild(b: BuildRequest, opts: { claude: string | null; temp: string; home: string }): Promise<Built> {
  if (!opts.claude) return { ok: false, said: "Claude Code (claude) is not installed on this Mac.", zip: null };
  const base = join(await realpath(opts.temp), "jarvis-builds");
  const folder = join(base, b.id);
  const out = join(base, `${b.id}.zip`);
  try {
    await mkdir(join(folder, ".claude"), { recursive: true, mode: 0o700 });
    await writeFile(join(folder, "INSTRUCTION.md"), `${b.task}\n`);
    await writeFile(join(folder, "RESEARCH.md"), `${b.notes}\n`);
    await writeFile(join(folder, ".claude", "settings.json"), `${JSON.stringify(buildSettings(opts.home), null, 2)}\n`);
    const ran = await runClaude(opts.claude, folder, opts.home, b.ms);
    if (ran.stopped) return { ok: false, said: "Stopped on the Mac.", zip: null };
    if (ran.timedOut) return { ok: false, said: `Out of time after ${Math.round(b.ms / 60_000)} minutes; what it started was ended. It said: ${ran.said}`, zip: null };
    if (ran.code !== 0) return { ok: false, said: `Claude Code stopped (exit ${ran.code ?? "unknown"}): ${ran.said}`, zip: null };
    // The finished site: its dist folder where it made one, else its folder.
    const root = existsSync(join(folder, "dist", "index.html")) ? join(folder, "dist") : folder;
    const files = pickFiles(await entriesOf(root));
    if (typeof files === "string") return { ok: false, said: `Not sent back: ${files}. It said: ${ran.said}`, zip: null };
    if (!(await zipList(root, files, out))) return { ok: false, said: "Its files could not be zipped.", zip: null };
    const zip = await readFile(out);
    if (zip.length > BUILD_MAX_BYTES) return { ok: false, said: "Its files are too big to send back.", zip: null };
    return { ok: true, said: ran.said, zip };
  } finally {
    await rm(folder, { recursive: true, force: true });
    await rm(out, { force: true });
  }
}
