import ActivityKit
import ExpoModulesCore
import Foundation
import WidgetKit

/// `WhombatLive` (iOS): live activities as ActivityKit activities (`WhombatLiveAttributes`), started and
/// updated by the app while it runs (`upsert` / `end`) and by APNs `liveactivity` pushes to the activity's
/// push token or the push-to-start token. Tokens go to the app as events; it registers them with
/// `devices.registerLiveActivity` and `devices.update({ liveActivityToken })`.
public class WhombatLiveModule: Module {
  /// The tasks below are reached from several threads at once: the functions JavaScript calls run on Swift's
  /// concurrent pool, and `observe` also runs in the `activityUpdates` task. Every read and write of them is
  /// inside `state.withLock`, a whole check-and-change at a time; tasks are cancelled outside it, and it is
  /// never held across an `await`.
  private let state = NSLock()
  private var tokenTasks: [String: Task<Void, Never>] = [:]
  private var activityUpdatesTask: Task<Void, Never>?
  private var pushToStartTask: Task<Void, Never>?

  public func definition() -> ModuleDefinition {
    Name("WhombatLive")

    Events("onPush", "onPushToken", "onActivityPushToken", "onPushToStartToken")

    OnStartObserving {
      self.startObserving()
    }

    OnStopObserving {
      self.stopObserving()
    }

    Function("isSupported") { () -> Bool in
      ActivityAuthorizationInfo().areActivitiesEnabled
    }

    /// Android keeps tone colors for background pushes; the widget has them built in.
    Function("configure") { (_: String) in }

    AsyncFunction("upsert") { (displayJson: String, burrow: String, attributesJson: String?) async throws -> String? in
      let display = try Self.decode(WhombatLiveAttributes.ContentState.self, displayJson)
      let content = ActivityContent(state: display, staleDate: nil)
      if let activity = Self.activity(for: display.key) {
        await activity.update(content)
        return nil
      }
      let attributes = try attributesJson.map { try Self.decode(WhombatLiveAttributes.self, $0) }
        ?? WhombatLiveAttributes(key: display.key, kind: display.kind, number: display.number, burrow: burrow)
      let activity = try Activity.request(attributes: attributes, content: content, pushType: .token)
      self.observe(activity)
      return nil
    }

    AsyncFunction("end") { (key: String, lastJson: String?, _: String) async throws in
      guard let activity = Self.activity(for: key) else { return }
      if let lastJson {
        let last = try Self.decode(WhombatLiveAttributes.ContentState.self, lastJson)
        // The last state stays on the Lock Screen for 30 minutes, like Android's ended notification.
        await activity.end(
          ActivityContent(state: last, staleDate: nil),
          dismissalPolicy: .after(Date().addingTimeInterval(30 * 60))
        )
      } else {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
      self.state.withLock { self.tokenTasks.removeValue(forKey: key) }?.cancel()
    }

    AsyncFunction("endAll") { () async in
      for activity in Activity<WhombatLiveAttributes>.activities {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
      self.takeTokenTasks().forEach { $0.cancel() }
    }

    AsyncFunction("active") { () -> [[String: String]] in
      Activity<WhombatLiveAttributes>.activities
        .filter { $0.activityState == .active }
        .map { ["key": $0.attributes.key, "burrow": $0.attributes.burrow] }
    }

    AsyncFunction("pushToStartToken") { () -> String? in
      if #available(iOS 17.2, *) {
        return Activity<WhombatLiveAttributes>.pushToStartToken.map(Self.hex)
      }
      return nil
    }

    AsyncFunction("setStatusWidget") { (snapshotJson: String) in
      guard let group = Self.statusWidgetAppGroup,
            let defaults = UserDefaults(suiteName: group),
            let data = snapshotJson.data(using: .utf8),
            (try? JSONSerialization.jsonObject(with: data)) is [String: Any]
      else { return }
      let changed = self.state.withLock { () -> Bool in
        if defaults.string(forKey: Self.statusWidgetDefaultsKey) == snapshotJson {
          return false
        }
        defaults.set(snapshotJson, forKey: Self.statusWidgetDefaultsKey)
        return true
      }
      if changed {
        WidgetCenter.shared.reloadTimelines(ofKind: Self.statusWidgetKind)
      }
    }

    AsyncFunction("clearStatusWidget") { (applianceId: String?) in
      guard let group = Self.statusWidgetAppGroup,
            let defaults = UserDefaults(suiteName: group)
      else { return }
      let changed = self.state.withLock { () -> Bool in
        guard let existing = defaults.string(forKey: Self.statusWidgetDefaultsKey) else {
          return false
        }
        if let applianceId = applianceId?.trimmingCharacters(in: .whitespacesAndNewlines),
           !applianceId.isEmpty,
           let data = existing.data(using: .utf8),
           let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           let savedId = obj["applianceId"] as? String,
           !savedId.isEmpty,
           savedId != applianceId
        {
          return false
        }
        defaults.removeObject(forKey: Self.statusWidgetDefaultsKey)
        return true
      }
      if changed {
        WidgetCenter.shared.reloadTimelines(ofKind: Self.statusWidgetKind)
      }
    }
  }

  // MARK: - Tokens

  private func startObserving() {
    for activity in Activity<WhombatLiveAttributes>.activities {
      observe(activity)
    }
    // Activities started by a push-to-start push: register their update tokens too.
    let updates = Task { [weak self] in
      for await activity in Activity<WhombatLiveAttributes>.activityUpdates {
        self?.observe(activity)
      }
    }
    var pushToStart: Task<Void, Never>?
    if #available(iOS 17.2, *) {
      pushToStart = Task { [weak self] in
        for await token in Activity<WhombatLiveAttributes>.pushToStartTokenUpdates {
          self?.sendEvent("onPushToStartToken", ["token": Self.hex(token)])
        }
      }
    }
    let earlier = state.withLock { () -> [Task<Void, Never>?] in
      let was = [activityUpdatesTask, pushToStartTask]
      activityUpdatesTask = updates
      pushToStartTask = pushToStart
      return was
    }
    earlier.forEach { $0?.cancel() }
  }

