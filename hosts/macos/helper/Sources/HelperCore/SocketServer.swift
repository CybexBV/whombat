import Foundation

#if canImport(Darwin)
import Darwin
#endif

/// The helper's Unix socket. The agent makes the folder for the user at the screen; until it exists the server waits.
/// A socket left behind by a helper that died is removed; one that still answers belongs to a helper that is running,
/// and is left alone. When the folder or the socket is removed (the agent made the folder again), the server listens
/// again. Each connection carries one request line and gets one answer line, then is closed.
public final class SocketServer: @unchecked Sendable {
    /// Turns a request line into an answer line. `deadline` is when it should stop and answer with what it has; a
    /// little after it, the connection gets `failed` anyway.
    public typealias Handler = @Sendable (_ line: Data, _ deadline: Date) -> Data

    public let path: String
    private let handler: Handler
    private let pollInterval: TimeInterval
    private let requestTimeout: TimeInterval
    private let maxInFlight: Int
    /// The users that may connect: root alone (the agent). Any program of the helper's own user could otherwise
    /// drive Accessibility through it, the permission the person gave Whombat Helper, not that program.
    private let allowedPeers: Set<uid_t>
    private let log: @Sendable (String) -> Void

    // Guarded by `lock`.
    private let lock = NSLock()
    private var stopping = false
    private var inFlight = 0
    private var bound: (dev: dev_t, ino: ino_t)?

    public init(
        path: String,
        pollInterval: TimeInterval = 2,
        requestTimeout: TimeInterval = Limits.requestSeconds,
        maxInFlight: Int = 8,
        allowedPeers: Set<uid_t> = [0],
        log: @escaping @Sendable (String) -> Void = { _ in },
        handler: @escaping Handler
    ) {
        self.path = path
        self.pollInterval = pollInterval
        self.requestTimeout = requestTimeout
        self.maxInFlight = maxInFlight
        self.allowedPeers = allowedPeers
        self.log = log
        self.handler = handler
    }

    /// Where the agent looks for the helper of the user with this uid.
    public static func defaultPath(uid: uid_t = getuid()) -> String {
        "/var/run/whombat-agent/ui/\(uid)/helper.sock"
    }

    private var isStopping: Bool { lock.withLock { stopping } }

    /// Serves until `stop()`; blocks the calling thread.
    public func run() {
        let folder = (path as NSString).deletingLastPathComponent
        var lastNote = ""
        // Says each new state once, not every 2 s.
        func note(_ s: String) {
            if s != lastNote { log(s) }
            lastNote = s
        }
        while !isStopping {
            var isFolder: ObjCBool = false
            guard FileManager.default.fileExists(atPath: folder, isDirectory: &isFolder), isFolder.boolValue else {
                note("waiting for \(folder)")
                Thread.sleep(forTimeInterval: pollInterval)
                continue
            }
            let fd: Int32
            do {
                fd = try listen()
            } catch {
                note("can't listen on \(path): \(error)")
                Thread.sleep(forTimeInterval: pollInterval)
                continue
            }
            note("listening on \(path)")
            serve(fd)
            close(fd)
        }
    }

    /// Stops serving and removes the socket if it is still this server's.
    public func stop() {
        let mine: Bool = lock.withLock {
            stopping = true
            return bound != nil && isStillBound()
        }
        if mine { unlink(path) }
    }

    // MARK: listening

    struct ListenError: Error, CustomStringConvertible {
        let description: String
    }

