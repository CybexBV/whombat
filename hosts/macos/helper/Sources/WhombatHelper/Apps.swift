import AppKit
import ApplicationServices
import HelperCore

// Running apps: which one a request means, their windows, opening one.

struct TargetApp {
    let pid: pid_t
    let name: String
    let bundleID: String
    let element: AXUIElement
    let running: NSRunningApplication?

    init(pid: pid_t, running: NSRunningApplication?) {
        self.pid = pid
        self.running = running
        name = running?.localizedName ?? running?.bundleIdentifier ?? "pid \(pid)"
        bundleID = running?.bundleIdentifier ?? ""
        element = AXUIElementCreateApplication(pid)
    }
}

enum Apps {
    static let loginWindowID = "com.apple.loginwindow"

    /// The app with the keyboard focus. Accessibility knows it best: a system dialog (a password prompt, “allow?”)
    /// has the focus without becoming the app macOS calls frontmost. The lock screen is loginwindow's: while it is
    /// up loginwindow is in front, and while it isn't, loginwindow never is (Accessibility can go on naming it for a
    /// moment after the lock screen went), so then the app macOS calls frontmost stands in.
    static func focused(locked: Bool = Session.locked) -> TargetApp? {
        if AX.trusted, let app = AX.element(AX.systemWide, kAXFocusedApplicationAttribute), let pid = AX.pid(app) {
            let running = NSRunningApplication(processIdentifier: pid)
            if locked || running?.bundleIdentifier != loginWindowID {
                return TargetApp(pid: pid, running: running)
            }
        }
        if locked, let lw = NSRunningApplication.runningApplications(withBundleIdentifier: loginWindowID).first {
            return TargetApp(pid: lw.processIdentifier, running: lw)
        }
        guard let front = frontmost() else { return nil }
        return TargetApp(pid: front.processIdentifier, running: front)
    }

    /// NSWorkspace's frontmost app, read on the main thread: it follows notifications the main run loop delivers,
    /// so read from the socket's thread it can lag behind. A main thread that doesn't answer within a second
    /// (it never should) leaves the value as this thread sees it.
    static func frontmost() -> NSRunningApplication? {
        if Thread.isMainThread { return NSWorkspace.shared.frontmostApplication }
        final class Box: @unchecked Sendable {
            var app: NSRunningApplication?
        }
        let box = Box()
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.main.async {
            box.app = NSWorkspace.shared.frontmostApplication
            done.signal()
        }
        if done.wait(timeout: .now() + 1) == .timedOut { return NSWorkspace.shared.frontmostApplication }
        return box.app
    }

    /// The app a request names: its bundle id, its name, or a part of its name; nil is the focused one. Every running
    /// app counts (a dialog may belong to a background agent), ordinary apps first.
    static func resolve(_ name: String?) throws -> TargetApp {
        guard let name else {
            guard let app = focused() else { throw HelperError(.notFound, "No app is in front.") }
            return app
        }
        let running = withFocused(NSWorkspace.shared.runningApplications.filter { !$0.isTerminated })
        let ordered = running.filter { $0.activationPolicy == .regular } + running.filter { $0.activationPolicy != .regular }
        let wanted = NameMatch.normalize(name)
        if let app = ordered.first(where: { ($0.bundleIdentifier ?? "").lowercased() == wanted }) {
            return TargetApp(pid: app.processIdentifier, running: app)
        }
        let named = ordered.compactMap { app -> (NSRunningApplication, MatchKind)? in
            guard let kind = NameMatch.match(normalizedQuery: wanted, fields: [app.localizedName ?? ""]) else { return nil }
            return (app, kind)
        }
        if let best = named.min(by: { $0.1 < $1.1 }) {
            return TargetApp(pid: best.0.processIdentifier, running: best.0)
        }
        let names = running.filter { $0.activationPolicy == .regular }.compactMap(\.localizedName)
        let close = NameMatch.closest(to: name, among: names)
        throw HelperError(.notFound, "No open app is called “\(name)”." + suggestion(close), names: close)
    }

    /// The running apps with the focused one added when NSWorkspace's list misses it. A helper started by its
    /// LaunchAgent was seen with a list that never gained a SecurityAgent started after it, while its prompt had the
    /// focus (a copy started otherwise saw it); a process looked up by its pid is always current.
    static func withFocused(_ apps: [NSRunningApplication], focused app: TargetApp? = focused()) -> [NSRunningApplication] {
        guard let app, let running = app.running, !running.isTerminated,
              !apps.contains(where: { $0.processIdentifier == app.pid })
        else { return apps }
        return apps + [running]
    }

