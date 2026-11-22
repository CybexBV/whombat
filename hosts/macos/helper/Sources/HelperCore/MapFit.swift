import Foundation

// The `map` request: which part of the world a map picture shows. Whombat draws the map of a Mac's Find My on the Mac
// itself with MapKit (Apple already holds those places; nothing new learns them), so the helper chooses the region:
// the one asked for, or one around every pin.

/// A place on the map, in degrees.
public struct MapPin: Equatable, Sendable {
    public var lat: Double
    public var lon: Double

    public init(lat: Double, lon: Double) {
        self.lat = lat
        self.lon = lon
    }
}

public enum ImageFormat: String, Equatable, Sendable {
    case jpeg, png
}

/// A map picture asked for: its size in points, pixels per point, light or dark, the pins to place, and the region
/// when the request names one.
public struct MapRequest: Equatable, Sendable {
    public var w: Int
    public var h: Int
    public var scale: Int
    public var dark: Bool
    public var format: ImageFormat
    public var pins: [MapPin]
    /// The middle of the region asked for, with `spanM`; nil: around the pins.
    public var center: MapPin?
    /// Metres across the picture's shorter side.
    public var spanM: Double?

    public init(w: Int = MapLimits.defaultW, h: Int = MapLimits.defaultH, scale: Int = MapLimits.defaultScale,
                dark: Bool = false, format: ImageFormat = .jpeg, pins: [MapPin] = [], center: MapPin? = nil,
                spanM: Double? = nil) {
        self.w = w
        self.h = h
        self.scale = scale
        self.dark = dark
        self.format = format
        self.pins = pins
        self.center = center
        self.spanM = spanM
    }
}

public enum MapLimits {
    public static let minSide = 64
    public static let maxSide = 1600
    public static let defaultW = 600
    public static let defaultH = 400
    /// Two pixels per point unless asked otherwise: the apps show it on high-density screens.
    public static let defaultScale = 2
    public static let maxPins = 20
    public static let minSpanM = 50.0
    public static let maxSpanM = 20_000_000.0
    /// A region around pins is never smaller than this across its shorter side, nor one around a single pin.
    public static let pinSpanM = 600.0
    /// A region around pins is their extent and this much more, so no pin sits on the picture's edge.
    public static let margin = 1.3
}

/// The region a map shows: its middle, metres across the picture's shorter side, and the degrees it spans.
public struct MapRegion: Equatable, Sendable {
    public var lat: Double
    public var lon: Double
    public var spanM: Double
    public var latDelta: Double
    public var lonDelta: Double
}

public enum MapFit {
    /// Metres in one degree of latitude (and of longitude at the equator).
    public static let metresPerDegree = 111_320.0

    /// The region for a request: the one it names, else every pin with the margin, at least `pinSpanM` across.
    /// The region has the picture's proportions, so MapKit draws it as it is.
    public static func region(for r: MapRequest) -> MapRegion {
        let short = Double(min(r.w, r.h))
        if let center = r.center, let span = r.spanM {
            return region(lat: center.lat, lon: center.lon, metresPerPoint: span / short, w: r.w, h: r.h)
        }
        let lats = r.pins.map(\.lat)
        guard let south = lats.min(), let north = lats.max() else {
            return region(lat: 0, lon: 0, metresPerPoint: MapLimits.pinSpanM / short, w: r.w, h: r.h)
        }
        let (west, lonExtent) = longitudes(r.pins.map(\.lon))
        let lat = (south + north) / 2
        let lon = normalized(west + lonExtent / 2)
        let heightM = (north - south) * metresPerDegree
        let widthM = lonExtent * metresPerDegree * cosine(lat)
        let mpp = max(widthM * MapLimits.margin / Double(r.w), heightM * MapLimits.margin / Double(r.h),
                      MapLimits.pinSpanM / short)
        return region(lat: lat, lon: lon, metresPerPoint: mpp, w: r.w, h: r.h)
    }

    static func region(lat: Double, lon: Double, metresPerPoint mpp: Double, w: Int, h: Int) -> MapRegion {
        MapRegion(
            lat: lat, lon: lon, spanM: mpp * Double(min(w, h)),
            latDelta: min(180, mpp * Double(h) / metresPerDegree),
            lonDelta: min(360, mpp * Double(w) / (metresPerDegree * cosine(lat))))
    }

    /// The westmost longitude and how many degrees east the pins reach from it, the shorter way round: pins on both
    /// sides of the 180th meridian span a few degrees, not most of the world.
    static func longitudes(_ lons: [Double]) -> (west: Double, extent: Double) {
        let sorted = lons.sorted()
        guard let first = sorted.first, let last = sorted.last else { return (0, 0) }
        var west = first
        var extent = last - first
        // The largest gap between neighbours (round the back too) is what the region leaves out.
        for i in sorted.indices.dropFirst() {
            let gap = sorted[i] - sorted[i - 1]
            if 360 - gap < extent {
                extent = 360 - gap
                west = sorted[i]
            }
        }
        return (west, extent)
    }

    /// A longitude in −180..<180.
    public static func normalized(_ lon: Double) -> Double {
        var l = lon.truncatingRemainder(dividingBy: 360)
        if l >= 180 { l -= 360 }
        if l < -180 { l += 360 }
        return l
    }

    /// cos(latitude), kept away from 0 near the poles.
    public static func cosine(_ lat: Double) -> Double {
        max(0.01, cos(lat * .pi / 180))
    }
}
