import Darwin
import Foundation
import XCTest

@testable import HelperCore

/// The socket as the agent sees it: a real Unix socket in a temporary folder, a stand-in handler.
final class SocketServerTests: XCTestCase {
    var folder: URL!
    var servers: [SocketServer] = []

    override func setUpWithError() throws {
        signal(SIGPIPE, SIG_IGN)
        // Short: a socket's path must fit in 104 bytes.
        folder = URL(fileURLWithPath: "/tmp", isDirectory: true)
            .appendingPathComponent("wh-\(UUID().uuidString.prefix(8))", isDirectory: true)
            .appendingPathComponent("501", isDirectory: true)
    }

    override func tearDown() {
        servers.forEach { $0.stop() }
        try? FileManager.default.removeItem(at: folder.deletingLastPathComponent())
    }

    var path: String { folder.appendingPathComponent("helper.sock").path }

    func makeFolder() throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    /// A server answering every request with its op echoed, as `{"ok":true,"echo":...}`.
    /// The tests run as an ordinary user, so the servers they talk to let that user in besides root.
    @discardableResult
    func start(timeout: TimeInterval = 2, name: String = "a", peers: Set<uid_t> = [0, getuid()], inFlight: Int = 8,
               handler: SocketServer.Handler? = nil) -> SocketServer {
        let echo: SocketServer.Handler = { line, _ in
            let op = (try? JSONSerialization.jsonObject(with: line) as? [String: Any])?["op"] as? String ?? "?"
            return Data(#"{"ok":true,"echo":"\#(op)","server":"\#(name)"}"#.utf8 + [0x0A])
        }
        let server = SocketServer(
            path: path, pollInterval: 0.05, requestTimeout: timeout, maxInFlight: inFlight, allowedPeers: peers,
            handler: handler ?? echo)
        servers.append(server)
        Thread.detachNewThread { server.run() }
        return server
    }

    /// Sends one line and reads the answer to the end, the way the agent does; nil when nobody listens.
    func ask(_ line: String, wait: TimeInterval = 3) -> [String: Any]? {
        let until = Date().addingTimeInterval(wait)
        repeat {
            if let data = exchange(Data(line.utf8)),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                return json
            }
            Thread.sleep(forTimeInterval: 0.02)
        } while Date() < until
        return nil
    }

