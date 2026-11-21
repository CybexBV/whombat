import Foundation

// Finding an element by the name a person or the assistant gives it: “Save”, “don't save”, “Save...”. Names are
// compared case-insensitively, the whole name first and then a part of it, over an element's title, description,
// value and identifier.

public enum MatchKind: Int, Comparable, Sendable {
    case exact = 0
    case contains = 1

    public static func < (a: MatchKind, b: MatchKind) -> Bool { a.rawValue < b.rawValue }
}

public enum NameMatch {
    /// The form two names are compared in: lower case, `…` as `...`, curly quotes as straight ones (macOS writes
    /// “Don’t Save”, people type "Don't Save"), runs of white space as one space, no space at the ends.
    public static func normalize(_ name: String) -> String {
        var s = name.lowercased()
        s = s.replacingOccurrences(of: "…", with: "...")
        for (curly, straight) in [("’", "'"), ("‘", "'"), ("“", "\""), ("”", "\""), ("\u{00A0}", " ")] {
            s = s.replacingOccurrences(of: curly, with: straight)
        }
        return s.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// How well `query` names an element with these fields (title, description, value, identifier), or nil.
    /// The query must already be normalized.
    public static func match(normalizedQuery query: String, fields: [String]) -> MatchKind? {
        if query.isEmpty { return nil }
        var best: MatchKind?
        for field in fields where !field.isEmpty {
            let f = normalize(field)
            if f == query { return .exact }
            if f.contains(query) { best = .contains }
        }
        return best
    }

    public static func match(_ query: String, fields: [String]) -> MatchKind? {
        match(normalizedQuery: normalize(query), fields: fields)
    }

    /// The field `query` names, as it is written there: one that is the whole name first, then one that holds it.
    /// The query must already be normalized.
    public static func matchedField(normalizedQuery query: String, fields: [String]) -> String? {
        if query.isEmpty { return nil }
        if let whole = fields.first(where: { !$0.isEmpty && normalize($0) == query }) { return whole }
        return fields.first { !$0.isEmpty && normalize($0).contains(query) }
    }

    /// Up to `limit` of `names` that come closest to `query`, for a `not_found` answer: names that contain a word of
    /// the query or share its start first, then the fewest letters to change. Each name once.
    public static func closest(to query: String, among names: [String], limit: Int = Limits.closeNames) -> [String] {
        let q = normalize(query)
        let words = Set(q.split(separator: " ").map(String.init).filter { $0.count >= 2 })
        var seen = Set<String>()
        var scored: [(score: Int, order: Int, name: String)] = []
        for (order, name) in names.enumerated() {
            let n = normalize(name)
            if n.isEmpty || !seen.insert(n).inserted { continue }
            var score = editDistance(q, n)
            if n.hasPrefix(q) || q.hasPrefix(n) { score -= 100 }
            if words.contains(where: { n.contains($0) }) { score -= 50 }
            scored.append((score, order, name))
        }
        scored.sort { ($0.score, $0.order) < ($1.score, $1.order) }
        return scored.prefix(limit).map(\.name)
    }

    /// Levenshtein distance over characters, bounded to names of a sensible length.
    public static func editDistance(_ a: String, _ b: String) -> Int {
        let x = Array(a.prefix(100)), y = Array(b.prefix(100))
        if x.isEmpty { return y.count }
        if y.isEmpty { return x.count }
        var previous = Array(0...y.count)
        var current = [Int](repeating: 0, count: y.count + 1)
        for i in 1...x.count {
            current[0] = i
            for j in 1...y.count {
                current[j] = Swift.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (x[i - 1] == y[j - 1] ? 0 : 1))
            }
            swap(&previous, &current)
        }
        return previous[y.count]
    }
}

/// One element a search found, with what decides which of several is meant.
public struct Candidate: Sendable {
    public var match: MatchKind
    /// Has an action that presses it (AXPress, AXPick, AXConfirm).
    public var pressable: Bool
    public var enabled: Bool
    /// 0 in a sheet or dialog of the window in front, 1 in the window in front, 2 in another window, 3 in the menus.
    public var zone: Int
    /// The order the search met it in.
    public var order: Int

    public init(match: MatchKind, pressable: Bool, enabled: Bool, zone: Int, order: Int) {
        self.match = match
        self.pressable = pressable
        self.enabled = enabled
        self.zone = zone
        self.order = order
    }

    /// Whole-name matches before partial ones; then what can be pressed, what is enabled, what is in front.
    public static func ranked(_ a: Candidate, before b: Candidate) -> Bool {
        if a.match != b.match { return a.match < b.match }
        if a.pressable != b.pressable { return a.pressable }
        if a.enabled != b.enabled { return a.enabled }
        if a.zone != b.zone { return a.zone < b.zone }
        return a.order < b.order
    }
}

/// Cuts a field to `max` characters without splitting a character.
public func clip(_ s: String, to max: Int = Limits.maxFieldCharacters) -> String {
    s.count <= max ? s : String(s.prefix(max))
}
