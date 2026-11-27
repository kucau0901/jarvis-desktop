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

- **Jarvis can use your Mac** when you ask, from the glasses, your phone or the web: "how much disk is free
  on my Mac?", "open Spotify on the office Mac", "what's on my Mac's screen?", then press and type there.
  Off until you turn it on ([below](#letting-jarvis-use-this-mac)).

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

## Letting Jarvis use this Mac

In the menu bar, Jarvis's menu → **Let Jarvis control this Mac**. The first time, Jarvis (signed in, in the
app's window) makes this Mac one of your devices, named after it; it is then listed in Jarvis's Devices,
where revoking it unlinks it. It needs a Jarvis recent enough to know about it, and the `computer` scope,
which an admin has and gives others in Family.

macOS then asks two things, once, in System Settings → Privacy & Security, and the menu shows which are
still to allow:

- **Accessibility**, to read other apps' windows and press and type in them.
- **Screen Recording**, only for a screenshot when you ask Jarvis to look at an app.

What it does, and what it never does:

- A command runs in your login shell, in your home folder, as you, for two minutes at most. It has no
  keyboard, so it cannot be asked for a password (`sudo` fails).
- It works in an app where it is, behind the one you are using or not, so you go on working: a look is
  that app's window, as words and a numbered list of what can be pressed (never a password field's value);
  a press, typing and keys go to that app alone. An app it opens opens behind yours. Only what cannot be
  done from behind needs the app in front, and Jarvis asks you first. A screenshot, of that window, only
  when asked.
- An app is found by its name as you say it: "whatsapp", "chatpad" for Chat Pad, or part of a name only
  one open app has. Apps made of a web page (Electron apps such as Slack or Discord) take presses and
  typing from behind but not keys: there Jarvis presses the app's own buttons, or asks to bring it forward.
- While this Mac is locked its apps can be neither seen nor used; commands still run.
- It never types, sends keys or presses into a terminal, Script Editor, Automator, Shortcuts, System
  Settings, macOS's password prompts, a password app or Jarvis itself; never into a password field.
- It opens an app by its name or a web address, never a file.
- While it works a banner says so at the top of the screen, with **Stop**. <kbd>⌘ Shift Esc</kbd> stops it
  from anywhere, too, and turns control off until you turn it on again.
- Everything it did is in the menu → *What Jarvis Did on This Mac…*.

Jarvis itself decides when it may ask: only you, in your own words, never a routine, a job or a bot; and a
command only in a turn that has not read someone else's words, such as an email, a web page or the
screen ([why](https://github.com/kucau0901/jarvis-voice-agent/blob/main/docs/DESIGN.md#the-mac)). Several
Macs can each be linked; Jarvis asks which when it is not clear.

Without [signing](#signing), macOS forgets the two permissions at every update, and they need allowing
again.

## What it allows

- Only pages from your Jarvis address may use the microphone, the camera, notifications and full screen.
  Nothing else gets any of them.
- Links to other sites, and sign-ins to Google, Spotify or ChatGPT, open in your usual browser, where your own
  sign-ins are.
- The app's bridge to the system (notifications, the shortcut, whether someone is at the computer) is given
  only to Jarvis's own pages, never to a page Jarvis made for someone else to see.

## Build it yourself

Needs Node 24, and on a Mac the Xcode command line tools, for the helper that reads and uses other apps
(`native/jarvis-control.swift`, built by `scripts/native.mjs` into `build/native/`).

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

### Signing

Without signing, the Mac app is signed ad hoc, and macOS treats each new version as a new app: whatever it was
allowed in System Settings → Privacy & Security (Accessibility, Screen Recording) has to be allowed again after
every update. Signed with an Apple Developer ID and notarized, it keeps them, and opens with no warning.

The build signs and notarizes the Mac app by itself once the repository has these secrets (Settings → Secrets
and variables → Actions):

| Secret | What it is |
| --- | --- |
| `MAC_CSC_LINK` | A *Developer ID Application* certificate with its private key, exported from Keychain Access as a `.p12`, then base64 (`base64 -i cert.p12`) |
| `MAC_CSC_KEY_PASSWORD` | The password the `.p12` was exported with |
| `APPLE_API_KEY` | An App Store Connect API key (Users and Access → Integrations), the whole text of its `.p8` file |
| `APPLE_API_KEY_ID` | That key's ID |
| `APPLE_API_ISSUER` | The issuer ID shown above the keys |

Without them, or in a fork, it builds as before. Windows is not signed.

## License

MIT
