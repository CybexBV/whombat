import AppKit
import ApplicationServices
import HelperCore

// The ops that read and act on apps' windows: list, press, set, menu, plus status.

/// A window of the app and how near the front it is (Candidate.zone: 0 a dialog in front, 1 the window in front,
/// 2 another window).
struct WindowRef {
    let id: String
    let node: Node
    let zone: Int
}

/// One element met on a walk, with where it is.
struct Visit {
    let node: Node
    let id: String
    let parentRole: String
    let zone: Int
    let window: String
}

enum Ops {
    // MARK: status

    static func status() -> Answer {
        let trusted = AX.trusted
        // One look at the lock decides both what status says and which app is in front.
        let locked = Session.locked
        let front = Apps.focused(locked: locked)
        var frontWindow: String?
        if trusted, let app = front, let window = AX.element(app.element, kAXFocusedWindowAttribute) {
            frontWindow = AX.string(window, kAXTitleAttribute).map { clip($0) }
        }
        return .status(StatusInfo(
            version: Helper.version,
            ax: trusted,
            locked: locked,
            user: NSUserName(),
            frontApp: front?.name,
            frontWindow: frontWindow,
            displays: Displays.all()
        ))
    }

    // MARK: focused

    /// The element with the keyboard focus, system-wide, and its process: its role, subrole and place, never its
    /// title or value, and its token: Accessibility's hash of the element, which is the same for every reference to
    /// that element in that process while it exists (equal elements hash alike) and almost surely another for another
    /// element. The agent pins a password field by all of these and checks them before each key.
    static func focused() throws -> Answer {
        guard let element = AX.element(AX.systemWide, kAXFocusedUIElementAttribute), let pid = AX.pid(element) else {
            throw HelperError(.notFound, "Nothing has the keyboard focus.")
        }
        var e = ElementInfo(id: "focused", role: AX.string(element, kAXRoleAttribute) ?? "")
        e.subrole = AX.string(element, kAXSubroleAttribute) ?? ""
        e.enabled = (AX.copy(element, kAXEnabledAttribute) as? Bool) ?? true
        e.focused = true
        if let p = AX.copy(element, kAXPositionAttribute).flatMap(AX.point),
           let size = AX.copy(element, kAXSizeAttribute).flatMap(AX.sizeValue) {
            (e.x, e.y) = (Int(p.x.rounded()), Int(p.y.rounded()))
            (e.w, e.h) = (Int(size.width.rounded()), Int(size.height.rounded()))
        }
        e.token = String(CFHash(element), radix: 16)
        let app = NSRunningApplication(processIdentifier: pid)
        e.app = app?.localizedName ?? ""
        return .focused(e, pid: pid, bundleID: app?.bundleIdentifier ?? "")
    }

    // MARK: walking an app's windows

    /// The app's windows, the one in front first, then dialogs, then the rest. Ids keep the app's own order.
    static func windows(of app: TargetApp, walk: Walk) throws -> [WindowRef] {
        let all = Array(AX.children(app.element, kAXWindowsAttribute).prefix(Limits.maxWindowsPerApp))
        let focused = AX.element(app.element, kAXFocusedWindowAttribute)
        var found: [(index: Int, node: Node, front: Bool)] = []
        for (i, window) in all.enumerated() {
            guard walk.step(), let node = AX.read(window, walk: walk) else { continue }
            found.append((i, node, focused.map { CFEqual($0, window) } ?? false))
        }
        if let focused, !found.contains(where: \.front), let node = AX.read(focused, walk: walk) {
            found.append((all.count, node, true))
        }
        if walk.unresponsive { throw notAnswering(app) }
        func rank(_ w: (index: Int, node: Node, front: Bool)) -> Int {
            w.front ? 0 : Roles.isDialog(role: w.node.role, subrole: w.node.subrole) ? 1 : 2
        }
        return found.sorted { (rank($0), $0.index) < (rank($1), $1.index) }.map { w in
            let dialog = Roles.isDialog(role: w.node.role, subrole: w.node.subrole)
            return WindowRef(id: "w\(w.index)", node: w.node, zone: w.front ? (dialog ? 0 : 1) : 2)
        }
    }

