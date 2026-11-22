import AppKit
import CoreLocation
import HelperCore
import MapKit

// Places and map pictures for Find My on a Mac's page: Apple's geocoder turns the addresses Find My shows into places,
// and MapKit draws them on a map. Both ask Apple's map service, which already knows these places, so nothing new
// learns where anyone is. Neither needs Accessibility, and both work while the screen is locked.

enum Geo {
    static let cache = PlaceCache()
    static let queue = DispatchQueue(label: "com.whombat.helper.map", qos: .userInitiated)

    // MARK: geocode

    /// Finds each query's place, in order (nil where nothing was found), one query at a time, also across requests:
    /// Apple's geocoder holds back a program that asks many at once. Answers are kept for an hour.
    static func geocode(_ queries: [String], deadline: Date) throws -> Answer {
        guard cache.turn.lock(before: deadline) else {
            throw HelperError(.failed, "Another search for places is still running; try again.")
        }
        defer { cache.turn.unlock() }
        var places: [Place?] = []
        for query in queries {
            let key = NameMatch.normalize(query)
            if let known = cache.get(key) {
                places.append(known.place)
                continue
            }
            guard Date() < deadline else { throw HelperError(.failed, "Finding the places took too long.") }
            let place = try lookUp(query, deadline: deadline)
            cache.put(key, place)
            places.append(place)
        }
        return .places(places)
    }

    /// One address's place: MapKit's geocoding on macOS 26 and later, Core Location's before.
    static func lookUp(_ query: String, deadline: Date) throws -> Place? {
        let outcome = Outcome<Place?>()
        let done = DispatchSemaphore(value: 0)
        let cancel: @Sendable () -> Void
        if #available(macOS 26, *) {
            let pending = Pending()
            Task { @MainActor in
                defer { done.signal() }
                guard let request = MKGeocodingRequest(addressString: query) else {
                    outcome.set(.success(nil))
                    return
                }
                let held = Held(request)
                pending.cancel = { Task { @MainActor in held.value.cancel() } }
                do {
                    let items = try await request.mapItems
                    outcome.set(.success(items.first.map { item in
                        Place(lat: item.location.coordinate.latitude, lon: item.location.coordinate.longitude,
                              accuracyM: item.location.horizontalAccuracy)
                    }))
                } catch {
                    outcome.set(.failure(error))
                }
            }
            cancel = { pending.cancel?() }
        } else {
            let geocoder = CLGeocoder()
            geocoder.geocodeAddressString(query) { placemarks, error in
                if let location = placemarks?.first?.location {
                    outcome.set(.success(Place(lat: location.coordinate.latitude, lon: location.coordinate.longitude,
                                               accuracyM: location.horizontalAccuracy)))
                } else if let error {
                    outcome.set(.failure(error))
                } else {
                    outcome.set(.success(nil))
                }
                done.signal()
            }
            let held = Held(geocoder)
            cancel = { held.value.cancelGeocode() }
        }
        if done.wait(timeout: .now() + max(0, deadline.timeIntervalSinceNow)) == .timedOut {
            cancel()
            throw HelperError(.failed, "Apple's map service didn't answer in time.")
        }
        switch outcome.get() {
        case let .success(place)?:
            return place
        case let .failure(error)?:
            if nothingFound(error) { return nil }
            throw HelperError(.failed, "Apple's map service couldn't look that up: \(error.localizedDescription)")
        case nil:
            throw HelperError(.failed, "Apple's map service gave no answer.")
        }
    }

    /// The geocoders' “no such place”, which is an answer (null), not a failure.
    static func nothingFound(_ error: Error) -> Bool {
        let e = error as NSError
        return (e.domain == kCLErrorDomain && e.code == CLError.Code.geocodeFoundNoResult.rawValue)
            || (e.domain == MKError.errorDomain && e.code == Int(MKError.Code.placemarkNotFound.rawValue))
    }

    // MARK: map

    /// A map picture of the request's region (MapFit), with where each pin lands on it.
    static func map(_ r: MapRequest, deadline: Date) throws -> Answer {
        let region = MapFit.region(for: r)
        let options = MKMapSnapshotter.Options()
        options.region = MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: region.lat, longitude: region.lon),
            span: MKCoordinateSpan(latitudeDelta: region.latDelta, longitudeDelta: region.lonDelta))
        options.size = NSSize(width: r.w, height: r.h)
        options.mapType = .standard
        // Where people are, not shops and museums: those would crowd the people's pictures on the map.
        options.pointOfInterestFilter = .excludingAll
        // Light or dark as asked, whatever the Mac's own setting.
        options.appearance = NSAppearance(named: r.dark ? .darkAqua : .aqua)
        let snapshotter = MKMapSnapshotter(options: options)
        let outcome = Outcome<MapImage>()
        let done = DispatchSemaphore(value: 0)
        snapshotter.start(with: queue) { snapshot, error in
            defer { done.signal() }
            guard let snapshot else {
                outcome.set(.failure(error ?? HelperError(.failed, "MapKit drew nothing.")))
                return
            }
            outcome.set(Result { try render(snapshot, r, region) })
        }
        if done.wait(timeout: .now() + max(0, deadline.timeIntervalSinceNow)) == .timedOut {
            snapshotter.cancel()
            throw HelperError(.failed, "The map wasn't drawn in time.")
        }
        switch outcome.get() {
        case let .success(image)?:
            return .map(image)
        case let .failure(error as HelperError)?:
            throw error
        case let .failure(error)?:
            throw HelperError(.failed, "MapKit couldn't draw the map: \(error.localizedDescription)")
        case nil:
            throw HelperError(.failed, "MapKit drew nothing.")
        }
    }

    /// The snapshot at `scale` pixels per point, encoded, with the pins' points (from the top-left, as everything the
    /// helper answers) and the region it shows.
    static func render(_ snapshot: MKMapSnapshotter.Snapshot, _ r: MapRequest, _ region: MapRegion) throws -> MapImage {
        let pw = r.w * r.scale, ph = r.h * r.scale
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: pw, pixelsHigh: ph, bitsPerSample: 8, samplesPerPixel: 4,
            hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
        else { throw HelperError(.failed, "Couldn't make room for the map picture.") }
        // In points before the context is made, so drawing in points fills all its pixels. MapKit draws at the Mac's
        // own screen scale: on a Mac with a 1× screen a 2× picture is that map enlarged.
        rep.size = NSSize(width: r.w, height: r.h)
        guard let context = NSGraphicsContext(bitmapImageRep: rep) else {
            throw HelperError(.failed, "Couldn't make room for the map picture.")
        }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        context.imageInterpolation = .high
        snapshot.image.draw(in: NSRect(x: 0, y: 0, width: r.w, height: r.h))
        context.flushGraphics()
        NSGraphicsContext.restoreGraphicsState()
        let encoded = r.format == .png
            ? rep.representation(using: .png, properties: [:])
            : rep.representation(using: .jpeg, properties: [.compressionFactor: 0.8])
        guard let data = encoded else { throw HelperError(.failed, "Couldn't encode the map picture.") }

        func point(_ lat: Double, _ lon: Double) -> NSPoint {
            snapshot.point(for: CLLocationCoordinate2D(latitude: lat, longitude: lon))
        }
        // AppKit's points may grow upwards; the answer's grow downwards. A place north of the middle says which.
        let middle = point(region.lat, region.lon)
        let north = point(min(89, region.lat + region.latDelta / 4), region.lon)
        let upwards = north.y > middle.y
        let points: [MapPoint?] = r.pins.map { pin in
            let p = point(pin.lat, pin.lon)
            let y = upwards ? Double(r.h) - p.y : p.y
            guard p.x.isFinite, y.isFinite, p.x >= 0, p.x <= Double(r.w), y >= 0, y <= Double(r.h) else { return nil }
            return MapPoint(x: p.x, y: y)
        }
        // MapKit may show a little more than asked to keep the picture's proportions: the span drawn is measured
        // across its middle.
        var drawn = region
        let step = min(region.lonDelta / 4, 10)
        let east = point(region.lat, MapFit.normalized(region.lon + step))
        let dx = abs(east.x - middle.x)
        if dx > 1, dx.isFinite {
            let metres = step * MapFit.metresPerDegree * MapFit.cosine(region.lat)
            drawn.spanM = metres / dx * Double(min(r.w, r.h))
        }
        return MapImage(image: data, format: r.format, w: pw, h: ph, points: points, region: drawn)
    }
}

