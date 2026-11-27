import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { capOutput, MAX_TEXT } from "./rules.ts";

/**
 * A command Jarvis runs on this Mac for its person (src/computer.ts): in their
 * login shell, in their home folder, as them. It has no keyboard (stdin is
 * closed), so nothing can wait to be typed into, a password above all. It runs
 * in its own process group, so a time limit or Stop ends everything it
 * started, unless something detached itself. No Electron here: Node tests it.
 */

export interface Ran {
  /** Its exit code; null when it was ended. */
  code: number | null;
  /** Its output and errors as they came, cut to their start and end. */
  out: string;
  timedOut: boolean;
  stopped: boolean;
}

const running = new Set<ChildProcess>();
const stopped = new WeakSet<ChildProcess>();

function end(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {
    // already gone
  }
}

export function runCommand(command: string, ms: number, shell = "/bin/zsh"): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(shell, ["-lc", command], { cwd: homedir(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    running.add(child);
    // The start, and the latest of what follows: enough to cut from, never all of a flood.
    let head = "";
    let tail = "";
    const take = (b: Buffer) => {
      const s = b.toString("utf8");
      if (head.length < MAX_TEXT) head += s;
      else tail = (tail + s).slice(-MAX_TEXT);
    };
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
      resolve({ code, out: capOutput(head + tail), timedOut, stopped: stopped.has(child) });
    };
    child.on("error", (e) => {
      take(Buffer.from(`${e.message}\n`));
      done(null);
    });
    child.on("close", (code) => done(code));
  });
}

/** Stop: every command Jarvis started here ends now. */
export function stopCommands(): void {
  for (const c of running) {
    stopped.add(c);
    end(c);
  }
}
