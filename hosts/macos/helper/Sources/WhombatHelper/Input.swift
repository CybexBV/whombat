import CoreGraphics
import Foundation
import HelperCore

// Keyboard and mouse, as if from the Mac's own keyboard and mouse (Quartz events at the HID level). macOS lets an app
// do this only with Accessibility, which the helper checks before it gets here.

enum Input {
    static let returnKey: CGKeyCode = 36
    static let tabKey: CGKeyCode = 48
    static let deleteKey: CGKeyCode = 51
    static let aKey: CGKeyCode = 0

    private static func source() -> CGEventSource? { CGEventSource(stateID: .hidSystemState) }

    /// A left click at a point (global display points, top-left origin): move there, press, release.
    static func click(at point: CGPoint) {
        let src = source()
        for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
            guard let event = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: point, mouseButton: .left)
            else { continue }
            if type != .mouseMoved { event.setIntegerValueField(.mouseEventClickState, value: 1) }
            event.post(tap: .cghidEventTap)
            usleep(30_000)
        }
    }

    /// One key, down and up, with these modifiers held.
    static func key(_ code: CGKeyCode, flags: CGEventFlags = []) {
        let src = source()
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down) else { continue }
            event.flags = flags
            event.post(tap: .cghidEventTap)
            usleep(10_000)
        }
    }

    /// Types text into whatever has the keyboard focus. Text goes as Unicode, so the keyboard layout doesn't matter;
    /// line breaks and tabs press Return and Tab.
    static func type(_ text: String, deadline: Date) throws {
        let src = source()
        let steps = TypingPlan.steps(for: text)
        for step in steps {
            if Date() >= deadline { throw HelperError(.failed, "Ran out of time while typing; only part of the text went in.") }
            switch step {
            case .returnKey:
                key(returnKey)
            case .tabKey:
                key(tabKey)
            case let .text(chunk):
                let units = Array(chunk.utf16)
                for down in [true, false] {
                    guard let event = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down) else { continue }
                    // No modifier keys: the text is exactly what was asked, whatever is held on the Mac.
                    event.flags = []
                    units.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress) }
                    event.post(tap: .cghidEventTap)
                }
                usleep(10_000)
            }
        }
    }
}
