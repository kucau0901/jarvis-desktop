// jarvis-control: what the desktop app cannot do from Node on a Mac, for Jarvis to use it
// (src/helper.ts). It reads an app's window through the Accessibility API, by the app's name,
// in front or behind, and presses, types, sends keys and scrolls in that app, where it is: the
// person goes on working in theirs. Only what cannot be done from behind needs the app in
// front, and Jarvis brings it there only when they say so. One JSON request a line on stdin, one
// answer a line on stdout, in order: {"id":1,"cmd":"read","max":6000} → {"id":1,"ok":true,…}.
//
// It is a child of the app, so macOS asks for, and keeps, the app's own Accessibility
// permission. It never reads a password field's value, never types or presses into one,
// and never types, sends keys or presses into an app of `deny` (the app's rules.ts:
// terminals, System Settings, Jarvis itself). Input goes only to the app last looked at.
import AppKit
import ApplicationServices
import Carbon.HIToolbox

setvbuf(stdout, nil, _IOLBF, 0)

/// The numbered elements of the last read, per app: `press 3` is the third of those.
var last: [pid_t: [AXUIElement]] = [:]
/// The app that read was of: input goes only to it, so nothing is pressed or typed into an app Jarvis has not seen.
var lastPid: pid_t = 0

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func str(_ el: AXUIElement, _ name: String) -> String {
  if let s = attr(el, name) as? String { return s }
  if let n = attr(el, name) as? NSNumber { return n.stringValue }
  return ""
}

func children(_ el: AXUIElement) -> [AXUIElement] {
  (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

func isSecure(_ el: AXUIElement) -> Bool {
  str(el, kAXRoleAttribute) == "AXSecureTextField" || str(el, kAXSubroleAttribute) == "AXSecureTextField"
}

func actions(_ el: AXUIElement) -> [String] {
  var names: CFArray?
  return AXUIElementCopyActionNames(el, &names) == .success ? ((names as? [String]) ?? []) : []
}

func frame(_ el: AXUIElement) -> CGRect? {
  guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute) else { return nil }
  var point = CGPoint.zero
  var size = CGSize.zero
  guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
  return CGRect(origin: point, size: size)
}

let ACTIONABLE: Set<String> = [
  "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXMenuItem", "AXMenuBarItem",
  "AXLink", "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXTab", "AXDisclosureTriangle",
  "AXSlider", "AXIncrementor", "AXCell", "AXRow",
]
let NAMES: [String: String] = [
  "AXButton": "button", "AXCheckBox": "checkbox", "AXRadioButton": "radio", "AXPopUpButton": "pop-up",
  "AXMenuButton": "menu button", "AXMenuItem": "menu item", "AXMenuBarItem": "menu", "AXLink": "link",
  "AXTextField": "text field", "AXTextArea": "text area", "AXComboBox": "combo box", "AXSearchField": "search field",
  "AXTab": "tab", "AXDisclosureTriangle": "disclosure", "AXSlider": "slider", "AXIncrementor": "stepper",
  "AXCell": "cell", "AXRow": "row", "AXSecureTextField": "password field",
]

struct App {
  let app: NSRunningApplication
  var name: String { shown(app.localizedName ?? "an app") }
  var bundle: String { app.bundleIdentifier ?? "" }
  var pid: pid_t { app.processIdentifier }
}

func front() -> App? {
  NSWorkspace.shared.frontmostApplication.map(App.init)
}

/// The run loop let through, so an app opened, quit or brought forward since the last request is seen: without it
/// macOS keeps telling this helper the apps that ran when it started.
func pump() {
  while CFRunLoopRunInMode(.defaultMode, 0, true) == .handledSource {}
}

/// A name without the marks some carry unseen (WhatsApp's starts with a left-to-right mark).
func shown(_ s: String) -> String {
  String(String.UnicodeScalarView(s.unicodeScalars.filter { $0.properties.generalCategory != .format }))
}

/// A name as people say it: letters and digits only, any case ("chatpad" is Chat Pad, "whatsapp" is WhatsApp).
func plain(_ s: String) -> String {
  String(String.UnicodeScalarView(s.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) })).lowercased()
}

