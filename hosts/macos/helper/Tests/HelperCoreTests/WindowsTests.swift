import CoreGraphics
import Foundation
import XCTest

@testable import HelperCore

final class WindowsTests: XCTestCase {
    /// A window as CGWindowListCopyWindowInfo describes it (names as the window server gives them).
    func cg(_ number: Int, layer: Int, pid: Int32, owner: String, _ x: Double, _ y: Double, _ w: Double, _ h: Double,
            alpha: Double = 1) -> [String: Any] {
        [
            kCGWindowNumber as String: NSNumber(value: number),
            kCGWindowLayer as String: NSNumber(value: layer),
            kCGWindowOwnerPID as String: NSNumber(value: pid),
            kCGWindowOwnerName as String: owner,
            kCGWindowAlpha as String: NSNumber(value: alpha),
            kCGWindowBounds as String: ["X": NSNumber(value: x), "Y": NSNumber(value: y), "Width": NSNumber(value: w),
                                        "Height": NSNumber(value: h)],
            kCGWindowSharingState as String: NSNumber(value: 1),
        ]
    }

    let securityAgent = WindowOwner(
        bundleID: "com.apple.SecurityAgent",
        path: "/System/Library/Frameworks/Security.framework/Versions/A/MachServices/SecurityAgent.bundle/Contents/MacOS/SecurityAgent",
        bundlePath: "/System/Library/Frameworks/Security.framework/Versions/A/MachServices/SecurityAgent.bundle")

    func testParse() throws {
        var looked: [Int32] = []
        let raw = [
            cg(475, layer: 2_147_483_630, pid: 614, owner: "Window Server", 1896, 1, 28, 28),
            cg(492, layer: 1000, pid: 64827, owner: "SecurityAgent", 830, 201, 260, 384),
            cg(493, layer: 1000, pid: 64827, owner: "SecurityAgent", 0, 0, 10.4, 10.6, alpha: 0),
            [kCGWindowNumber as String: NSNumber(value: 7)],  // no bounds, no owner: left out
            cg(483, layer: 0, pid: 600, owner: "System Settings", 893.4, 214.5, 740, 625),
        ]
        let (list, truncated) = WindowList.parse(raw) { pid in
            looked.append(pid)
            return pid == 64827 ? self.securityAgent : nil
        }
        XCTAssertFalse(truncated)
        XCTAssertEqual(list.map(\.number), [475, 492, 493, 483], "front to back, as the window server lists them")
        XCTAssertEqual(looked, [614, 64827, 600], "one look-up per process")
        let prompt = list[1]
        XCTAssertEqual(prompt.layer, 1000)
        XCTAssertEqual([prompt.x, prompt.y, prompt.w, prompt.h], [830, 201, 260, 384])
        XCTAssertEqual(prompt.pid, 64827)
        XCTAssertEqual(prompt.owner, "SecurityAgent")
        XCTAssertEqual(prompt.bundleID, "com.apple.SecurityAgent")
        XCTAssertEqual(prompt.path, securityAgent.path)
        XCTAssertEqual(list[2].alpha, 0)
        XCTAssertEqual([list[2].w, list[2].h], [10, 11])
        XCTAssertEqual([list[3].x, list[3].y], [893, 215], "points rounded as list's elements are")
        XCTAssertEqual(list[0].bundleID, "", "the window server itself is no app")
    }

    func testBounded() {
        let raw = (0..<250).map { cg($0, layer: 0, pid: Int32($0 % 3), owner: "App", 0, 0, 100, 100) }
        let (list, truncated) = WindowList.parse(raw) { _ in nil }
        XCTAssertEqual(list.count, WindowList.maxWindows)
        XCTAssertTrue(truncated)
    }

    func testOp() throws {
        XCTAssertEqual(try Command.parse(Data(#"{"v":1,"op":"windows"}"#.utf8)), .windows)
        XCTAssertFalse(Command.windows.needsAccessibility, "it is how the agent sees a prompt before the helper has it")
        XCTAssertFalse(Command.windows.refusedWhileLocked)
    }

    func testAnswer() throws {
        var w = WindowInfo(number: 492, layer: 1000, alpha: 1, bounds: Rect(x: 830, y: 201, w: 260, h: 384), pid: 77,
                           owner: "SecurityAgent")
        w.bundleID = securityAgent.bundleID
        w.path = securityAgent.path
        w.bundlePath = securityAgent.bundlePath
        let bare = WindowInfo(number: 5, layer: 24, alpha: 1, bounds: Rect(x: 0, y: 0, w: 1920, h: 30), pid: 614,
                              owner: "Window Server")
        let line = Answer.windows([w, bare], truncated: false).line()
        XCTAssertEqual(line.filter { $0 == 0x0A }.count, 1)
        let j = try XCTUnwrap(JSONSerialization.jsonObject(with: line) as? [String: Any])
        XCTAssertEqual(j["ok"] as? Bool, true)
        XCTAssertEqual(j["truncated"] as? Bool, false)
        let list = try XCTUnwrap(j["windows"] as? [[String: Any]])
        XCTAssertEqual(list.count, 2)
        XCTAssertEqual(list[0]["number"] as? Int, 492)
        XCTAssertEqual(list[0]["layer"] as? Int, 1000)
        XCTAssertEqual(list[0]["alpha"] as? Double, 1)
        XCTAssertEqual(list[0]["x"] as? Int, 830)
        XCTAssertEqual(list[0]["h"] as? Int, 384)
        XCTAssertEqual(list[0]["pid"] as? Int, 77)
        XCTAssertEqual(list[0]["owner"] as? String, "SecurityAgent")
        XCTAssertEqual(list[0]["bundle_id"] as? String, "com.apple.SecurityAgent")
        XCTAssertEqual(list[0]["path"] as? String, securityAgent.path, "slashes stay as they are")
        XCTAssertEqual(list[0]["bundle_path"] as? String, securityAgent.bundlePath)
        XCTAssertNil(list[1]["bundle_id"], "empty fields are left out")
        XCTAssertNil(list[1]["path"])
        XCTAssertNil(list[0]["title"], "no titles: they need Screen Recording")
    }
}
