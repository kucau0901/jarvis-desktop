import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AGAIN_PROMPT,
  BUILD_FILE_MAX,
  BUILD_MAX_FILES,
  BUILD_ROOT,
  FIRST_PROMPT,
  LIMIT_MAX_MS,
  LIMIT_RETRY_MS,
  NOT_SOURCE,
  STUCK_MS,
  buildEnv,
  buildSettings,
  claudeArgs,
  pickOut,
  pickSite,
  pickSource,
  roundEnd,
  type BuildEntry,
  type BuildRequest,
} from "./rules.ts";

/**
 * A Claude Code session for a Jarvis job on this Mac (src/computer.ts), which
 * its person's tap on a card in Jarvis began (jarvis-voice-agent
 * lib/mac-build.ts), one round at a time.
 *
 * Each round runs in the session's folder, outside the home folder, under the
 * settings on its command line (rules.ts buildSettings): in Claude Code's
 * sandbox, writing only there, reading nothing in the home folder but the
 * Android SDK, reaching only the package registries, with no web tools. It
 * starts with a clean environment, so nothing this Mac keeps in its own
 * reaches it, and no keyboard. A round has no time of its own: one that prints
 * nothing for half an hour is stuck, and Stop ends it, with everything it
 * started that did not detach itself. At its person's Claude plan's limit it
 * waits and goes on by itself, for a day at most. Nothing is kept here between
 * rounds but the folder: Jarvis names it and the session every time.
 *
 * What goes back is plain files alone (rules.ts pickSite, pickOut,
 * pickSource), zipped from a list, never by following a link; the folder
 * stays, for its person and for a later job of the same project. No Electron
 * here: Node tests it.
 */

type Round = Extract<BuildRequest, { start: unknown } | { round: number }>;
export interface RoundOut {
  said: string;
  how: "turn" | "error" | "stuck" | "limit" | "stopped";
}
export interface Collected {
  /** What goes back, by its name for Jarvis, and where it is here. */
  files: { name: string; path: string }[];
  left: { name: string; why: string }[];
  /** The folder, which stays; and a folder of zips, to remove once they are sent. */
  path: string;
  scratch: string;
}
export interface Where {
  claude: string | null;
  home: string;
  temp: string;
  /** Where the folders are; BUILD_ROOT but in tests. */
  root?: string;
  /** How long a stuck round, and the plan's limit, are waited for; theirs but in tests. */
  stuckMs?: number;
  retryMs?: number;
  limitMs?: number;
}

/** How much of what Claude Code printed is kept, to read how the round ended. */
const KEEP_LINES = 40;
const LINE_MAX = 200_000;

const running = new Set<ChildProcess>();
let stopping = false;
let wake: (() => void) | null = null;

