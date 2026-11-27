// jarvis-control: what the desktop app cannot do from Node on a Mac, for Jarvis to use it
// (src/helper.ts). It reads the front app's window through the Accessibility API, and
// presses, types, sends keys and scrolls there. One JSON request a line on stdin, one
// answer a line on stdout, in order: {"id":1,"cmd":"read","max":6000} → {"id":1,"ok":true,…}.
//
// It is a child of the app, so macOS asks for, and keeps, the app's own Accessibility
// permission. It never reads a password field's value, never types or presses into one,
// and refuses to type, send keys or press while the front app is one of `deny` (the
// app's rules.ts: terminals, System Settings, Jarvis itself), checked at that moment.
import AppKit
import ApplicationServices
import Carbon.HIToolbox

setvbuf(stdout, nil, _IOLBF, 0)

/// The numbered elements of the last read, per app: `press 3` is the third of those.
var last: [pid_t: [AXUIElement]] = [:]

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

struct Front {
  let app: NSRunningApplication
  var name: String { app.localizedName ?? "an app" }
  var bundle: String { app.bundleIdentifier ?? "" }
}

func front() -> Front? {
  NSWorkspace.shared.frontmostApplication.map(Front.init)
}

/// What the front window shows: numbered elements to press or fill, and its words, within `max` characters.
func read(max: Int) -> [String: Any] {
  guard let f = front() else { return ["ok": false, "text": "No app is in front."] }
  let app = AXUIElementCreateApplication(f.app.processIdentifier)
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
  let window = (attr(app, kAXFocusedWindowAttribute) ?? attr(app, kAXMainWindowAttribute)).map { $0 as! AXUIElement }
  let title = window.map { str($0, kAXTitleAttribute) } ?? ""
  if let w = window { walk(w, depth: 0) }
  last[f.app.processIdentifier] = found
  let head = "App: \(f.name)\nWindow: \(title.isEmpty ? "(none)" : "\"\(title)\"")"
  var text = head + "\n" + lines.joined(separator: "\n")
  if !words.isEmpty { text += "\nText:\n" + words.joined(separator: "\n") }
  if budget <= 0 { text += "\n(more not shown)" }
  return ["ok": true, "text": text, "app": f.name, "bundle": f.bundle]
}

/// Refused into a password field, under secure input, or while the front app is denied.
func refused(_ deny: [String]) -> String? {
  guard let f = front() else { return "No app is in front." }
  if deny.contains(f.bundle) { return "Not into \(f.name): Jarvis does not type or press there." }
  if IsSecureEventInputEnabled() { return "Secure input is on (a password is being typed somewhere): not now." }
  let system = AXUIElementCreateSystemWide()
  if let focused = attr(system, kAXFocusedUIElementAttribute), isSecure(focused as! AXUIElement) {
    return "That is a password field: Jarvis never types a password."
  }
  return nil
}

func element(_ n: Int) -> AXUIElement? {
  guard let f = front(), let list = last[f.app.processIdentifier], n >= 1, n <= list.count else { return nil }
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
  if let why = refused(deny) { return ["ok": false, "text": why] }
  guard let el = element(n) else { return ["ok": false, "text": "No element \(n) in the last look at this app: look again."] }
  if isSecure(el) { return ["ok": false, "text": "That is a password field: Jarvis never types a password."] }
  if AXUIElementPerformAction(el, kAXPressAction as CFString) == .success { return ["ok": true] }
  guard let r = frame(el) else { return ["ok": false, "text": "It could not be pressed."] }
  click(at: CGPoint(x: r.midX, y: r.midY))
  return ["ok": true]
}

func focus(_ n: Int, deny: [String]) -> [String: Any] {
  if let why = refused(deny) { return ["ok": false, "text": why] }
  guard let el = element(n) else { return ["ok": false, "text": "No element \(n) in the last look at this app: look again."] }
  if isSecure(el) { return ["ok": false, "text": "That is a password field: Jarvis never types a password."] }
  return AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success ? ["ok": true] : ["ok": false, "text": "It could not be focused."]
}

func type(_ text: String, deny: [String]) -> [String: Any] {
  if let why = refused(deny) { return ["ok": false, "text": why] }
  let src = CGEventSource(stateID: .hidSystemState)
  let units = Array(text.utf16)
  var i = 0
  while i < units.count {
    let chunk = Array(units[i..<min(i + 16, units.count)])
    for down in [true, false] {
      let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)
      e?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
      e?.post(tap: .cghidEventTap)
    }
    usleep(8_000)
    i += 16
  }
  return ["ok": true]
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

func key(_ name: String, mods: [String], deny: [String]) -> [String: Any] {
  if let why = refused(deny) { return ["ok": false, "text": why] }
  guard let code = KEYS[name] else { return ["ok": false, "text": "No such key: \(name)."] }
  let flags = mods.reduce(CGEventFlags()) { $0.union(MODS[$1] ?? []) }
  let src = CGEventSource(stateID: .hidSystemState)
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(code), keyDown: down)
    e?.flags = flags
    e?.post(tap: .cghidEventTap)
    usleep(20_000)
  }
  return ["ok": true]
}

func scroll(_ n: Int?, up: Bool) -> [String: Any] {
  if let n {
    guard let el = element(n), let r = frame(el) else { return ["ok": false, "text": "No element \(n) in the last look at this app: look again."] }
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: r.midX, y: r.midY), mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(30_000)
  }
  CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: up ? 8 : -8, wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
  return ["ok": true]
}

func answer(_ req: [String: Any]) -> [String: Any] {
  let deny = (req["deny"] as? [String]) ?? []
  let n = (req["n"] as? NSNumber)?.intValue
  switch req["cmd"] as? String {
  case "trusted": return ["ok": AXIsProcessTrusted()]
  case "front":
    guard let f = front() else { return ["ok": false, "text": "No app is in front."] }
    return ["ok": true, "app": f.name, "bundle": f.bundle]
  case "read": return AXIsProcessTrusted() ? read(max: (req["max"] as? NSNumber)?.intValue ?? 6000) : untrusted
  case "press": return AXIsProcessTrusted() ? press(n ?? 0, deny: deny) : untrusted
  case "focus": return AXIsProcessTrusted() ? focus(n ?? 0, deny: deny) : untrusted
  case "type": return AXIsProcessTrusted() ? type((req["text"] as? String) ?? "", deny: deny) : untrusted
  case "key": return AXIsProcessTrusted() ? key((req["key"] as? String) ?? "", mods: (req["mods"] as? [String]) ?? [], deny: deny) : untrusted
  case "scroll": return AXIsProcessTrusted() ? scroll(n, up: (req["dir"] as? String) == "up") : untrusted
  default: return ["ok": false, "text": "No such command."]
  }
}

let untrusted: [String: Any] = [
  "ok": false,
  "text": "Jarvis is not allowed to use this Mac's apps: allow Jarvis in System Settings → Privacy & Security → Accessibility.",
]

while let line = readLine() {
  guard let data = line.data(using: .utf8), let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
  var out = answer(req)
  out["id"] = req["id"] ?? NSNull()
  if let json = try? JSONSerialization.data(withJSONObject: out), let s = String(data: json, encoding: .utf8) { print(s) }
}