  private func stopObserving() {
    let watching = state.withLock { () -> [Task<Void, Never>?] in
      let was = [activityUpdatesTask, pushToStartTask]
      activityUpdatesTask = nil
      pushToStartTask = nil
      return was
    }
    watching.forEach { $0?.cancel() }
    takeTokenTasks().forEach { $0.cancel() }
  }

  /// Every token task, taken out of the registry: the caller cancels them, outside the lock.
  private func takeTokenTasks() -> [Task<Void, Never>] {
    state.withLock {
      let tasks = Array(tokenTasks.values)
      tokenTasks.removeAll()
      return tasks
    }
  }

  private func observe(_ activity: Activity<WhombatLiveAttributes>) {
    let key = activity.attributes.key
    // The check and the insert are one step: two callers for one activity start one task.
    state.withLock {
      guard tokenTasks[key] == nil else { return }
      tokenTasks[key] = Task { [weak self] in
        for await token in activity.pushTokenUpdates {
          self?.sendEvent("onActivityPushToken", ["key": key, "token": Self.hex(token)])
        }
      }
    }
  }

  // MARK: - Helpers

  /// Info.plist key set by the Expo plugin only when the iOS App Group is enabled.
  private static let statusWidgetAppGroupInfoKey = "WhombatStatusWidgetAppGroup"
  private static let statusWidgetDefaultsKey = "com.whombat.live.widget.status"
  private static let statusWidgetKind = "WhombatStatusWidget"

  private static var statusWidgetAppGroup: String? {
    guard let value = Bundle.main.object(forInfoDictionaryKey: statusWidgetAppGroupInfoKey) as? String else {
      return nil
    }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  private static func activity(for key: String) -> Activity<WhombatLiveAttributes>? {
    Activity<WhombatLiveAttributes>.activities.first { $0.attributes.key == key }
  }

  private static func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
  }

  private static func hex(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
  }
}