    /// Visits every element under these windows depth-first, a parent before its children and sheets before the
    /// rest, until `visit` says stop or the walk runs out. Menus are left out unless asked for; scroll bars always.
    static func walkTree(_ windows: [WindowRef], maxDepth: Int, includeMenus: Bool, walk: Walk, visit: (Visit) -> Bool) {
        func descend(_ v: Visit, depth: Int) -> Bool {
            if !visit(v) { return false }
            if v.node.children.isEmpty { return true }
            if depth >= maxDepth {
                walk.incomplete = true
                return true
            }
            var kids: [(index: Int, node: Node)] = []
            for (i, child) in v.node.children.enumerated() {
                guard walk.step() else { return false }
                guard let node = AX.read(child, walk: walk) else {
                    if walk.halted { return false }
                    continue
                }
                if node.role == "AXScrollBar" || (!includeMenus && Roles.skipped.contains(node.role)) { continue }
                kids.append((i, node))
            }
            kids.sort { kid0, kid1 in
                let d0 = Roles.isDialog(role: kid0.node.role, subrole: kid0.node.subrole) ? 0 : 1
                let d1 = Roles.isDialog(role: kid1.node.role, subrole: kid1.node.subrole) ? 0 : 1
                return (d0, kid0.index) < (d1, kid1.index)
            }
            for kid in kids {
                let zone = kid.node.role == "AXSheet" ? 0 : v.zone
                let next = Visit(node: kid.node, id: "\(v.id).\(kid.index)", parentRole: v.node.role, zone: zone, window: v.window)
                if !descend(next, depth: depth + 1) { return false }
            }
            return true
        }
        for window in windows {
            let v = Visit(node: window.node, id: window.id, parentRole: "", zone: window.zone, window: window.node.title)
            if !descend(v, depth: 0) { return }
        }
    }

    static func info(_ v: Visit, app: TargetApp, actions: [String]) -> ElementInfo {
        let n = v.node
        var e = ElementInfo(id: v.id, role: n.role)
        e.subrole = n.subrole
        e.title = n.title
        e.desc = n.desc
        e.value = n.isSecure ? "" : n.value
        e.ident = n.ident
        e.enabled = n.enabled
        e.focused = n.focused
        if let frame = n.frame {
            let r = frame.rounded
            (e.x, e.y, e.w, e.h) = (r.x, r.y, r.w, r.h)
        }
        e.actions = actions
        e.app = app.name
        e.window = v.window
        return e
    }

    // MARK: list

    static func list(_ q: ListQuery, deadline: Date) throws -> Answer {
        let app = try Apps.resolve(q.app)
        let walk = Walk(deadline: deadline)
        var windows = try windows(of: app, walk: walk)
        if let wanted = q.window {
            let query = NameMatch.normalize(wanted)
            let named = windows.filter { NameMatch.match(normalizedQuery: query, fields: [$0.node.title]) != nil }
            if named.isEmpty {
                let titles = windows.map(\.node.title).filter { !$0.isEmpty }
                let close = NameMatch.closest(to: wanted, among: titles)
                throw HelperError(.notFound, "\(app.name) has no window called “\(wanted)”." + suggestion(close), names: close)
            }
            windows = named
        }
        var out: [ElementInfo] = []
        walkTree(windows, maxDepth: q.depth, includeMenus: false, walk: walk) { v in
            var node = v.node
            guard q.roles.matches(role: node.role, subrole: node.subrole, parentRole: v.parentRole) else { return true }
            if node.title.isEmpty, node.desc.isEmpty, Roles.namedByContents.contains(node.role) {
                node.title = AX.contentsName(node, walk: walk)
            }
            guard worthListing(node) else { return true }
            if out.count >= q.limit {
                walk.incomplete = true
                return false
            }
            let v2 = Visit(node: node, id: v.id, parentRole: v.parentRole, zone: v.zone, window: v.window)
            out.append(info(v2, app: app, actions: AX.actions(node.element)))
            return true
        }
        if walk.unresponsive, out.isEmpty { throw notAnswering(app) }
        return .elements(out, truncated: walk.incomplete)
    }

