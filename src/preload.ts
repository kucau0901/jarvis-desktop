/**
 * The bridge Jarvis's page may use, `window.jarvisDesktop`, version 1
 * (jarvis-voice-agent docs/DESIGN.md, "The desktop app"). Only on Jarvis's
 * own pages, never on a page it serves for others (`/api/…`) or anywhere
 * else. The main process also takes these messages only from its window.
 *
 * This runs sandboxed, so it requires nothing but electron.
 */
import { contextBridge, ipcRenderer } from "electron";

const origin = process.argv.find((a) => a.startsWith("--jarvis-origin="))?.slice("--jarvis-origin=".length);

if (origin && location.origin === origin && !location.pathname.startsWith("/api/")) {
  contextBridge.exposeInMainWorld("jarvisDesktop", {
    version: 1,
    /** False where a passkey on this computer cannot be used from the app (a Mac). */
    passkeys: process.platform !== "darwin",
    /** Someone is at the computer: used in the last two minutes and not locked. */
    inUse: (): Promise<boolean> => ipcRenderer.invoke("jd:inUse"),
    /** Whether someone is at the computer has changed. */
    onPresence: (cb: () => void): void => {
      ipcRenderer.on("jd:presence", () => cb());
    },
    /** Show an alert as the system's own notification. */
    notify: (a: { id: string; title: string; text: string }): void => {
      ipcRenderer.send("jd:notify", { id: String(a?.id ?? ""), title: String(a?.title ?? ""), text: String(a?.text ?? "") });
    },
    /** The talk shortcut was pressed. */
    onTalk: (cb: () => void): void => {
      ipcRenderer.on("jd:talk", () => cb());
    },
    // On a Mac, Jarvis may be let use it (src/computer.ts): its person turned that on, and the page,
    // signed in as them, makes this Mac a device of theirs and hands its token over once.
    ...(process.platform === "darwin"
      ? {
          /** Asked to link this Mac, by its name. */
          onLinkComputer: (cb: (name: string) => void): void => {
            ipcRenderer.on("jd:linkComputer", (_e, name: unknown) => cb(String(name ?? "Mac")));
          },
          /** The answer: the new device's token, or why not. */
          computerLinked: (r: { token?: unknown; error?: unknown }): void => {
            ipcRenderer.send("jd:computerLinked", typeof r?.token === "string" ? { token: r.token } : { error: String(r?.error ?? "") });
          },
        }
      : {}),
  });
}
