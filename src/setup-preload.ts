/** What the setup screen (setup/setup.html) may ask of the app. Sandboxed: electron only. */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("setup", {
  /** The saved address, whether a token is kept, and why this screen opened (a failed load), if it did. */
  get: (): Promise<{ address: string; accessId: string; hasSecret: boolean; problem: string }> => ipcRenderer.invoke("setup:get"),
  /** Save and open Jarvis; resolves with a reason when it was not saved. */
  save: (v: { address: string; accessId: string; accessSecret: string; keepSecret: boolean }): Promise<string> =>
    ipcRenderer.invoke("setup:save", v),
  /** Open the saved address again, as it is. */
  retry: (): Promise<void> => ipcRenderer.invoke("setup:retry"),
});
