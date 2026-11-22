import Foundation

// The helper's side of the socket protocol (whombat-hosts docs/decisions/hosts.md, the helper's rows): one JSON line
// in, one JSON line out. The agent writes `{"v": 1, "op": "...", ...}`; this file turns that line into a Command the
// app can carry out, or a HelperError the agent can show.

/// The error codes the agent knows. Anything unexpected is `failed`.
public enum ErrorCode: String, Sendable, Codable {
    case noAccess = "no_access"
    case notFound = "not_found"
    case invalidRequest = "invalid_request"
    case failed
    case locked
    /// The helper already answers as many requests as it takes; sent as it closes the connection, before the request.
    case busy
}

/// An answer that says no: its code, a short plain message, and for `not_found` the names that came closest.
public struct HelperError: Error, Equatable, Sendable {
    public var code: ErrorCode
    public var message: String
    public var names: [String]

    public init(_ code: ErrorCode, _ message: String, names: [String] = []) {
        self.code = code
        self.message = message
        self.names = names
    }

    public static func invalid(_ message: String) -> HelperError { HelperError(.invalidRequest, message) }
}

/// Bounds that keep one request small and quick, whatever the agent or a stuck app does.
public enum Limits {
    public static let protocolVersion = 1
    /// The longest request line; a `type` text is the biggest thing a request carries.
    public static let maxRequestBytes = 1 << 20
    /// The longest answer line the agent reads.
    public static let maxAnswerBytes = 16 << 20
    /// The agent waits a little longer than this; work that runs past it is answered with `failed`.
    public static let requestSeconds: TimeInterval = 10
    /// Work stops a moment before the request's 10 s so a long list still comes back, cut short.
    public static let workSeconds: TimeInterval = 8.5
    /// `geocode` and `map` ask Apple's map service over the network, which takes longer.
    public static let slowRequestSeconds: TimeInterval = 20
    /// The share of a request's time its work may use: the rest is for answering.
    public static let workShare = workSeconds / requestSeconds
    public static let defaultListLimit = 300
    public static let maxListLimit = 1000
    public static let defaultDepth = 12
    public static let maxDepth = 30
    /// How deep press/set/menu search: web pages nest buttons far deeper than a list needs to show.
    public static let searchDepth = 30
    /// Elements visited by one list or search, counted or not: a huge table can't keep the helper busy.
    public static let maxVisited = 20_000
    /// Children read from one element (a long table or list beyond this is cut).
    public static let maxChildren = 500
    /// Title, description, value and identifier are cut to this many characters.
    public static let maxFieldCharacters = 200
    public static let maxTypedCharacters = 10_000
    /// The longest password unlock types.
    public static let maxPasswordCharacters = 128
    public static let maxNameCharacters = 500
    public static let maxMenuDepth = 10
    public static let maxApps = 200
    public static let maxWindowsPerApp = 50
    /// The names a `not_found` answer suggests.
    public static let closeNames = 10
    /// The longest action name (`action`).
    public static let maxActionCharacters = 200
    /// How many places one `geocode` looks up, and the longest of them.
    public static let maxQueries = 8
    public static let maxQueryCharacters = 300
    /// How long `quit` waits for the app to end.
    public static let quitSeconds: TimeInterval = 3
}

/// Which elements to look at: an app (name or bundle id, nil = the one in front), and for press/set the name, roles
/// and which match.
public struct Target: Equatable, Sendable {
    public var app: String?
    public var name: String?
    public var roles: RoleFilter
    public var index: Int

    public init(app: String? = nil, name: String? = nil, roles: RoleFilter = .any, index: Int = 0) {
        self.app = app
        self.name = name
        self.roles = roles
        self.index = index
    }
}

public struct ListQuery: Equatable, Sendable {
    public var app: String?
    public var window: String?
    public var roles: RoleFilter
    public var limit: Int
    public var depth: Int
}

public enum OpenTarget: Equatable, Sendable {
    case accessibility
    case url(URL)
    case app(String)
}