    /// The titles of an app's windows. A stuck app costs at most one short wait.
    static func windowTitles(_ pid: pid_t) -> [String] {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.5)
        var titles: [String] = []
        for window in AX.children(app, kAXWindowsAttribute).prefix(Limits.maxWindowsPerApp) {
            var value: CFTypeRef?
            let err = AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &value)
            if err == .cannotComplete { break }
            titles.append(clip(value.flatMap(AX.text) ?? ""))
        }
        return titles
    }

    /// Ordinary apps (with a Dock icon), and the focused app when it isn't one: the assistant needs a name for the
    /// dialog in front.
    static func list(deadline: Date) -> [AppInfo] {
        // The same app status names as front_app is the active one here.
        let front = focused()
        let focusedPID = front?.pid
        let all = withFocused(NSWorkspace.shared.runningApplications.filter { !$0.isTerminated }, focused: front)
        var apps = all.filter { $0.activationPolicy == .regular }
        if let focusedPID, !apps.contains(where: { $0.processIdentifier == focusedPID }),
           let other = all.first(where: { $0.processIdentifier == focusedPID }) {
            apps.append(other)
        }
        let trusted = AX.trusted
        return apps.prefix(Limits.maxApps).map { app in
            AppInfo(
                name: app.localizedName ?? app.bundleIdentifier ?? "",
                bundleID: app.bundleIdentifier ?? "",
                pid: app.processIdentifier,
                active: app.processIdentifier == focusedPID,
                windows: trusted && Date() < deadline ? windowTitles(app.processIdentifier) : []
            )
        }
    }

    // MARK: opening

    /// Folders apps live in, searched in this order for an app that isn't running.
    static var folders: [URL] {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return [
            "/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities",
            home.appendingPathComponent("Applications").path, "/System/Library/CoreServices/Applications",
        ].map { URL(fileURLWithPath: $0, isDirectory: true) }
    }

    /// Where the app called `name` is: a running one's own place, a bundle id's, or an app of that name in the usual
    /// folders.
    static func location(of name: String) throws -> URL {
        let wanted = NameMatch.normalize(name.hasSuffix(".app") ? String(name.dropLast(4)) : name)
        for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
            if NameMatch.normalize(app.localizedName ?? "") == wanted, let url = app.bundleURL { return url }
        }
        if name.contains("."), !name.contains(" "),
           let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: name) {
            return url
        }
        var seen: [String] = []
        for folder in folders {
            let items = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
            for item in items where item.pathExtension == "app" {
                let appName = item.deletingPathExtension().lastPathComponent
                if NameMatch.normalize(appName) == wanted { return item }
                seen.append(appName)
            }
        }
        let close = NameMatch.closest(to: name, among: seen)
        throw HelperError(.notFound, "No app called “\(name)” on this Mac." + suggestion(close), names: close)
    }

    /// Starts the app (or brings it forward when it runs) and waits until macOS says it has.
    static func open(_ name: String, deadline: Date) throws {
        let url = try location(of: name)
        final class Outcome: @unchecked Sendable {
            let lock = NSLock()
            var error: Error?
        }
        let outcome = Outcome()
        let done = DispatchSemaphore(value: 0)
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
            outcome.lock.withLock { outcome.error = error }
            done.signal()
        }
        if done.wait(timeout: .now() + max(0.5, deadline.timeIntervalSinceNow)) == .timedOut {
            throw HelperError(.failed, "\(url.deletingPathExtension().lastPathComponent) is still starting.")
        }
        if let error = outcome.lock.withLock({ outcome.error }) {
            throw HelperError(.failed, "\(url.deletingPathExtension().lastPathComponent) didn't open: \(error.localizedDescription)")
        }
    }

    /// Opens a link or a Settings page with the app macOS chooses for it.
    static func open(url: URL) throws {
        guard NSWorkspace.shared.open(url) else { throw HelperError(.failed, "macOS didn't open it.") }
    }

    /// Unhides the app and brings it forward, then waits a moment for macOS to do it.
    static func focus(_ app: TargetApp, deadline: Date) {
        app.running?.unhide()
        if AX.trusted { AX.set(app.element, kAXFrontmostAttribute, kCFBooleanTrue) }
        app.running?.activate(options: [.activateAllWindows])
        let until = min(deadline, Date().addingTimeInterval(1))
        while Date() < until, NSWorkspace.shared.frontmostApplication?.processIdentifier != app.pid {
            Thread.sleep(forTimeInterval: 0.05)
        }
    }
}

/// “ Close names: “A”, “B”.” for a not_found message, or nothing.
func suggestion(_ names: [String]) -> String {
    names.isEmpty ? "" : " Close: " + names.map { "“\($0)”" }.joined(separator: ", ") + "."
}
