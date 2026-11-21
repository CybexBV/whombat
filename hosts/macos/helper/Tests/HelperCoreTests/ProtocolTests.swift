import Foundation
import XCTest

@testable import HelperCore

final class ProtocolTests: XCTestCase {
    func parse(_ json: String) throws -> Command { try Command.parse(Data(json.utf8)) }

    func refusal(_ json: String, file: StaticString = #filePath, line: UInt = #line) -> HelperError? {
        do {
            _ = try parse(json)
            XCTFail("\(json) was accepted", file: file, line: line)
            return nil
        } catch let error as HelperError {
            return error
        } catch {
            XCTFail("\(error)", file: file, line: line)
            return nil
        }
    }

    func testEveryOp() throws {
        XCTAssertEqual(try parse(#"{"v":1,"op":"status"}"#), .status)
        XCTAssertEqual(try parse(#"{"v":1,"op":"apps"}"#), .apps)
        XCTAssertEqual(
            try parse(#"{"v":1,"op":"list","app":"TextEdit","window":"Untitled","limit":50,"depth":4}"#),
            .list(ListQuery(app: "TextEdit", window: "Untitled", roles: .any, limit: 50, depth: 4)))
        XCTAssertEqual(
            try parse(#"{"v":1,"op":"press","app":"com.apple.TextEdit","name":"Don’t Save","role":"AXButton","index":1}"#),
            .press(Target(app: "com.apple.TextEdit", name: "Don’t Save", roles: RoleFilter(rules: [RoleRule("AXButton")]), index: 1)))
        XCTAssertEqual(
            try parse(#"{"v":1,"op":"set","name":"Name","value":"Mac Studio"}"#),
            .set(Target(name: "Name"), value: "Mac Studio"))
        XCTAssertEqual(try parse(#"{"v":1,"op":"type","text":"hello\nworld"}"#), .type("hello\nworld"))
        XCTAssertEqual(
            try parse(#"{"v":1,"op":"menu","app":"TextEdit","path":["File","Save..."]}"#),
            .menu(app: "TextEdit", path: ["File", "Save..."]))
        XCTAssertEqual(try parse(#"{"v":1,"op":"focus","app":"Safari"}"#), .focus(app: "Safari"))
        XCTAssertEqual(try parse(#"{"v":1,"op":"unlock","password":"Pw! ü"}"#), .unlock(password: "Pw! ü"))
        XCTAssertEqual(try parse(#"{"v":1,"op":"focused"}"#), .focused)
        XCTAssertEqual(try parse(#"{"v":1,"op":"open","target":"accessibility"}"#), .open(.accessibility))
        XCTAssertEqual(try parse(#"{"v":1,"op":"open","target":"Accessibility"}"#), .open(.accessibility))
        XCTAssertEqual(try parse(#"{"v":1,"op":"open","target":"TextEdit"}"#), .open(.app("TextEdit")))
        XCTAssertEqual(
            try parse(#"{"v":1,"op":"open","target":"https://example.com/a?b=c"}"#),
            .open(.url(URL(string: "https://example.com/a?b=c")!)))
    }

    func testDefaultsAndBounds() throws {
        guard case let .list(q) = try parse(#"{"v":1,"op":"list"}"#) else { return XCTFail("not a list") }
        XCTAssertNil(q.app)
        XCTAssertNil(q.window)
        XCTAssertEqual(q.limit, 300)
        XCTAssertEqual(q.depth, 12)
        guard case let .list(big) = try parse(#"{"v":1,"op":"list","limit":5000,"depth":99,"app":"  "}"#) else {
            return XCTFail("not a list")
        }
        XCTAssertEqual(big.limit, 1000)
        XCTAssertEqual(big.depth, 30)
        XCTAssertNil(big.app, "a blank app is the app in front")
        // Go's omitempty never sends 0, but a 0 is the default too.
        guard case let .list(zero) = try parse(#"{"v":1,"op":"list","limit":0,"depth":0}"#) else {
            return XCTFail("not a list")
        }
        XCTAssertEqual(zero.limit, 300)
        XCTAssertEqual(zero.depth, 12)
        XCTAssertEqual(try parse(#"{"op":"status"}"#), .status, "a missing version is version 1")
        XCTAssertEqual(try parse(#"{"v":1,"op":"status","something_new":[1,2]}"#), .status, "unknown fields are ignored")
        XCTAssertEqual(try parse(#"{"v":1,"op":"set","value":""}"#), .set(Target(), value: ""), "an empty value clears")
    }

    func testRefusals() {
        let cases: [(String, String)] = [
            ("[]", "JSON object"),
            ("not json", "JSON object"),
            (#"{"v":1}"#, "no op"),
            (#"{"v":2,"op":"status"}"#, "version 2"),
            (#"{"v":1,"op":"dance"}"#, "dance"),
            (#"{"v":1,"op":"press"}"#, "name"),
            (#"{"v":1,"op":"press","name":"  "}"#, "name"),
            (#"{"v":1,"op":"press","name":"OK","index":-1}"#, "index"),
            (#"{"v":1,"op":"press","name":"OK","index":"2"}"#, "index"),
            (#"{"v":1,"op":"press","name":"OK","role":"blob"}"#, "blob"),
            (#"{"v":1,"op":"list","limit":-3}"#, "limit"),
            (#"{"v":1,"op":"set","name":"x"}"#, "value"),
            (#"{"v":1,"op":"type"}"#, "text"),
            (#"{"v":1,"op":"type","text":""}"#, "text"),
            (#"{"v":1,"op":"menu","path":[]}"#, "path"),
            (#"{"v":1,"op":"menu","path":["File",""]}"#, "path"),
            (#"{"v":1,"op":"menu","path":"File"}"#, "path"),
            (#"{"v":1,"op":"focus"}"#, "app"),
            (#"{"v":1,"op":"open"}"#, "target"),
            (#"{"v":1,"op":"open","target":"http://example.com"}"#, "https"),
            (#"{"v":1,"op":"open","target":"file:///etc/hosts"}"#, "https"),
            (#"{"v":1,"op":"open","target":"x-apple.systempreferences:com.apple.preference.security"}"#, "https"),
            (#"{"v":1,"op":"open","target":"/Applications/TextEdit.app"}"#, "path"),
            (#"{"v":1,"op":"unlock"}"#, "password"),
            (#"{"v":1,"op":"unlock","password":""}"#, "password"),
            (#"{"v":1,"op":"unlock","password":"a\nb"}"#, "password"),
        ]
        for (json, word) in cases {
            guard let error = refusal(json) else { continue }
            XCTAssertEqual(error.code, .invalidRequest, json)
            XCTAssertTrue(error.message.contains(word), "\(json): \(error.message)")
        }
    }

    func testSizeBounds() {
        let long = String(repeating: "a", count: Limits.maxTypedCharacters + 1)
        XCTAssertEqual(refusal(#"{"v":1,"op":"type","text":"\#(long)"}"#)?.code, .invalidRequest)
        XCTAssertEqual(refusal(#"{"v":1,"op":"set","value":"\#(long)"}"#)?.code, .invalidRequest)
        let name = String(repeating: "n", count: Limits.maxNameCharacters + 1)
        XCTAssertEqual(refusal(#"{"v":1,"op":"press","name":"\#(name)"}"#)?.code, .invalidRequest)
        let huge = Data(count: Limits.maxRequestBytes + 1)
        XCTAssertThrowsError(try Command.parse(huge))
        let fine = String(repeating: "é", count: Limits.maxTypedCharacters)
        XCTAssertEqual(try parse(#"{"v":1,"op":"type","text":"\#(fine)"}"#), .type(fine))
    }

    func testWhatEachOpNeeds() throws {
        XCTAssertFalse(Command.status.needsAccessibility)
        XCTAssertFalse(Command.apps.needsAccessibility)
        XCTAssertFalse(Command.open(.accessibility).needsAccessibility, "opening the setting must work without it")
        XCTAssertTrue(Command.press(Target(name: "OK")).needsAccessibility)
        XCTAssertTrue(Command.type("x").needsAccessibility)
        XCTAssertFalse(Command.status.refusedWhileLocked)
        XCTAssertFalse(Command.apps.refusedWhileLocked)
        XCTAssertTrue(Command.type("x").refusedWhileLocked)
        XCTAssertTrue(Command.unlock(password: "x").needsAccessibility, "typing into the lock screen needs it")
        XCTAssertFalse(Command.unlock(password: "x").refusedWhileLocked, "the lock screen is what it is for")
        XCTAssertTrue(Command.list(ListQuery(app: nil, window: nil, roles: .any, limit: 1, depth: 1)).refusedWhileLocked)
        XCTAssertTrue(Command.focused.needsAccessibility)
        XCTAssertFalse(Command.focused.refusedWhileLocked, "it reads no content: the lock screen's field counts too")
    }

    func testOptions() throws {
        XCTAssertEqual(try Options.parse([]), Options())
        XCTAssertEqual(try Options.parse(["--socket", "/tmp/t.sock"]), Options(socket: "/tmp/t.sock"))
        XCTAssertEqual(try Options.parse(["--version"]), Options(version: true))
        XCTAssertEqual(
            try Options.parse(["-psn_0_12345", "--request", #"{"op":"status"}"#]), Options(request: #"{"op":"status"}"#))
        XCTAssertEqual(try Options.parse(["-NSDocumentRevisionsDebugMode", "YES"]), Options())
        XCTAssertThrowsError(try Options.parse(["--socket"]))
        XCTAssertThrowsError(try Options.parse(["--frobnicate"]))
        XCTAssertEqual(SocketServer.defaultPath(uid: 501), "/var/run/whombat-agent/ui/501/helper.sock")
    }
}

final class AnswerTests: XCTestCase {
    func json(_ answer: Answer) throws -> [String: Any] {
        let line = answer.line()
        XCTAssertEqual(line.last, 0x0A, "one line, newline-terminated")
        XCTAssertEqual(line.filter { $0 == 0x0A }.count, 1, "exactly one line")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: line) as? [String: Any])
    }

    func testFailure() throws {
        let j = try json(.failure(HelperError(.notFound, "Nothing called “Sav”.", names: ["Save", "Save As…"])))
        XCTAssertEqual(j["ok"] as? Bool, false)
        XCTAssertEqual(j["code"] as? String, "not_found")
        XCTAssertEqual(j["message"] as? String, "Nothing called “Sav”.")
        XCTAssertEqual(j["names"] as? [String], ["Save", "Save As…"])
        let plain = try json(.failure(HelperError(.noAccess, "no")))
        XCTAssertNil(plain["names"])
        XCTAssertEqual(plain["code"] as? String, "no_access")
    }

    func testFocused() throws {
        var e = ElementInfo(id: "focused", role: "AXTextField")
        e.subrole = "AXSecureTextField"
        e.focused = true
        (e.x, e.y, e.w, e.h) = (10, 20, 200, 22)
        e.app = "SecurityAgent"
        e.token = "5f3a19c2"
        let j = try json(.focused(e, pid: 77, bundleID: "com.apple.SecurityAgent"))
        XCTAssertEqual(j["ok"] as? Bool, true)
        XCTAssertEqual(j["pid"] as? Int, 77)
        XCTAssertEqual(j["bundle_id"] as? String, "com.apple.SecurityAgent")
        let el = try XCTUnwrap(j["element"] as? [String: Any])
        XCTAssertEqual(el["subrole"] as? String, "AXSecureTextField")
        XCTAssertNil(el["value"], "never a value")
        XCTAssertEqual(el["token"] as? String, "5f3a19c2")
        let button = try json(.focused(ElementInfo(id: "focused", role: "AXButton"), pid: 1, bundleID: ""))
        XCTAssertNil(button["bundle_id"])
        XCTAssertNil((button["element"] as? [String: Any])?["token"], "no token, none sent")
    }

    func testStatus() throws {
        let display = DisplayInfo(id: 1, bounds: Rect(x: 0, y: 0, w: 2560, h: 1440), pixelWidth: 5120, main: true)
        let j = try json(.status(StatusInfo(
            version: "1.0.0", ax: false, locked: true, user: "someone", frontApp: "Finder", frontWindow: nil,
            displays: [display])))
        XCTAssertEqual(j["ok"] as? Bool, true)
        XCTAssertEqual(j["version"] as? String, "1.0.0")
        XCTAssertEqual(j["ax"] as? Bool, false)
        XCTAssertEqual(j["locked"] as? Bool, true)
        XCTAssertEqual(j["user"] as? String, "someone")
        XCTAssertEqual(j["front_app"] as? String, "Finder")
        XCTAssertNil(j["front_window"])
        let d = try XCTUnwrap((j["displays"] as? [[String: Any]])?.first)
        XCTAssertEqual(d["id"] as? Int, 1)
        XCTAssertEqual(d["w"] as? Int, 2560)
        XCTAssertEqual(d["h"] as? Int, 1440)
        XCTAssertEqual(d["scale"] as? Double, 2)
        XCTAssertEqual(d["main"] as? Bool, true)
    }

    func testAppsAndElements() throws {
        let apps = try json(.apps([AppInfo(name: "TextEdit", bundleID: "com.apple.TextEdit", pid: 42, active: true, windows: [])]))
        let app = try XCTUnwrap((apps["apps"] as? [[String: Any]])?.first)
        XCTAssertEqual(app["bundle_id"] as? String, "com.apple.TextEdit")
        XCTAssertEqual(app["pid"] as? Int, 42)
        XCTAssertEqual(app["active"] as? Bool, true)
        XCTAssertEqual(app["windows"] as? [String], [], "windows is always there")

        var e = ElementInfo(id: "w0.3.1", role: "AXButton")
        e.title = "Save"
        e.ident = "save-button"
        e.x = 10
        e.y = 20
        e.w = 80
        e.h = 24
        e.actions = ["AXPress"]
        e.app = "TextEdit"
        e.window = "Untitled"
        let list = try json(.elements([e], truncated: true))
        XCTAssertEqual(list["truncated"] as? Bool, true)
        let el = try XCTUnwrap((list["elements"] as? [[String: Any]])?.first)
        XCTAssertEqual(el["id"] as? String, "w0.3.1")
        XCTAssertEqual(el["role"] as? String, "AXButton")
        XCTAssertEqual(el["title"] as? String, "Save")
        XCTAssertEqual(el["ident"] as? String, "save-button")
        XCTAssertEqual(el["enabled"] as? Bool, true)
        XCTAssertEqual(el["focused"] as? Bool, false)
        XCTAssertEqual(el["x"] as? Int, 10)
        XCTAssertEqual(el["h"] as? Int, 24)
        XCTAssertEqual(el["actions"] as? [String], ["AXPress"])
        XCTAssertEqual(el["window"] as? String, "Untitled")
        XCTAssertNil(el["value"], "empty fields are left out")
        XCTAssertNil(el["desc"])

        let pressed = try json(.element(e, note: "Pressed; TextEdit is still busy."))
        XCTAssertEqual((pressed["element"] as? [String: Any])?["title"] as? String, "Save")
        XCTAssertEqual(pressed["message"] as? String, "Pressed; TextEdit is still busy.")
        let done = try json(.done)
        XCTAssertEqual(done.count, 1)
        XCTAssertEqual(done["ok"] as? Bool, true)
        let noted = try json(.note("typed"))
        XCTAssertEqual(noted["ok"] as? Bool, true)
        XCTAssertEqual(noted["message"] as? String, "typed")
    }

    func testNewlinesInTextStayInOneLine() throws {
        var e = ElementInfo(id: "w0", role: "AXStaticText")
        e.value = "two\nlines and a / slash"
        let line = Answer.elements([e], truncated: false).line()
        XCTAssertEqual(line.filter { $0 == 0x0A }.count, 1)
        XCTAssertTrue(String(decoding: line, as: UTF8.self).contains("a / slash"))
    }

    func testHugeListIsCutToFit() throws {
        var e = ElementInfo(id: "w0", role: "AXStaticText")
        e.value = String(repeating: "x", count: 200)
        // About 300 bytes each: 80 000 of them are well over 16 MiB.
        let list = Array(repeating: e, count: 80_000)
        let line = Answer.elements(list, truncated: false).line()
        XCTAssertLessThanOrEqual(line.count, Limits.maxAnswerBytes + 1)
        let j = try XCTUnwrap(JSONSerialization.jsonObject(with: line) as? [String: Any])
        XCTAssertEqual(j["truncated"] as? Bool, true)
        XCTAssertGreaterThan((j["elements"] as? [Any])?.count ?? 0, 1000)
    }
}
