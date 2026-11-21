// Which kinds of element a request is about. The agent sends AX roles (`AXButton`, a comma list), and may send the
// assistant's role words (`button`, `text_field`) as they are: both work, so the two sides can't disagree on the
// mapping.

/// One accepted kind: an AX role or subrole, optionally only inside a tab group (a tab is a radio button there).
public struct RoleRule: Equatable, Sendable {
    public var role: String
    public var inTabGroup: Bool

    public init(_ role: String, inTabGroup: Bool = false) {
        self.role = role
        self.inTabGroup = inTabGroup
    }
}

public struct RoleFilter: Equatable, Sendable {
    /// Empty means any role.
    public var rules: [RoleRule]

    public static let any = RoleFilter(rules: [])

    public init(rules: [RoleRule]) { self.rules = rules }

    public var isAny: Bool { rules.isEmpty }

    /// The assistant's words and the AX roles they stand for (the agent's mapping in the spec).
    public static let words: [String: [RoleRule]] = [
        "button": [RoleRule("AXButton")],
        "checkbox": [RoleRule("AXCheckBox")],
        "switch": [RoleRule("AXCheckBox"), RoleRule("AXSwitch")],
        "text_field": [RoleRule("AXTextField"), RoleRule("AXTextArea"), RoleRule("AXSecureTextField"), RoleRule("AXSearchField")],
        "menu_item": [RoleRule("AXMenuItem")],
        "link": [RoleRule("AXLink")],
        "tab": [RoleRule("AXRadioButton", inTabGroup: true), RoleRule("AXTabButton")],
        "row": [RoleRule("AXRow"), RoleRule("AXCell")],
        "popup": [RoleRule("AXPopUpButton"), RoleRule("AXMenuButton")],
        "radio": [RoleRule("AXRadioButton")],
    ]

    /// `"AXButton"`, `"AXButton,AXCheckBox"`, `"button"`, `"any"`, or nothing. Unknown words are refused so a typo
    /// doesn't quietly match nothing.
    public static func parse(_ value: String?) throws -> RoleFilter {
        guard let value else { return .any }
        var rules: [RoleRule] = []
        for part in value.split(separator: ",") {
            let word = part.trimmingCharacters(in: .whitespaces)
            if word.isEmpty { continue }
            if word.lowercased() == "any" { return .any }
            if word.hasPrefix("AX"), word.count > 2, word.allSatisfy({ $0.isLetter || $0.isNumber }) {
                rules.append(RoleRule(word))
            } else if let mapped = words[word.lowercased()] {
                rules.append(contentsOf: mapped)
            } else {
                throw HelperError.invalid("unknown role \(word)")
            }
        }
        var unique: [RoleRule] = []
        for rule in rules where !unique.contains(rule) { unique.append(rule) }
        return RoleFilter(rules: unique)
    }

    /// Whether an element of this role and subrole (whose parent has `parentRole`) is one of the kinds asked for.
    /// A rule names either the role (`AXCheckBox`) or the subrole (`AXSwitch`, `AXSecureTextField`).
    public func matches(role: String, subrole: String, parentRole: String) -> Bool {
        if rules.isEmpty { return true }
        return rules.contains { rule in
            guard rule.role == role || (!subrole.isEmpty && rule.role == subrole) else { return false }
            return !rule.inTabGroup || parentRole == "AXTabGroup"
        }
    }

    public func includes(role: String) -> Bool {
        rules.contains { $0.role == role }
    }
}

/// What kinds of element mean what, for lists and searches.
public enum Roles {
    /// Layout around other elements: left out of a list unless named, but walked into.
    public static let containers: Set<String> = [
        "AXGroup", "AXSplitGroup", "AXScrollArea", "AXLayoutArea", "AXLayoutItem", "AXUnknown", "AXSplitter",
        "AXList", "AXOutline", "AXTable", "AXBrowser", "AXColumn", "AXRuler", "AXGrowArea", "AXMatte",
        "AXRadioGroup", "AXTabGroup", "AXToolbar", "AXWebArea", "AXGenericElement",
    ]
    /// Never walked into: scroll bars hold nothing to press, menus are for the menu op.
    public static let skipped: Set<String> = [
        "AXScrollBar", "AXMenuBar", "AXMenuBarItem", "AXMenu", "AXMenuItem",
    ]
    /// Elements someone can press, pick, type into or switch, which a press or set looks at when no role is given.
    public static let interactive: Set<String> = [
        "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXLink", "AXRow", "AXCell",
        "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXSlider", "AXIncrementor",
        "AXDisclosureTriangle", "AXColorWell", "AXDateField", "AXTabButton", "AXSegmentedControl",
    ]
    /// Text a person types into: what `set` looks for when no role is given.
    public static let textInputs: Set<String> = [
        "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXSecureTextField",
    ]
    /// Elements whose value says something (text, a check box's state, a pop-up's choice). Others' values aren't
    /// read: every read is a round trip to the app.
    public static let withValue: Set<String> = [
        "AXStaticText", "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXCheckBox", "AXRadioButton",
        "AXPopUpButton", "AXMenuButton", "AXSlider", "AXIncrementor", "AXDisclosureTriangle", "AXProgressIndicator",
        "AXLevelIndicator", "AXValueIndicator", "AXDateField", "AXHeading", "AXSwitch",
    ]
    /// Elements whose name is often only in the text inside them (table rows, web links, some SwiftUI buttons).
    public static let namedByContents: Set<String> = [
        "AXRow", "AXCell", "AXButton", "AXLink", "AXRadioButton", "AXMenuButton",
    ]
    /// Actions that mean “press it”, in the order they are tried.
    public static let pressActions = ["AXPress", "AXPick", "AXConfirm"]

    /// A password field: its value is never read, matched or reported.
    public static func isSecure(role: String, subrole: String) -> Bool {
        role == "AXSecureTextField" || subrole == "AXSecureTextField"
    }

    /// A window that is a dialog, listed before ordinary windows.
    public static func isDialog(role: String, subrole: String) -> Bool {
        role == "AXSheet" || subrole == "AXDialog" || subrole == "AXSystemDialog" || subrole == "AXFloatingWindow"
    }
}
