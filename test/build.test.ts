import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, runRound, stopBuilds, tidyUp } from "../src/build.ts";

// A Claude Code session (src/build.ts), with a stand-in for `claude`: a script that does what each test needs, and keeps
// its arguments. A Mac's tools (zip, tar, process groups): Windows has no builds (CI builds there too).
const mac = { skip: process.platform !== "darwin" };

const SESSION = "11111111-2222-4333-8444-555555555555";
const base = { id: "jabc12345.0123456789abcdef", folder: "bakery-site-abc123", session: SESSION, name: "Bakery site" };
const start = (repo = false) => ({ ...base, start: { task: "Build a page for a bakery.", notes: "Open 8 to 5.", repo } });
const result = (text: string, error = false) => JSON.stringify({ type: "result", subtype: error ? "error" : "success", is_error: error, result: text });

/** A home folder, a temp folder, a root for build folders, and a fake `claude` running `script` in the build's folder. */
function setup(script: string) {
  const root = mkdtempSync(join(tmpdir(), "jd-build-"));
  const home = join(root, "home");
  const temp = join(root, "temp");
  const builds = join(root, "builds");
  mkdirSync(home);
  mkdirSync(temp);
  const claude = join(root, "claude");
  writeFileSync(claude, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${join(root, "args")}"\necho --- >> "${join(root, "args")}"\n${script}\n`);
  chmodSync(claude, 0o755);
  const where = { claude, home, temp, root: builds };
  const args = () => (existsSync(join(root, "args")) ? readFileSync(join(root, "args"), "utf8").split("---\n").filter(Boolean).map((a) => a.trim().split("\n")) : []);
  return { root, home, temp, builds, claude, where, args, folder: join(builds, base.folder), done: () => rmSync(root, { recursive: true, force: true }) };
}
const entries = (zip: string): string[] => execFileSync("/usr/bin/zipinfo", ["-1", zip]).toString().trim().split("\n").sort();

test("a first round: in its folder outside home, with what it was given, a clean environment, and its session begun", mac, async () => {
  const s = setup(`printf "%s|%s" "$(pwd)" "\${SECRET_TOKEN:-none}" > where.txt; echo '${result("Which colour?")}'`);
  process.env.SECRET_TOKEN = "s3cret";
  try {
    const r = await runRound(start(), s.where, () => {});
    assert.deepEqual(r, { said: "Which colour?", how: "turn" });
    const [cwd, secret] = readFileSync(join(s.folder, "where.txt"), "utf8").split("|");
    assert.equal(cwd, realpathSync(s.folder));
    assert.ok(!cwd!.startsWith(s.home));
    assert.equal(secret, "none");
    assert.equal(readFileSync(join(s.folder, "INSTRUCTION.md"), "utf8").trim(), "Build a page for a bakery.");
    assert.equal(readFileSync(join(s.folder, "RESEARCH.md"), "utf8").trim(), "Open 8 to 5.");
    const a = s.args()[0]!;
    assert.deepEqual(a.slice(2, 4), ["--session-id", SESSION]);
    assert.match(a[a.indexOf("--settings") + 1]!, /"denyRead":\["[^"]*home"\]/);
  } finally {
    delete process.env.SECRET_TOKEN;
    s.done();
  }
});

test("the next round goes on in the same folder and session, with the job's answer; one whose folder is gone does not", mac, async () => {
  const s = setup(`echo '${result("Done. DONE")}'`);
  try {
    await runRound(start(), s.where, () => {});
    writeFileSync(join(s.folder, "kept.txt"), "earlier work");
    const r = await runRound({ ...base, round: 2, reply: "Cream buttons." }, s.where, () => {});
    assert.equal(r.how, "turn");
    const a = s.args()[1]!;
    assert.deepEqual(a.slice(0, 4), ["-p", "Cream buttons.", "-r", SESSION]);
    assert.equal(readFileSync(join(s.folder, "kept.txt"), "utf8"), "earlier work");
    const gone = await runRound({ ...base, folder: "not-there", round: 2, reply: "x" }, s.where, () => {});
    assert.equal(gone.how, "error");
    assert.match(gone.said, /not on this Mac any more/);
  } finally {
    s.done();
  }
});

test("at its person's Claude plan's limit, it waits, says until when, and goes on in the same session", mac, async () => {
  // Limited once, then not.
  const s = setup(`if [ -f limited ]; then echo '${result("Built it. DONE")}'; else touch limited; echo '${result("You have hit your session limit · resets 3pm", true)}'; exit 1; fi`);
  try {
    const paused: number[] = [];
    const r = await runRound(start(), { ...s.where, retryMs: 200 }, (until) => paused.push(until));
    assert.deepEqual(r, { said: "Built it. DONE", how: "turn" });
    assert.equal(paused.length, 1);
    assert.deepEqual(s.args()[1]!.slice(0, 4), ["-p", "Continue where you stopped.", "-r", SESSION]);
    // For no longer than its day.
    const t = setup(`echo '${result("You have hit your weekly limit", true)}'; exit 1`);
    try {
      const long = await runRound(start(), { ...t.where, retryMs: 200, limitMs: 300 }, () => {});
      assert.equal(long.how, "limit");
    } finally {
      t.done();
    }
  } finally {
    s.done();
  }
});

test("not begun, failed, stuck, stopped: said so; nothing it started outlives it", mac, async () => {
  const none = await runRound(start(), { claude: null, home: tmpdir(), temp: tmpdir() }, () => {});
  assert.equal(none.how, "error");
  assert.match(none.said, /not installed/);

  const failed = setup("echo broke >&2; exit 4");
  try {
    const r = await runRound(start(), failed.where, () => {});
    assert.equal(r.how, "error");
    assert.match(r.said, /broke/);
  } finally {
    failed.done();
  }

  const slow = setup("sleep 31.7 & sleep 31.7");
  try {
    const began = Date.now();
    const r = await runRound(start(), { ...slow.where, stuckMs: 600 }, () => {});
    assert.equal(r.how, "stuck");
    assert.ok(Date.now() - began < 5_000);
    // Everything it started ended with it: pgrep finds none (and says so with 1).
    assert.equal(spawnSync("/usr/bin/pgrep", ["-f", "sleep 31[.]7"]).status, 1);
  } finally {
    slow.done();
  }

  const stopped = setup("sleep 31.8");
  try {
    const running = runRound(start(), stopped.where, () => {});
    setTimeout(stopBuilds, 300);
    const r = await running;
    assert.equal(r.how, "stopped");
    // Its folder stays.
    assert.ok(existsSync(stopped.folder));
  } finally {
    stopped.done();
  }
});

test("on a repository, it begins from its files", mac, async () => {
  const s = setup(`echo '${result("ok")}'`);
  try {
    const src = join(s.root, "src", "ana-site-abc123");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "README.md"), "the repo");
    const tgz = execFileSync("/usr/bin/tar", ["-czf", "-", "-C", join(s.root, "src"), "ana-site-abc123"]);
    await runRound(start(true), s.where, () => {}, tgz);
    assert.equal(readFileSync(join(s.folder, "README.md"), "utf8"), "the repo");
  } finally {
    s.done();
  }
});

