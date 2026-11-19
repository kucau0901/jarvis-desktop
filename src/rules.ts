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
