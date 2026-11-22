// An element's accessibility actions by name. Besides AXPress and its kind, an app may give an element actions of its
// own (Find My's rows: Open Details, Directions, Play), which Accessibility lists as
// `Name:Play\nTarget:0x0\nSelector:(null)`. A person names them by the words after `Name:`.

public enum ActionName {
    /// The name a person reads for an action Accessibility lists as `raw`: a custom action's words after `Name:` up to
    /// the first line break; an `AX…` action's own name.
    public static func display(_ raw: String) -> String {
        guard raw.hasPrefix("Name:") else { return raw }
        let rest = raw.dropFirst("Name:".count)
        let line = rest.prefix { !$0.isNewline }
        return line.trimmingCharacters(in: .whitespaces)
    }

    public enum Pick: Equatable, Sendable {
        /// The action to perform, as Accessibility lists it.
        case found(raw: String, name: String)
        case none
        /// More than one action starts with the query, and none is it: the names to choose from.
        case ambiguous([String])
    }

    /// The action `query` names among an element's actions (as Accessibility lists them): one whose name is the query
    /// with case and white space ignored, else the one whose name starts with it (“Directions” runs
    /// “Directions · 0 min”, whose minutes change). Two that start with it name nothing for sure: a wrong guess could
    /// run something else than what was meant.
    public static func pick(_ query: String, among raws: [String]) -> Pick {
        let q = NameMatch.compact(query)
        if q.isEmpty { return .none }
        let named = raws.map { (raw: $0, name: display($0)) }.filter { !$0.name.isEmpty }
        if let whole = named.first(where: { NameMatch.compact($0.name) == q }) {
            return .found(raw: whole.raw, name: whole.name)
        }
        var starts: [(raw: String, name: String)] = []
        for action in named where NameMatch.compact(action.name).hasPrefix(q) {
            if !starts.contains(where: { NameMatch.compact($0.name) == NameMatch.compact(action.name) }) {
                starts.append(action)
            }
        }
        switch starts.count {
        case 0: return .none
        case 1: return .found(raw: starts[0].raw, name: starts[0].name)
        default: return .ambiguous(starts.map(\.name))
        }
    }
}
