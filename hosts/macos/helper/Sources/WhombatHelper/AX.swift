import ApplicationServices
import Foundation
import HelperCore

// Reading the Accessibility tree. Every call here is a round trip to another app, which may be stuck: the messaging
// timeout (set at start) bounds each one, and a walk stops at the first app that doesn't answer, at its deadline, or
// after `Limits.maxVisited` elements.

/// One element and the attributes the helper uses, read in one round trip (the value separately, never for a
/// password field).
struct Node {
    let element: AXUIElement
    var role = ""
    var subrole = ""
    var title = ""
    var desc = ""
    var ident = ""
    var placeholder = ""
    var value = ""
    var enabled = true
    var focused = false
    var frame: Rect?
    var children: [AXUIElement] = []
    var titleElement: AXUIElement?

    init(element: AXUIElement) { self.element = element }

    var isSecure: Bool { Roles.isSecure(role: role, subrole: subrole) }

    /// The words a name is matched against. The placeholder (“Search”, “Name”) counts too: a text field often has
    /// no other name.
    var nameFields: [String] { [title, desc, value, ident, placeholder] }

    /// The name to show for it in a `not_found` answer.
    var shownName: String { [title, desc, placeholder, ident].first { !$0.isEmpty } ?? "" }
}

/// One walk's budget. `halted` stops it (out of time or elements, or the app stopped answering); `incomplete` says
/// the answer misses something (a cut list of children, a halted walk).
final class Walk {
    let deadline: Date
    private(set) var visited = 0
    private(set) var halted = false
    var incomplete = false
    /// The app stopped answering: nothing more is asked of it.
    private(set) var unresponsive = false

    init(deadline: Date) { self.deadline = deadline }

    /// Counts one more element; false when the walk must stop.
    func step() -> Bool {
        if halted { return false }
        visited += 1
        if visited > Limits.maxVisited || Date() >= deadline { halt() }
        return !halted
    }

    func halt() {
        halted = true
        incomplete = true
    }

    /// Notes an error from the app: a timeout means it is busy or stuck.
    func saw(_ error: AXError) {
        if error == .cannotComplete {
            unresponsive = true
            halt()
        }
    }
}

enum AX {
    /// How long one Accessibility call may wait for an app.
    static let messagingTimeout: Float = 1.5

    static var systemWide: AXUIElement { AXUIElementCreateSystemWide() }

    static let nodeAttributes: [String] = [
        kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, "AXIdentifier",
        kAXEnabledAttribute, kAXFocusedAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXChildrenAttribute,
        kAXTitleUIElementAttribute, kAXPlaceholderValueAttribute,
    ]

    static var trusted: Bool { AXIsProcessTrusted() }

