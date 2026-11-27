/**
 * Jarvis using this Mac for its person (jarvis-voice-agent docs/DESIGN.md,
 * "The Mac"): a command run in their shell, an app opened, the front window
 * read, a press, typing, keys, scrolling.
 *
 * Off until its person turns on "Let Jarvis control this Mac" in the menu bar.
 * The first time, the page in Jarvis's window, signed in as them, makes this
 * Mac a device of theirs and hands its token over once; it is kept here, in
 * the keychain, never in the page, and this process opens its own socket to
 * Jarvis with it. Requests come on that socket and are answered there, one at
 * a time. While one runs a banner says so on the screen, with a Stop button;
 * the Stop shortcut does the same from anywhere and turns control off. Every
 * request is written to a log here.
 *
 * What it will not do is the app's own rules (rules.ts), checked here and by
 * the helper at the moment it acts: no typing, keys or presses into a
 * terminal, System Settings, a password prompt, a password app or Jarvis
 * itself; never a password field; it opens an app or a web address, never a
 * file. Jarvis decides when it may ask at all.
 */
import { app, BrowserWindow, globalShortcut, ipcMain, Notification, powerMonitor, screen, shell, systemPreferences, type MenuItemConstructorOptions, type WebContents } from "electron";
import { execFile } from "node:child_process";
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { openSecret, sealSecret, type Config } from "./config.ts";
import { Helper } from "./helper.ts";
import { runCommand, stopCommands } from "./run.ts";
import { screenshot } from "./screen.ts";
import { answerOf, backoff, eventsUrl, gotOf, isMacToken, keyCombo, mayOpen, readRequest, REFUSED_APPS, STOP_SHORTCUT, type ComputerRequest } from "./rules.ts";

const exec = promisify(execFile);

export interface ComputerDeps {
  config(): Config | null;
  save(c: Config): void;
  /** The page in Jarvis's window, signed in as its person: only it may link this Mac. */
  page(): WebContents | null;
  /** The Cloudflare Access service token, when one is set. */
  access(): { id: string; secret: string } | null;
  /** The tray's menu again, and its icon's mark while Jarvis works here. */
  refresh(): void;
  working(on: boolean): void;
}

type Status = "off" | "linking" | "connecting" | "on";

/** How long the page has to link this Mac, and what is kept of the log. */
const LINK_MS = 30_000;
const LOG_LINES = 500;
/** Time kept back from what Jarvis gives a command, for the answer to travel. */
const MARGIN_MS = 3_000;

let deps: ComputerDeps;
let helper: Helper;
let status: Status = "off";
let socket: WebSocket | null = null;
let attempt = 0;
let retry: NodeJS.Timeout | undefined;
let ping: NodeJS.Timeout | undefined;
let linking: NodeJS.Timeout | undefined;
let busy = false;
let banner: BrowserWindow | null = null;
let bannerTimer: NodeJS.Timeout | undefined;

const logFile = () => join(app.getPath("userData"), "computer.log");

function note(text: string): void {
  if (Notification.isSupported()) new Notification({ title: "Jarvis", body: text }).show();
}

function set(s: Status): void {
  status = s;
  deps.refresh();
}

/** One line a request: when, what, and how it went. */
function log(r: ComputerRequest, ok: boolean, said: string): void {
  const what = r.op === "do" ? `${r.act}${r.element ? ` ${r.element}` : ""}${r.text && r.act !== "type" ? ` ${r.text}` : r.act === "type" ? ` (${r.text?.length ?? 0} characters)` : ""}` : r.op === "run" ? `run ${r.text}` : `look${r.picture ? " with a screenshot" : ""}`;
  const line = `${new Date().toISOString()} ${ok ? "ok " : "no "} ${what.replace(/\s+/g, " ").slice(0, 300)}${ok ? "" : ` (${said.replace(/\s+/g, " ").slice(0, 120)})`}\n`;
  try {
    appendFileSync(logFile(), line, { mode: 0o600 });
    if (statSync(logFile()).size > 200_000) writeFileSync(logFile(), `${readFileSync(logFile(), "utf8").split("\n").slice(-LOG_LINES).join("\n")}`);
  } catch {
    // a log that cannot be written stops nothing
  }
}

export function initComputer(d: ComputerDeps): void {
  deps = d;
  helper = new Helper(app.isPackaged ? join(process.resourcesPath, "jarvis-control") : join(app.getAppPath(), "build", "native", "jarvis-control"));
  ipcMain.on("jd:computerLinked", (e, r: { token?: unknown; error?: unknown }) => linked(e.sender, r));
  ipcMain.on("jd:computerStop", (e) => {
    if (banner && e.sender === banner.webContents) stop();
  });
  powerMonitor.on("resume", reconnectNow);
  powerMonitor.on("unlock-screen", reconnectNow);
  if (deps.config()?.computerOn) turnOn();
}

/** The address changed: a token is only for the Jarvis that made it (main.ts drops it), so control is off. */
export function addressChanged(): void {
  close();
  set("off");
}

