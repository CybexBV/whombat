import XCTest

@testable import HelperCore

final class MatchingTests: XCTestCase {
    func testWholeNameBeforePart() {
        XCTAssertEqual(NameMatch.match("save", fields: ["Save"]), .exact)
        XCTAssertEqual(NameMatch.match("SAVE", fields: ["", "Save"]), .exact, "case doesn't matter; empty fields skip")
        XCTAssertEqual(NameMatch.match("save", fields: ["Save As…"]), .contains)
        XCTAssertEqual(NameMatch.match("save", fields: ["Save As…", "Save"]), .exact, "any field may be the exact one")
        XCTAssertNil(NameMatch.match("save", fields: ["Cancel", "", "cancel-button"]))
        XCTAssertNil(NameMatch.match("", fields: ["anything"]), "an empty name matches nothing")
    }

    func testEveryFieldCounts() {
        // title, description, value, identifier
        XCTAssertEqual(NameMatch.match("ok", fields: ["", "", "", "OK"]), .exact)
        XCTAssertEqual(NameMatch.match("close", fields: ["", "close button", "", ""]), .contains)
        XCTAssertEqual(NameMatch.match("mac studio", fields: ["", "", "Mac Studio", ""]), .exact)
    }

    func testMatchedFieldNamesWhatMatched() {
        // A button named only by its description answers with that name, as macOS writes it.
        let q = NameMatch.normalize("Don't Allow")
        XCTAssertEqual(NameMatch.matchedField(normalizedQuery: q, fields: ["", "Don’t Allow", "", ""]), "Don’t Allow")
        XCTAssertEqual(
            NameMatch.matchedField(normalizedQuery: "save", fields: ["Save As…", "Save"]), "Save", "the whole name first")
        XCTAssertEqual(NameMatch.matchedField(normalizedQuery: "save", fields: ["", "Save As…"]), "Save As…")
        XCTAssertNil(NameMatch.matchedField(normalizedQuery: "save", fields: ["Cancel", ""]))
        XCTAssertNil(NameMatch.matchedField(normalizedQuery: "", fields: ["Save"]))
    }

    func testEllipsisQuotesAndSpaces() {
        XCTAssertEqual(NameMatch.match("Save...", fields: ["Save…"]), .exact)
        XCTAssertEqual(NameMatch.match("Save…", fields: ["Save..."]), .exact)
        XCTAssertEqual(NameMatch.match("Don't Save", fields: ["Don’t Save"]), .exact)
        XCTAssertEqual(NameMatch.match("“quoted”", fields: ["\"Quoted\""]), .exact)
        XCTAssertEqual(NameMatch.match("  Save   As ", fields: ["Save\u{00A0}As"]), .exact)
        XCTAssertEqual(NameMatch.normalize("  Export as PDF…  "), "export as pdf...")
    }

    func testRanking() {
        func c(_ m: MatchKind, pressable: Bool = true, enabled: Bool = true, zone: Int = 1, order: Int)
            -> Candidate {
            Candidate(match: m, pressable: pressable, enabled: enabled, zone: zone, order: order)
        }
        let sorted = [
            c(.contains, zone: 0, order: 0),                  // a part of the name, even in a dialog
            c(.exact, enabled: false, zone: 0, order: 1),     // whole name but greyed out
            c(.exact, zone: 2, order: 2),                     // whole name in a window behind
            c(.exact, zone: 0, order: 3),                     // whole name in the dialog in front
            c(.exact, pressable: false, zone: 0, order: 4),   // whole name, but only text
            c(.exact, zone: 1, order: 5),                     // whole name in the window in front
        ].sorted(by: Candidate.ranked).map(\.order)
        XCTAssertEqual(sorted, [3, 5, 2, 1, 4, 0])
        // Same everything: the order met.
        XCTAssertEqual([c(.exact, order: 7), c(.exact, order: 6)].sorted(by: Candidate.ranked).map(\.order), [6, 7])
    }

    func testCloseNames() {
        let names = ["Cancel", "Save", "Save As…", "Don’t Save", "Revert", "Save", "Print…"]
        let close = NameMatch.closest(to: "Sav", among: names)
        XCTAssertEqual(Array(close.prefix(3)), ["Save", "Save As…", "Don’t Save"])
        XCTAssertEqual(close.filter { $0 == "Save" }.count, 1, "each name once")
        XCTAssertLessThanOrEqual(NameMatch.closest(to: "x", among: (0..<50).map { "Item \($0)" }).count, 10)
        XCTAssertEqual(NameMatch.closest(to: "x", among: []), [])
        XCTAssertEqual(NameMatch.editDistance("kitten", "sitting"), 3)
        XCTAssertEqual(NameMatch.editDistance("", "abc"), 3)
    }

    func testClip() {
        XCTAssertEqual(clip(String(repeating: "a", count: 250)).count, 200)
        XCTAssertEqual(clip("short"), "short")
        // A flag is one character made of two scalars: never cut in half.
        let flags = String(repeating: "🇳🇱", count: 201)
        XCTAssertEqual(clip(flags).count, 200)
        XCTAssertEqual(clip(flags).unicodeScalars.count, 400)
    }
}