    /// Whether a list shows this element: layout groups and scroll areas only when they have a name, texts when they
    /// say something, pictures when they are described, everything else always.
    static func worthListing(_ n: Node) -> Bool {
        let named = !n.title.isEmpty || !n.desc.isEmpty
        if Roles.containers.contains(n.role) { return named }
        if n.role == "AXStaticText" { return named || !n.value.isEmpty }
        if n.role == "AXImage" { return named }
        return true
    }

    // MARK: finding one element by name

    struct Hit {
        let visit: Visit
        let candidate: Candidate
        let actions: [String]
    }

    /// The element `target` names. `defaults` are the kinds looked at when no role is given; for a press, other kinds
    /// count too when they can be pressed.
    static func find(_ target: Target, name: String, defaults: Set<String>, forPress: Bool, deadline: Date) throws
        -> (TargetApp, Hit) {
        let app = try Apps.resolve(target.app)
        let walk = Walk(deadline: deadline)
        let query = NameMatch.normalize(name)
        var windows = try windows(of: app, walk: walk)
        let includeMenus = target.roles.includes(role: "AXMenuItem") || target.roles.includes(role: "AXMenuBarItem")
        if includeMenus {
            // An open menu is in front of everything; the menu bar is behind every window.
            for (i, menu) in AX.children(app.element).enumerated() {
                if let node = AX.read(menu, walk: walk), node.role == "AXMenu" {
                    windows.insert(WindowRef(id: "a\(i)", node: node, zone: 0), at: 0)
                }
            }
            if let bar = AX.element(app.element, kAXMenuBarAttribute), let node = AX.read(bar, walk: walk) {
                windows.append(WindowRef(id: "m", node: node, zone: 3))
            }
        }
        var hits: [Hit] = []
        var names: [String] = []
        walkTree(windows, maxDepth: Limits.searchDepth, includeMenus: includeMenus, walk: walk) { v in
            var node = v.node
            let kindOK = target.roles.isAny
                ? defaults.contains(node.role)
                : target.roles.matches(role: node.role, subrole: node.subrole, parentRole: v.parentRole)
            if !kindOK, !(target.roles.isAny && forPress) { return true }
            if node.title.isEmpty, node.desc.isEmpty, Roles.namedByContents.contains(node.role) {
                node.title = AX.contentsName(node, walk: walk)
            }
            guard let kind = NameMatch.match(normalizedQuery: query, fields: node.nameFields) else {
                if kindOK, !node.shownName.isEmpty, names.count < 500 { names.append(node.shownName) }
                return true
            }
            let actions = AX.actions(node.element)
            let pressable = actions.contains(where: Roles.pressActions.contains)
            // Outside the usual kinds, only something that can be pressed (a picture that is a button, a web text
            // with a click action).
            if !kindOK, !pressable { return true }
            let candidate = Candidate(
                match: kind, pressable: forPress ? pressable : true, enabled: node.enabled, zone: v.zone, order: hits.count)
            let v2 = Visit(node: node, id: v.id, parentRole: v.parentRole, zone: v.zone, window: v.window)
            hits.append(Hit(visit: v2, candidate: candidate, actions: actions))
            return true
        }
        if hits.isEmpty {
            if walk.unresponsive { throw notAnswering(app) }
            let close = NameMatch.closest(to: name, among: names)
            let partly = walk.incomplete ? " Only part of it could be searched." : ""
            throw HelperError(.notFound, "Nothing called “\(name)” in \(app.name)." + suggestion(close) + partly, names: close)
        }
        hits.sort { Candidate.ranked($0.candidate, before: $1.candidate) }
        guard target.index < hits.count else {
            let names = hits.prefix(Limits.closeNames).map(\.visit.node.shownName)
            throw HelperError(.notFound, "Only \(hits.count) match “\(name)” in \(app.name).", names: names)
        }
        return (app, hits[target.index])
    }

