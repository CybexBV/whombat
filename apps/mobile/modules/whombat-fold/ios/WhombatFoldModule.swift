import ExpoModulesCore
import UIKit

/**
 * `WhombatFold` (iOS): what a folding iPhone tells an app about its screen (docs/app/decisions/iphone-duo.md). iOS 27.1
 * keeps its own controls in a vertical bar down one edge on the iPhone Duo (`verticalBarEdge`, with a safe-area inset
 * there: 84 points open), reserves the fold as a division region (the crease at 475.5 of 951, with 20-point margins)
 * and the clock and cameras as occlusion regions, and reports the hinge. A view behind the app's root
 * view, the size of the window, reads all of it in window points whenever its size, its safe area, the bar's traits or
 * the hinge change, and `onChange` sends it when it differs from the last. Older iPhones and iOS versions report no bar,
 * no regions and no posture. The JavaScript side is `modules/whombat-fold/index.ts`.
 */
public final class WhombatFoldModule: Module {
  private var observer: FoldObserverView?
  private let lock = NSLock()
  private var last: [String: Any]?

  public func definition() -> ModuleDefinition {
    Name("WhombatFold")

    Events("onChange")

    /** The last state read, or nil before the first. */
    Function("current") { () -> [String: Any]? in
      self.lock.lock()
      defer { self.lock.unlock() }
      return self.last
    }

    OnCreate {
      DispatchQueue.main.async { self.attach() }
    }

    OnStartObserving {
      DispatchQueue.main.async { self.attach() }
    }

    OnAppEntersForeground {
      DispatchQueue.main.async { self.attach() }
    }

    OnDestroy {
      DispatchQueue.main.async {
        self.observer?.removeFromSuperview()
        self.observer = nil
      }
    }
  }

  /** Puts the observer behind the app in its window, again when the app came back in a new window. */
  private func attach() {
    guard let window = Self.appWindow() else { return }
    if let observer, observer.window === window {
      // Coming back to the front in the same window: send only what changed meanwhile, if anything. Sending the same
      // state again made the app lay itself out again on every return.
      observer.report()
      return
    }
    observer?.removeFromSuperview()
    let view = FoldObserverView(frame: window.bounds) { [weak self] state in
      self?.publish(state)
    }
    view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.isUserInteractionEnabled = false
    view.backgroundColor = .clear
    window.insertSubview(view, at: 0)
    observer = view
    view.report(force: true)
  }

  private func publish(_ state: [String: Any]) {
    lock.lock()
    last = state
    lock.unlock()
    sendEvent("onChange", state)
  }

  private static func appWindow() -> UIWindow? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let active = scenes.filter { $0.activationState == .foregroundActive }
    for scene in active + scenes {
      if let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first {
        return window
      }
    }
    return nil
  }
}

/** The window-sized view that reads the bar, the regions and the hinge. */
final class FoldObserverView: UIView {
  private let onChange: ([String: Any]) -> Void
  private var posture: String?
  private var reported: NSDictionary?

  init(frame: CGRect, onChange: @escaping ([String: Any]) -> Void) {
    self.onChange = onChange
    super.init(frame: frame)
    if #available(iOS 27.1, *) {
      addInteraction(
        UIHingeInteraction { [weak self] _, update in
          self?.posture = Self.posture(update.hinge)
          self?.scheduleReport()
        })
      registerForTraitChanges(UITraitCollection.systemTraitsAffectingVerticalBarEdge) {
        (view: FoldObserverView, _: UITraitCollection) in
        view.scheduleReport()
      }
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not used")
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    scheduleReport()
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    scheduleReport()
  }

  private var reportPending = false

  /**
   * One fold or unfold changes the size, the safe area and the traits one after another inside the scene's update:
   * read the regions once, after that update is through, instead of three times in the middle of it.
   */
  func scheduleReport() {
    if reportPending { return }
    reportPending = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.reportPending = false
      self.report()
    }
  }

  func report(force: Bool = false) {
    var state: [String: Any] = [
      "barEdge": NSNull(),
      "folds": [[String: Double]](),
      "occlusions": [[String: Double]](),
      "posture": posture ?? NSNull(),
    ]
    if #available(iOS 27.1, *) {
      switch traitCollection.verticalBarEdge {
      case .leading: state["barEdge"] = "leading"
      case .trailing: state["barEdge"] = "trailing"
      default: break
      }
      // The fold is there whether or not iOS calls it active (it doesn't while the phone lies flat): the crease
      // itself, without the margins iOS keeps around it for buttons.
      state["folds"] = reservedRegions(kind: .division, options: .includeInactive).map {
        Self.rect($0.frame.inset(by: $0.margins))
      }
      state["occlusions"] = reservedRegions(kind: .occlusion).filter(\.isActive).map { Self.rect($0.frame) }
    }
    let dictionary = state as NSDictionary
    if !force, let reported, reported.isEqual(dictionary) { return }
    reported = dictionary
    onChange(state)
  }

  private static func rect(_ frame: CGRect) -> [String: Double] {
    [
      "x": Double(frame.origin.x), "y": Double(frame.origin.y),
      "width": Double(frame.size.width), "height": Double(frame.size.height),
    ]
  }

  @available(iOS 27.1, *)
  private static func posture(_ hinge: UIHinge?) -> String? {
    switch hinge?.status {
    case .closed: return "closed"
    case .partiallyOpen: return "half"
    case .fullyOpen: return "flat"
    default: return nil
    }
  }
}