/** The tray's part: the switch, and while it is on, what macOS allows it and the log. */
export function computerMenu(): MenuItemConstructorOptions[] {
  if (!deps) return [];
  const on = !!deps.config()?.computerOn;
  const said = { off: "", linking: " (linking…)", connecting: " (connecting…)", on: "" }[status];
  const items: MenuItemConstructorOptions[] = [
    { label: `Let Jarvis control this Mac${said}`, type: "checkbox", checked: on || status === "linking", click: (i) => (i.checked ? turnOn(true) : turnOff()) },
  ];
  if (!on) return items;
  const ax = systemPreferences.isTrustedAccessibilityClient(false);
  const rec = systemPreferences.getMediaAccessStatus("screen") === "granted";
  items.push(
    { label: ax ? "Using apps: allowed" : "Allow Jarvis to use apps…", enabled: !ax, click: () => void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") },
    { label: rec ? "Screenshots: allowed" : "Allow Jarvis to take screenshots…", enabled: !rec, click: () => void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") },
    { label: "What Jarvis Did on This Mac…", click: () => void shell.openPath(logFile()) },
  );
  return items;
}

/** `asked`: by its person, just now, so macOS may ask them whether Jarvis may use other apps. */
function turnOn(asked = false): void {
  const c = deps.config();
  if (!c) return;
  if (c.computer && openSecret(c.computer)) {
    if (!c.computerOn) deps.save({ ...c, computerOn: true });
    // Until it is allowed, Jarvis reads and presses nothing here (the helper says so).
    if (asked) systemPreferences.isTrustedAccessibilityClient(true);
    globalShortcut.register(STOP_SHORTCUT, () => stop());
    return connect();
  }
  const page = deps.page();
  if (!page) {
    note("Open Jarvis and sign in first, then turn this on.");
    return deps.refresh();
  }
  set("linking");
  void exec("/usr/sbin/scutil", ["--get", "ComputerName"])
    .then((r) => r.stdout.trim())
    .catch(() => "Mac")
    .then((name) => page.send("jd:linkComputer", name || "Mac"));
  clearTimeout(linking);
  linking = setTimeout(() => {
    if (status !== "linking") return;
    set("off");
    note("Jarvis did not answer. Open it and sign in; this needs a Jarvis recent enough to use a Mac.");
  }, LINK_MS);
}

/** The page's answer: this Mac's token, or why not. Only from Jarvis's window, only while it was asked. */
function linked(sender: WebContents, r: { token?: unknown; error?: unknown }): void {
  if (status !== "linking" || sender !== deps.page()) return;
  clearTimeout(linking);
  const c = deps.config();
  if (!c || !isMacToken(r?.token)) {
    set("off");
    return note(typeof r?.error === "string" && r.error ? r.error.slice(0, 200) : "Jarvis did not link this Mac.");
  }
  try {
    deps.save({ ...c, computer: sealSecret(r.token), computerOn: true });
  } catch (e) {
    set("off");
    return note(e instanceof Error ? e.message : String(e));
  }
  turnOn(true);
}

function turnOff(): void {
  const c = deps.config();
  if (c?.computerOn) deps.save({ ...c, computerOn: false });
  close();
  set("off");
}

/** Stop, from the banner or the shortcut: what runs ends, and control is off until turned on again. */
function stop(): void {
  stopCommands();
  helper.restart();
  turnOff();
  note("Stopped. Jarvis can't use this Mac until you turn it on again in the menu bar.");
}

function close(): void {
  clearTimeout(retry);
  clearInterval(ping);
  globalShortcut.unregister(STOP_SHORTCUT);
  const s = socket;
  socket = null;
  s?.close();
}

function reconnectNow(): void {
  if (!deps.config()?.computerOn || status === "on") return;
  attempt = 0;
  connect();
}

function connect(): void {
  clearTimeout(retry);
  clearInterval(ping);
  const old = socket;
  socket = null;
  old?.close();
  const c = deps.config();
  const token = c?.computer ? openSecret(c.computer) : "";
  if (!c?.computerOn || !token) return set("off");
  set("connecting");
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const a = deps.access();
  if (a) Object.assign(headers, { "CF-Access-Client-Id": a.id, "CF-Access-Client-Secret": a.secret });
  // Node's own WebSocket takes headers (undici), so the token never goes in the address.
  const ws = new WebSocket(eventsUrl(c.origin), { headers } as unknown as string[]);
  socket = ws;
  ws.onopen = () => {
    attempt = 0;
    set("on");
  };
  ws.onmessage = (e) => {
    if (typeof e.data === "string") void take(ws, e.data);
  };
  ws.onclose = (e) => {
    if (socket !== ws) return;
    socket = null;
    clearInterval(ping);
    // 4001: this Mac's device was revoked in Jarvis.
    if (e.code === 4001) {
      const now = deps.config();
      if (now) deps.save({ ...now, computer: "", computerOn: false });
      close();
      set("off");
      return note("This Mac was unlinked in Jarvis. Turn control on again to link it anew.");
    }
    if (!deps.config()?.computerOn) return set("off");
    set("connecting");
    retry = setTimeout(connect, backoff(attempt++));
  };
  ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send("ping");
  }, 25_000);
}

