import Foundation
import XCTest

@testable import HelperCore

// What Find My on a Mac's page needs from the helper: apps found by the name the Mac shows, a row's own actions by
// name, the new requests and their answers, and the region a map shows. Every name and place here is made up.

final class AppMatchTests: XCTestCase {
    let findMy = AppCandidate(names: ["Find My", "FindMy"], bundleID: "com.apple.findmy", regular: true)
    let widget = AppCandidate(names: ["FindMyWidgetPeople"], bundleID: "com.apple.findmy.widget.people", regular: false)

    func testSpacesDontCount() {
        XCTAssertEqual(AppMatch.kind("FindMy", names: ["Find My"]), .exact, "the file's name is the shown name")
        XCTAssertEqual(AppMatch.kind("find my", names: ["FindMy"]), .exact)
        XCTAssertEqual(AppMatch.kind("Find", names: ["Find My"]), .prefix)
        XCTAssertEqual(AppMatch.kind("My", names: ["Find My"]), .contains)
        XCTAssertEqual(AppMatch.kind("Find", names: ["Some Finder", "Find My"]), .prefix, "the best of its names")
        XCTAssertNil(AppMatch.kind("Maps", names: ["Find My"]))
        XCTAssertNil(AppMatch.kind("  ", names: ["Find My"]))
    }

    func testOrdinaryAppWins() {
        // The widget extension runs as well and comes first: it used to take “FindMy”.
        let apps = [widget, findMy]
        XCTAssertEqual(AppMatch.best("FindMy", among: apps), 1)
        XCTAssertEqual(AppMatch.best("Find My", among: apps), 1)
        XCTAssertEqual(AppMatch.best("Find", among: apps), 1, "both start with it: the ordinary app")
        XCTAssertEqual(AppMatch.best("com.apple.findmy", among: apps), 1, "the bundle id, in any language")
        XCTAssertEqual(AppMatch.best("COM.APPLE.FINDMY", among: apps), 1)
        XCTAssertEqual(AppMatch.best("Widget", among: apps), 0, "only the extension has it")
        XCTAssertNil(AppMatch.best("Calendar", among: apps))
        // A whole name beats the start of another's, even an ordinary app's.
        let dock = AppCandidate(names: ["Dock"], bundleID: "com.apple.dock", regular: false)
        let docker = AppCandidate(names: ["Docker Desktop"], bundleID: "com.example.docker", regular: true)
        XCTAssertEqual(AppMatch.best("Dock", among: [docker, dock]), 1)
        // Alike, the order given decides.
        let a = AppCandidate(names: ["Notes"], bundleID: "a", regular: true)
        let b = AppCandidate(names: ["Notes"], bundleID: "b", regular: true)
        XCTAssertEqual(AppMatch.best("notes", among: [a, b]), 0)
    }

    func testOpeningTakesTheWholeName() {
        XCTAssertTrue(AppMatch.named("Find My", names: ["FindMy"]))
        XCTAssertTrue(AppMatch.named("FindMy.app", names: ["Find My"]))
        XCTAssertTrue(AppMatch.named("find my", names: ["Wo ist?", "Find My.app"]))
        XCTAssertFalse(AppMatch.named("Find", names: ["Find My"]))
        XCTAssertFalse(AppMatch.named("", names: [""]))
    }
}

final class ActionNameTests: XCTestCase {
    let row = [
        "AXPress", "AXShowMenu",
        "Name:Open Details\nTarget:0x0\nSelector:(null)",
        "Name:Directions\u{00A0}·\u{00A0}0 min\nTarget:0x0\nSelector:(null)",
        "Name:Play\nTarget:0x0\nSelector:(null)",
    ]

    func testDisplayNames() {
        XCTAssertEqual(ActionName.display("Name:Play\nTarget:0x0\nSelector:(null)"), "Play")
        XCTAssertEqual(ActionName.display("Name:Open Details\r\nTarget:0x0"), "Open Details")
        XCTAssertEqual(ActionName.display("Name:Contact"), "Contact", "no line break")
        XCTAssertEqual(ActionName.display("AXPress"), "AXPress")
        XCTAssertEqual(ActionName.display("Name:\nTarget:0x0"), "")
    }

    func testPicking() {
        XCTAssertEqual(ActionName.pick("Play", among: row), .found(raw: row[4], name: "Play"))
        XCTAssertEqual(ActionName.pick("play", among: row), .found(raw: row[4], name: "Play"))
        XCTAssertEqual(ActionName.pick("OpenDetails", among: row), .found(raw: row[2], name: "Open Details"))
        XCTAssertEqual(
            ActionName.pick("Directions", among: row), .found(raw: row[3], name: "Directions\u{00A0}·\u{00A0}0 min"),
            "the start of a name whose minutes change")
        XCTAssertEqual(
            ActionName.pick("Directions · 0 min", among: row), .found(raw: row[3], name: "Directions\u{00A0}·\u{00A0}0 min"))
        XCTAssertEqual(ActionName.pick("AXPress", among: row), .found(raw: "AXPress", name: "AXPress"))
        XCTAssertEqual(ActionName.pick("Stop", among: row), .none)
        XCTAssertEqual(ActionName.pick("", among: row), .none)
        XCTAssertEqual(ActionName.pick("Details", among: row), .none, "a part in the middle names nothing")
    }