    /// An element found by name says that name as its title when it has none of its own (a button named only by
    /// its description, a field by its placeholder or label), so the answer names what was pressed or set.
    static func named(_ element: ElementInfo, by query: String, node: Node) -> ElementInfo {
        guard element.title.isEmpty,
              let name = NameMatch.matchedField(normalizedQuery: NameMatch.normalize(query), fields: node.nameFields)
        else { return element }
        var e = element
        e.title = clip(name)
        return e
    }

    // MARK: press

    static func press(_ target: Target, deadline: Date) throws -> Answer {
        let name = target.name ?? ""
        let (app, hit) = try find(target, name: name, defaults: Roles.interactive, forPress: true, deadline: deadline)
        let node = hit.visit.node
        let element = named(info(hit.visit, app: app, actions: hit.actions), by: name, node: node)
        guard node.enabled else { throw HelperError(.failed, "“\(node.shownName)” is greyed out: it can't be pressed now.") }
        for action in Roles.pressActions where hit.actions.contains(action) {
            switch AXUIElementPerformAction(node.element, action as CFString) {
            case .success:
                return .element(element, note: nil)
            case .cannotComplete:
                // A press that opens a dialog keeps the app busy past the timeout; the press itself went through.
                return .element(element, note: "Pressed; \(app.name) is still busy.")
            default:
                continue
            }
        }
        if let frame = node.frame, !frame.isEmpty {
            let c = frame.center
            Input.click(at: CGPoint(x: c.x, y: c.y))
            return .element(element, note: "Clicked the middle of it: it has no press action.")
        }
        throw HelperError(.failed, "“\(node.shownName)” can't be pressed: it has no action and no place on the screen.")
    }

    // MARK: set

    static func set(_ target: Target, value: String, deadline: Date) throws -> Answer {
        let node: Node
        let element: ElementInfo
        if let name = target.name {
            let (app, hit) = try find(target, name: name, defaults: Roles.textInputs, forPress: false, deadline: deadline)
            node = hit.visit.node
            element = named(info(hit.visit, app: app, actions: hit.actions), by: name, node: node)
        } else {
            // No name: whatever has the keyboard focus in the app.
            let app = try Apps.resolve(target.app)
            let walk = Walk(deadline: deadline)
            guard let focused = AX.element(app.element, kAXFocusedUIElementAttribute),
                  let n = AX.read(focused, walk: walk)
            else {
                if walk.unresponsive { throw notAnswering(app) }
                throw HelperError(.notFound, "Nothing has the keyboard focus in \(app.name).")
            }
            node = n
            let window = AX.element(focused, kAXWindowAttribute).flatMap { AX.string($0, kAXTitleAttribute) } ?? ""
            let v = Visit(node: n, id: "focused", parentRole: "", zone: 1, window: clip(window))
            element = info(v, app: app, actions: AX.actions(focused))
        }
        guard node.enabled else { throw HelperError(.failed, "“\(node.shownName)” is greyed out: it can't be changed now.") }
        try put(value, into: node, deadline: deadline)
        return .element(element, note: nil)
    }

    /// Sets a field's text: directly when the app allows it (not for a password field, whose value the helper
    /// never touches through Accessibility), else by focusing it, selecting what is in it and typing over it.
    static func put(_ value: String, into node: Node, deadline: Date) throws {
        let el = node.element
        if !node.isSecure, AX.isSettable(el, kAXValueAttribute) {
            AX.set(el, kAXFocusedAttribute, kCFBooleanTrue)
            if AX.set(el, kAXValueAttribute, value as CFString) == .success { return }
        }
        if AX.set(el, kAXFocusedAttribute, kCFBooleanTrue) != .success {
            guard let frame = node.frame, !frame.isEmpty else {
                throw HelperError(.failed, "Couldn't put the keyboard focus in “\(node.shownName)”.")
            }
            let c = frame.center
            Input.click(at: CGPoint(x: c.x, y: c.y))
        }
        usleep(100_000)
        selectAll(el)
        if value.isEmpty {
            Input.key(Input.deleteKey)
        } else {
            try Input.type(value, deadline: deadline)
        }
    }

