/**
 * Jarvis on the desktop: the person's own Jarvis address in a window of its
 * own, so everything the web app does comes with it, plus what a browser tab
 * cannot do: a place in the menu bar or tray, the system's own notifications
 * for alerts, a talk shortcut from any app, starting at login, and files
 * dropped on the app's icon.
 *
 * Why it loads the address rather than carrying the app inside: Jarvis's page
 * asks its own origin for everything (/api/…), keeps its sign-in in that
 * origin's storage, and its passkeys are bound to that origin.
 */
import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  session,
  shell,
  systemPreferences,
  Tray,
  type MenuItemConstructorOptions,
  type Session,
  type WebContents,
} from "electron";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig, openSecret, saveConfig, sealSecret, type Config } from "./config.ts";
import { addressChanged, computerMenu, initComputer } from "./computer.ts";
import {
  filesInArgs,
  isWeb,
  MAX_SHARED,
  MAX_SHARED_BYTES,
  navigation,
  normalizeAddress,
  permissionAllowed,
  sameOrigin,
  shareBody,
  typeOf,
  windowOpening,
  type SharedFile,
} from "./rules.ts";

const TALK_SHORTCUT = "CommandOrControl+Shift+J";
/** The page's storage, kept between runs like a browser profile: its sign-in lives there. */
const PARTITION = "persist:jarvis";
/** Seconds without a key or mouse after which nobody counts as being at the computer. */
const IDLE_S = 120;
const RETRY_MS = 30_000;
/** How long an address may take to answer before the setup screen says it did not. */
const LOAD_S = 20;
const mac = process.platform === "darwin";

