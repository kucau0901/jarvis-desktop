import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

/**
 * The Swift helper (native/jarvis-control.swift), kept running while Jarvis may
 * use this Mac: it remembers the elements of the last look, so "press 3" is the
 * third of those. One JSON line out, one back, in order; started again if it
 * ends. Mac only.
 */

export type HelperAnswer = { ok: boolean; text?: string; app?: string; bundle?: string };

const WAIT_MS = 15_000;

export class Helper {
  private child: ChildProcessWithoutNullStreams | null = null;
  private next = 1;
  private waiting = new Map<number, (a: HelperAnswer) => void>();
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** Whether it was built into this app (scripts/native.mjs). */
  get present(): boolean {
    return existsSync(this.path);
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const c = spawn(this.path, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = c;
    createInterface({ input: c.stdout }).on("line", (line) => {
      try {
        const a = JSON.parse(line) as HelperAnswer & { id?: number };
        if (typeof a.id === "number") this.waiting.get(a.id)?.(a);
      } catch {
        // not one of its answers
      }
    });
    c.on("exit", () => {
      if (this.child === c) this.child = null;
      for (const [id, done] of this.waiting) {
        this.waiting.delete(id);
        done({ ok: false, text: "The helper stopped." });
      }
    });
    c.on("error", () => c.kill());
    return c;
  }

  ask(cmd: string, args: Record<string, unknown> = {}): Promise<HelperAnswer> {
    if (!this.present) return Promise.resolve({ ok: false, text: "This app was built without its Mac helper." });
    const id = this.next++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve({ ok: false, text: "The Mac did not answer in time." });
      }, WAIT_MS);
      this.waiting.set(id, (a) => {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve(a);
      });
      this.start().stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
  }

  /** Stop: whatever it is doing ends, and the next request starts it afresh. */
  restart(): void {
    this.child?.kill("SIGKILL");
    this.child = null;
  }
}