    /// Selects the whole text of a field, so typing replaces it.
    static func selectAll(_ el: AXUIElement) {
        if let count = AX.copy(el, kAXNumberOfCharactersAttribute) as? Int {
            if count == 0 { return }
            var range = CFRange(location: 0, length: count)
            if let v = AXValueCreate(.cfRange, &range), AX.set(el, kAXSelectedTextRangeAttribute, v) == .success { return }
        }
        Input.key(Input.aKey, flags: .maskCommand)
    }

    // MARK: menu

    static func menu(app name: String?, path: [String], deadline: Date) throws -> Answer {
        let app = try Apps.resolve(name)
        let walk = Walk(deadline: deadline)
        guard let bar = AX.element(app.element, kAXMenuBarAttribute) else {
            throw HelperError(.failed, "\(app.name) has no menu bar to use.")
        }
        var level = AX.children(bar)
        var picked: Node?
        var id = "m"
        var trail: [String] = []
        for (depth, wanted) in path.enumerated() {
            var items: [(index: Int, node: Node)] = []
            for (i, el) in level.enumerated() {
                guard walk.step() else { break }
                if let node = AX.read(el, walk: walk), !node.title.isEmpty { items.append((i, node)) }
            }
            if walk.unresponsive { throw notAnswering(app) }
            let query = NameMatch.normalize(wanted)
            let matches = items.compactMap { item in
                NameMatch.match(normalizedQuery: query, fields: [item.node.title]).map { (item, $0) }
            }
            guard let best = matches.min(by: { ($0.1, $0.0.node.enabled ? 0 : 1) < ($1.1, $1.0.node.enabled ? 0 : 1) }) else {
                let close = NameMatch.closest(to: wanted, among: items.map(\.node.title))
                let place = trail.isEmpty ? "\(app.name)’s menu bar" : "the menu \(trail.joined(separator: " → "))"
                throw HelperError(.notFound, "No “\(wanted)” in \(place)." + suggestion(close), names: close)
            }
            picked = best.0.node
            id += ".\(best.0.index)"
            trail.append(best.0.node.title)
            if depth < path.count - 1 {
                guard let submenu = best.0.node.children.first else {
                    throw HelperError(.notFound, "“\(best.0.node.title)” has no menu under it.")
                }
                level = AX.children(submenu)
            }
        }
        guard let item = picked else { throw HelperError.invalid("menu needs a path") }
        let element = info(Visit(node: item, id: id, parentRole: "AXMenu", zone: 3, window: ""), app: app,
                           actions: AX.actions(item.element))
        guard item.enabled else { throw HelperError(.failed, "“\(trail.joined(separator: " → "))” is greyed out in the menu.") }
        switch AXUIElementPerformAction(item.element, kAXPressAction as CFString) {
        case .success: return .element(element, note: nil)
        case .cannotComplete: return .element(element, note: "Picked; \(app.name) is still busy.")
        case let err: throw HelperError(.failed, "Couldn't pick “\(trail.joined(separator: " → "))” (\(err.rawValue)).")
        }
    }

    static func notAnswering(_ app: TargetApp) -> HelperError {
        HelperError(.failed, "\(app.name) isn't answering: it may be busy or stuck.")
    }
}

enum Session {
    /// Whether the lock screen is up, as the window server tells this session.
    static var locked: Bool {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
        return (session["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false
    }
}

enum Displays {
    /// Every active display, the main one first, in global points.
    static func all() -> [DisplayInfo] {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
        return ids.prefix(Int(count)).map { id in
            let b = CGDisplayBounds(id)
            let pixels = CGDisplayCopyDisplayMode(id)?.pixelWidth ?? Int(CGDisplayPixelsWide(id))
            return DisplayInfo(
                id: id, bounds: Rect(x: b.origin.x, y: b.origin.y, w: b.width, h: b.height), pixelWidth: pixels,
                main: CGDisplayIsMain(id) != 0)
        }
    }
}
