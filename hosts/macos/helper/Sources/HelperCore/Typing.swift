// How a text becomes key events. A Quartz key event carries at most 20 UTF-16 units of text, and a line break or
// tab sent as text doesn't always act like the key (a dialog's default button, the next field), so those are sent as
// the Return and Tab keys.

public enum TypingStep: Equatable, Sendable {
    case text(String)
    case returnKey
    case tabKey
}

public enum TypingPlan {
    /// The most text one key event can carry.
    public static let maxUnitsPerEvent = 20

    public static func steps(for text: String) -> [TypingStep] {
        var steps: [TypingStep] = []
        var chunk = ""
        var units = 0
        func flush() {
            if !chunk.isEmpty { steps.append(.text(chunk)) }
            chunk = ""
            units = 0
        }
        for ch in text {
            // "\r\n" is one Character in Swift, so a Windows line ending is one Return.
            if ch == "\n" || ch == "\r" || ch == "\r\n" {
                flush()
                steps.append(.returnKey)
                continue
            }
            if ch == "\t" {
                flush()
                steps.append(.tabKey)
                continue
            }
            let n = ch.utf16.count
            if units + n > maxUnitsPerEvent { flush() }
            chunk.append(ch)
            units += n
        }
        flush()
        return steps
    }
}

/// Keys meant for one field only (a password): each goes only while the field still has the keyboard, checked right
/// before it, so whatever takes the keyboard meanwhile gets nothing more.
public enum GuardedKeys {
    /// Sends the items in order, each only while `stillThere` passes right before it. Returns how many went: all of
    /// them, or those before the first failed check.
    @discardableResult
    public static func send<T>(_ items: [T], while stillThere: () -> Bool, _ send: (T) throws -> Void) rethrows -> Int {
        var sent = 0
        for item in items {
            guard stillThere() else { return sent }
            try send(item)
            sent += 1
        }
        return sent
    }
}
