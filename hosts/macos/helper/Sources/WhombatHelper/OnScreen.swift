import AppKit
import CoreGraphics
import HelperCore

// The `windows` op: what the window server says is on the screen, front to back. It works without Accessibility, so
// the agent can recognise macOS's own password prompt in front while the helper is still waiting for that
// permission (the prompt that switches it on, for one).

enum OnScreen {
    static func windows() -> Answer {
        // Desktop elements (the wallpaper, Finder's icons) are behind everything and say nothing about what is in front.
        let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]] ?? []
        let (list, truncated) = WindowList.parse(raw) { pid in
            guard let app = NSRunningApplication(processIdentifier: pid) else { return nil }
            return WindowOwner(
                bundleID: app.bundleIdentifier ?? "",
                path: app.executableURL?.resolvingSymlinksInPath().path ?? "",
                bundlePath: app.bundleURL?.path ?? "")
        }
        return .windows(list, truncated: truncated)
    }
}