let config: Config | null = null;
let ses: Session;
let win: BrowserWindow | null = null;
/** The origin `win` was made for: its bridge is bound to it, so a new address makes a new window. */
let winOrigin = "";
let setupWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
/** Why Jarvis could not be opened, shown on the setup screen; empty when it opened. */
let problem = "";
let retryTimer: NodeJS.Timeout | undefined;
/** The window was asked to show and has not loaded yet: a failure then brings the setup screen. */
let showWhenLoaded = false;
let shortcutOk = false;
const waitingFiles: string[] = [];
let filesTimer: NodeJS.Timeout | undefined;
/** Shown notifications, held so they are not collected while on screen (their clicks would be lost). */
const shown = new Set<Notification>();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start(): void {
  // Windows shows notifications only for an app with this id, the installer's (package.json build.appId).
  if (process.platform === "win32") app.setAppUserModelId("app.jarvis.desktop");

  // A file dropped on the Dock icon, possibly before the app is ready (macOS).
  app.on("open-file", (e, path) => {
    e.preventDefault();
    takeFiles([path]);
  });

  // Opened again: a file dropped on the icon (Windows passes it in the command line), or just brought forward.
  app.on("second-instance", (_e, argv) => {
    const files = filesInArgs(argv, isFile);
    if (files.length) takeFiles(files);
    else showMain();
  });

  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("activate", () => showMain());
  // The main window only ever hides; this is the setup screen closed before Jarvis was ever opened.
  app.on("window-all-closed", () => {
    if (!win) app.quit();
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());

  void app.whenReady().then(() => {
    config = loadConfig();
    ses = session.fromPartition(PARTITION);
    guardSession(ses);
    applyAccess();
    buildMenu();
    makeTray();
    shortcutOk = globalShortcut.register(TALK_SHORTCUT, talk);
    refreshTray();
    watchPresence();
    bridge();
    setupScreen();
    // Jarvis using this Mac for its person (src/computer.ts): on a Mac only.
    if (mac) {
      initComputer({
        config: () => config,
        save: (c) => {
          config = c;
          saveConfig(c);
        },
        page: () => win?.webContents ?? null,
        access: () => (config?.accessId && openSecret(config.accessSecret) ? { id: config.accessId, secret: openSecret(config.accessSecret) } : null),
        refresh: () => {
          buildMenu();
          refreshTray();
        },
        working: (on) => tray?.setTitle(on ? "●" : ""),
      });
    }

    const atLogin = process.argv.includes("--hidden") || (mac && app.getLoginItemSettings().wasOpenedAtLogin === true);
    if (!config) openSetup();
    else openMain(!atLogin);
    if (process.platform === "win32") {
      const files = filesInArgs(process.argv, isFile);
      if (files.length) takeFiles(files);
    }
  });
}

// ---- The main window -------------------------------------------------------

function background(): string {
  return nativeTheme.shouldUseDarkColors ? "#000000" : "#f4f5f7";
}

/** Open Jarvis, making its window if there is none or the address changed. */
function openMain(show = true): void {
  if (!config) return openSetup();
  const origin = config.origin;
  if (win && winOrigin !== origin) {
    const old = win;
    win = null;
    old.destroy();
  }
  if (win) {
    showWhenLoaded = show;
    void win.loadURL(`${origin}/`);
    return;
  }
  winOrigin = origin;
  const w = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 360,
    minHeight: 480,
    show: false,
    title: "Jarvis",
    backgroundColor: background(),
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      preload: join(__dirname, "preload.js"),
      additionalArguments: [`--jarvis-origin=${origin}`],
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Alerts are spoken with nobody pressing anything first, as Jarvis's own screens do.
      autoplayPolicy: "no-user-gesture-required",
      spellcheck: true,
    },
  });
  win = w;
  showWhenLoaded = show;
  w.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    w.hide();
  });
  // A page closing itself (window.close()) skips the above: the next open makes a new window.
  w.on("closed", () => {
    if (win === w) win = null;
  });
  guardContents(w.webContents, origin, true);
  // Chromium finishes loading its own error page after a failure: that is not Jarvis loaded.
  let failed = false;
  let slow: NodeJS.Timeout | undefined;
  const fail = (why: string, url: string) => {
    clearTimeout(slow);
    failed = true;
    problem = `Jarvis could not be opened at ${origin} (${why}).`;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (w === win && problem) void w.loadURL(url || `${origin}/`);
    }, RETRY_MS);
    if (w.isVisible() || showWhenLoaded) {
      showWhenLoaded = false;
      w.hide();
      openSetup();
    }
  };
  w.webContents.on("did-start-loading", () => {
    failed = false;
    clearTimeout(slow);
    // An address that never answers (a wrong port, https to a plain-http server) would otherwise wait for minutes.
    slow = setTimeout(() => {
      if (w !== win || !w.webContents.isLoadingMainFrame()) return;
      const url = w.webContents.getURL();
      w.webContents.stop();
      fail(`no answer in ${LOAD_S} seconds`, url);
    }, LOAD_S * 1000);
  });
  w.webContents.on("did-stop-loading", () => clearTimeout(slow));
  w.webContents.on("did-fail-load", (_e, code, description, url, mainFrame) => {
    // -3 is a load replaced by another (a redirect, a new address): not a failure.
    if (!mainFrame || code === -3 || w !== win) return;
    fail(description || String(code), url);
  });
  w.webContents.on("did-finish-load", () => {
    if (w !== win || failed) return;
    // Jarvis, or a Cloudflare Access sign-in in front of it: either way something to show.
    if (sameOrigin(w.webContents.getURL(), origin)) {
      problem = "";
      clearTimeout(retryTimer);
    }
    if (showWhenLoaded && !problem) {
      showWhenLoaded = false;
      showMain();
    }
  });
  w.webContents.on("render-process-gone", (_e, d) => {
    if (d.reason !== "clean-exit" && w === win) w.webContents.reload();
  });
  if (waitingFiles.length) shareFiles();
  else void w.loadURL(`${origin}/`);
}

