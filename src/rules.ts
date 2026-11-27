/**
 * The decisions the app makes, as plain functions with no Electron in them,
 * so Node can test them (test/rules.test.ts).
 */

/** Hosts a plain-http Jarvis may be on: this computer only. Anywhere else needs https. */
function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
}

/**
 * The origin of the Jarvis address someone typed, or why it is not one.
 * "jarvis.example.com" means https; a path after it is dropped, since the app
 * always lives at the root of its address.
 */
export function normalizeAddress(input: string): { origin: string } | { error: string } {
  const typed = input.trim();
  if (!typed) return { error: "Type your Jarvis address." };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`);
    // Typed without a scheme, a Jarvis on this computer is plain http.
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) && isLocalHost(url.hostname)) url = new URL(`http://${typed}`);
  } catch {
    return { error: "That is not a web address." };
  }
  if (url.protocol === "http:" && !isLocalHost(url.hostname)) {
    return { error: "Use https: plain http is only for a Jarvis on this computer." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { error: "Use an https address." };
  if (url.username || url.password) return { error: "Leave the name and password out of the address." };
  return { origin: url.origin };
}

/** Same origin as Jarvis, compared by the parsed origin, never by text. */
export function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

export type Opening = "window" | "blank" | "external" | "deny";

/**
 * What to do with a window the page opens: Jarvis's own pages open in a
 * window of the app; `about:blank` too, since the page fills it in after
 * (src/app/pageCard.ts in Jarvis), and is followed from there; any other web
 * address goes to the system browser, where the person's own sign-ins are
 * (Google, Spotify, ChatGPT). Anything else is refused.
 */
export function windowOpening(url: string, origin: string): Opening {
  if (url === "about:blank" || url === "") return "blank";
  if (sameOrigin(url, origin)) return "window";
  return isWeb(url) ? "external" : "deny";
}

/**
 * Whether the window may go to `url` itself. On Jarvis it stays on Jarvis:
 * a link elsewhere goes to the system browser. Off Jarvis (a Cloudflare
 * Access sign-in in front of it) the sign-in may go where it needs to and
 * come back.
 */
export function navigation(url: string, current: string, origin: string): "stay" | "external" | "deny" {
  if (sameOrigin(url, origin)) return "stay";
  if (!isWeb(url)) return "deny";
  if (current && !sameOrigin(current, origin) && isWeb(current)) return "stay";
  return "external";
}

export function isWeb(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** The permissions a page of Jarvis's may have; everything else is refused. */
const ALLOWED = new Set(["media", "notifications", "fullscreen", "clipboard-sanitized-write", "speaker-selection"]);

export function permissionAllowed(permission: string, requestingUrl: string, origin: string): boolean {
  return ALLOWED.has(permission) && sameOrigin(requestingUrl, origin);
}

/** As many files as Jarvis's share target takes, and as large (public/sw.js in Jarvis). */
export const MAX_SHARED = 4;
export const MAX_SHARED_BYTES = 25 * 1024 * 1024;

/** File paths in a command line: Windows passes files dropped on the app's icon this way. */
export function filesInArgs(argv: readonly string[], isFile: (p: string) => boolean): string[] {
  // argv[0] is the app; when run from source, argv[1] is the source folder.
  return argv.slice(1).filter((a) => !a.startsWith("-") && isFile(a));
}

export interface SharedFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}

/** A content type for a file by its name, for what the share target accepts; otherwise none. */
export function typeOf(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const types: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    heic: "image/heic",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    tsv: "text/tab-separated-values",
    json: "application/json",
    log: "text/plain",
    xml: "application/xml",
    yaml: "application/yaml",
    yml: "application/yaml",
  };
  return types[ext] ?? "application/octet-stream";
}

/**
 * The body of a share, as a phone's share sheet would post it to Jarvis's
 * `/share` (its manifest's share_target): each file as a `files` part.
 */
