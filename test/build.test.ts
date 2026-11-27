import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuild, stopBuilds } from "../src/build.ts";

// A build for Claude Code (src/build.ts), with a stand-in for `claude`: a script that does what each test needs.
// A Mac's tools (zip, zsh's process groups): Windows has no builds (CI builds there too).
const mac = { skip: process.platform !== "darwin" };

const req = (ms = 20_000) => ({ id: "jabc12345.0123456789abcdef", task: "Build a page for a bakery.", notes: "Open 8 to 5.", name: "Bakery site", ms });

/** A home folder, a temp folder, and a fake `claude` running `script` in the build's folder. */
function setup(script: string) {
  const root = mkdtempSync(join(tmpdir(), "jd-build-"));
  const home = join(root, "home");
  const temp = join(root, "temp");
  mkdirSync(home);
  mkdirSync(temp);
  const claude = join(root, "claude");
  writeFileSync(claude, `#!/bin/sh\n${script}\n`);
  chmodSync(claude, 0o755);
  return { root, home, temp, claude, done: () => rmSync(root, { recursive: true, force: true }) };
}
const entries = (zip: Buffer, root: string): string[] => {
  const f = join(root, "out.zip");
  writeFileSync(f, zip);
  return execFileSync("/usr/bin/zipinfo", ["-1", f]).toString().trim().split("\n").sort();
};
const inZip = (zip: Buffer, root: string, name: string): string => {
  const f = join(root, "out.zip");
  writeFileSync(f, zip);
  return execFileSync("/usr/bin/unzip", ["-p", f, name]).toString();
};

test("it runs in a folder of its own, outside home, with what it was given and a clean environment", mac, async () => {
  const s = setup('printf "%s|%s|%s|%s" "$(pwd)" "${SECRET_TOKEN:-none}" "$(cat INSTRUCTION.md)" "$(cat .claude/settings.json | tr -d "\\n ")" > index.html; echo "Built it."');
  process.env.SECRET_TOKEN = "s3cret";
  try {
    const r = await runBuild(req(), { claude: s.claude, temp: s.temp, home: s.home });
    assert.equal(r.ok, true, r.said);
    assert.equal(r.said, "Built it.");
    const [cwd, secret, task, settings] = inZip(r.zip!, s.root, "index.html").split("|");
    assert.match(cwd!, /jarvis-builds\/jabc12345\.0123456789abcdef$/);
    assert.ok(!cwd!.startsWith(s.home));
    assert.equal(secret, "none");
    assert.equal(task, "Build a page for a bakery.");
    assert.match(settings!, /"denyRead":\["[^"]*home"\]/);
    // Gone afterwards.
    assert.deepEqual(readdirSync(join(s.temp, "jarvis-builds")), []);
  } finally {
    delete process.env.SECRET_TOKEN;
    s.done();
  }
});

test("only its plain files go back: never a link, or a hard link, to a file elsewhere", mac, async () => {
  const s = setup("");
  const secret = join(s.root, "secret.txt");
  writeFileSync(secret, "the owner's secret");
  writeFileSync(s.claude, `#!/bin/sh\necho hi > index.html\nmkdir css && echo a > css/site.css\nln -s "${secret}" leak.txt\nln "${secret}" hard.txt\necho x > .env\nmkdir node_modules && echo y > node_modules/z.js\n`);
  try {
    const r = await runBuild(req(), { claude: s.claude, temp: s.temp, home: s.home });
    assert.equal(r.ok, true, r.said);
    assert.deepEqual(entries(r.zip!, s.root), ["css/site.css", "index.html"]);
  } finally {
    s.done();
  }
});

test("a dist folder, where it made one, is the site", mac, async () => {
  const s = setup("mkdir dist && echo built > dist/index.html && echo src > index.html");
  try {
    const r = await runBuild(req(), { claude: s.claude, temp: s.temp, home: s.home });
    assert.deepEqual(entries(r.zip!, s.root), ["index.html"]);
    assert.equal(inZip(r.zip!, s.root, "index.html").trim(), "built");
  } finally {
    s.done();
  }
});

test("not built: not installed, failed, no index.html, out of time, stopped", mac, async () => {
  const none = await runBuild(req(), { claude: null, temp: tmpdir(), home: tmpdir() });
  assert.equal(none.ok, false);
  assert.match(none.said, /not installed/);

  const failed = setup("echo broke >&2; exit 4");
  try {
    const r = await runBuild(req(), { claude: failed.claude, temp: failed.temp, home: failed.home });
    assert.equal(r.ok, false);
    assert.match(r.said, /exit 4/);
    assert.match(r.said, /broke/);
  } finally {
    failed.done();
  }

  const empty = setup("echo hi > about.html");
  try {
    const r = await runBuild(req(), { claude: empty.claude, temp: empty.temp, home: empty.home });
    assert.equal(r.ok, false);
    assert.match(r.said, /no index\.html/);
  } finally {
    empty.done();
  }

  const slow = setup("sleep 31.7 & sleep 31.7");
  try {
    const started = Date.now();
    const r = await runBuild(req(600), { claude: slow.claude, temp: slow.temp, home: slow.home });
    assert.equal(r.ok, false);
    assert.match(r.said, /Out of time/);
    assert.ok(Date.now() - started < 5_000);
    // Everything it started ended with it: pgrep finds none (and says so with 1).
    assert.equal(spawnSync("/usr/bin/pgrep", ["-f", "sleep 31[.]7"]).status, 1);
  } finally {
    slow.done();
  }

  const stopped = setup("sleep 31.8");
  try {
    const running = runBuild(req(), { claude: stopped.claude, temp: stopped.temp, home: stopped.home });
    setTimeout(stopBuilds, 300);
    const r = await running;
    assert.equal(r.ok, false);
    assert.match(r.said, /Stopped on the Mac/);
    assert.ok(!existsSync(join(stopped.temp, "jarvis-builds", "jabc12345.0123456789abcdef")));
  } finally {
    stopped.done();
  }
});