/// An app by its name or bundle id, or the one in front: Jarvis looks at any app, behind others or not. Part of a
/// name will do when only one open app has it; otherwise why not.
func named(_ name: String) -> (App?, String) {
  if name.isEmpty { return (front(), "No app is in front.") }
  let want = plain(name)
  let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
  if let a = apps.first(where: { plain($0.localizedName ?? "") == want || $0.bundleIdentifier?.lowercased() == name.lowercased() }) {
    return (App(app: a), "")
  }
  let some = want.isEmpty ? [] : apps.filter { plain($0.localizedName ?? "").contains(want) }
  if some.count == 1 { return (App(app: some[0]), "") }
  if some.count > 1 { return (nil, "Several open apps are called something like \(name): \(some.map { App(app: $0).name }.joined(separator: ", ")). Say which.") }
  return (nil, "\(name) is not open on this Mac: open it first.")
}

/// Apps made with Electron (Slack, Discord and the like) show their window's page to Accessibility only once asked:
/// asked at each look until it shows, the first time with up to three seconds for the page to come through.
var asked: Set<pid_t> = []
/// Those apps: keys sent to one behind other windows never reach its page.
var electron: Set<pid_t> = []
func reveal(_ app: AXUIElement, _ pid: pid_t) {
  if electron.contains(pid) && paged(app) { return }
  guard AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success else { return }
  electron.insert(pid)
  guard !asked.contains(pid) else { return }
  asked.insert(pid)
  for _ in 0..<12 {
    if paged(app) { return }
    usleep(250_000)
  }
}

/// Whether a window's page has come through: a web area with something in it.
func paged(_ app: AXUIElement) -> Bool {
  var queue = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  var seen = 0
  while !queue.isEmpty && seen < 500 {
    let el = queue.removeFirst()
    seen += 1
    if str(el, kAXRoleAttribute) == "AXWebArea" { return !children(el).isEmpty }
    queue += children(el)
  }
  return false
}

/// The app the last look was of, while it runs: what is pressed, typed or scrolled goes to it alone, where it is.
func looked() -> App? {
  guard lastPid != 0, let a = NSRunningApplication(processIdentifier: lastPid), !a.isTerminated else { return nil }
  return App(app: a)
}

/// Its window on screen, for a picture of that window alone (screencapture -l), covered or not.
func windowNumber(_ pid: pid_t) -> Int? {
  let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
  return list.first { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid && ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 }
    .flatMap { ($0[kCGWindowNumber as String] as? NSNumber)?.intValue }
}

/// What an app's window shows, in front or behind: numbered elements to press or fill, and its words, within `max` characters.
func read(max: Int, name: String) -> [String: Any] {
  let (app_, why) = named(name)
  guard let f = app_ else { return ["ok": false, "text": why] }
  let app = AXUIElementCreateApplication(f.pid)
  reveal(app, f.pid)
  var found: [AXUIElement] = []
  var lines: [String] = []
  var words: [String] = []
  var budget = max
  var visited = 0
  func say(_ el: AXUIElement, role: String) {
    let label = [str(el, kAXTitleAttribute), str(el, kAXDescriptionAttribute), str(el, "AXPlaceholderValue")]
      .first { !$0.isEmpty } ?? ""
    let value = isSecure(el) ? "" : str(el, kAXValueAttribute)
    var line = "[\(found.count + 1)] \(NAMES[role] ?? role.replacingOccurrences(of: "AX", with: "").lowercased())"
    if !label.isEmpty { line += " \"\(label.prefix(80))\"" }
    if !value.isEmpty && value != label { line += " = \"\(value.prefix(120))\"" }
    if str(el, kAXEnabledAttribute) == "0" { line += " (dimmed)" }
    found.append(el)
    lines.append(line)
    budget -= line.count
  }
  func walk(_ el: AXUIElement, depth: Int) {
    visited += 1
    if visited > 4000 || depth > 30 || budget <= 0 || found.count >= 200 { return }
    let role = str(el, kAXRoleAttribute)
    if ACTIONABLE.contains(role) || role == "AXSecureTextField" || actions(el).contains(kAXPressAction) && role != "AXGroup" && role != "AXWindow" && role != "AXScrollArea" {
      say(el, role: role)
    } else if role == "AXStaticText" || role == "AXHeading" {
      let v = str(el, kAXValueAttribute)
      if !v.isEmpty && budget > 0 {
        words.append(String(v.prefix(300)))
        budget -= min(v.count, 300)
      }
    }
    for c in children(el) { walk(c, depth: depth + 1) }
  }
  // The menu bar's own menus first, and an open menu's items with them.
  if let bar = attr(app, kAXMenuBarAttribute) {
    for item in children(bar as! AXUIElement) {
      say(item, role: "AXMenuBarItem")
      if str(item, kAXSelectedAttribute) == "1" { for c in children(item) { walk(c, depth: 1) } }
    }
  }
  let windows = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  let window = (attr(app, kAXFocusedWindowAttribute) ?? attr(app, kAXMainWindowAttribute)).map { $0 as! AXUIElement } ?? windows.first
  let title = window.map { str($0, kAXTitleAttribute) } ?? ""
  if let w = window { walk(w, depth: 0) }
  last[f.pid] = found
  lastPid = f.pid
  let head = "App: \(f.name) (\(f.app.isActive ? "in front" : "behind other windows"))\nWindow: \(title.isEmpty ? "(none)" : "\"\(title)\"")"
  var text = head + "\n" + lines.joined(separator: "\n")
  if !words.isEmpty { text += "\nText:\n" + words.joined(separator: "\n") }
  if budget <= 0 { text += "\n(more not shown)" }
  var out: [String: Any] = ["ok": true, "text": text, "app": f.name, "bundle": f.bundle]
  if let w = windowNumber(f.pid) { out["window"] = w }
  return out
}

