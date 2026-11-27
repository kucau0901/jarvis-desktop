/**
 * The banner shown while Jarvis uses this Mac (src/computer.ts): its one button
 * stops it. Sandboxed, so it requires nothing but electron.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("jarvisBanner", {
  stop: (): void => ipcRenderer.send("jd:computerStop"),
});