/** One message from Jarvis: only a request for this Mac is ours (alerts and the rest go by). */
async function take(ws: WebSocket, raw: string): Promise<void> {
  if (!raw.startsWith('{"type":"computer.do"')) return;
  const r = readRequest(raw);
  if (!r) return;
  ws.send(gotOf(r.id));
  if (busy) return ws.send(answerOf(r.id, false, "This Mac is busy with something else Jarvis asked: try again in a moment."));
  busy = true;
  working(true);
  let out: { ok: boolean; text: string; image?: string | null };
  try {
    out = await handle(r);
  } catch (e) {
    out = { ok: false, text: e instanceof Error ? e.message : String(e) };
  }
  log(r, out.ok, out.text);
  busy = false;
  working(false);
  if (ws.readyState === WebSocket.OPEN) ws.send(answerOf(r.id, out.ok, out.text, out.image ?? null));
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Which app is in front, and nothing more: what an act says back. */
async function front(ok: boolean, why?: string): Promise<{ ok: boolean; text: string }> {
  if (!ok) return { ok, text: why ?? "It did not work." };
  await pause(400);
  const f = await helper.ask("front");
  return { ok, text: f.ok && f.app ? `${f.app} is in front.` : "Done." };
}

async function handle(r: ComputerRequest): Promise<{ ok: boolean; text: string; image?: string | null }> {
  if (r.op === "run") {
    const ms = Math.max(1000, r.ms - MARGIN_MS);
    const ran = await runCommand(r.text ?? "", ms);
    const how = ran.stopped ? "Stopped on the Mac." : ran.timedOut ? `Out of time after ${Math.round(ms / 1000)} s; what it started was ended.` : `Exit code ${ran.code}.`;
    return { ok: ran.code === 0, text: `${how}\n${ran.out}` };
  }
  if (r.op === "look") {
    const read = await helper.ask("read", { max: 6000 });
    if (!read.ok) return { ok: false, text: read.text ?? "The screen could not be read." };
    const image = r.picture ? await screenshot() : null;
    const missing = r.picture && !image ? "\n(No screenshot: Jarvis is not allowed Screen Recording on this Mac.)" : "";
    return { ok: true, text: `${read.text ?? ""}${missing}`, image };
  }
  const deny = REFUSED_APPS;
  switch (r.act) {
    case "open": {
      const o = r.text ? mayOpen(r.text) : null;
      if (!o) return { ok: false, text: "Only an app, by its name, or a web address is opened: never a file." };
      if ("url" in o) {
        await shell.openExternal(o.url);
        return front(true);
      }
      const opened = await exec("/usr/bin/open", ["-a", o.app]).then(() => true, () => false);
      return front(opened, `No app called ${o.app} on this Mac.`);
    }
    case "press": {
      const a = await helper.ask("press", { n: r.element, deny });
      return front(a.ok, a.text);
    }
    case "type": {
      const a = await helper.ask("type", { text: r.text ?? "", deny });
      return front(a.ok, a.text);
    }
    case "key": {
      const k = r.text ? keyCombo(r.text) : null;
      if (!k) return { ok: false, text: "Not a key this Mac knows (like cmd+t), or it is the Stop shortcut." };
      const a = await helper.ask("key", { key: k.key, mods: k.mods, deny });
      return front(a.ok, a.text);
    }
    case "scroll": {
      const a = await helper.ask("scroll", { n: r.element, dir: r.text === "up" ? "up" : "down" });
      return front(a.ok, a.text);
    }
    default:
      return { ok: false, text: "Nothing to do." };
  }
}

/** The banner while Jarvis works here, left out of screenshots, with Stop; and the tray icon's mark. */
function working(on: boolean): void {
  deps.working(on);
  clearTimeout(bannerTimer);
  if (!on) {
    bannerTimer = setTimeout(() => banner?.hide(), 1500);
    return;
  }
  if (!banner || banner.isDestroyed()) banner = makeBanner();
  banner.showInactive();
}

function makeBanner(): BrowserWindow {
  const area = screen.getPrimaryDisplay().workArea;
  const width = 380;
  const w = new BrowserWindow({
    width,
    height: 44,
    x: Math.round(area.x + (area.width - width) / 2),
    y: area.y + 8,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: true,
    roundedCorners: true,
    webPreferences: { preload: join(__dirname, "banner-preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  w.setAlwaysOnTop(true, "screen-saver");
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  w.setContentProtection(true);
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  w.webContents.on("will-navigate", (e) => e.preventDefault());
  void w.loadFile(join(app.getAppPath(), "setup", "banner.html"));
  return w;
}