    private func listen() throws -> Int32 {
        var st = stat()
        if lstat(path, &st) == 0 {
            guard (st.st_mode & S_IFMT) == S_IFSOCK else { throw ListenError(description: "something else is in the way") }
            if Self.answers(path) { throw ListenError(description: "another helper is listening there") }
            unlink(path)
        }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw ListenError(description: errnoText()) }
        do {
            _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
            try Self.withAddress(path) { addr, len in
                if bind(fd, addr, len) != 0 { throw ListenError(description: errnoText()) }
            }
            // The folder is the user's own (0700); the socket is too. Root, the agent, connects anyway, and no one else
            // is answered.
            chmod(path, 0o600)
            guard Darwin.listen(fd, 16) == 0 else { throw ListenError(description: errnoText()) }
            // Never blocks in accept when a client gave up between poll and accept.
            _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
            guard lstat(path, &st) == 0 else { throw ListenError(description: "the socket vanished") }
            lock.withLock { bound = (st.st_dev, st.st_ino) }
            return fd
        } catch {
            close(fd)
            throw error
        }
    }

    private func serve(_ fd: Int32) {
        var nextCheck = Date().addingTimeInterval(pollInterval)
        while !isStopping {
            var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let waitMs = Int32(min(pollInterval, 0.5) * 1000)
            if Darwin.poll(&pfd, 1, waitMs) > 0, pfd.revents & Int16(POLLIN) != 0 {
                acceptOne(fd)
            }
            if Date() >= nextCheck {
                let still = lock.withLock { isStillBound() }
                if !still {
                    log("the socket was removed; listening again")
                    lock.withLock { bound = nil }
                    return
                }
                nextCheck = Date().addingTimeInterval(pollInterval)
            }
        }
    }

    /// Whether the path is still the socket this server made (not gone, not made again by someone else).
    /// Called with `lock` held.
    private func isStillBound() -> Bool {
        guard let bound else { return false }
        var st = stat()
        return lstat(path, &st) == 0 && st.st_dev == bound.dev && st.st_ino == bound.ino
    }

    // MARK: connections

    private func acceptOne(_ listener: Int32) {
        let conn = accept(listener, nil, nil)
        guard conn >= 0 else { return }
        _ = fcntl(conn, F_SETFD, FD_CLOEXEC)
        // A connection inherits the listener's non-blocking mode on macOS; reads here wait (with a time limit).
        _ = fcntl(conn, F_SETFL, fcntl(conn, F_GETFL) & ~O_NONBLOCK)
        var one: Int32 = 1
        setsockopt(conn, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        Self.setTimeout(conn, requestTimeout)

        // Only root (the agent) may ask: the folder keeps other users out, and the helper's own user must not drive
        // its Accessibility either.
        var uid: uid_t = 0
        var gid: gid_t = 0
        if getpeereid(conn, &uid, &gid) != 0 || !allowedPeers.contains(uid) {
            log("refused a connection from uid \(uid)")
            close(conn)
            return
        }
        let admitted: Bool = lock.withLock {
            if inFlight >= maxInFlight { return false }
            inFlight += 1
            return true
        }
        guard admitted else {
            // The one thing ever written before a request is read, and the connection closes with it: the agent counts
            // anything else waiting on a connection before it asks as written by something other than the helper.
            Self.writeAll(conn, Answer.failure(HelperError(.busy, "the helper is busy; try again")).line())
            close(conn)
            return
        }
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            handle(conn)
            close(conn)
            lock.withLock { inFlight -= 1 }
        }
    }

    private func handle(_ conn: Int32) {
        let started = Date()
        let hardDeadline = started.addingTimeInterval(requestTimeout)
        switch Self.readRequest(conn) {
        case .nothing:
            return
        case .tooLong:
            Self.writeAll(conn, Answer.failure(.invalid("the request is too long")).line())
        case let .line(line):
            let workDeadline = started.addingTimeInterval(requestTimeout * Limits.workSeconds / Limits.requestSeconds)
            Self.writeAll(conn, answer(line, workDeadline: workDeadline, hardDeadline: hardDeadline))
        }
    }

    /// Runs the handler, but answers by the hard deadline whatever it does: an app that doesn't answer Accessibility
    /// can hold a request up, and the agent must not wait for it.
    private func answer(_ line: Data, workDeadline: Date, hardDeadline: Date) -> Data {
        final class Box: @unchecked Sendable {
            let lock = NSLock()
            var value: Data?
        }
        let box = Box()
        let done = DispatchSemaphore(value: 0)
        let handler = self.handler
        DispatchQueue.global(qos: .userInitiated).async {
            let result = handler(line, workDeadline)
            box.lock.withLock { box.value = result }
            done.signal()
        }
        let seconds = Int((requestTimeout).rounded())
        if done.wait(timeout: .now() + max(0, hardDeadline.timeIntervalSinceNow)) == .timedOut {
            return Answer.failure(HelperError(.failed, "timed out after \(seconds) s: the app isn't answering")).line()
        }
        return box.lock.withLock { box.value } ?? Answer.failure(HelperError(.failed, "no answer")).line()
    }

    enum ReadResult {
        case line(Data)
        case tooLong
        /// Nothing came: the client went away or only checked that someone listens.
        case nothing
    }

    /// Reads up to the first newline. A client that sends its line without one and closes its side is fine too.
    static func readRequest(_ conn: Int32) -> ReadResult {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let n = buffer.withUnsafeMutableBytes { recv(conn, $0.baseAddress, $0.count, 0) }
            if n < 0, errno == EINTR { continue }
            if n <= 0 { break }
            data.append(contentsOf: buffer[0..<n])
            if let newline = data.firstIndex(of: 0x0A) {
                let line = data[data.startIndex..<newline]
                return line.count > Limits.maxRequestBytes ? .tooLong : .line(Data(line))
            }
            if data.count > Limits.maxRequestBytes { return .tooLong }
        }
        let trimmed = data.filter { $0 != 0x0D }
        return trimmed.isEmpty ? .nothing : .line(Data(trimmed))
    }

    // MARK: small pieces

    static func writeAll(_ conn: Int32, _ data: Data) {
        data.withUnsafeBytes { raw in
            guard var p = raw.baseAddress else { return }
            var left = raw.count
            while left > 0 {
                let n = send(conn, p, left, 0)
                if n < 0, errno == EINTR { continue }
                if n <= 0 { return }
                p += n
                left -= n
            }
        }
    }

    static func setTimeout(_ fd: Int32, _ seconds: TimeInterval) {
        var tv = timeval(tv_sec: Int(seconds), tv_usec: Int32((seconds - Double(Int(seconds))) * 1_000_000))
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    }

    /// Calls `body` with the socket address of `path`.
    static func withAddress(_ path: String, _ body: (UnsafePointer<sockaddr>, socklen_t) throws -> Void) throws {
        var addr = sockaddr_un()
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
            throw ListenError(description: "the path is too long for a socket")
        }
        addr.sun_family = sa_family_t(AF_UNIX)
        addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &addr.sun_path) { $0.copyBytes(from: bytes) }
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        try withUnsafePointer(to: &addr) {
            try $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { try body($0, len) }
        }
    }

    /// Whether something answers on the socket at `path` (a running helper) rather than a file left behind.
    static func answers(_ path: String) -> Bool {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var ok = false
        try? withAddress(path) { addr, len in ok = connect(fd, addr, len) == 0 }
        return ok
    }
}

private func errnoText() -> String { String(cString: strerror(errno)) }
