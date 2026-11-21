import CoreGraphics
import Foundation

// The windows on the screen, front to back, as the window server lists them: who owns each and where it is. It needs
// no permission at all (no Accessibility, no Screen Recording), so the agent can tell what is in front, a password
// prompt of macOS's own for instance, before the helper has Accessibility. Titles are never read: without Screen
// Recording macOS leaves them out, and the helper never asks for it.

/// What the helper knows of a window's owner beyond the window server's word: from NSRunningApplication.
public struct WindowOwner: Equatable, Sendable {
    public var bundleID: String
    /// The owner's executable.
    public var path: String
    /// Its bundle (an app, an app extension), when it has one.
    public var bundlePath: String

    public init(bundleID: String, path: String, bundlePath: String) {
        self.bundleID = bundleID
        self.path = path
        self.bundlePath = bundlePath
    }
}

public struct WindowInfo: Encodable, Equatable, Sendable {
    /// The window server's number for it: the same window keeps it while it is open.
    public var number: Int
    /// Its level: 0 ordinary windows, 20 the Dock, 24 the menu bar, 1000 SecurityAgent's prompts.
    public var layer: Int
    public var alpha: Double
    /// Bounds in global display points, top-left origin (what `list` and `status` use).
    public var x: Int
    public var y: Int
    public var w: Int
    public var h: Int
    public var pid: Int32
    /// The owner's process name as the window server says it.
    public var owner: String
    public var bundleID: String = ""
    public var path: String = ""
    public var bundlePath: String = ""

    public init(number: Int, layer: Int, alpha: Double, bounds: Rect, pid: Int32, owner: String) {
        self.number = number
        self.layer = layer
        self.alpha = alpha
        let r = bounds.rounded
        (x, y, w, h) = (r.x, r.y, r.w, r.h)
        self.pid = pid
        self.owner = owner
    }

    enum CodingKeys: String, CodingKey {
        case number, layer, alpha, x, y, w, h, pid, owner, bundleID = "bundle_id", path, bundlePath = "bundle_path"
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(number, forKey: .number)
        try c.encode(layer, forKey: .layer)
        try c.encode(alpha, forKey: .alpha)
        try c.encode(x, forKey: .x)
        try c.encode(y, forKey: .y)
        try c.encode(w, forKey: .w)
        try c.encode(h, forKey: .h)
        try c.encode(pid, forKey: .pid)
        try c.encode(owner, forKey: .owner)
        for (key, text) in [(CodingKeys.bundleID, bundleID), (.path, path), (.bundlePath, bundlePath)] where !text.isEmpty {
            try c.encode(text, forKey: key)
        }
    }
}

public enum WindowList {
    /// The most windows one answer carries; a busy screen has a few dozen.
    public static let maxWindows = 200

    /// The window server's descriptions (`CGWindowListCopyWindowInfo`, front to back) as the answer lists them, at
    /// most `maxWindows` (`truncated` when there were more). A description without a number, a layer, an owner or
    /// bounds is left out. `owner` looks a process up once per pid.
    public static func parse(_ raw: [[String: Any]], owner lookup: (Int32) -> WindowOwner?) -> (windows: [WindowInfo], truncated: Bool) {
        var out: [WindowInfo] = []
        var owners: [Int32: WindowOwner?] = [:]
        for item in raw {
            guard let number = int(item[kCGWindowNumber as String]),
                  let layer = int(item[kCGWindowLayer as String]),
                  let pid = int(item[kCGWindowOwnerPID as String]),
                  let bounds = rect(item[kCGWindowBounds as String])
            else { continue }
            if out.count >= maxWindows { return (out, true) }
            let alpha = (item[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
            let name = clip(item[kCGWindowOwnerName as String] as? String ?? "")
            var w = WindowInfo(number: number, layer: layer, alpha: alpha, bounds: bounds, pid: Int32(truncatingIfNeeded: pid), owner: name)
            let found: WindowOwner?
            if let known = owners[w.pid] {
                found = known
            } else {
                found = lookup(w.pid)
                owners[w.pid] = found
            }
            if let found {
                w.bundleID = clip(found.bundleID)
                w.path = clip(found.path, to: 1024)
                w.bundlePath = clip(found.bundlePath, to: 1024)
            }
            out.append(w)
        }
        return (out, false)
    }

    static func int(_ value: Any?) -> Int? {
        guard let n = value as? NSNumber else { return nil }
        let d = n.doubleValue
        guard d.isFinite, d >= Double(Int32.min), d <= Double(Int32.max) else { return nil }
        return n.intValue
    }

    /// `kCGWindowBounds`: a dictionary of X, Y, Width and Height (`CGRectMakeWithDictionaryRepresentation`'s form).
    static func rect(_ value: Any?) -> Rect? {
        guard let d = value as? [String: Any] else { return nil }
        let parts = ["X", "Y", "Width", "Height"].map { (d[$0] as? NSNumber)?.doubleValue }
        guard let x = parts[0], let y = parts[1], let w = parts[2], let h = parts[3],
              [x, y, w, h].allSatisfy({ $0.isFinite && abs($0) < 1e6 })
        else { return nil }
        return Rect(x: x, y: y, w: w, h: h)
    }
}
