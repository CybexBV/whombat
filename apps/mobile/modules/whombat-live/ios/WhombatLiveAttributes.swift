import ActivityKit
import Foundation

/// A Whombat live activity: a run in progress or an approval that needs a person.
///
/// One attributes type for both kinds, so a device has a single push-to-start token
/// (`IOS_LIVE_ACTIVITY_ATTRIBUTES` in `@whombat/core`, the `attributes-type` of the server's APNs push).
/// This file is compiled into the app (the WhombatLive pod) and into the widget extension (copied there by
/// `app.plugin.cjs`); ActivityKit matches the two by the type's name.
public struct WhombatLiveAttributes: ActivityAttributes {
  /// `LiveActivityDisplay` from `@whombat/core`, decoded as is: the server's `content-state` and the app's
  /// `upsert` carry the same JSON. The widget renders it without building copy of its own.
  public struct ContentState: Codable, Hashable {
    public var key: String
    /// `run` or `approval`
    public var kind: String
    public var number: Int
    /// `RUN · LIVE`, `NEEDS A PERSON`, `APPROVED · DEPLOYING`, `DEPLOYED`
    public var label: String
    /// `ok`, `warn`, `bad`, `neutral`
    public var tone: String
    public var title: String
    public var text: String
    /// 0–100
    public var progress: Int
    /// Progress drawn in this many segments (an approval's conditions); 1 for a run.
    public var segments: Int
    /// `62%`, `2/3`; nil once ended.
    public var chip: String?
    public var ongoing: Bool
    /// `approve`, `details`, `open_run`
    public var actions: [String]
    public var locale: String?
  }

  /// `run:<id>` / `approval:<id>` (`liveActivityRef`).
  public var key: String
  public var kind: String
  public var number: Int
  /// Burrow slug.
  public var burrow: String

  public init(key: String, kind: String, number: Int, burrow: String) {
    self.key = key
    self.kind = kind
    self.number = number
    self.burrow = burrow
  }
}

public extension WhombatLiveAttributes.ContentState {
  func actionLabel(_ action: String, fallbackLocale: String? = nil) -> String {
    let language = LiveWidgetLocale.languageCode(locale ?? fallbackLocale ?? LiveWidgetLocale.shared)
    let words = ActivityActionWords.byLanguage[language] ?? ActivityActionWords.english
    switch action {
    case "approve": return words.review
    case "details": return words.details
    default: return words.openRun
    }
  }

  /// The app screen for this activity (`whombat://runs/1907`, `whombat://approvals/12`).
  var url: URL? {
    URL(string: kind == "run" ? "whombat://runs/\(number)" : "whombat://approvals/\(number)")
  }
}

private struct ActivityActionWords {
  let review: String
  let details: String
  let openRun: String

  static let english = Self(review: "Review", details: "Details", openRun: "Open run")
  static let byLanguage: [String: Self] = [
    "en": english,
    "nl": Self(review: "Bekijken", details: "Details", openRun: "Open uitvoering"),
  ]
}

enum LiveWidgetLocale {
  static let key = "com.whombat.live.locale"

  static var shared: String? {
    let group = (Bundle.main.object(forInfoDictionaryKey: "WhombatStatusWidgetAppGroup") as? String)
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .flatMap { $0.isEmpty ? nil : $0 } ?? "group.com.whombat.mobile"
    return UserDefaults(suiteName: group)?.string(forKey: key)
      ?? Locale.preferredLanguages.first
  }

  static func languageCode(_ tag: String?) -> String {
    Locale(identifier: tag ?? "en-GB").language.languageCode?.identifier ?? "en"
  }
}