/// The app last looked at, unless it is gone or one Jarvis never types or presses into.
func target(_ deny: [String]) -> (App?, String?) {
  guard let a = looked() else { return (nil, "Look at the app first, by its name.") }
  if deny.contains(a.bundle) { return (nil, "Not in \(a.name): Jarvis does not type or press there.") }
  return (a, nil)
}

let BEHIND = "it would have to come to the front first (act front), which Jarvis does only when they say so."
/// Where text is typed: pressing one puts the cursor in it, in front or behind.
let FIELDS: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]

func element(_ n: Int) -> AXUIElement? {
  guard let list = last[lastPid], n >= 1, n <= list.count else { return nil }
  return list[n - 1]
}

func click(at p: CGPoint) {
  let src = CGEventSource(stateID: .hidSystemState)
  for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
    CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(30_000)
  }
}

func press(_ n: Int, deny: [String]) -> [String: Any] {
  let (a, why) = target(deny)
  guard let a else { return ["ok": false, "text": why ?? ""] }
  guard let el = element(n) else { return ["ok": false, "text": "No element \(n) in the last look at \(a.name): look again."] }
  if isSecure(el) { return ["ok": false, "text": "That is a password field: Jarvis never types a password."] }
  if FIELDS.contains(str(el, kAXRoleAttribute)) {
    field = (a.pid, el)
    // A page's field is typed into by its value, the cursor or not; any other only once the cursor is really there.
    if inPage(el) { AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue) }
    return inPage(el) || into(el, a.pid)
      ? ["ok": true, "app": a.name, "text": "The cursor is in that field in \(a.name): type now."]
      : ["ok": false, "text": "The cursor would not go into that field in \(a.name) from behind: \(BEHIND)"]
  }
  // Through Accessibility, wherever the window is: nothing of the person's is touched.
  if AXUIElementPerformAction(el, kAXPressAction as CFString) == .success { return ["ok": true, "app": a.name] }
  // A real click only on an app in front, at a place that is its own.
  guard a.app.isActive, let r = frame(el) else { return ["ok": false, "text": "That cannot be pressed in \(a.name) from behind: \(BEHIND)"] }
  click(at: CGPoint(x: r.midX, y: r.midY))
  return ["ok": true, "app": a.name]
}

func focus(_ n: Int, deny: [String]) -> [String: Any] {
  let (a, why) = target(deny)
  guard let a else { return ["ok": false, "text": why ?? ""] }
  guard let el = element(n) else { return ["ok": false, "text": "No element \(n) in the last look at \(a.name): look again."] }
  if isSecure(el) { return ["ok": false, "text": "That is a password field: Jarvis never types a password."] }
  return AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success ? ["ok": true, "app": a.name] : ["ok": false, "text": "It could not be focused."]
}