test("what goes back: the site, what its person installs, the source; plain files only; what is too big stays, and why", mac, async () => {
  const s = setup("");
  const secret = join(s.root, "secret.txt");
  writeFileSync(secret, "the owner's secret");
  writeFileSync(
    s.claude,
    `#!/bin/sh\nmkdir -p dist css out node_modules app/src && echo built > dist/index.html && echo src > index.html && echo a > css/site.css\n` +
      `echo apk > out/bakery.apk && ln -s "${secret}" out/leak.apk && ln -s "${secret}" leak.txt && ln "${secret}" hard.txt && echo x > .env && echo y > node_modules/z.js && echo k > app/src/Main.kt\n` +
      `echo '${result("DONE")}'\n`,
  );
  try {
    await runRound(start(), s.where, () => {});
    const c = await collect(base, s.where);
    assert.deepEqual(c.files.map((f) => f.name), ["site.zip", "out/bakery.apk", "source.zip"]);
    assert.deepEqual(entries(c.files[0]!.path), ["index.html"]);
    assert.equal(execFileSync("/usr/bin/unzip", ["-p", c.files[0]!.path, "index.html"]).toString().trim(), "built");
    assert.deepEqual(entries(c.files[2]!.path), ["app/src/Main.kt", "css/site.css", "index.html"]);
    assert.deepEqual(c.left, [{ name: "out/leak.apk", why: "not a plain file with a plain name" }]);
    assert.equal(c.path, s.folder);
    await tidyUp(c);
    assert.ok(!existsSync(c.scratch));
    // The folder stays, for its person and a later job.
    assert.ok(existsSync(join(s.folder, "app", "src", "Main.kt")));
  } finally {
    s.done();
  }
});
