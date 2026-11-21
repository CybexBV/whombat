import ExpoModulesCore
import UIKit

/**
 * `WhombatTransfer` (iOS): keeps the screen on while a backup file moves (docs/app/decisions/ios-parity.md AP-6323), as
 * the Android module does; a phone that sleeps pauses the transfer. iOS has no “Save as” that hands back a place to
 * write: the app picks a folder instead (expo-file-system), so `createDocument` says it isn't here.
 */
public final class WhombatTransferModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WhombatTransfer")

    Function("isSupported") { () -> Bool in true }

    AsyncFunction("createDocument") { (_: String, _: String, promise: Promise) in
      promise.reject("unsupported", "No “Save as” on iPhone: pick a folder instead.")
    }

    Function("keepScreenOn") { (on: Bool) -> Bool in
      DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = on }
      return true
    }
  }
}
