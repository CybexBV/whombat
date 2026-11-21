import ExpoModulesCore
import Foundation
import MetricKit

/**
 * `WhombatDiagnostics` (iOS): what iOS itself knows about how the app ended (docs/app/decisions/phone-resilience.md).
 * iOS hands an app its own crash and hang reports, and once a day counts of how its runs ended, through MetricKit; a
 * crash in native code and an ending for memory or for not answering are described nowhere else. Each payload is kept
 * as the JSON iOS makes of it, in a file of its own in the app's support folder, until the JavaScript side
 * (`modules/whombat-diagnostics/index.ts`, `src/errors/diagnostics.ts`) has turned it into error notes: `pending`
 * lists them, `remove` lets them go, and `onPayload` says one arrived. Nothing is read from a payload here.
 */
public final class WhombatDiagnosticsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WhombatDiagnostics")

    Events("onPayload")

    OnCreate {
      PayloadKeeper.shared.start { [weak self] in
        self?.sendEvent("onPayload", [:])
      }
    }

    /** `[{id, json}]`: every payload kept, oldest first. */
    Function("pending") { () -> [[String: String]] in
      PayloadKeeper.shared.pending()
    }

    Function("remove") { (ids: [String]) in
      PayloadKeeper.shared.remove(ids)
    }
  }
}

/** The one MetricKit subscriber of the app, and the folder its payloads wait in. */
private final class PayloadKeeper: NSObject, MXMetricManagerSubscriber {
  static let shared = PayloadKeeper()

  /// The newest payloads kept, and how many of the ones already taken are remembered (iOS hands the past ones over
  /// again at every start).
  private static let kept = 20
  private static let remembered = 80

  private let lock = NSLock()
  private var started = false
  private var arrived: (() -> Void)?

  private var folder: URL? {
    guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
      return nil
    }
    let folder = base.appendingPathComponent("whombat-diagnostics", isDirectory: true)
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    return folder
  }

  func start(arrived: @escaping () -> Void) {
    let first = lock.withLock { () -> Bool in
      self.arrived = arrived
      if started { return false }
      started = true
      return true
    }
    guard first else { return }
    MXMetricManager.shared.add(self)
    // The reports of a crash that ended the app before it subscribed are still there to be read; off the thread the
    // app starts on.
    DispatchQueue.global(qos: .utility).async { [weak self] in
      let past = MXMetricManager.shared.pastDiagnosticPayloads
      self?.keep(past.map { ("diagnostic", $0.timeStampBegin, $0.timeStampEnd, $0.jsonRepresentation()) })
    }
  }

  func didReceive(_ payloads: [MXDiagnosticPayload]) {
    keep(payloads.map { ("diagnostic", $0.timeStampBegin, $0.timeStampEnd, $0.jsonRepresentation()) })
  }

  func didReceive(_ payloads: [MXMetricPayload]) {
    keep(payloads.map { ("metric", $0.timeStampBegin, $0.timeStampEnd, $0.jsonRepresentation()) })
  }

  /// Each payload into a file named after its kind and time span, once: one already kept or already taken is skipped.
  private func keep(_ payloads: [(String, Date, Date, Data)]) {
    guard !payloads.isEmpty, let folder else { return }
    var wrote = false
    lock.withLock {
      let taken = Set(self.taken(in: folder))
      for (kind, begin, end, json) in payloads {
        let id = "\(kind)-\(Int(begin.timeIntervalSince1970))-\(Int(end.timeIntervalSince1970))"
        let file = folder.appendingPathComponent("\(id).json")
        if taken.contains(id) || FileManager.default.fileExists(atPath: file.path) { continue }
        if (try? json.write(to: file, options: .atomic)) != nil { wrote = true }
      }
      // Never more than the newest few: nobody may be reading them.
      let files = self.files(in: folder)
      for old in files.dropLast(Self.kept) { try? FileManager.default.removeItem(at: old) }
    }
    if wrote { lock.withLock { arrived }?() }
  }

  /// Oldest first, by the end of the time span in each one's name (`kind-begin-end`).
  private func files(in folder: URL) -> [URL] {
    let all = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
    let end = { (url: URL) -> Int in
      Int(url.deletingPathExtension().lastPathComponent.split(separator: "-").last ?? "") ?? 0
    }
    return all.filter { $0.pathExtension == "json" }.sorted { end($0) < end($1) }
  }

  /// The ids already noted, a line each, in a file beside the payloads.
  private func taken(in folder: URL) -> [String] {
    let text = (try? String(contentsOf: folder.appendingPathComponent("taken.txt"), encoding: .utf8)) ?? ""
    return text.split(separator: "\n").map(String.init)
  }

  func pending() -> [[String: String]] {
    guard let folder else { return [] }
    return lock.withLock {
      files(in: folder).compactMap { file in
        guard let json = try? String(contentsOf: file, encoding: .utf8) else { return nil }
        return ["id": file.deletingPathExtension().lastPathComponent, "json": json]
      }
    }
  }

  func remove(_ ids: [String]) {
    guard let folder else { return }
    lock.withLock {
      for id in ids where !id.contains("/") && !id.contains("..") {
        try? FileManager.default.removeItem(at: folder.appendingPathComponent("\(id).json"))
      }
      let taken = (self.taken(in: folder) + ids).suffix(Self.remembered).joined(separator: "\n")
      try? taken.write(to: folder.appendingPathComponent("taken.txt"), atomically: true, encoding: .utf8)
    }
  }
}