export function shareBody(files: readonly SharedFile[], boundary: string): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const f of files) {
    const name = f.name.replace(/["\r\n\\]/g, "_");
    parts.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: ${f.type}\r\n\r\n`,
      ),
      f.bytes,
      enc.encode("\r\n"),
    );
  }
  parts.push(enc.encode(`--${boundary}--\r\n`));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/* ---- Jarvis using this Mac (src/computer.ts) ------------------------------- */

export type Op = "look" | "do" | "run";
export type Act = "press" | "type" | "key" | "scroll" | "open" | "front";

/** One thing Jarvis asks of this Mac (jarvis-voice-agent lib/computer.ts). */
export interface ComputerRequest {
  id: string;
  op: Op;
  act: Act | null;
  element: number | null;
  text: string | null;
  picture: boolean;
  ms: number;
}

const OPS: readonly Op[] = ["look", "do", "run"];
const ACTS: readonly Act[] = ["press", "type", "key", "scroll", "open", "front"];

/** What Jarvis asked, checked: anything not as Jarvis sends it is not done. */
export function readRequest(raw: unknown): ComputerRequest | null {
  if (typeof raw !== "string" || raw.length > 20_000) return null;
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!m || m.type !== "computer.do" || typeof m.id !== "string" || !/^[\w-]{1,64}$/.test(m.id)) return null;
  const op = OPS.find((o) => o === m.op);
  const act = m.act === null ? null : ACTS.find((a) => a === m.act);
  const element = m.element === null ? null : Number.isInteger(m.element) && (m.element as number) >= 1 && (m.element as number) <= 1000 ? (m.element as number) : undefined;
  const text = m.text === null ? null : typeof m.text === "string" && m.text.length <= 10_000 ? m.text : undefined;
  const ms = typeof m.ms === "number" && m.ms >= 1000 && m.ms <= 300_000 ? m.ms : undefined;
  if (!op || act === undefined || element === undefined || text === undefined || typeof m.picture !== "boolean" || ms === undefined) return null;
  if (op === "do" && !act) return null;
  return { id: m.id, op, act, element, text, picture: m.picture, ms };
}

/**
 * The apps Jarvis never types, sends keys or presses into, checked by the helper
 * at that moment. Not a list of forbidden commands: commands go through `run`,
 * which Jarvis allows only in a turn that read nothing someone else wrote, and a
 * terminal would be a way round that; System Settings and macOS's own password
 * prompts would let it change what it is allowed; a password app holds passwords;
 * Jarvis itself is where control is turned off; and the lock screen is the person's.
 */
export const REFUSED_APPS: readonly string[] = [
  "com.apple.Terminal",
  "com.googlecode.iterm2",
  "dev.warp.Warp-Stable",
  "net.kovidgoyal.kitty",
  "org.alacritty",
  "com.github.wez.wezterm",
  "com.mitchellh.ghostty",
  "co.zeit.hyper",
  "com.apple.ScriptEditor2",
  "com.apple.Automator",
  "com.apple.shortcuts",
  "com.apple.systempreferences",
  "com.apple.SecurityAgent",
  "com.apple.keychainaccess",
  "com.apple.Passwords",
  "app.jarvis.desktop",
  "com.github.Electron",
  "com.apple.loginwindow",
];

/** The lock screen's own app: in front while the Mac is locked, when nothing on it can be seen or used. */
export const LOCKED_APP = "com.apple.loginwindow";

export const refusesInput = (bundle: string): boolean => REFUSED_APPS.includes(bundle);

/** What `open` may open: an app by its name, or a web address. Never a file or a folder, since opening one can run it, nor another kind of link. */
export function mayOpen(text: string): { app: string } | { url: string } | null {
  const t = text.trim();
  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password ? { url: u.href } : null;
    } catch {
      return null;
    }
  }
  return /^[\p{L}\p{N}][\p{L}\p{N} .&'+()_-]{0,59}$/u.test(t) && !t.includes("..") ? { app: t } : null;
}

/** A name as people say it: letters and digits only, any case ("chatpad" is Chat Pad; marks some names carry unseen go). */
export const plainName = (s: string): string => s.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();

/**
 * Installed apps named like what Jarvis asked to open, the closest first: the same name as people say it, then
 * those with it inside ("Chat" in Chat Pad). At most five, for Jarvis to choose from or say.
 */
export function nearApps(asked: string, installed: readonly string[]): string[] {
  const want = plainName(asked);
  if (!want) return [];
  const same = installed.filter((n) => plainName(n) === want);
  const inside = installed.filter((n) => plainName(n) !== want && plainName(n).includes(want));
  return [...new Set([...same, ...inside])].slice(0, 5);
}

/** The shortcut that stops whatever Jarvis is doing here and turns control off. */
export const STOP_SHORTCUT = "CommandOrControl+Shift+Escape";

const KEY_NAMES = new Set([
  ..."abcdefghijklmnopqrstuvwxyz0123456789-=[];',./\\`",
  "return", "tab", "space", "delete", "forwarddelete", "escape", "left", "right", "up", "down", "home", "end", "pageup", "pagedown",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);
const KEY_ALIASES: Record<string, string> = { enter: "return", esc: "escape", backspace: "delete", pgup: "pageup", pgdn: "pagedown" };
const MOD_ALIASES: Record<string, string> = { cmd: "cmd", command: "cmd", "⌘": "cmd", shift: "shift", alt: "alt", option: "alt", opt: "alt", ctrl: "ctrl", control: "ctrl", fn: "fn" };

/** A key combo as Jarvis writes it ("cmd+shift+t"), or null: a key the helper knows, never the Stop shortcut. */
export function keyCombo(text: string): { key: string; mods: string[] } | null {
  const parts = text.toLowerCase().split("+").map((p) => p.trim());
  const named = parts.pop() ?? "";
  const key = KEY_ALIASES[named] ?? named;
  if (!KEY_NAMES.has(key)) return null;
  const mods = [...new Set(parts.map((p) => MOD_ALIASES[p]))];
  if (mods.some((m) => m === undefined)) return null;
  const sorted = (mods as string[]).sort();
  if (key === "escape" && sorted.includes("cmd") && sorted.includes("shift")) return null;
  return { key, mods: sorted };
}

/** The most of an answer's words, and of a whole answer with its screenshot (as Jarvis takes them). */
export const MAX_TEXT = 16_000;
export const MAX_ANSWER = 512 * 1024;

/** At most `max` characters: the start and the end, with how much was left out between. */
export function capOutput(s: string, max = MAX_TEXT): string {
  if (s.length <= max) return s;
  const head = Math.floor(max / 4);
  const tail = max - head - 60;
  return `${s.slice(0, head)}\n… ${s.length - head - tail} characters left out …\n${s.slice(-tail)}`;
}

/** That a request arrived, sent at once: without it Jarvis counts this Mac as asleep. */
export const gotOf = (id: string): string => JSON.stringify({ type: "computer.got", id });

/** The answer as Jarvis takes it: its type first, which Jarvis reads before the rest, and within its size. */
export function answerOf(id: string, ok: boolean, text: string, image: string | null = null): string {
  const words = capOutput(text);
  const s = JSON.stringify({ type: "computer.answer", id, ok, text: words, image });
  return s.length <= MAX_ANSWER ? s : JSON.stringify({ type: "computer.answer", id, ok, text: `${words}\n(The screenshot was too big to send.)`, image: null });
}

/** How long to wait before connecting again: doubling from a second, a minute at most. */
export const backoff = (attempt: number): number => Math.min(60_000, 1000 * 2 ** Math.min(Math.max(attempt, 0), 6));

/** A Mac's device token, as Jarvis makes them (lib/devices.ts). */
export const isMacToken = (t: unknown): t is string => typeof t === "string" && /^jdv1_[abcdefghijkmnpqrstuvwxyz23456789]{32}$/.test(t);

/** The events socket for this Mac, named so in Jarvis's list. */
export function eventsUrl(origin: string): string {
  const u = new URL("/api/v1/events", origin);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.href;
}
