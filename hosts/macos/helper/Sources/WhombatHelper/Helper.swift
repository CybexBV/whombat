import ApplicationServices
import Foundation
import HelperCore
import os

// One request in, one answer out: checks what every op needs (Accessibility, an unlocked screen), runs the op, logs
// what happened (the op and its outcome, never names, values or typed text).

enum Helper {
    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    }

    static func respond(_ line: Data, deadline: Date) -> Answer {
        let started = Date()
        var op = "?"
        let answer: Answer
        do {
            let command = try Command.parse(line)
            op = command.op
            answer = try perform(command, deadline: deadline)
        } catch let error as HelperError {
            answer = .failure(error)
        } catch {
            answer = .failure(HelperError(.failed, "\(error)"))
        }
        let ms = Int(Date().timeIntervalSince(started) * 1000)
        if case let .failure(error) = answer {
            Log.info("\(op): \(error.code.rawValue) in \(ms) ms")
        } else {
            Log.info("\(op): ok in \(ms) ms")
        }
        return answer
    }

    static func perform(_ command: Command, deadline: Date) throws -> Answer {
        if command.needsAccessibility, !AX.trusted {
            throw HelperError(
                .noAccess,
                "Whombat Helper isn't allowed to use Accessibility yet: switch it on in System Settings → Privacy & Security → Accessibility.")
        }
        if command.refusedWhileLocked, Session.locked {
            throw HelperError(.locked, "The screen is locked: unlock it first.")
        }
        switch command {
        case .status:
            return Ops.status()
        case .apps:
            return .apps(Apps.list(deadline: deadline))
        case let .list(query):
            return try Ops.list(query, deadline: deadline)
        case let .press(target):
            return try Ops.press(target, deadline: deadline)
        case let .set(target, value):
            return try Ops.set(target, value: value, deadline: deadline)
        case let .type(text):
            try Input.type(text, deadline: deadline)
            return .done
        case let .menu(app, path):
            return try Ops.menu(app: app, path: path, deadline: deadline)
        case let .focus(name):
            Apps.focus(try Apps.resolve(name), deadline: deadline)
            return .done
        case let .open(target):
            switch target {
            case .accessibility: try Apps.open(url: OpenTarget.accessibilitySettings)
            case let .url(url): try Apps.open(url: url)
            case let .app(name): try Apps.open(name, deadline: deadline)
            }
            return .done
        case let .unlock(password):
            return try LockScreen.unlock(password, deadline: deadline)
        case .windows:
            return OnScreen.windows()
        case .focused:
            return try Ops.focused()
        }
    }
}

enum Log {
    static let logger = Logger(subsystem: "com.whombat.helper", category: "helper")

    /// To the unified log (the agent's logs console reads it) and to standard error for someone running it by hand.
    static func info(_ message: String) {
        logger.info("\(message, privacy: .public)")
        FileHandle.standardError.write(Data("whombat-helper: \(message)\n".utf8))
    }
}