/// One request the helper understood.
public enum Command: Equatable, Sendable {
    case status
    case apps
    case list(ListQuery)
    case press(Target)
    case set(Target, value: String)
    case type(String)
    case menu(app: String?, path: [String])
    case focus(app: String)
    case open(OpenTarget)
    /// Types the person's password into the lock screen (the agent's unlock).
    case unlock(password: String)
    /// The windows on the screen, front to back: their owners and places, never their titles.
    case windows
    /// The element with the keyboard focus: its process, role and place, never its value or title (the agent checks
    /// a password field has the keyboard before typing a password).
    case focused
    /// Runs an action of the element `Target` names by the action's name (an app's own, such as Find My's “Play”).
    case action(Target, action: String)
    /// Asks a running app to quit, as its Quit menu item does.
    case quit(app: String)
    /// Finds places by address with Apple's geocoder.
    case geocode([String])
    /// Draws a map picture with MapKit.
    case map(MapRequest)

    public var op: String {
        switch self {
        case .status: "status"
        case .apps: "apps"
        case .list: "list"
        case .press: "press"
        case .set: "set"
        case .type: "type"
        case .menu: "menu"
        case .focus: "focus"
        case .open: "open"
        case .unlock: "unlock"
        case .windows: "windows"
        case .focused: "focused"
        case .action: "action"
        case .quit: "quit"
        case .geocode: "geocode"
        case .map: "map"
        }
    }

    /// How long the agent gives it: Apple's map service may take a while.
    public var seconds: TimeInterval {
        switch self {
        case .geocode, .map: Limits.slowRequestSeconds
        default: Limits.requestSeconds
        }
    }

    /// The time a request line gets, read before it runs; a line that doesn't parse is answered quickly anyway.
    public static func seconds(forLine line: Data) -> TimeInterval {
        (try? parse(line))?.seconds ?? Limits.requestSeconds
    }

    /// Needs Accessibility to do anything: the rest answer without it (status says it's off; apps lists apps
    /// without their windows; focus and open ask macOS, not the app; windows asks the window server).
    public var needsAccessibility: Bool {
        switch self {
        case .list, .press, .set, .type, .menu, .unlock, .focused, .action: true
        case .status, .apps, .focus, .open, .windows, .quit, .geocode, .map: false
        }
    }

    /// Reads or acts on what is on the screen, which while the screen is locked is the lock screen, not the apps.
    /// Quitting an app, finding places and drawing a map don't touch what is on the screen.
    public var refusedWhileLocked: Bool {
        switch self {
        case .status, .apps, .unlock, .windows, .focused, .quit, .geocode, .map: false
        case .list, .press, .set, .type, .menu, .focus, .open, .action: true
        }
    }
}

/// The request line as JSON: every field optional here, each op checks its own.
struct RawRequest: Decodable {
    var v: Int?
    var op: String?
    var app: String?
    var window: String?
    var limit: Int?
    var depth: Int?
    var name: String?
    var role: String?
    var index: Int?
    var value: String?
    var text: String?
    var path: [String]?
    var target: String?
    var password: String?
    var action: String?
    var queries: [String]?
    var w: Int?
    var h: Int?
    var scale: Int?
    var dark: Bool?
    var format: String?
    var pins: [RawPin]?
    var lat: Double?
    var lon: Double?
    var spanM: Double?

    enum CodingKeys: String, CodingKey {
        case v, op, app, window, limit, depth, name, role, index, value, text, path, target, password, action, queries
        case w, h, scale, dark, format, pins, lat, lon, spanM = "span_m"
    }
}

struct RawPin: Decodable {
    var lat: Double?
    var lon: Double?
}