/// The places `geocode` found, for an hour, and the turn that keeps one search at a time.
final class PlaceCache: @unchecked Sendable {
    struct Entry {
        let place: Place?
        let at: Date
    }

    static let keep: TimeInterval = 3600
    static let most = 1000

    let turn = NSLock()
    private let lock = NSLock()
    private var entries: [String: Entry] = [:]

    func get(_ key: String) -> Entry? {
        lock.withLock {
            guard let e = entries[key], Date().timeIntervalSince(e.at) < Self.keep else { return nil }
            return e
        }
    }

    func put(_ key: String, _ place: Place?) {
        lock.withLock {
            let now = Date()
            entries = entries.filter { now.timeIntervalSince($0.value.at) < Self.keep }
            if entries.count >= Self.most, let oldest = entries.min(by: { $0.value.at < $1.value.at }) {
                entries[oldest.key] = nil
            }
            entries[key] = Entry(place: place, at: now)
        }
    }
}

/// A result handed from a callback to the thread waiting for it.
final class Outcome<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Result<T, Error>?

    func set(_ v: Result<T, Error>) { lock.withLock { value = v } }
    func get() -> Result<T, Error>? { lock.withLock { value } }
}

/// How to stop a request that runs elsewhere, once it has started.
final class Pending: @unchecked Sendable {
    private let lock = NSLock()
    private var stop: (@Sendable () -> Void)?

    var cancel: (@Sendable () -> Void)? {
        get { lock.withLock { stop } }
        set { lock.withLock { stop = newValue } }
    }
}

/// Keeps an object for a closure that may run on another thread.
final class Held<T>: @unchecked Sendable {
    let value: T
    init(_ value: T) { self.value = value }
}
