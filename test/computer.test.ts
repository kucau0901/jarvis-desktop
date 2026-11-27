import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answerOf,
  backoff,
  capOutput,
  eventsUrl,
  gotOf,
  isMacToken,
  keyCombo,
  MAX_ANSWER,
  MAX_TEXT,
  mayOpen,
  readRequest,
  refusesInput,
} from "../src/rules.ts";

const req = (more: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "computer.do", id: "a1b2-c3", op: "look", act: null, element: null, text: null, picture: false, ms: 15_000, ...more });

test("a request as Jarvis sends it is read", () => {
  assert.deepEqual(readRequest(req()), { id: "a1b2-c3", op: "look", act: null, element: null, text: null, picture: false, ms: 15_000 });
  assert.equal(readRequest(req({ op: "run", text: "df -h", ms: 120_000 }))?.text, "df -h");
  assert.equal(readRequest(req({ op: "do", act: "press", element: 3 }))?.element, 3);
});

test("anything else is not done", () => {
  for (const bad of [
    "not json",
    JSON.stringify({ type: "alert", id: "x" }),
    req({ id: "has spaces" }),
    req({ op: "delete" }),
    req({ op: "do" }),
    req({ op: "do", act: "drag" }),
    req({ element: 0 }),
    req({ element: 2.5 }),
    req({ text: 42 }),
    req({ text: "x".repeat(10_001) }),
    req({ picture: "yes" }),
    req({ ms: 999_999 }),
    req({ ms: 10 }),
  ]) {
    assert.equal(readRequest(bad), null, bad.slice(0, 80));
  }
});

test("open: an app by its name or a web address, never a file or another kind of link", () => {
  assert.deepEqual(mayOpen("Spotify"), { app: "Spotify" });
  assert.deepEqual(mayOpen(" Visual Studio Code "), { app: "Visual Studio Code" });
  assert.deepEqual(mayOpen("https://example.com/a?b=1"), { url: "https://example.com/a?b=1" });
  for (const bad of [
    "/Applications/Calculator.app",
    "~/Downloads/run.command",
    "../evil",
    "file:///etc/passwd",
    "shortcuts://run-shortcut?name=x",
    "x-apple.systempreferences:com.apple.preference.security",
    "ssh://host",
    "https://user:pass@example.com",
    "",
    "-a Terminal",
  ]) {
    assert.equal(mayOpen(bad), null, bad);
  }
});

test("never typed or pressed into: terminals, System Settings, password prompts and apps, Jarvis itself", () => {
  for (const b of ["com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable", "com.apple.systempreferences", "com.apple.SecurityAgent", "com.apple.Passwords", "app.jarvis.desktop", "com.apple.ScriptEditor2"]) {
    assert.equal(refusesInput(b), true, b);
  }
  for (const b of ["com.apple.Safari", "com.spotify.client", "com.apple.finder", "com.apple.TextEdit"]) assert.equal(refusesInput(b), false, b);
});

test("a key combo, as Jarvis writes it", () => {
  assert.deepEqual(keyCombo("cmd+t"), { key: "t", mods: ["cmd"] });
  assert.deepEqual(keyCombo("Command + Shift + T"), { key: "t", mods: ["cmd", "shift"] });
  assert.deepEqual(keyCombo("enter"), { key: "return", mods: [] });
  assert.deepEqual(keyCombo("option+left"), { key: "left", mods: ["alt"] });
  assert.equal(keyCombo("cmd+banana"), null);
  assert.equal(keyCombo("hyper+t"), null);
  // The Stop shortcut is the person's, never Jarvis's.
  assert.equal(keyCombo("cmd+shift+escape"), null);
  assert.equal(keyCombo("shift+cmd+esc"), null);
});

test("output is cut to its start and its end", () => {
  assert.equal(capOutput("short"), "short");
  const long = `${"a".repeat(30_000)}${"z".repeat(30_000)}`;
  const cut = capOutput(long);
  assert.ok(cut.length <= MAX_TEXT + 60);
  assert.ok(cut.startsWith("aaaa") && cut.endsWith("zzzz"));
  assert.match(cut, /characters left out/);
});

test("answers are what Jarvis takes: their type first, and within its size", () => {
  assert.ok(gotOf("r1").startsWith('{"type":"computer.got"'));
  const a = answerOf("r1", true, "Finder is in front.");
  assert.ok(a.startsWith('{"type":"computer.answer"'));
  assert.deepEqual(JSON.parse(a), { type: "computer.answer", id: "r1", ok: true, text: "Finder is in front.", image: null });
  const big = answerOf("r2", true, "look", `data:image/jpeg;base64,${"A".repeat(MAX_ANSWER)}`);
  assert.ok(big.length <= MAX_ANSWER);
  assert.equal(JSON.parse(big).image, null);
  assert.match(JSON.parse(big).text, /too big/);
});

test("connecting again: doubling from a second, a minute at most", () => {
  assert.deepEqual([0, 1, 2, 3, 10, -1].map(backoff), [1000, 2000, 4000, 8000, 60_000, 1000]);
});

test("a Mac's token, and the socket it opens", () => {
  assert.equal(isMacToken(`jdv1_${"a".repeat(32)}`), true);
  assert.equal(isMacToken(`jdv1_${"l".repeat(32)}`), false);
  assert.equal(isMacToken("jss1_x"), false);
  assert.equal(isMacToken(null), false);
  assert.equal(eventsUrl("https://jarvis.example.com"), "wss://jarvis.example.com/api/v1/events");
  assert.equal(eventsUrl("http://localhost:8787"), "ws://localhost:8787/api/v1/events");
});