    func testTwoThatStartAlikeNameNeither() {
        let person = ["Name:Remove Friend\nTarget:0x0", "Name:Remove from Favourites\nTarget:0x0"]
        XCTAssertEqual(ActionName.pick("Remove", among: person), .ambiguous(["Remove Friend", "Remove from Favourites"]))
        XCTAssertEqual(ActionName.pick("remove friend", among: person), .found(raw: person[0], name: "Remove Friend"))
        // The same name twice is one action.
        XCTAssertEqual(ActionName.pick("Op", among: ["Name:Open\nA", "Name:Open\nB"]), .found(raw: "Name:Open\nA", name: "Open"))
    }
}

final class FindMyProtocolTests: XCTestCase {
    func parse(_ json: String) throws -> Command { try Command.parse(Data(json.utf8)) }

    func refused(_ json: String, _ words: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try parse(json), json, file: file, line: line) { error in
            guard let e = error as? HelperError else { return XCTFail("\(error)", file: file, line: line) }
            XCTAssertEqual(e.code, .invalidRequest, json, file: file, line: line)
            XCTAssertTrue(e.message.contains(words), "\(json): \(e.message)", file: file, line: line)
        }
    }

    func testNewOps() throws {
        XCTAssertEqual(
            try parse(#"{"v":1,"op":"action","app":"Find My","name":"Pat Example","role":"AXButton","index":1,"action":"Open Details"}"#),
            .action(Target(app: "Find My", name: "Pat Example", roles: RoleFilter(rules: [RoleRule("AXButton")]), index: 1),
                    action: "Open Details"))
        XCTAssertEqual(try parse(#"{"v":1,"op":"quit","app":"com.apple.findmy"}"#), .quit(app: "com.apple.findmy"))
        XCTAssertEqual(
            try parse(#"{"v":1,"op":"geocode","queries":[" Dam, Amsterdam ","Example Street 1, Springfield"]}"#),
            .geocode(["Dam, Amsterdam", "Example Street 1, Springfield"]))
        XCTAssertEqual(
            try parse(#"{"v":1,"op":"map","w":300,"h":200,"scale":1,"dark":true,"format":"png","pins":[{"lat":52.37,"lon":4.89}]}"#),
            .map(MapRequest(w: 300, h: 200, scale: 1, dark: true, format: .png, pins: [MapPin(lat: 52.37, lon: 4.89)])))
        XCTAssertEqual(
            try parse(#"{"op":"map","lat":-33.9,"lon":151.2,"span_m":2500}"#),
            .map(MapRequest(center: MapPin(lat: -33.9, lon: 151.2), spanM: 2500)), "600×400 at 2× in JPEG unless asked")
        XCTAssertEqual(try parse(#"{"op":"map","w":0,"h":0,"scale":0,"format":"jpg","pins":[{"lat":0,"lon":0}]}"#),
                       .map(MapRequest(pins: [MapPin(lat: 0, lon: 0)])), "0 is the default, as Go's omitempty leaves it")
    }

    func testNewOpsRefusals() {
        refused(#"{"op":"action","action":"Play"}"#, "name")
        refused(#"{"op":"action","name":"Pat Example"}"#, "action")
        refused(#"{"op":"action","name":"Pat Example","action":"  "}"#, "action")
        refused(#"{"op":"action","name":"Pat Example","action":"\#(String(repeating: "a", count: 201))"}"#, "too long")
        refused(#"{"op":"quit"}"#, "app")
        refused(#"{"op":"geocode"}"#, "1 to 8")
        refused(#"{"op":"geocode","queries":[]}"#, "1 to 8")
        refused(#"{"op":"geocode","queries":["a","b","c","d","e","f","g","h","i"]}"#, "1 to 8")
        refused(#"{"op":"geocode","queries":["Dam, Amsterdam",""]}"#, "empty")
        refused(#"{"op":"geocode","queries":["\#(String(repeating: "x", count: 301))"]}"#, "300")
        refused(#"{"op":"map"}"#, "pins")
        refused(#"{"op":"map","w":63,"pins":[{"lat":1,"lon":1}]}"#, "64 to 1600")
        refused(#"{"op":"map","h":1601,"pins":[{"lat":1,"lon":1}]}"#, "64 to 1600")
        refused(#"{"op":"map","scale":3,"pins":[{"lat":1,"lon":1}]}"#, "scale")
        refused(#"{"op":"map","format":"gif","pins":[{"lat":1,"lon":1}]}"#, "format")
        refused(#"{"op":"map","pins":[{"lat":91,"lon":1}]}"#, "lat")
        refused(#"{"op":"map","pins":[{"lat":1,"lon":-181}]}"#, "lon")
        refused(#"{"op":"map","pins":[{"lat":1}]}"#, "lon")
        refused(#"{"op":"map","pins":[\#(Array(repeating: #"{"lat":1,"lon":1}"#, count: 21).joined(separator: ","))]}"#, "20")
        refused(#"{"op":"map","lat":1,"lon":1}"#, "together")
        refused(#"{"op":"map","lat":1,"span_m":1000,"pins":[{"lat":1,"lon":1}]}"#, "together")
        refused(#"{"op":"map","lat":1,"lon":1,"span_m":49}"#, "span_m")
        refused(#"{"op":"map","lat":1,"lon":1,"span_m":20000001}"#, "span_m")
        refused(#"{"op":"map","lat":1,"lon":1,"span_m":"far"}"#, "span_m")
    }

    func testWhatTheyNeedAndHowLong() throws {
        let action = try parse(#"{"op":"action","name":"x","action":"Play"}"#)
        XCTAssertTrue(action.needsAccessibility)
        XCTAssertTrue(action.refusedWhileLocked)
        for json in [#"{"op":"quit","app":"Maps"}"#, #"{"op":"geocode","queries":["x"]}"#,
                     #"{"op":"map","pins":[{"lat":1,"lon":1}]}"#] {
            let c = try parse(json)
            XCTAssertFalse(c.needsAccessibility, json)
            XCTAssertFalse(c.refusedWhileLocked, json)
        }
        XCTAssertEqual(Command.seconds(forLine: Data(#"{"op":"geocode","queries":["x"]}"#.utf8)), 20)
        XCTAssertEqual(Command.seconds(forLine: Data(#"{"op":"map","pins":[{"lat":1,"lon":1}]}"#.utf8)), 20)
        XCTAssertEqual(Command.seconds(forLine: Data(#"{"op":"list"}"#.utf8)), 10)
        XCTAssertEqual(Command.seconds(forLine: Data("nonsense".utf8)), 10)
    }

    func json(_ answer: Answer) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: answer.line()) as? [String: Any])
    }

    func testPlacesKeepTheOrder() throws {
        let j = try json(.places([Place(lat: 52.3731234567, lon: 4.8925, accuracyM: 35.4), nil, Place(lat: 1, lon: 2, accuracyM: -1)]))
        let places = try XCTUnwrap(j["places"] as? [Any])
        XCTAssertEqual(places.count, 3)
        let first = try XCTUnwrap(places[0] as? [String: Any])
        XCTAssertEqual(first["lat"] as? Double, 52.373123)
        XCTAssertEqual(first["accuracy_m"] as? Int, 35)
        XCTAssertTrue(places[1] is NSNull, "nothing found is null in its place")
        XCTAssertEqual((places[2] as? [String: Any])?["accuracy_m"] as? Int, 100, "unknown accuracy: about 100 m")
    }

    func testMapAnswer() throws {
        let region = MapRegion(lat: 52.37, lon: 4.89, spanM: 1234.4, latDelta: 0.01, lonDelta: 0.02)
        let j = try json(.map(MapImage(
            image: Data([0xFF, 0xD8, 0xFF]), format: .jpeg, w: 1200, h: 800,
            points: [MapPoint(x: 300.04, y: 199.96), nil], region: region)))
        XCTAssertEqual(j["image"] as? String, "/9j/", "base64")
        XCTAssertEqual(j["format"] as? String, "jpeg")
        XCTAssertEqual(j["w"] as? Int, 1200)
        XCTAssertEqual(j["h"] as? Int, 800)
        XCTAssertEqual(j["span_m"] as? Double, 1234)
        XCTAssertEqual(j["lat"] as? Double, 52.37)
        let points = try XCTUnwrap(j["points"] as? [Any])
        XCTAssertEqual((points[0] as? [String: Any])?["x"] as? Double, 300)
        XCTAssertEqual((points[0] as? [String: Any])?["y"] as? Double, 200)
        XCTAssertTrue(points[1] is NSNull, "a pin outside the picture is null")
    }

    func testIdleSeconds() throws {
        let busy = try json(.status(StatusInfo(version: "1.1.0", ax: true, locked: false, user: "someone", frontApp: nil,
                                               frontWindow: nil, displays: [], idleS: 12)))
        XCTAssertEqual(busy["idle_s"] as? Int, 12)
        let unknown = try json(.status(StatusInfo(version: "1.1.0", ax: true, locked: false, user: "someone",
                                                  frontApp: nil, frontWindow: nil, displays: [])))
        XCTAssertTrue(unknown["idle_s"] is NSNull, "unknown is null, not left out")
    }
}

final class MapFitTests: XCTestCase {
    func testOnePin() {
        let r = MapFit.region(for: MapRequest(w: 600, h: 400, pins: [MapPin(lat: 52.37, lon: 4.89)]))
        XCTAssertEqual(r.lat, 52.37, accuracy: 1e-9)
        XCTAssertEqual(r.lon, 4.89, accuracy: 1e-9)
        XCTAssertEqual(r.spanM, 600, accuracy: 1e-6, "600 m across the shorter side")
        XCTAssertEqual(r.latDelta, 600 / MapFit.metresPerDegree, accuracy: 1e-9)
        // Wider than high, and a degree of longitude is shorter up north.
        XCTAssertEqual(r.lonDelta, 900 / (MapFit.metresPerDegree * cos(52.37 * .pi / 180)), accuracy: 1e-9)
    }

    func testPinsWithAMargin() {
        // About 11 km north to south and little east to west: the height decides.
        let pins = [MapPin(lat: 52.30, lon: 4.90), MapPin(lat: 52.40, lon: 4.91)]
        let r = MapFit.region(for: MapRequest(w: 600, h: 400, pins: pins))
        XCTAssertEqual(r.lat, 52.35, accuracy: 1e-9)
        XCTAssertEqual(r.lon, 4.905, accuracy: 1e-9)
        XCTAssertEqual(r.latDelta, 0.1 * MapLimits.margin, accuracy: 1e-9)
        XCTAssertEqual(r.spanM, 0.1 * MapFit.metresPerDegree * MapLimits.margin, accuracy: 1e-6)
        // East to west: the width decides, and the shorter side follows from it.
        let wide = [MapPin(lat: 0, lon: 10), MapPin(lat: 0, lon: 11)]
        let w = MapFit.region(for: MapRequest(w: 400, h: 400, pins: wide))
        XCTAssertEqual(w.lonDelta, 1.3, accuracy: 1e-9)
        XCTAssertEqual(w.spanM, MapFit.metresPerDegree * 1.3, accuracy: 1e-6)
        // Close together: never less than 600 m.
        let near = [MapPin(lat: 10, lon: 10), MapPin(lat: 10.0001, lon: 10.0001)]
        XCTAssertEqual(MapFit.region(for: MapRequest(w: 400, h: 300, pins: near)).spanM, 600, accuracy: 1e-6)
    }

    func testEveryPinIsInside() {
        let pins = [MapPin(lat: 48.85, lon: 2.35), MapPin(lat: 51.51, lon: -0.13), MapPin(lat: 50.85, lon: 4.35)]
        for (w, h) in [(600, 400), (400, 600), (64, 1600)] {
            let r = MapFit.region(for: MapRequest(w: w, h: h, pins: pins))
            for p in pins {
                XCTAssertLessThanOrEqual(abs(p.lat - r.lat), r.latDelta / 2, "\(w)×\(h)")
                XCTAssertLessThanOrEqual(abs(p.lon - r.lon), r.lonDelta / 2, "\(w)×\(h)")
            }
        }
    }

    func testTheShorterWayRound() {
        // Both sides of the 180th meridian: a few degrees, not most of the world.
        let pins = [MapPin(lat: -17, lon: 179), MapPin(lat: -17, lon: -179)]
        let r = MapFit.region(for: MapRequest(w: 400, h: 400, pins: pins))
        XCTAssertEqual(abs(r.lon), 180, accuracy: 1e-9)
        XCTAssertEqual(r.lonDelta, 2 * MapLimits.margin, accuracy: 1e-6)
    }

    func testTheRegionAskedFor() {
        let r = MapFit.region(for: MapRequest(w: 600, h: 400, pins: [MapPin(lat: 1, lon: 1)],
                                              center: MapPin(lat: 52.37, lon: 4.89), spanM: 2000))
        XCTAssertEqual(r.lat, 52.37)
        XCTAssertEqual(r.lon, 4.89)
        XCTAssertEqual(r.spanM, 2000, accuracy: 1e-9, "the pins don't move it")
        XCTAssertEqual(r.latDelta, 2000 / MapFit.metresPerDegree, accuracy: 1e-12)
        // A world-sized one stays inside the world.
        let world = MapFit.region(for: MapRequest(w: 1600, h: 64, center: MapPin(lat: 0, lon: 0), spanM: 20_000_000))
        XCTAssertLessThanOrEqual(world.latDelta, 180)
        XCTAssertLessThanOrEqual(world.lonDelta, 360)
        XCTAssertEqual(MapFit.normalized(190), -170, accuracy: 1e-9)
        XCTAssertEqual(MapFit.normalized(-180), -180, accuracy: 1e-9)
    }
}
