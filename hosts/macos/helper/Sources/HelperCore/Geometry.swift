import Foundation

// Where things are. Everything the helper says or clicks is in global display points with the origin at the top-left
// of the main display and y growing downwards: what Accessibility and Quartz events use. (AppKit's NSScreen measures
// from the bottom-left; the helper never uses it.)

public struct Rect: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var w: Double
    public var h: Double

    public init(x: Double, y: Double, w: Double, h: Double) {
        self.x = x
        self.y = y
        self.w = w
        self.h = h
    }

    public var isEmpty: Bool { w <= 0 || h <= 0 }

    /// Where a click on it lands.
    public var center: (x: Double, y: Double) { (x + w / 2, y + h / 2) }

    public func contains(x px: Double, y py: Double) -> Bool {
        px >= x && px < x + w && py >= y && py < y + h
    }

    /// Whole points for the answer: the edges rounded, so the width is the rounded right edge minus the rounded left
    /// one and neighbours never overlap by rounding.
    public var rounded: (x: Int, y: Int, w: Int, h: Int) {
        let left = (x).rounded(), top = (y).rounded()
        let right = (x + w).rounded(), bottom = (y + h).rounded()
        return (Int(left), Int(top), Int(right - left), Int(bottom - top))
    }
}

/// A display as `status` reports it.
public struct DisplayInfo: Encodable, Equatable, Sendable {
    public var id: UInt32
    public var x: Int
    public var y: Int
    public var w: Int
    public var h: Int
    /// Pixels per point (2 on a Retina display).
    public var scale: Double
    public var main: Bool

    public init(id: UInt32, bounds: Rect, pixelWidth: Int, main: Bool) {
        let r = bounds.rounded
        self.id = id
        x = r.x
        y = r.y
        w = r.w
        h = r.h
        scale = bounds.w > 0 && pixelWidth > 0 ? (Double(pixelWidth) / bounds.w * 100).rounded() / 100 : 1
        self.main = main
    }
}

/// The display a point is on, or nil when it is on none (off every screen).
public func display(containing x: Double, _ y: Double, in displays: [DisplayInfo]) -> DisplayInfo? {
    displays.first { Rect(x: Double($0.x), y: Double($0.y), w: Double($0.w), h: Double($0.h)).contains(x: x, y: y) }
}
