import { test } from "node:test";
import assert from "node:assert/strict";
import { runCommand, stopCommands } from "../src/run.ts";
import { MAX_TEXT } from "../src/rules.ts";

// A Mac's shell: Windows has no control of the computer, nor zsh (CI builds there too).
const mac = { skip: process.platform !== "darwin" };

test("a command's output, errors and exit code", mac, async () => {
  const r = await runCommand("echo out; echo err >&2; exit 3", 10_000);
  assert.equal(r.code, 3);
  assert.match(r.out, /out/);
  assert.match(r.out, /err/);
  assert.equal(r.timedOut, false);
});

test("it runs in the home folder, with no keyboard", mac, async () => {
  const r = await runCommand('pwd; read -t 1 x && echo "typed: $x" || echo "no input"', 10_000);
  assert.match(r.out, new RegExp(process.env.HOME ?? "/"));
  assert.match(r.out, /no input/);
});

test("out of time, everything it started ends", mac, async () => {
  const started = Date.now();
  const r = await runCommand("sleep 31.5 & sleep 31.5; echo never", 500);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 5_000);
  assert.doesNotMatch(r.out, /never/);
  // The pattern does not match its own command line, so only a sleep left over is found.
  const left = await runCommand("pgrep -f 'sleep 3[1].5' || echo none", 5_000);
  assert.match(left.out, /none/);
});

test("Stop ends what runs", mac, async () => {
  const p = runCommand("sleep 30", 60_000);
  setTimeout(stopCommands, 200);
  const r = await p;
  assert.equal(r.stopped, true);
  assert.equal(r.timedOut, false);
});

test("a flood is cut to its start and its end", mac, async () => {
  const r = await runCommand("seq 1 200000", 20_000);
  assert.ok(r.out.length <= MAX_TEXT + 10, String(r.out.length));
  assert.match(r.out, /^1\n2\n/);
  assert.match(r.out, /200000\n?$/);
  assert.match(r.out, /characters left out/);
});