function end(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** Stop: the round running here ends now, and one waiting for the plan stops waiting. */
export function stopBuilds(): void {
  if (!running.size && !wake) return;
  stopping = true;
  for (const c of running) end(c);
  wake?.();
}

/** Where Claude Code is on this Mac, where its installer and Homebrew put it; null when it is not. */
export function findClaude(home: string): string | null {
  return [join(home, ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"].find((p) => existsSync(p)) ?? null;
}

/** The Android SDK, where Android Studio puts it, and Java, where Homebrew does: what an app's build needs, when this Mac has them. */
export function findTools(home: string): { sdk: string | null; java: string | null } {
  const sdk = join(home, "Library", "Android", "sdk");
  const java = ["/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home", "/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home"].find((p) => existsSync(p)) ?? null;
  return { sdk: existsSync(sdk) ? sdk : null, java };
}

const folderOf = (b: { folder: string }, w: Where): string => join(w.root ?? BUILD_ROOT, b.folder);
const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    wake = () => {
      clearTimeout(t);
      wake = null;
      resolve();
    };
  });

/** Its folder ready: made on its first round, with what it was given; its tools' own folder in it. */
async function prepare(b: Round, folder: string, root: string, source: Buffer | null): Promise<string | null> {
  if (!("start" in b)) return existsSync(folder) ? null : "its folder is not on this Mac any more";
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await mkdir(join(folder, ".jarvis", "cache"), { recursive: true, mode: 0o700 });
  await writeFile(join(folder, ".jarvis", "gitconfig"), "[user]\n\tname = Claude Code\n\temail = claude-code@example.invalid\n");
  if (source && !(await untar(source, folder))) return "the repository's files could not be unpacked";
  await writeFile(join(folder, "INSTRUCTION.md"), `${b.start.task}\n`);
  await writeFile(join(folder, "RESEARCH.md"), `${b.start.notes}\n`);
  return null;
}

/** A repository's files (GitHub's .tar.gz, its one top folder dropped) into the folder: bsdtar keeps every name inside it. */
function untar(bytes: Buffer, folder: string): Promise<boolean> {
  return new Promise((resolve) => {
    const t = spawn("/usr/bin/tar", ["-xzf", "-", "--strip-components", "1", "-C", folder], { stdio: ["pipe", "ignore", "ignore"] });
    t.on("error", () => resolve(false));
    t.on("close", (code) => resolve(code === 0));
    t.stdin.end(bytes);
  });
}

/** Claude Code run once in `folder`, in its sandbox: how it ended, and the last of what it printed. */
function runClaude(claude: string, args: string[], folder: string, env: Record<string, string>, stuckMs: number): Promise<{ code: number | null; lines: string[]; stuck: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(claude, args, { cwd: folder, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    running.add(child);
    const lines: string[] = [];
    let rest = "";
    let stuck = false;
    let timer = setTimeout(() => ((stuck = true), end(child)), stuckMs);
    const take = (b: Buffer) => {
      clearTimeout(timer);
      timer = setTimeout(() => ((stuck = true), end(child)), stuckMs);
      const parts = (rest + b.toString("utf8")).split("\n");
      rest = parts.pop()!.slice(-LINE_MAX);
      for (const p of parts) lines.push(p.slice(0, LINE_MAX));
      if (lines.length > KEEP_LINES) lines.splice(0, lines.length - KEEP_LINES);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const done = (code: number | null) => {
      clearTimeout(timer);
      running.delete(child);
      // What it left running goes with it: nothing of the round outlives it.
      end(child);
      if (rest) lines.push(rest);
      resolve({ code, lines, stuck });
    };
    child.on("error", (e) => {
      lines.push(e.message);
      done(null);
    });
    child.on("close", (code) => done(code));
  });
}

/**
 * One round of a session: the first, with what it was given (`source`, a
 * repository's files to start from), or the next, with the job's answer. It
 * goes on by itself past its person's Claude plan's limit, saying until when
 * it waits (`paused`). How it ended, and Claude Code's last words.
 */
export async function runRound(b: Round, w: Where, paused: (until: number) => void, source: Buffer | null = null): Promise<RoundOut> {
  if (!w.claude) return { said: "Claude Code (claude) is not installed on this Mac.", how: "error" };
  const root = w.root ?? BUILD_ROOT;
  const folder = folderOf(b, w);
  stopping = false;
  const unready = await prepare(b, folder, root, source);
  if (unready) return { said: `Not begun: ${unready}.`, how: "error" };
  const tools = findTools(w.home);
  const settings = buildSettings(w.home, tools.sdk);
  const env = buildEnv(w.home, folder, tools, process.env);
  let prompt = "start" in b ? FIRST_PROMPT : b.reply;
  let first = "start" in b;
  const since = Date.now();
  for (;;) {
    const ran = await runClaude(w.claude, claudeArgs(prompt, b.session, first, settings), folder, env, w.stuckMs ?? STUCK_MS);
    if (stopping) return { said: "Stopped on the Mac.", how: "stopped" };
    if (ran.stuck) return { said: `It printed nothing for ${Math.round((w.stuckMs ?? STUCK_MS) / 60_000)} minutes, and was stopped.`, how: "stuck" };
    const r = roundEnd(ran.lines, ran.code);
    if (r.how !== "limit") return r;
    const retry = w.retryMs ?? LIMIT_RETRY_MS;
    if (Date.now() + retry - since > (w.limitMs ?? LIMIT_MAX_MS)) return r;
    paused(Date.now() + retry);
    await pause(retry);
    if (stopping) return { said: "Stopped on the Mac.", how: "stopped" };
    // On in the same session, from where the limit stopped it.
    prompt = AGAIN_PROMPT;
    first = false;
  }
}

/** Everything in a folder, as lstat sees it: a link is a link, never what it names. Not into a folder `skip` names. */
async function entriesOf(root: string, skip: (name: string) => boolean, at = ""): Promise<BuildEntry[]> {
  const out: BuildEntry[] = [];
  for (const name of await readdir(join(root, at)).catch(() => [] as string[])) {
    const path = at ? `${at}/${name}` : name;
    const st = await lstat(join(root, path));
    const kind = st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
    out.push({ path, kind, links: st.nlink, size: st.size });
    if (kind === "dir" && !name.startsWith(".") && !skip(name)) out.push(...(await entriesOf(root, skip, path)));
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

/** One zip for what goes back, in `scratch`; or why not. */
async function zipped(root: string, files: string[] | string, name: string, scratch: string): Promise<{ name: string; path: string } | string> {
  if (typeof files === "string") return files;
  const path = join(scratch, name);
  if (!(await zipList(root, files, path))) return "it could not be zipped";
  return (await stat(path)).size > BUILD_FILE_MAX ? `over ${BUILD_FILE_MAX / 1_000_000} MB` : { name, path };
}

/**
 * What a session made, ready to go back: its site, if it made one; what its
 * person installs (its out folder); its source. Each by itself, plain files
 * only; what is too big, or not plain, stays here, and why is said.
 */
export async function collect(b: { folder: string }, w: Where): Promise<Collected> {
  const folder = folderOf(b, w);
  const scratch = await mkdtemp(join(w.temp, "jarvis-build-"));
  const files: Collected["files"] = [];
  const left: Collected["left"] = [];
  const add = (name: string, got: { name: string; path: string } | string) => (typeof got === "string" ? left.push({ name, why: got }) : files.push(got));
  if (!existsSync(folder)) return { files, left: [{ name: "everything", why: "its folder is not on this Mac any more" }], path: folder, scratch };
  const dist = existsSync(join(folder, "dist", "index.html"));
  if (dist || existsSync(join(folder, "index.html"))) {
    const at = dist ? join(folder, "dist") : folder;
    add("site.zip", await zipped(at, pickSite(await entriesOf(at, (n) => NOT_SOURCE.has(n))), "site.zip", scratch));
  }
  const out = pickOut(await entriesOf(join(folder, "out"), () => true));
  left.push(...out.left);
  for (const f of out.send) files.push({ name: `out/${f}`, path: join(folder, "out", f) });
  add("source.zip", await zipped(folder, pickSource(await entriesOf(folder, (n) => NOT_SOURCE.has(n))), "source.zip", scratch));
  // So many go back, the source last of all; the rest stays here.
  const send = files.slice(0, BUILD_MAX_FILES);
  for (const f of files.slice(BUILD_MAX_FILES)) left.push({ name: f.name, why: `more than ${BUILD_MAX_FILES} files` });
  return { files: send, left, path: folder, scratch };
}

/** Its zips gone, once sent. */
export const tidyUp = (c: Collected): Promise<void> => rm(c.scratch, { recursive: true, force: true });
