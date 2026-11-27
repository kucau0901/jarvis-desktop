import { app, safeStorage } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What the app keeps between runs, in its own folder: the Jarvis address and,
 * for a Jarvis behind Cloudflare Access, a service token. The token's secret
 * is encrypted with the system's keychain (safeStorage) and never written in
 * the clear. The sign-in to Jarvis itself is the page's own, kept with the
 * page's storage like a browser's. So is this Mac's own token, once its person
 * lets Jarvis use it: kept here, never in the page.
 */
export interface Config {
  origin: string;
  accessId: string;
  /** The secret, encrypted, base64. */
  accessSecret: string;
  /** This Mac's own device token, for Jarvis to use it (src/computer.ts): encrypted, base64; empty until linked. */
  computer: string;
  /** Whether its person has let Jarvis use this Mac now. */
  computerOn: boolean;
}

const file = () => join(app.getPath("userData"), "config.json");

export function loadConfig(): Config | null {
  try {
    const c = JSON.parse(readFileSync(file(), "utf8")) as Partial<Config>;
    if (typeof c.origin !== "string" || !c.origin) return null;
    return {
      origin: c.origin,
      accessId: typeof c.accessId === "string" ? c.accessId : "",
      accessSecret: typeof c.accessSecret === "string" ? c.accessSecret : "",
      computer: typeof c.computer === "string" ? c.computer : "",
      computerOn: c.computerOn === true,
    };
  } catch {
    return null;
  }
}

export function saveConfig(c: Config): void {
  writeFileSync(file(), JSON.stringify(c, null, 2), { mode: 0o600 });
}

export function sealSecret(secret: string): string {
  if (!secret) return "";
  if (!safeStorage.isEncryptionAvailable()) throw new Error("This computer cannot keep the secret safely, so it was not saved.");
  return safeStorage.encryptString(secret).toString("base64");
}

export function openSecret(sealed: string): string {
  if (!sealed) return "";
  try {
    return safeStorage.decryptString(Buffer.from(sealed, "base64"));
  } catch {
    return "";
  }
}