extension Command {
    /// Reads one request line. Unknown fields are ignored, so a newer agent can add some.
    public static func parse(_ line: Data) throws -> Command {
        if line.count > Limits.maxRequestBytes { throw HelperError.invalid("the request is too long") }
        let raw: RawRequest
        do {
            raw = try JSONDecoder().decode(RawRequest.self, from: line)
        } catch let DecodingError.typeMismatch(_, context), let DecodingError.valueNotFound(_, context) {
            guard let field = context.codingPath.first?.stringValue else {
                throw HelperError.invalid("the request isn't a JSON object")
            }
            throw HelperError.invalid("\(field) has the wrong type")
        } catch {
            throw HelperError.invalid("the request isn't a JSON object")
        }
        // A missing version is version 1, the only one there is.
        if let v = raw.v, v != Limits.protocolVersion {
            throw HelperError.invalid("protocol version \(v) isn't supported (this helper speaks \(Limits.protocolVersion))")
        }
        let app = try optionalName(raw.app, field: "app")
        switch raw.op ?? "" {
        case "status":
            return .status
        case "apps":
            return .apps
        case "windows":
            return .windows
        case "focused":
            return .focused
        case "list":
            return .list(ListQuery(
                app: app,
                window: try optionalName(raw.window, field: "window"),
                roles: try RoleFilter.parse(raw.role),
                limit: try clamp(raw.limit, field: "limit", default: Limits.defaultListLimit, max: Limits.maxListLimit),
                depth: try clamp(raw.depth, field: "depth", default: Limits.defaultDepth, max: Limits.maxDepth)
            ))
        case "press":
            guard let name = try optionalName(raw.name, field: "name") else {
                throw HelperError.invalid("press needs the name of what to press")
            }
            return .press(Target(app: app, name: name, roles: try RoleFilter.parse(raw.role), index: try index(raw.index)))
        case "set":
            // Missing and empty differ: "" clears a field, a missing value is a mistake that mustn't clear one.
            guard let value = raw.value else { throw HelperError.invalid("set needs a value") }
            if value.count > Limits.maxTypedCharacters {
                throw HelperError.invalid("the value is longer than \(Limits.maxTypedCharacters) characters")
            }
            let target = Target(
                app: app,
                name: try optionalName(raw.name, field: "name"),
                roles: try RoleFilter.parse(raw.role),
                index: try index(raw.index)
            )
            return .set(target, value: value)
        case "type":
            guard let text = raw.text, !text.isEmpty else { throw HelperError.invalid("type needs some text") }
            if text.count > Limits.maxTypedCharacters {
                throw HelperError.invalid("the text is longer than \(Limits.maxTypedCharacters) characters")
            }
            return .type(text)
        case "menu":
            let path = (raw.path ?? []).map { $0.trimmingCharacters(in: .whitespaces) }
            if path.isEmpty || path.contains(where: \.isEmpty) {
                throw HelperError.invalid("menu needs a path such as [\"File\", \"Save…\"]")
            }
            if path.count > Limits.maxMenuDepth || path.contains(where: { $0.count > Limits.maxNameCharacters }) {
                throw HelperError.invalid("the menu path is too long")
            }
            return .menu(app: app, path: path)
        case "focus":
            guard let app else { throw HelperError.invalid("focus needs the app to bring forward") }
            return .focus(app: app)
        case "open":
            return .open(try OpenTarget.parse(raw.target))
        case "unlock":
            guard let password = raw.password, !password.isEmpty else { throw HelperError.invalid("unlock needs the password") }
            if password.count > Limits.maxPasswordCharacters || password.contains(where: \.isNewline) {
                throw HelperError.invalid("that isn't a password the lock screen takes")
            }
            return .unlock(password: password)
        case "action":
            guard let name = try optionalName(raw.name, field: "name") else {
                throw HelperError.invalid("action needs the name of the element")
            }
            guard let action = raw.action?.trimmingCharacters(in: .whitespacesAndNewlines), !action.isEmpty else {
                throw HelperError.invalid("action needs the action's name, such as \"Open Details\"")
            }
            if action.count > Limits.maxActionCharacters { throw HelperError.invalid("the action's name is too long") }
            let target = Target(app: app, name: name, roles: try RoleFilter.parse(raw.role), index: try index(raw.index))
            return .action(target, action: action)
        case "quit":
            guard let app else { throw HelperError.invalid("quit needs the app to quit") }
            return .quit(app: app)
        case "geocode":
            let queries = (raw.queries ?? []).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            if queries.isEmpty || queries.count > Limits.maxQueries {
                throw HelperError.invalid("geocode needs 1 to \(Limits.maxQueries) places to find")
            }
            if queries.contains(where: \.isEmpty) { throw HelperError.invalid("a place to find is empty") }
            if queries.contains(where: { $0.count > Limits.maxQueryCharacters }) {
                throw HelperError.invalid("a place to find is longer than \(Limits.maxQueryCharacters) characters")
            }
            return .geocode(queries)
        case "map":
            return .map(try mapRequest(raw))
        case "":
            throw HelperError.invalid("the request has no op")
        case let other:
            throw HelperError.invalid("unknown op \(other)")
        }
    }