    /// Reads an element's attributes in one call, its value in a second (only for kinds whose value means something,
    /// never for a password field).
    static func read(_ element: AXUIElement, walk: Walk?) -> Node? {
        var node = Node(element: element)
        var values: CFArray?
        let err = AXUIElementCopyMultipleAttributeValues(
            element, nodeAttributes as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
        guard err == .success, let array = values as? [AnyObject] else {
            walk?.saw(err)
            return nil
        }
        var position: CGPoint?
        var size: CGSize?
        for (i, name) in nodeAttributes.enumerated() where i < array.count {
            let v = array[i]
            if isError(v) { continue }
            switch name {
            case kAXRoleAttribute: node.role = v as? String ?? ""
            case kAXSubroleAttribute: node.subrole = v as? String ?? ""
            case kAXTitleAttribute: node.title = clip(text(v) ?? "")
            case kAXDescriptionAttribute: node.desc = clip(text(v) ?? "")
            case "AXIdentifier": node.ident = clip(v as? String ?? "")
            case kAXPlaceholderValueAttribute: node.placeholder = clip(text(v) ?? "")
            case kAXEnabledAttribute: node.enabled = (v as? Bool) ?? true
            case kAXFocusedAttribute: node.focused = (v as? Bool) ?? false
            case kAXPositionAttribute: position = point(v)
            case kAXSizeAttribute: size = sizeValue(v)
            case kAXChildrenAttribute:
                node.children = elements(v)
                if (v as? [AnyObject])?.count ?? 0 > node.children.count { walk?.incomplete = true }
            case kAXTitleUIElementAttribute:
                if CFGetTypeID(v) == AXUIElementGetTypeID() { node.titleElement = (v as! AXUIElement) }
            default: break
            }
        }
        if let position, let size {
            node.frame = Rect(x: position.x, y: position.y, w: size.width, h: size.height)
        }
        // A field's label is often a separate text beside it that names it as its title element.
        if node.title.isEmpty, let label = node.titleElement {
            node.title = clip(string(label, kAXValueAttribute) ?? string(label, kAXTitleAttribute) ?? "")
        }
        if Roles.withValue.contains(node.role), !node.isSecure {
            node.value = clip(string(element, kAXValueAttribute) ?? "")
        }
        return node
    }

    /// A row, cell, link or bare button is often named only by the text inside it: up to three texts from its first
    /// few descendants.
    static func contentsName(_ node: Node, walk: Walk) -> String {
        var texts: [String] = []
        var queue = node.children.prefix(10).map { ($0, 1) }
        var seen = 0
        while !queue.isEmpty, texts.count < 3, seen < 30, !walk.halted {
            let (element, depth) = queue.removeFirst()
            seen += 1
            guard let child = read(element, walk: walk) else { continue }
            if child.isSecure { continue }
            let t = [child.value, child.title, child.desc].first { !$0.isEmpty } ?? ""
            if child.role == "AXStaticText" || child.role == "AXImage" || child.role == "AXTextField", !t.isEmpty {
                texts.append(t)
            } else if depth < 3 {
                queue.append(contentsOf: child.children.prefix(10).map { ($0, depth + 1) })
            }
        }
        return clip(texts.joined(separator: " "))
    }

    static func actions(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success, let list = names as? [String] else { return [] }
        return list
    }

    // MARK: single attributes

    static func copy(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value
    }

    static func string(_ element: AXUIElement, _ attribute: String) -> String? {
        copy(element, attribute).flatMap(text)
    }

    static func element(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
        guard let v = copy(element, attribute), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }

    static func children(_ element: AXUIElement, _ attribute: String = kAXChildrenAttribute) -> [AXUIElement] {
        copy(element, attribute).map(elements) ?? []
    }

    static func pid(_ element: AXUIElement) -> pid_t? {
        var pid: pid_t = 0
        return AXUIElementGetPid(element, &pid) == .success && pid > 0 ? pid : nil
    }

    static func isSettable(_ element: AXUIElement, _ attribute: String) -> Bool {
        var settable: DarwinBoolean = false
        return AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success && settable.boolValue
    }

    @discardableResult
    static func set(_ element: AXUIElement, _ attribute: String, _ value: CFTypeRef) -> AXError {
        AXUIElementSetAttributeValue(element, attribute as CFString, value)
    }

    // MARK: converting values

    /// A value as text: strings, numbers (a check box's 0 or 1), links and styled text. Others (points, ranges) say
    /// nothing a person reads.
    static func text(_ v: CFTypeRef) -> String? {
        if let s = v as? String { return s }
        if CFGetTypeID(v) == CFBooleanGetTypeID() { return CFBooleanGetValue((v as! CFBoolean)) ? "1" : "0" }
        if let n = v as? NSNumber { return n.stringValue }
        if let u = v as? URL { return u.absoluteString }
        if let a = v as? NSAttributedString { return a.string }
        return nil
    }

    static func isError(_ v: CFTypeRef) -> Bool {
        CFGetTypeID(v) == AXValueGetTypeID() && AXValueGetType(v as! AXValue) == .axError
    }

    static func point(_ v: CFTypeRef) -> CGPoint? {
        guard CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var p = CGPoint.zero
        return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
    }

    static func sizeValue(_ v: CFTypeRef) -> CGSize? {
        guard CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var s = CGSize.zero
        return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
    }

    static func elements(_ v: CFTypeRef) -> [AXUIElement] {
        guard let list = v as? [AnyObject] else { return [] }
        return list.prefix(Limits.maxChildren).compactMap {
            CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil
        }
    }
}
