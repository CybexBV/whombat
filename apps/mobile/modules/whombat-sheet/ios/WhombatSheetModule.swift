import ExpoModulesCore
import UIKit

/**
 * `WhombatSheet` (iOS): the app's sheets as iOS draws its own (docs/app/decisions/ios-native.md). The view is a sheet's
 * panel inside a React Native `Modal` presented as a form sheet. It makes that sheet as tall as the panel (the system
 * adds the home indicator's room under it), shows the system's grabber, and paints the sheet in the app's colour, light
 * or dark as the app is, so it slides up, drags down and dims the screen as iOS's own sheets do. Where the window is
 * wide (the open iPhone Duo) the sheet is a card a phone's width. It says how much of its sides the system's own
 * things cover (the closed Duo's bar under the clock), for the panel to keep clear of them (`onSides`).
 */
public final class WhombatSheetModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WhombatSheet")

    View(WhombatSheetView.self) {
      Events("onSides")

      /** The sheet's surface (`bg` or `sf`). */
      Prop("color") { (view: WhombatSheetView, color: UIColor?) in
        view.color = color
        view.fit()
      }

      /** The app's theme is dark: the grabber, the keyboard and the dimming follow it, not the phone's. */
      Prop("dark") { (view: WhombatSheetView, dark: Bool?) in
        view.dark = dark ?? false
        view.fit()
      }

      /** The card's width on a wide window. */
      Prop("width") { (view: WhombatSheetView, width: Double?) in
        view.width = CGFloat(width ?? 560)
        view.fit()
      }
    }
  }
}

final class WhombatSheetView: ExpoView {
  let onSides = EventDispatcher()
  var color: UIColor?
  var dark = false
  var width: CGFloat = 560

  private static let fitting = UISheetPresentationController.Detent.Identifier("whombat.fit")
  /** The panel's height, which the sheet's one detent follows. */
  private var height: CGFloat = 0
  private weak var sheet: UISheetPresentationController?

  override func didMoveToSuperview() {
    super.didMoveToSuperview()
    fit()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    reportSides()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    fit()
    reportSides()
  }

  private var sides: (left: CGFloat, right: CGFloat)?

  /**
   * How far the panel reaches into the window's unsafe sides. Measured against the window: a sheet doesn't hand the
   * window's side insets (the closed Duo's bar under the clock) to what it presents.
   */
  private func reportSides() {
    guard let window else { return }
    let frame = convert(bounds, to: window)
    let safe = window.bounds.inset(by: window.safeAreaInsets)
    let next = (left: max(0, safe.minX - frame.minX), right: max(0, frame.maxX - safe.maxX))
    if let sides, sides == next { return }
    sides = next
    onSides(["left": next.left, "right": next.right])
  }

  /** The modal's controller: the one whose own view holds the panel. */
  private func controller() -> UIViewController? {
    var view = superview
    while let current = view {
      if let controller = current.next as? UIViewController { return controller }
      view = current.superview
    }
    return nil
  }

  /** Before the sheet shows (React puts the panel in its controller first) and whenever the panel's height changes. */
  func fit() {
    guard let controller = controller() else { return }
    controller.view.backgroundColor = color
    controller.overrideUserInterfaceStyle = dark ? .dark : .light
    let tall = bounds.height
    let size = CGSize(width: width, height: tall)
    if controller.preferredContentSize != size { controller.preferredContentSize = size }
    guard let sheet = controller.sheetPresentationController else { return }
    if self.sheet !== sheet {
      self.sheet = sheet
      height = tall
      sheet.prefersGrabberVisible = true
      sheet.detents = [
        .custom(identifier: Self.fitting) { [weak self] context in
          guard let height = self?.height, height > 0 else { return context.maximumDetentValue }
          return min(height, context.maximumDetentValue)
        },
      ]
      return
    }
    guard tall > 0, abs(tall - height) > 0.5 else { return }
    height = tall
    sheet.animateChanges { sheet.invalidateDetents() }
  }
}