    /// A name field: absent or blank is nil, so `"app": ""` means the app in front, as the agent's spec says.
    static func optionalName(_ value: String?, field: String) throws -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        if value.count > Limits.maxNameCharacters { throw HelperError.invalid("\(field) is too long") }
        return value
    }

    /// 0 or absent means the default; above the maximum is the maximum (a list is cut short, not refused).
    static func clamp(_ value: Int?, field: String, default def: Int, max: Int) throws -> Int {
        guard let value, value != 0 else { return def }
        if value < 0 { throw HelperError.invalid("\(field) can't be negative") }
        return Swift.min(value, max)
    }

    static func mapRequest(_ raw: RawRequest) throws -> MapRequest {
        func side(_ v: Int?, _ field: String, _ def: Int) throws -> Int {
            guard let v, v != 0 else { return def }
            guard (MapLimits.minSide...MapLimits.maxSide).contains(v) else {
                throw HelperError.invalid("\(field) is \(MapLimits.minSide) to \(MapLimits.maxSide) points")
            }
            return v
        }
        var r = MapRequest(w: try side(raw.w, "w", MapLimits.defaultW), h: try side(raw.h, "h", MapLimits.defaultH))
        switch raw.scale ?? 0 {
        case 0: break
        case 1, 2: r.scale = raw.scale!
        default: throw HelperError.invalid("scale is 1 or 2")
        }
        r.dark = raw.dark ?? false
        switch (raw.format ?? "").lowercased() {
        case "", "jpeg", "jpg": r.format = .jpeg
        case "png": r.format = .png
        default: throw HelperError.invalid("format is jpeg or png")
        }
        let pins = raw.pins ?? []
        if pins.count > MapLimits.maxPins { throw HelperError.invalid("at most \(MapLimits.maxPins) pins") }
        r.pins = try pins.map { pin in
            guard let lat = pin.lat, let lon = pin.lon, place(lat, lon) else {
                throw HelperError.invalid("a pin needs lat (−90 to 90) and lon (−180 to 180)")
            }
            return MapPin(lat: lat, lon: lon)
        }
        switch (raw.lat, raw.lon, raw.spanM) {
        case (nil, nil, nil):
            if r.pins.isEmpty { throw HelperError.invalid("map needs pins, or lat, lon and span_m") }
        case let (lat?, lon?, span?):
            guard place(lat, lon) else { throw HelperError.invalid("lat is −90 to 90 and lon −180 to 180") }
            guard span.isFinite, span >= MapLimits.minSpanM, span <= MapLimits.maxSpanM else {
                throw HelperError.invalid("span_m is \(Int(MapLimits.minSpanM)) to \(Int(MapLimits.maxSpanM)) metres")
            }
            r.center = MapPin(lat: lat, lon: lon)
            r.spanM = span
        default:
            throw HelperError.invalid("give lat, lon and span_m together")
        }
        return r
    }

    static func place(_ lat: Double, _ lon: Double) -> Bool {
        lat.isFinite && lon.isFinite && abs(lat) <= 90 && abs(lon) <= 180
    }

    static func index(_ value: Int?) throws -> Int {
        guard let value else { return 0 }
        if value < 0 { throw HelperError.invalid("index can't be negative") }
        return value
    }
}

extension OpenTarget {
    public static let accessibilitySettings =
        URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!

    /// `accessibility`, an https link, or an app's name or bundle id. Other kinds of link (file:, http:, custom
    /// schemes that start apps with arguments) are refused: the helper opens only what the spec names.
    static func parse(_ value: String?) throws -> OpenTarget {
        guard let target = try Command.optionalName(value, field: "target") else {
            throw HelperError.invalid("open needs a target: accessibility, an app or an https link")
        }
        if target.lowercased() == "accessibility" { return .accessibility }
        if target.range(of: #"^[A-Za-z][A-Za-z0-9+.-]*:"#, options: .regularExpression) != nil {
            guard let url = URL(string: target), url.scheme?.lowercased() == "https", let host = url.host, !host.isEmpty
            else { throw HelperError.invalid("open takes only https links") }
            return .url(url)
        }
        if target.contains("/") { throw HelperError.invalid("open takes an app's name, not a path") }
        return .app(target)
    }
}