final class RoleTests: XCTestCase {
    func testAXRolesAndWords() throws {
        XCTAssertEqual(try RoleFilter.parse(nil), .any)
        XCTAssertEqual(try RoleFilter.parse(""), .any)
        XCTAssertEqual(try RoleFilter.parse("any"), .any)
        XCTAssertEqual(try RoleFilter.parse("AXButton"), RoleFilter(rules: [RoleRule("AXButton")]))
        XCTAssertEqual(
            try RoleFilter.parse("AXCheckBox, AXSwitch"), RoleFilter(rules: [RoleRule("AXCheckBox"), RoleRule("AXSwitch")]))
        XCTAssertEqual(try RoleFilter.parse("button"), RoleFilter(rules: [RoleRule("AXButton")]))
        XCTAssertEqual(try RoleFilter.parse("Button"), RoleFilter(rules: [RoleRule("AXButton")]))
        XCTAssertEqual(
            try RoleFilter.parse("button,AXButton"), RoleFilter(rules: [RoleRule("AXButton")]), "the same role once")
        XCTAssertThrowsError(try RoleFilter.parse("buton"))
        XCTAssertThrowsError(try RoleFilter.parse("AX"))
        XCTAssertThrowsError(try RoleFilter.parse("AXBut ton"))
        for word in ["button", "checkbox", "switch", "text_field", "menu_item", "link", "tab", "row", "popup", "radio"] {
            XCTAssertFalse(try RoleFilter.parse(word).isAny, word)
        }
    }

    func testMatchingRoles() throws {
        let button = try RoleFilter.parse("button")
        XCTAssertTrue(button.matches(role: "AXButton", subrole: "", parentRole: "AXGroup"))
        XCTAssertFalse(button.matches(role: "AXCheckBox", subrole: "", parentRole: "AXGroup"))

        let toggle = try RoleFilter.parse("switch")
        XCTAssertTrue(toggle.matches(role: "AXCheckBox", subrole: "AXSwitch", parentRole: ""))
        XCTAssertTrue(toggle.matches(role: "AXCheckBox", subrole: "", parentRole: ""))
        XCTAssertFalse(toggle.matches(role: "AXButton", subrole: "", parentRole: ""))

        let text = try RoleFilter.parse("text_field")
        for role in ["AXTextField", "AXTextArea", "AXSecureTextField", "AXSearchField"] {
            XCTAssertTrue(text.matches(role: role, subrole: "", parentRole: ""), role)
        }
        XCTAssertTrue(text.matches(role: "AXTextField", subrole: "AXSecureTextField", parentRole: ""))
        // An AX subrole given as a role matches the subrole.
        XCTAssertTrue(try RoleFilter.parse("AXSecureTextField").matches(role: "AXTextField", subrole: "AXSecureTextField", parentRole: ""))

        // A tab is a radio button in a tab group; a plain radio button is not a tab.
        let tab = try RoleFilter.parse("tab")
        XCTAssertTrue(tab.matches(role: "AXRadioButton", subrole: "", parentRole: "AXTabGroup"))
        XCTAssertFalse(tab.matches(role: "AXRadioButton", subrole: "", parentRole: "AXRadioGroup"))
        XCTAssertTrue(tab.matches(role: "AXRadioButton", subrole: "AXTabButton", parentRole: "AXGroup"))
        let radio = try RoleFilter.parse("radio")
        XCTAssertTrue(radio.matches(role: "AXRadioButton", subrole: "", parentRole: "AXTabGroup"))
        // What the agent sends for a tab: the AX role alone, any radio button.
        XCTAssertTrue(try RoleFilter.parse("AXRadioButton").matches(role: "AXRadioButton", subrole: "", parentRole: "AXRadioGroup"))

        let row = try RoleFilter.parse("row")
        XCTAssertTrue(row.matches(role: "AXRow", subrole: "AXOutlineRow", parentRole: "AXOutline"))
        XCTAssertTrue(row.matches(role: "AXCell", subrole: "", parentRole: "AXRow"))
        let popup = try RoleFilter.parse("popup")
        XCTAssertTrue(popup.matches(role: "AXMenuButton", subrole: "", parentRole: ""))
        XCTAssertTrue(RoleFilter.any.matches(role: "AXAnything", subrole: "", parentRole: ""))
        XCTAssertTrue(try RoleFilter.parse("menu_item").includes(role: "AXMenuItem"))
    }

    func testSecureFieldsAndDialogs() {
        XCTAssertTrue(Roles.isSecure(role: "AXSecureTextField", subrole: ""))
        XCTAssertTrue(Roles.isSecure(role: "AXTextField", subrole: "AXSecureTextField"))
        XCTAssertFalse(Roles.isSecure(role: "AXTextField", subrole: "AXSearchField"))
        XCTAssertTrue(Roles.isDialog(role: "AXSheet", subrole: ""))
        XCTAssertTrue(Roles.isDialog(role: "AXWindow", subrole: "AXDialog"))
        XCTAssertTrue(Roles.isDialog(role: "AXWindow", subrole: "AXSystemDialog"))
        XCTAssertFalse(Roles.isDialog(role: "AXWindow", subrole: "AXStandardWindow"))
        XCTAssertTrue(Roles.textInputs.contains("AXSecureTextField"))
        XCTAssertFalse(Roles.withValue.contains("AXSecureTextField"), "a password field's value is never read")
        XCTAssertTrue(Roles.skipped.contains("AXMenuBar"))
    }
}