/// The field last pressed, and its app: typed into next while that app is the one looked at.
var field: (pid_t, AXUIElement)?

/// Whether an element is part of a web page (an Electron app's window, a browser's).
func inPage(_ el: AXUIElement) -> Bool {
  var at = el
  for _ in 0..<60 {
    if str(at, kAXRoleAttribute) == "AXWebArea" { return true }
    guard let p = attr(at, kAXParentAttribute) else { return false }
    at = p as! AXUIElement
  }
  return false
}

/// Waits up to `ms` for something to be so.
func settle(_ ms: Int = 800, _ so: () -> Bool) -> Bool {
  for _ in 0..<(ms / 100) {
    if so() { return true }
    usleep(100_000)
  }
  return so()
}

/// Whether the cursor is in that field.
func holds(_ el: AXUIElement, _ pid: pid_t) -> Bool {
  (attr(el, kAXFocusedAttribute) as? Bool) == true
    || attr(AXUIElementCreateApplication(pid), kAXFocusedUIElementAttribute).map { CFEqual($0, el) } == true
}

/// The cursor put in a field: pressed, which UIKit apps such as WhatsApp take from behind, else focused. Whether it is
/// there: an app can say yes to being focused and stay as it was.
func into(_ el: AXUIElement, _ pid: pid_t) -> Bool {
  if holds(el, pid) { return true }
  AXUIElementPerformAction(el, kAXPressAction as CFString)
  if settle(500, { holds(el, pid) }) { return true }
  AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  return settle(500) { holds(el, pid) }
}

/// UIKit apps on a Mac (Mac Catalyst and iPad apps: WhatsApp, Messages, Weather…): text Accessibility writes into
/// their fields shows but the app never notices it, so nothing is sent; they are typed into as keys.
func uikit(_ a: App) -> Bool {
  a.app.bundleURL.flatMap { Bundle(url: $0)?.object(forInfoDictionaryKey: "UIDeviceFamily") } != nil
}

/// Keys for the text, one character at a time, to that app alone.
func keys(_ text: String, _ pid: pid_t) {
  let src = CGEventSource(stateID: .hidSystemState)
  for ch in text {
    let units = Array(String(ch).utf16)
    for down in [true, false] {
      let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)
      e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
      e?.postToPid(pid)
    }
    usleep(6_000)
  }
}

/// Text into field `n` of the last look, else the one last pressed, else the one with the app's cursor, in front or
/// behind, and said to be typed only once the field shows it (a page's field cannot be read back at once: Jarvis is
/// told to look). A Mac app's own field takes it through Accessibility; a UIKit app's gets keys.
func type(_ text: String, into n: Int?, deny: [String]) -> [String: Any] {
  let (a, why) = target(deny)
  guard let a else { return ["ok": false, "text": why ?? ""] }
  var chosen: AXUIElement?
  if let n {
    guard let el = element(n) else { return ["ok": false, "text": "No element \(n) in the last look at \(a.name): look again."] }
    chosen = el
  } else if let (pid, el) = field, pid == a.pid {
    chosen = el
  }
  guard let el = chosen ?? attr(AXUIElementCreateApplication(a.pid), kAXFocusedUIElementAttribute).map({ $0 as! AXUIElement }) else {
    return ["ok": false, "text": "No field to type into in \(a.name): press one first (press N)."]
  }
  if isSecure(el) { return ["ok": false, "text": "That is a password field: Jarvis never types a password."] }
  let before = str(el, kAXValueAttribute)
  // A page's field (Electron, Safari) says yes to selected text and does nothing: its value is written, as typing would.
  if inPage(el) {
    AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    return AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, (before + text) as CFString) == .success
      ? ["ok": true, "app": a.name, "text": "Typed in \(a.name). Look again to see it there before saying it is done."]
      : ["ok": false, "text": "\(a.name) did not take the text."]
  }
  let shows = { settle { let now = str(el, kAXValueAttribute); return now != before && now.contains(text) } }
  let typed: [String: Any] = ["ok": true, "app": a.name, "text": "Typed in \(a.name)."]
  if !uikit(a) {
    if AXUIElementSetAttributeValue(el, kAXSelectedTextAttribute as CFString, text as CFString) == .success, shows() { return typed }
    var settable: DarwinBoolean = false
    if AXUIElementIsAttributeSettable(el, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue,
       AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, (before + text) as CFString) == .success, shows() {
      return typed
    }
  }
  if IsSecureEventInputEnabled() { return ["ok": false, "text": "Secure input is on (a password is being typed somewhere): not now."] }
  guard into(el, a.pid) else { return ["ok": false, "text": "The cursor would not go into that field in \(a.name) from behind: \(BEHIND)"] }
  keys(text, a.pid)
  if shows() { return typed }
  return ["ok": false, "text": "\(a.name) did not take the typing\(a.app.isActive ? "." : " from behind: \(BEHIND)")"]
}