function showMain(): void {
  if (!config) return openSetup();
  if (!win) return openMain();
  if (problem) return openSetup();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** The talk shortcut: Jarvis forward, and the page told to listen (its bridge's onTalk). */
function talk(): void {
  if (!config || !win || problem) return showMain();
  showMain();
  win.webContents.send("jd:talk");
}

// ---- What pages may do -----------------------------------------------------

/** Only Jarvis's own pages get the microphone, camera, notifications and the like; nothing else does. */
function guardSession(s: Session): void {
  s.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (!config || !permissionAllowed(permission, details.requestingUrl, config.origin)) return callback(false);
    if (permission !== "media" || !mac) return callback(true);
    // macOS asks the person once per app; the page's request waits for that answer.
    const kinds = "mediaTypes" in details && Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    void Promise.all(
      kinds.map((k) => (k === "video" ? systemPreferences.askForMediaAccess("camera") : systemPreferences.askForMediaAccess("microphone"))),
    ).then((answers) => callback(answers.every(Boolean)));
  });
  s.setPermissionCheckHandler((_wc, permission, requestingOrigin) => !!config && permissionAllowed(permission, requestingOrigin, config.origin));
}

/** Requests to Jarvis carry the Cloudflare Access service token, when one is set; no request elsewhere does. */
function applyAccess(): void {
  const id = config?.accessId ?? "";
  const secret = config ? openSecret(config.accessSecret) : "";
  if (!config || !id || !secret) {
    ses.webRequest.onBeforeSendHeaders(null);
    return;
  }
  const origin = config.origin;
  ses.webRequest.onBeforeSendHeaders((d, callback) => {
    const asHttp = d.url.replace(/^ws(s?):/i, "http$1:");
    if (!sameOrigin(asHttp, origin)) return callback({ requestHeaders: d.requestHeaders });
    callback({ requestHeaders: { ...d.requestHeaders, "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret } });
  });
}

/**
 * Where a window may go. Jarvis stays in the app; other sites open in the
 * system browser, with the person's own sign-ins; a page Jarvis opens in a
 * new window is followed there the same way.
 */
function guardContents(wc: WebContents, origin: string, main: boolean): void {
  wc.setWindowOpenHandler(({ url }) => {
    const how = windowOpening(url, origin);
    if (how === "external") void shell.openExternal(url);
    if (how === "external" || how === "deny") return { action: "deny" };
    return {
      action: "allow",
      overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: background(), width: 1000, height: 760 },
    };
  });
  wc.on("did-create-window", (child) => guardContents(child.webContents, origin, false));
  wc.on("will-navigate", (e, url) => {
    const how = navigation(url, wc.getURL(), origin);
    if (how === "stay") return;
    e.preventDefault();
    if (how === "external") void shell.openExternal(url);
    // A window opened blank for a page elsewhere (Jarvis's page card, a link): it has gone to the browser.
    if (!main && (wc.getURL() === "" || wc.getURL() === "about:blank")) BrowserWindow.fromWebContents(wc)?.close();
  });
  wc.on("context-menu", (_e, p) => {
    const items: MenuItemConstructorOptions[] = [];
    for (const s of p.dictionarySuggestions.slice(0, 4)) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
    if (items.length) items.push({ type: "separator" });
    if (p.linkURL && isWeb(p.linkURL)) {
      items.push(
        { label: "Open Link in Browser", click: () => void shell.openExternal(p.linkURL) },
        { label: "Copy Link", click: () => clipboard.writeText(p.linkURL) },
        { type: "separator" },
      );
    }
    if (p.isEditable) items.push({ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" });
    else if (p.selectionText) items.push({ role: "copy" });
    while (items.at(-1)?.type === "separator") items.pop();
    if (items.length) Menu.buildFromTemplate(items).popup();
  });
}

// ---- The bridge (src/preload.ts) -------------------------------------------

/** Someone is at the computer: used within IDLE_S and not locked. */
function inUse(): boolean {
  return powerMonitor.getSystemIdleState(IDLE_S) === "active";
}

/** Only the main window's page may ask; a window it opened may not. */
const fromMain = (wc: WebContents) => !!win && wc === win.webContents;

function bridge(): void {
  ipcMain.handle("jd:inUse", (e) => fromMain(e.sender) && inUse());
  ipcMain.on("jd:notify", (e, a: { id: string; title: string; text: string }) => {
    if (!fromMain(e.sender) || !Notification.isSupported()) return;
    const n = new Notification({ title: a.title || "Jarvis", body: a.text });
    shown.add(n);
    n.on("close", () => shown.delete(n));
    n.on("click", () => {
      shown.delete(n);
      // Jarvis opens an alert from its address (src/app/main.ts, ?alert=).
      if (config && win && a.id) void win.loadURL(`${config.origin}/?alert=${encodeURIComponent(a.id)}`);
      showMain();
    });
    n.show();
  });
}

/** Tell the page when someone comes to or leaves the computer, so Jarvis knows whether an alert here is seen. */
function watchPresence(): void {
  let was = inUse();
  const tell = () => {
    was = inUse();
    win?.webContents.send("jd:presence");
  };
  setInterval(() => {
    if (inUse() !== was) tell();
  }, 15_000);
  powerMonitor.on("lock-screen", tell);
  powerMonitor.on("unlock-screen", tell);
  powerMonitor.on("suspend", tell);
  powerMonitor.on("resume", tell);
}

// ---- Setup screen ----------------------------------------------------------

function openSetup(): void {
  if (setupWin) {
    setupWin.show();
    setupWin.focus();
    return;
  }
  const w = new BrowserWindow({
    width: 480,
    height: 620,
    resizable: false,
    minimizable: false,
    fullscreenable: false,
    title: "Jarvis",
    backgroundColor: background(),
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: join(__dirname, "setup-preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  setupWin = w;
  w.once("ready-to-show", () => w.show());
  w.on("closed", () => {
    if (setupWin === w) setupWin = null;
  });
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  w.webContents.on("will-navigate", (e) => e.preventDefault());
  void w.loadFile(join(app.getAppPath(), "setup", "setup.html"));
}

/** Closed at once as far as the app is concerned: a load failing right after must open a new one. */
function closeSetup(): void {
  const w = setupWin;
  setupWin = null;
  w?.close();
}

function setupScreen(): void {
  const fromSetup = (wc: WebContents) => !!setupWin && wc === setupWin.webContents;
  ipcMain.handle("setup:get", (e) => {
    if (!fromSetup(e.sender)) return null;
    return { address: config?.origin ?? "", accessId: config?.accessId ?? "", hasSecret: !!config?.accessSecret, problem };
  });
  ipcMain.handle("setup:save", (e, v: { address: string; accessId: string; accessSecret: string; keepSecret: boolean }) => {
    if (!fromSetup(e.sender)) return "Not allowed.";
    const n = normalizeAddress(String(v?.address ?? ""));
    if ("error" in n) return n.error;
    const accessId = String(v.accessId ?? "").trim();
    let accessSecret = "";
    if (accessId) {
      if (v.accessSecret) {
        try {
          accessSecret = sealSecret(String(v.accessSecret));
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      } else if (v.keepSecret && config?.accessSecret) {
        // A kept secret goes only to the address it was given for.
        if (config.origin !== n.origin) return "The address changed: type the client secret again.";
        accessSecret = config.accessSecret;
      } else {
        return "Type the client secret too, or clear the Client ID.";
      }
    }
    // This Mac's token is for the Jarvis that made it: another address drops it.
    const same = config?.origin === n.origin;
    config = { origin: n.origin, accessId, accessSecret, computer: same ? config!.computer : "", computerOn: same && config!.computerOn };
    saveConfig(config);
    if (mac && !same) addressChanged();
    applyAccess();
    problem = "";
    clearTimeout(retryTimer);
    closeSetup();
    openMain();
    return "";
  });
  ipcMain.handle("setup:retry", (e) => {
    if (!fromSetup(e.sender)) return;
    problem = "";
    closeSetup();
    openMain();
  });
}

// ---- Menu, tray, starting at login -----------------------------------------

function openAtLogin(): boolean {
  return app.getLoginItemSettings().openAtLogin;
}

function setOpenAtLogin(on: boolean): void {
  // Windows starts it with --hidden, macOS says so itself (wasOpenedAtLogin): Jarvis waits in the tray either way.
  app.setLoginItemSettings({ openAtLogin: on, args: ["--hidden"] });
  buildMenu();
  refreshTray();
}

function buildMenu(): void {
  const address: MenuItemConstructorOptions = { label: "Change Jarvis Address…", click: () => openSetup() };
  const login: MenuItemConstructorOptions = {
    label: "Open at Login",
    type: "checkbox",
    checked: openAtLogin(),
    click: (item) => setOpenAtLogin(item.checked),
  };
  const view: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      { role: "reload" },
      { role: "forceReload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };
  const template: MenuItemConstructorOptions[] = mac
    ? [
        {
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            address,
            login,
            { type: "separator" },
            // In the app's own menu too, not only the menu bar's icon, which a full menu bar can hide.
            ...computerMenu(),
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        // File holds Close Window (⌘W), which hides Jarvis to the menu bar.
        { role: "fileMenu" },
        // Without the Edit menu's roles, copy and paste do nothing on a Mac.
        { role: "editMenu" },
        view,
        { role: "windowMenu" },
      ]
    : [{ label: "File", submenu: [address, login, { type: "separator" }, { role: "quit" }] }, { role: "editMenu" }, view, { role: "windowMenu" }];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function makeTray(): void {
  const icon = nativeImage.createFromPath(join(app.getAppPath(), "assets", mac ? "trayTemplate.png" : "tray.png"));
  if (mac) icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Jarvis");
  // On Windows a click on the tray icon opens Jarvis; its menu is on the right button.
  if (!mac) tray.on("click", () => showMain());
}

function refreshTray(): void {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Jarvis", click: () => showMain() },
      {
        label: shortcutOk ? "Talk" : "Talk (shortcut taken by another app)",
        accelerator: shortcutOk ? TALK_SHORTCUT : undefined,
        registerAccelerator: false,
        click: () => talk(),
      },
      { type: "separator" },
      ...(mac ? [...computerMenu(), { type: "separator" as const }] : []),
      { label: "Open at Login", type: "checkbox", checked: openAtLogin(), click: (item) => setOpenAtLogin(item.checked) },
      { label: "Change Jarvis Address…", click: () => openSetup() },
      { type: "separator" },
      { label: "Quit Jarvis", click: () => app.quit() },
    ]),
  );
}

// ---- Files dropped on the app's icon ----------------------------------------

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Files arriving one event each (macOS sends one per file): gathered, then shared together. */
function takeFiles(paths: string[]): void {
  waitingFiles.push(...paths);
  clearTimeout(filesTimer);
  filesTimer = setTimeout(() => {
    if (app.isReady() && config) {
      if (win) shareFiles();
      else openMain();
    }
  }, 300);
}

/**
 * Into Jarvis as a phone's share sheet would: posted to its share target,
 * where its service worker keeps them and the page puts them in Chat's tray,
 * not sent (public/sw.js, src/app/share.ts in Jarvis).
 */
function shareFiles(): void {
  if (!win || !config) return;
  const paths = waitingFiles.splice(0);
  const files: SharedFile[] = [];
  const tooBig: string[] = [];
  for (const p of paths) {
    if (!isFile(p)) continue;
    if (statSync(p).size > MAX_SHARED_BYTES) {
      tooBig.push(basename(p));
      continue;
    }
    if (files.length < MAX_SHARED) files.push({ name: basename(p), type: typeOf(p), bytes: readFileSync(p) });
  }
  if (tooBig.length && Notification.isSupported()) {
    new Notification({ title: "Jarvis", body: `${tooBig.join(", ")}: too big to share into Jarvis (25 MB at most).` }).show();
  }
  if (!files.length) return showMain();
  const boundary = `----jarvis${randomBytes(12).toString("hex")}`;
  void win.loadURL(`${config.origin}/share`, {
    postData: [{ type: "rawData", bytes: Buffer.from(shareBody(files, boundary)) }],
    extraHeaders: `Content-Type: multipart/form-data; boundary=${boundary}`,
  });
  showMain();
}