final class GeometryAndTypingTests: XCTestCase {
    func testRectRoundingAndCentre() {
        let r = Rect(x: 10.4, y: 20.6, w: 99.4, h: 10.2)
        let rounded = r.rounded
        XCTAssertEqual(rounded.x, 10)
        XCTAssertEqual(rounded.y, 21)
        XCTAssertEqual(rounded.w, 100, "right edge 109.8 → 110, minus the left 10")
        XCTAssertEqual(rounded.h, 10, "bottom 30.8 → 31, minus the top 21")
        XCTAssertEqual(r.center.x, 60.1, accuracy: 0.0001)
        XCTAssertEqual(r.center.y, 25.7, accuracy: 0.0001)
        XCTAssertTrue(Rect(x: 0, y: 0, w: 0, h: 5).isEmpty)
        // Negative points are real: a display left of or above the main one.
        let left = Rect(x: -1920, y: -200, w: 1920, h: 1080).rounded
        XCTAssertEqual(left.x, -1920)
        XCTAssertEqual(left.y, -200)
    }

    func testDisplays() {
        let main = DisplayInfo(id: 1, bounds: Rect(x: 0, y: 0, w: 2560, h: 1440), pixelWidth: 5120, main: true)
        let left = DisplayInfo(id: 2, bounds: Rect(x: -1920, y: 0, w: 1920, h: 1080), pixelWidth: 1920, main: false)
        XCTAssertEqual(main.scale, 2)
        XCTAssertEqual(left.scale, 1)
        XCTAssertEqual(DisplayInfo(id: 3, bounds: Rect(x: 0, y: 0, w: 1512, h: 982), pixelWidth: 3024, main: false).scale, 2)
        XCTAssertEqual(DisplayInfo(id: 4, bounds: Rect(x: 0, y: 0, w: 0, h: 0), pixelWidth: 0, main: false).scale, 1)
        XCTAssertEqual(display(containing: 100, 100, in: [main, left])?.id, 1)
        XCTAssertEqual(display(containing: -5, 100, in: [main, left])?.id, 2)
        XCTAssertEqual(display(containing: 2560, 100, in: [main, left])?.id, nil, "the right edge belongs to no display")
        XCTAssertEqual(display(containing: 100, 1200, in: [main, left])?.id, 1, "below the left one, on the main one")
        XCTAssertNil(display(containing: -100, 1100, in: [main, left]))
    }

    func testGuardedKeys() {
        var sent: [String] = []
        XCTAssertEqual(GuardedKeys.send(["a", "b", "c"], while: { true }) { sent.append($0) }, 3)
        XCTAssertEqual(sent, ["a", "b", "c"])
        // The field loses the keyboard after the second key: nothing more goes.
        sent = []
        var checks = 0
        let n = GuardedKeys.send(["a", "b", "c", "d"], while: { checks += 1; return checks <= 2 }) { sent.append($0) }
        XCTAssertEqual(n, 2)
        XCTAssertEqual(sent, ["a", "b"])
        XCTAssertEqual(checks, 3)
        // Never there: nothing at all.
        sent = []
        XCTAssertEqual(GuardedKeys.send(["a"], while: { false }) { sent.append($0) }, 0)
        XCTAssertEqual(sent, [])
    }

    func testTypingSteps() {
        XCTAssertEqual(TypingPlan.steps(for: "hello"), [.text("hello")])
        XCTAssertEqual(TypingPlan.steps(for: "a\nb\tc"), [.text("a"), .returnKey, .text("b"), .tabKey, .text("c")])
        XCTAssertEqual(TypingPlan.steps(for: "a\r\nb"), [.text("a"), .returnKey, .text("b")], "CR LF is one Return")
        XCTAssertEqual(TypingPlan.steps(for: "\n"), [.returnKey])
        XCTAssertEqual(TypingPlan.steps(for: ""), [])
        // At most 20 UTF-16 units per event, never splitting a character.
        let long = String(repeating: "x", count: 45)
        XCTAssertEqual(TypingPlan.steps(for: long).count, 3)
        let emoji = String(repeating: "👍🏽", count: 7)  // 4 units each
        for step in TypingPlan.steps(for: emoji) {
            guard case let .text(chunk) = step else { return XCTFail("not text") }
            XCTAssertLessThanOrEqual(chunk.utf16.count, 20)
            XCTAssertTrue(chunk.allSatisfy { $0 == "👍🏽" })
        }
        let joined = TypingPlan.steps(for: emoji).compactMap { step -> String? in
            if case let .text(chunk) = step { return chunk }
            return nil
        }.joined()
        XCTAssertEqual(joined, emoji)
    }
}