let KEYS: [String: Int] = [
  "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E, "f": kVK_ANSI_F, "g": kVK_ANSI_G,
  "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L, "m": kVK_ANSI_M, "n": kVK_ANSI_N,
  "o": kVK_ANSI_O, "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T, "u": kVK_ANSI_U,
  "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X, "y": kVK_ANSI_Y, "z": kVK_ANSI_Z,
  "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6,
  "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
  "-": kVK_ANSI_Minus, "=": kVK_ANSI_Equal, "[": kVK_ANSI_LeftBracket, "]": kVK_ANSI_RightBracket, ";": kVK_ANSI_Semicolon,
  "'": kVK_ANSI_Quote, ",": kVK_ANSI_Comma, ".": kVK_ANSI_Period, "/": kVK_ANSI_Slash, "\\": kVK_ANSI_Backslash, "`": kVK_ANSI_Grave,
  "return": kVK_Return, "tab": kVK_Tab, "space": kVK_Space, "delete": kVK_Delete, "forwarddelete": kVK_ForwardDelete,
  "escape": kVK_Escape, "left": kVK_LeftArrow, "right": kVK_RightArrow, "up": kVK_UpArrow, "down": kVK_DownArrow,
  "home": kVK_Home, "end": kVK_End, "pageup": kVK_PageUp, "pagedown": kVK_PageDown,
  "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5, "f6": kVK_F6, "f7": kVK_F7, "f8": kVK_F8,
  "f9": kVK_F9, "f10": kVK_F10, "f11": kVK_F11, "f12": kVK_F12,
]
let MODS: [String: CGEventFlags] = ["cmd": .maskCommand, "shift": .maskShift, "alt": .maskAlternate, "ctrl": .maskControl, "fn": .maskSecondaryFn]

/// A key or combo to the app last looked at: sent to that app alone, in front or behind (and so never to the app in use).
func key(_ name: String, mods: [String], deny: [String]) -> [String: Any] {
  let (a, why) = target(deny)
  guard let a else { return ["ok": false, "text": why ?? ""] }
  guard let code = KEYS[name] else { return ["ok": false, "text": "No such key: \(name)."] }
  if electron.contains(a.pid) && !a.app.isActive {
    return ["ok": false, "text": "Keys do not reach \(a.name) from behind: press its buttons instead (press N), or \(BEHIND)"]
  }
  if IsSecureEventInputEnabled() { return ["ok": false, "text": "Secure input is on (a password is being typed somewhere): not now."] }
  let flags = mods.reduce(CGEventFlags()) { $0.union(MODS[$1] ?? []) }
  let src = CGEventSource(stateID: .hidSystemState)
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(code), keyDown: down)
    e?.flags = flags
    e?.postToPid(a.pid)
    usleep(20_000)
  }
  // Whether it did anything cannot be told from here.
  return ["ok": true, "app": a.name, "text": "Sent to \(a.name). Look again to see what it did before saying it is done."]
}

