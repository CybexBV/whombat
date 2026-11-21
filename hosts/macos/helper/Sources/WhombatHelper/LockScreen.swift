import AppKit
import ApplicationServices
import HelperCore
import IOKit.pwr_mgt

// The agent's unlock, typed by the helper. Keys from inside the person's session open the lock screen for good;
// typed through Screen Sharing they don't last: macOS saves the lock when Screen Sharing starts showing the screen
// and locks it again when the last viewer leaves.

enum LockScreen {
    static let loginWindowID = "com.apple.loginwindow"
    static let loginWindowPath = "/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow"

    /// Wakes the display as a key press would, waits until the lock screen's password field has the keyboard focus
    /// and keeps it (letters typed before that are lost), empties it with Delete (Escape makes the lock screen look
    /// again and drop the next keys: tried), types the password and presses Return. Every key goes only while the
    /// screen is still locked and the lock screen's password field still has the keyboard, checked right before it:
    /// the password goes one character at a time. Whether the screen opened is the agent's to watch; the note says
    /// what was done.
    static func unlock(_ password: String, deadline: Date) throws -> Answer {
        guard Session.locked else { return .note("not locked") }
        var activity: IOPMAssertionID = 0
        let declared = IOPMAssertionDeclareUserActivity(
            "Whombat unlocks the screen" as CFString, kIOPMUserActiveLocal, &activity) == kIOReturnSuccess
        defer { if declared { IOPMAssertionRelease(activity) } }
        // Steady for half a second: a lock screen that is still waking, or going away by itself (woken within
        // macOS's grace period), must not get the keys.
        let until = min(deadline.addingTimeInterval(-2), Date().addingTimeInterval(5))
        var steadySince: Date?
        while true {
            if !Session.locked { return .note("opened by itself") }
            if let field = passwordField() {
                let since = steadySince ?? Date()
                steadySince = since
                if Date().timeIntervalSince(since) >= 0.5 {
                    let stillThere = { passwordField() != nil && Session.locked }
                    // Whatever is in the field goes first, without reading it. Lost meanwhile: nothing of the
                    // password went yet, so wait for the field again.
                    let count = min((AX.copy(field, kAXNumberOfCharactersAttribute) as? Int) ?? 0, 256)
                    let deleted = GuardedKeys.send(Array(0..<count), while: stillThere) { _ in Input.key(Input.deleteKey) }
                    guard deleted == count, stillThere() else {
                        steadySince = nil
                        continue
                    }
                    let characters = password.map { String($0) }
                    let typed = try GuardedKeys.send(characters, while: stillThere) { try Input.type($0, deadline: deadline) }
                    guard typed == characters.count else {
                        throw HelperError(.failed, "The lock screen's password field lost the keyboard while the password was typed; nothing more was typed and Return wasn't pressed.")
                    }
                    usleep(50_000)
                    guard stillThere() else {
                        throw HelperError(.failed, "The lock screen's password field lost the keyboard while the password was typed; Return wasn't pressed.")
                    }
                    Input.key(Input.returnKey)
                    return .note("typed")
                }
            } else {
                steadySince = nil
            }
            if Date() >= until {
                throw HelperError(.failed, "The lock screen's password field didn't take the keyboard focus.")
            }
            Thread.sleep(forTimeInterval: 0.1)
        }
    }

    /// The lock screen's password field when it has the keyboard focus: a password field of macOS's own
    /// loginwindow, so typed keys go nowhere else.
    static func passwordField() -> AXUIElement? {
        guard let element = AX.element(AX.systemWide, kAXFocusedUIElementAttribute), let pid = AX.pid(element),
              let app = NSRunningApplication(processIdentifier: pid), app.bundleIdentifier == loginWindowID,
              app.executableURL?.resolvingSymlinksInPath().path == loginWindowPath,
              Roles.isSecure(
                role: AX.string(element, kAXRoleAttribute) ?? "", subrole: AX.string(element, kAXSubroleAttribute) ?? "")
        else { return nil }
        return element
    }
}