    func exchange(_ request: Data) -> Data? {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var ok = false
        try? SocketServer.withAddress(path) { addr, len in ok = connect(fd, addr, len) == 0 }
        guard ok else { return nil }
        SocketServer.setTimeout(fd, 5)
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        SocketServer.writeAll(fd, request)
        // Done sending, as the agent is after its one line.
        shutdown(fd, SHUT_WR)
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = buffer.withUnsafeMutableBytes { recv(fd, $0.baseAddress, $0.count, 0) }
            if n <= 0 { break }
            data.append(contentsOf: buffer[0..<n])
        }
        return data.isEmpty ? nil : data
    }

    func testOneLineInOneLineOutThenClosed() throws {
        try makeFolder()
        start()
        let answer = try XCTUnwrap(ask(#"{"v":1,"op":"status"}"# + "\n"))
        XCTAssertEqual(answer["echo"] as? String, "status")
        // The raw bytes: exactly one line, and the server closed the connection after it (exchange read to EOF).
        let raw = try XCTUnwrap(exchange(Data((#"{"v":1,"op":"apps"}"# + "\n").utf8)))
        XCTAssertEqual(raw.filter { $0 == 0x0A }.count, 1)
        XCTAssertEqual(raw.last, 0x0A)
        // A line without a newline, the client closing its side, is read too.
        XCTAssertEqual(ask(#"{"v":1,"op":"list"}"#)?["echo"] as? String, "list")
        // The socket is the user's alone.
        var st = stat()
        XCTAssertEqual(lstat(path, &st), 0)
        XCTAssertEqual(st.st_mode & 0o777, 0o600)
    }

    /// The helper answers root (the agent) only: a program of its own user gets nothing, so it can't drive the
    /// helper's Accessibility.
    func testOnlyRootIsAnswered() throws {
        try makeFolder()
        start(peers: [0])
        Thread.sleep(forTimeInterval: 0.2)
        if getuid() == 0 { throw XCTSkip("running as root") }
        XCTAssertNil(exchange(Data((#"{"v":1,"op":"status"}"# + "\n").utf8)), "the helper's own user was answered")
    }

    func testWaitsForTheFolder() throws {
        start()
        Thread.sleep(forTimeInterval: 0.2)
        XCTAssertNil(exchange(Data("{}\n".utf8)), "nothing listens before the agent makes the folder")
        try makeFolder()
        XCTAssertEqual(ask(#"{"op":"status"}"#)?["echo"] as? String, "status")
    }

    func testReplacesAStaleSocket() throws {
        try makeFolder()
        // A socket file nobody listens on: what a helper that crashed leaves.
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        try SocketServer.withAddress(path) { addr, len in XCTAssertEqual(Darwin.bind(fd, addr, len), 0) }
        close(fd)
        XCTAssertTrue(FileManager.default.fileExists(atPath: path))
        XCTAssertFalse(SocketServer.answers(path))
        start()
        XCTAssertEqual(ask(#"{"op":"status"}"#)?["echo"] as? String, "status")
    }

    func testLeavesARunningHelperAlone() throws {
        try makeFolder()
        let first = start(name: "first")
        XCTAssertEqual(ask(#"{"op":"status"}"#)?["server"] as? String, "first")
        start(name: "second")
        Thread.sleep(forTimeInterval: 0.3)
        XCTAssertEqual(ask(#"{"op":"status"}"#)?["server"] as? String, "first", "the second waits")
        first.stop()
        XCTAssertFalse(FileManager.default.fileExists(atPath: path), "stop removes its own socket")
        let deadline = Date().addingTimeInterval(3)
        var server: String?
        while Date() < deadline, server != "second" {
            server = ask(#"{"op":"status"}"#, wait: 0.2)?["server"] as? String
        }
        XCTAssertEqual(server, "second", "and takes over once the first is gone")
    }

    func testListensAgainWhenTheFolderIsMadeAgain() throws {
        try makeFolder()
        start()
        XCTAssertNotNil(ask(#"{"op":"status"}"#))
        try FileManager.default.removeItem(at: folder)
        try makeFolder()
        XCTAssertEqual(ask(#"{"op":"apps"}"#)?["echo"] as? String, "apps")
        // And when only the socket was removed.
        try FileManager.default.removeItem(atPath: path)
        XCTAssertEqual(ask(#"{"op":"list"}"#)?["echo"] as? String, "list")
    }

    func testSlowWorkIsAnsweredByTheDeadline() throws {
        try makeFolder()
        let seen = DeadlineBox()
        start(timeout: 0.3) { _, deadline in
            seen.set(deadline)
            Thread.sleep(forTimeInterval: 1)
            return Data("{\"ok\":true}\n".utf8)
        }
        let started = Date()
        let answer = try XCTUnwrap(ask(#"{"op":"list"}"#))
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.9)
        XCTAssertEqual(answer["ok"] as? Bool, false)
        XCTAssertEqual(answer["code"] as? String, "failed")
        XCTAssertTrue((answer["message"] as? String ?? "").contains("timed out"))
        // The work was told to stop before the connection's own limit.
        let workDeadline = try XCTUnwrap(seen.get())
        XCTAssertLessThan(workDeadline.timeIntervalSince(started), 0.3)
    }

    func testTooLongARequestIsRefused() throws {
        try makeFolder()
        start()
        XCTAssertNotNil(ask(#"{"op":"status"}"#), "listening")
        var request = Data(repeating: UInt8(ascii: "a"), count: Limits.maxRequestBytes + 10)
        request.append(0x0A)
        let raw = try XCTUnwrap(exchange(request))
        let answer = try XCTUnwrap(try JSONSerialization.jsonObject(with: raw) as? [String: Any])
        XCTAssertEqual(answer["code"] as? String, "invalid_request")
    }

    /// A helper answering as many requests as it takes says it is busy, with its own code, as soon as the connection
    /// comes and before reading anything, and closes it: the one thing it ever writes first.
    func testBusySaysSoFirstAndCloses() throws {
        try makeFolder()
        start(inFlight: 1) { _, _ in
            Thread.sleep(forTimeInterval: 0.6)
            return Data("{\"ok\":true}\n".utf8)
        }
        XCTAssertNotNil(ask(#"{"op":"status"}"#), "listening")
        let slow = expectation(description: "the slow request")
        DispatchQueue.global().async {
            _ = self.exchange(Data((#"{"op":"status"}"# + "\n").utf8))
            slow.fulfill()
        }
        Thread.sleep(forTimeInterval: 0.2)
        // Nothing sent: the answer is there anyway, then the end.
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        defer { close(fd) }
        var ok = false
        try SocketServer.withAddress(path) { addr, len in ok = connect(fd, addr, len) == 0 }
        XCTAssertTrue(ok)
        SocketServer.setTimeout(fd, 2)
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = buffer.withUnsafeMutableBytes { recv(fd, $0.baseAddress, $0.count, 0) }
            if n <= 0 { break }
            data.append(contentsOf: buffer[0..<n])
        }
        XCTAssertEqual(data.last, 0x0A)
        let answer = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(answer["ok"] as? Bool, false)
        XCTAssertEqual(answer["code"] as? String, "busy")
        wait(for: [slow], timeout: 3)
    }

    func testAConnectionWithoutARequestGetsNothing() throws {
        try makeFolder()
        start()
        XCTAssertNotNil(ask(#"{"op":"status"}"#))
        // Connecting and hanging up is how a second helper checks for a first one: no answer, no harm.
        XCTAssertNil(exchange(Data()))
        XCTAssertNotNil(ask(#"{"op":"status"}"#))
    }
}

final class DeadlineBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Date?
    func set(_ d: Date) { lock.withLock { value = d } }
    func get() -> Date? { lock.withLock { value } }
}