/// The nearest scroll area: around element `n`, or the first in the app's window.
func scrollArea(_ n: Int?, _ a: App) -> AXUIElement? {
  if let n, var el = element(n) {
    for _ in 0..<30 {
      if str(el, kAXRoleAttribute) == "AXScrollArea" { return el }
      guard let p = attr(el, kAXParentAttribute) else { return nil }
      el = p as! AXUIElement
    }
    return nil
  }
  let app = AXUIElementCreateApplication(a.pid)
  guard let w = (attr(app, kAXFocusedWindowAttribute) ?? attr(app, kAXMainWindowAttribute)) else { return nil }
  var queue = [w as! AXUIElement]
  var seen = 0
  while !queue.isEmpty && seen < 1500 {
    let el = queue.removeFirst()
    seen += 1
    if str(el, kAXRoleAttribute) == "AXScrollArea" { return el }
    queue += children(el)
  }
  return nil
}

/// A screenful up or down, by its scroll bar, wherever the window is.
func scroll(_ n: Int?, up: Bool) -> [String: Any] {
  let (a, why) = target([])
  guard let a else { return ["ok": false, "text": why ?? ""] }
  guard let area = scrollArea(n, a), let bar = attr(area, kAXVerticalScrollBarAttribute),
        let now = (attr(bar as! AXUIElement, kAXValueAttribute) as? NSNumber)?.doubleValue else {
    return ["ok": false, "text": "Nothing there scrolls in \(a.name)."]
  }
  let to = min(1, max(0, now + (up ? -0.2 : 0.2)))
  guard AXUIElementSetAttributeValue(bar as! AXUIElement, kAXValueAttribute as CFString, NSNumber(value: to)) == .success else {
    return ["ok": false, "text": "It could not be scrolled from behind: \(BEHIND)"]
  }
  return ["ok": true, "app": a.name]
}

/// The app last looked at brought to the front: only when its person said so.
func activate() -> [String: Any] {
  guard let a = looked() else { return ["ok": false, "text": "Look at the app first, by its name."] }
  if AXUIElementSetAttributeValue(AXUIElementCreateApplication(a.pid), kAXFrontmostAttribute as CFString, kCFBooleanTrue) != .success { a.app.activate() }
  for _ in 0..<20 {
    usleep(100_000)
    pump()
    if NSWorkspace.shared.frontmostApplication?.processIdentifier == a.pid { return ["ok": true, "app": a.name, "text": "\(a.name) is in front."] }
  }
  return ["ok": false, "app": a.name, "text": "\(a.name) did not come to the front."]
}

func answer(_ req: [String: Any]) -> [String: Any] {
  let deny = (req["deny"] as? [String]) ?? []
  let n = (req["n"] as? NSNumber)?.intValue
  switch req["cmd"] as? String {
  case "trusted": return ["ok": AXIsProcessTrusted()]
  case "front":
    guard let f = front() else { return ["ok": false, "text": "No app is in front."] }
    return ["ok": true, "app": f.name, "bundle": f.bundle]
  case "read": return AXIsProcessTrusted() ? read(max: (req["max"] as? NSNumber)?.intValue ?? 6000, name: (req["name"] as? String) ?? "") : untrusted
  case "press": return AXIsProcessTrusted() ? press(n ?? 0, deny: deny) : untrusted
  case "focus": return AXIsProcessTrusted() ? focus(n ?? 0, deny: deny) : untrusted
  case "type": return AXIsProcessTrusted() ? type((req["text"] as? String) ?? "", into: n, deny: deny) : untrusted
  case "key": return AXIsProcessTrusted() ? key((req["key"] as? String) ?? "", mods: (req["mods"] as? [String]) ?? [], deny: deny) : untrusted
  case "scroll": return AXIsProcessTrusted() ? scroll(n, up: (req["dir"] as? String) == "up") : untrusted
  case "activate": return AXIsProcessTrusted() ? activate() : untrusted
  default: return ["ok": false, "text": "No such command."]
  }
}

let untrusted: [String: Any] = [
  "ok": false,
  "text": "Jarvis is not allowed to use this Mac's apps: allow Jarvis in System Settings → Privacy & Security → Accessibility.",
]

while let line = readLine() {
  guard let data = line.data(using: .utf8), let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
  pump()
  var out = answer(req)
  out["id"] = req["id"] ?? NSNull()
  if let json = try? JSONSerialization.data(withJSONObject: out), let s = String(data: json, encoding: .utf8) { print(s) }
}
