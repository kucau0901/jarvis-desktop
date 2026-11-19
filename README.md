# Jarvis for Mac and Windows

Your own [Jarvis](https://github.com/kucau0901/jarvis-voice-agent) in a window of its own. Everything the
web app does comes with it: live voice, push-to-talk, Chat, Home, the browser, Settings. On top of that it
adds what a browser tab can't do:

- **A place in the menu bar or tray.** Closing the window keeps Jarvis running. Quit it from the tray icon.
- **Alerts as the system's own notifications.** When someone is at the computer, Jarvis's alerts show as Mac
  or Windows notifications, even with the window closed. When the computer is idle (two minutes) or
  locked, they go on to your phone as before.
- **A talk shortcut**: <kbd>⌘ Shift J</kbd> on a Mac, <kbd>Ctrl Shift J</kbd> on Windows, from any app.
- **Open at Login**, from the tray menu or the app menu.
- **Files dropped on the app's icon** (the Dock on a Mac, the app's shortcut on Windows) are attached in
  Chat, ready to ask about.

The notifications and the talk shortcut need a Jarvis recent enough to know about the desktop app.

## Install

Download the newest `.dmg` (Mac) or `.exe` (Windows) from
[Releases](https://github.com/kucau0901/jarvis-desktop/releases).

The apps aren't signed by Apple or Microsoft yet, so the first open needs one extra step:

- **Mac.** Open the `.dmg`, drag Jarvis to Applications and open it. When macOS says it can't check it,
  go to System Settings → Privacy & Security, find the note about Jarvis, and choose **Open Anyway**.
- **Windows.** When SmartScreen says it protected your PC, choose **More info**, then **Run anyway**.

Updates are manual for now: download the new version and install it over the old one. Your sign-in is kept.

## First run

Type your Jarvis address, the one you open it at in a browser (for example `jarvis.example.com`). Then sign
in as you would on any new screen. The easiest way is **Sign in another screen** from your phone: Menu →
Family on a signed-in Jarvis, then approve the code the app shows.

On a Mac, sign in by code or with your key. A passkey kept in iCloud Keychain can't be used from an app
that isn't a browser.

**Behind Cloudflare Access?** Without a token, the app shows Access's own sign-in, which works with the
one-time PIN by email. Signing in with Google refuses windows inside apps, so for that, make a service token
in Cloudflare Zero Trust (Access → Service auth), allow it in your Jarvis Access application's policy, and
enter its Client ID and secret under *Behind Cloudflare Access* on the first-run screen. The secret is kept
in the system keychain and only ever sent to your Jarvis address.

To change the address later: the app menu (Mac) or File menu (Windows) → *Change Jarvis Address…*.

## What it allows

- Only pages from your Jarvis address may use the microphone, the camera, notifications and full screen.
  Nothing else gets any of them.
- Links to other sites, and sign-ins to Google, Spotify or ChatGPT, open in your usual browser, where your own
  sign-ins are.
- The app's bridge to the system (notifications, the shortcut, whether someone is at the computer) is given
  only to Jarvis's own pages, never to a page Jarvis made for someone else to see.

## Build it yourself

Needs Node 24.

```bash
npm install
npm start
```

Other commands:

| What | Command |
| --- | --- |
| Typecheck | `npm run typecheck` |
| Test | `npm test` |
| Installer for this system | `npm run dist` (into `release/`) |

A tag `v*` pushed to GitHub builds both installers and attaches them to that release
(`.github/workflows/release.yml`).

## License

MIT
