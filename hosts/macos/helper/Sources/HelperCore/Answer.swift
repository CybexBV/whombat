import Foundation

// What the helper answers: `{"ok": true, ...}` or `{"ok": false, "code", "message"}`, as one line of snake_case JSON.
// Empty strings and empty lists are left out to keep a long list small; the agent reads a missing field as empty.

public struct ElementInfo: Encodable, Equatable, Sendable {
    /// The element's place in the tree (“w0.3.1”: window 0, its child 3, that one's child 1); it only means something
    /// for the list it came in.
    public var id: String
    public var role: String
    public var subrole: String = ""
    public var title: String = ""
    public var desc: String = ""
    public var value: String = ""
    public var ident: String = ""
    public var enabled: Bool = true
    public var focused: Bool = false
    public var x: Int = 0
    public var y: Int = 0
    public var w: Int = 0
    public var h: Int = 0
    public var actions: [String] = []
    public var app: String = ""
    public var window: String = ""
    /// The element itself (`focused` only): the same for the same element as long as it exists, another for another
    /// element. The agent pins a password field by it and checks before each key that the focus is still that field.
    public var token: String = ""

    public init(id: String, role: String) {
        self.id = id
        self.role = role
    }

    enum CodingKeys: String, CodingKey {
        case id, role, subrole, title, desc, value, ident, enabled, focused, x, y, w, h, actions, app, window, token
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(role, forKey: .role)
        for (key, text) in [(CodingKeys.subrole, subrole), (.title, title), (.desc, desc), (.value, value), (.ident, ident)]
        where !text.isEmpty {
            try c.encode(text, forKey: key)
        }
        try c.encode(enabled, forKey: .enabled)
        try c.encode(focused, forKey: .focused)
        try c.encode(x, forKey: .x)
        try c.encode(y, forKey: .y)
        try c.encode(w, forKey: .w)
        try c.encode(h, forKey: .h)
        if !actions.isEmpty { try c.encode(actions, forKey: .actions) }
        if !app.isEmpty { try c.encode(app, forKey: .app) }
        if !window.isEmpty { try c.encode(window, forKey: .window) }
        if !token.isEmpty { try c.encode(token, forKey: .token) }
    }
}

public struct AppInfo: Encodable, Equatable, Sendable {
    public var name: String
    public var bundleID: String
    public var pid: Int32
    public var active: Bool
    public var windows: [String]

    public init(name: String, bundleID: String, pid: Int32, active: Bool, windows: [String]) {
        self.name = name
        self.bundleID = bundleID
        self.pid = pid
        self.active = active
        self.windows = windows
    }

    enum CodingKeys: String, CodingKey {
        case name, bundleID = "bundle_id", pid, active, windows
    }
}

public struct StatusInfo: Encodable, Equatable, Sendable {
    public var version: String
    public var ax: Bool
    public var locked: Bool
    public var user: String
    public var frontApp: String?
    public var frontWindow: String?
    public var displays: [DisplayInfo]

    public init(version: String, ax: Bool, locked: Bool, user: String, frontApp: String?, frontWindow: String?,
                displays: [DisplayInfo]) {
        self.version = version
        self.ax = ax
        self.locked = locked
        self.user = user
        self.frontApp = frontApp
        self.frontWindow = frontWindow
        self.displays = displays
    }
}

public enum Answer: Equatable, Sendable {
    case done
    /// Done, with a word on what happened (`message`).
    case note(String)
    case status(StatusInfo)
    case apps([AppInfo])
    case elements([ElementInfo], truncated: Bool)
    case element(ElementInfo, note: String?)
    case windows([WindowInfo], truncated: Bool)
    /// The focused element and its process (`pid`, `bundle_id`; the element's role and place only).
    case focused(ElementInfo, pid: Int32, bundleID: String)
    case failure(HelperError)

    /// The answer as one line, newline included, never longer than the agent reads: a list that would be is cut
    /// (and says so), anything else becomes `failed`.
    public func line() -> Data {
        var data = encoded()
        if data.count > Limits.maxAnswerBytes, case let .elements(list, _) = self {
            var keep = list.count / 2
            while keep > 0 {
                data = Answer.elements(Array(list.prefix(keep)), truncated: true).encoded()
                if data.count <= Limits.maxAnswerBytes { break }
                keep /= 2
            }
        }
        if data.count > Limits.maxAnswerBytes {
            data = Answer.failure(HelperError(.failed, "the answer was too big to send")).encoded()
        }
        data.append(0x0A)
        return data
    }

    func encoded() -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        do {
            return try encoder.encode(Wire(self))
        } catch {
            // Only non-finite numbers fail to encode, and the helper sends none; still, answer something.
            return Data(#"{"code":"failed","message":"the answer couldn't be written","ok":false}"#.utf8)
        }
    }
}

/// The JSON shape of an answer.
private struct Wire: Encodable {
    let answer: Answer

    init(_ answer: Answer) { self.answer = answer }

    enum Key: String, CodingKey {
        case ok, code, message, names, version, ax, locked, user, frontApp = "front_app", frontWindow = "front_window"
        case displays, apps, elements, truncated, element, windows, pid, bundleID = "bundle_id"
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        if case let .failure(error) = answer {
            try c.encode(false, forKey: .ok)
            try c.encode(error.code, forKey: .code)
            try c.encode(error.message, forKey: .message)
            if !error.names.isEmpty { try c.encode(error.names, forKey: .names) }
            return
        }
        try c.encode(true, forKey: .ok)
        switch answer {
        case .done, .failure:
            break
        case let .note(text):
            try c.encode(text, forKey: .message)
        case let .status(s):
            try c.encode(s.version, forKey: .version)
            try c.encode(s.ax, forKey: .ax)
            try c.encode(s.locked, forKey: .locked)
            try c.encode(s.user, forKey: .user)
            try c.encodeIfPresent(s.frontApp, forKey: .frontApp)
            try c.encodeIfPresent(s.frontWindow, forKey: .frontWindow)
            try c.encode(s.displays, forKey: .displays)
        case let .apps(apps):
            try c.encode(apps, forKey: .apps)
        case let .elements(list, truncated):
            try c.encode(list, forKey: .elements)
            try c.encode(truncated, forKey: .truncated)
        case let .element(element, note):
            try c.encode(element, forKey: .element)
            try c.encodeIfPresent(note, forKey: .message)
        case let .windows(list, truncated):
            try c.encode(list, forKey: .windows)
            try c.encode(truncated, forKey: .truncated)
        case let .focused(element, pid, bundleID):
            try c.encode(element, forKey: .element)
            try c.encode(pid, forKey: .pid)
            if !bundleID.isEmpty { try c.encode(bundleID, forKey: .bundleID) }
        }
    }
}
