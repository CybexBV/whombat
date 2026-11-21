import SwiftUI
import WidgetKit

/// Saved calm status written by the main app into the shared App Group (`group.com.whombat.mobile`).
/// The widget never fetches on its own: it only displays what the app last saved and rolls the “as of”
/// label to the date once the calendar day moves on.
private struct StatusWidgetSnapshot: Decodable {
  let applianceId: String?
  let boxName: String
  let status: String
  let tone: String
  let asOf: String
  let asOfEarlier: String?
  let asOfDay: String?
  let timeZone: String?
  let updatedAt: Double?

  func resolvedTimeZone() -> TimeZone {
    timeZone.flatMap(TimeZone.init(identifier:)) ?? .current
  }

  func asOfLabel(at date: Date) -> String {
    guard let savedDay = asOfDay, !savedDay.isEmpty else { return asOf }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = resolvedTimeZone()
    let parts = calendar.dateComponents([.year, .month, .day], from: date)
    let today = String(
      format: "%04d-%02d-%02d",
      parts.year ?? 0,
      parts.month ?? 0,
      parts.day ?? 0
    )
    return today == savedDay ? asOf : (asOfEarlier ?? asOf)
  }

  func nextMidnight(after date: Date) -> Date? {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = resolvedTimeZone()
    return calendar.nextDate(
      after: date,
      matching: DateComponents(hour: 0, minute: 0, second: 0),
      matchingPolicy: .nextTime
    )
  }
}

/// Mirrors `WIDGET_EMPTY_COPY` in `@whombat/client` (verified by `statusWidget.test.ts`).
private enum StatusWidgetEmpty {
  static let boxName = "Whombat"
  static let status = "Open Whombat"
  static let asOf = "Tap to see status"
}

struct WhombatStatusEntry: TimelineEntry {
  let date: Date
  let boxName: String
  let status: String
  let tone: String
  let asOf: String
  let isEmpty: Bool

  var accessibilityLabel: String {
    if isEmpty {
      return "\(boxName). \(status). \(asOf)."
    }
    return "\(boxName). \(status), \(asOf)."
  }

  static func empty(at date: Date) -> WhombatStatusEntry {
    WhombatStatusEntry(
      date: date,
      boxName: StatusWidgetEmpty.boxName,
      status: StatusWidgetEmpty.status,
      tone: "neutral",
      asOf: StatusWidgetEmpty.asOf,
      isEmpty: true
    )
  }

  static func sample(at date: Date) -> WhombatStatusEntry {
    WhombatStatusEntry(
      date: date,
      boxName: "Home",
      status: "All good",
      tone: "ok",
      asOf: "as of 14:05",
      isEmpty: false
    )
  }
}

struct WhombatStatusProvider: TimelineProvider {
  private static let appGroupInfoKey = "WhombatStatusWidgetAppGroup"
  private static let defaultAppGroup = "group.com.whombat.mobile"
  private static let defaultsKey = "com.whombat.live.widget.status"

  private static func readSnapshot() -> StatusWidgetSnapshot? {
    let group = (Bundle.main.object(forInfoDictionaryKey: appGroupInfoKey) as? String)
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .flatMap { $0.isEmpty ? nil : $0 } ?? defaultAppGroup
    guard let raw = UserDefaults(suiteName: group)?.string(forKey: defaultsKey),
          let data = raw.data(using: .utf8),
          let snapshot = try? JSONDecoder().decode(StatusWidgetSnapshot.self, from: data),
          !snapshot.boxName.isEmpty,
          !snapshot.status.isEmpty,
          !snapshot.asOf.isEmpty
    else { return nil }
    return snapshot
  }

  func placeholder(in context: Context) -> WhombatStatusEntry {
    .sample(at: Date())
  }

  func getSnapshot(in context: Context, completion: @escaping (WhombatStatusEntry) -> Void) {
    let now = Date()
    if let snapshot = Self.readSnapshot() {
      completion(
        WhombatStatusEntry(
          date: now,
          boxName: snapshot.boxName,
          status: snapshot.status,
          tone: snapshot.tone,
          asOf: snapshot.asOfLabel(at: now),
          isEmpty: false
        )
      )
    } else if context.isPreview {
      completion(.sample(at: now))
    } else {
      completion(.empty(at: now))
    }
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<WhombatStatusEntry>) -> Void) {
    let now = Date()
    guard let snapshot = Self.readSnapshot() else {
      completion(Timeline(entries: [.empty(at: now)], policy: .never))
      return
    }
    let currentAsOf = snapshot.asOfLabel(at: now)
    var entries = [
      WhombatStatusEntry(
        date: now,
        boxName: snapshot.boxName,
        status: snapshot.status,
        tone: snapshot.tone,
        asOf: currentAsOf,
        isEmpty: false
      )
    ]
    // Roll “as of 14:05” over to “as of 21 Nov” locally at midnight without fetching anything.
    if let earlier = snapshot.asOfEarlier,
       earlier != currentAsOf,
       let midnight = snapshot.nextMidnight(after: now)
    {
      entries.append(
        WhombatStatusEntry(
          date: midnight,
          boxName: snapshot.boxName,
          status: snapshot.status,
          tone: snapshot.tone,
          asOf: earlier,
          isEmpty: false
        )
      )
    }
    completion(Timeline(entries: entries, policy: .never))
  }
}

struct WhombatStatusWidget: Widget {
  let kind = "WhombatStatusWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: WhombatStatusProvider()) { entry in
      WhombatStatusWidgetView(entry: entry)
    }
    .configurationDisplayName("Whombat")
    .description("Shows your Whombat’s last status and opens the app.")
    .supportedFamilies([.systemSmall])
  }
}

private struct WhombatStatusWidgetView: View {
  let entry: WhombatStatusEntry

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 6) {
        WhombatMark(color: Palette.logo)
          .frame(width: 16, height: 13)
          .accessibilityHidden(true)
        Text(entry.boxName)
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(Palette.mut)
          .lineLimit(1)
      }
      Spacer(minLength: 8)
      HStack(alignment: .center, spacing: 7) {
        Circle()
          .fill(Palette.tone(entry.tone))
          .frame(width: 9, height: 9)
          .accessibilityHidden(true)
        Text(entry.status)
          .font(.system(size: 16, weight: .bold))
          .foregroundStyle(Palette.ink)
          .lineLimit(2)
          .minimumScaleFactor(0.85)
      }
      Text(entry.asOf)
        .font(.system(size: 12, weight: .regular, design: .monospaced))
        .foregroundStyle(Palette.mut)
        .lineLimit(1)
        .padding(.top, 4)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(entry.accessibilityLabel)
    .accessibilityHint("Opens Whombat")
    .widgetSurface(Palette.bg)
  }
}

private extension View {
  @ViewBuilder
  func widgetSurface(_ color: Color) -> some View {
    if #available(iOS 17.0, *) {
      self.containerBackground(color, for: .widget)
    } else {
      self
        .padding(16)
        .background(color)
    }
  }
}

/// The Whombat face mark from `@whombat/brand`, drawn as silhouette minus eye/muzzle cutouts so it stays crisp
/// in light, dark and tinted widget modes without requiring an asset catalog in the extension.
private struct WhombatMark: View {
  let color: Color

  var body: some View {
    ZStack {
      WhombatSilhouette().fill(color)
      WhombatCutouts().fill(Color.black).blendMode(.destinationOut)
    }
    .compositingGroup()
  }
}

private struct WhombatSilhouette: Shape {
  func path(in rect: CGRect) -> Path {
    var path = Path()
    let sx = rect.width / 114.0
    let sy = rect.height / 90.0
    func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
      CGPoint(x: rect.minX + (x - 3.0) * sx, y: rect.minY + (y - 8.0) * sy)
    }
    func box(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> CGRect {
      CGRect(x: rect.minX + (x - 3.0) * sx, y: rect.minY + (y - 8.0) * sy, width: w * sx, height: h * sy)
    }
    path.addEllipse(in: box(11, 8, 28, 28))
    path.addEllipse(in: box(81, 8, 28, 28))
    path.move(to: pt(60, 14))
    path.addCurve(to: pt(117, 60), control1: pt(94, 14), control2: pt(117, 32))
    path.addCurve(to: pt(60, 98), control1: pt(117, 86), control2: pt(94, 98))
    path.addCurve(to: pt(3, 60), control1: pt(26, 98), control2: pt(3, 86))
    path.addCurve(to: pt(60, 14), control1: pt(3, 32), control2: pt(26, 14))
    path.closeSubpath()
    return path
  }
}

private struct WhombatCutouts: Shape {
  func path(in rect: CGRect) -> Path {
    var path = Path()
    let sx = rect.width / 114.0
    let sy = rect.height / 90.0
    func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
      CGPoint(x: rect.minX + (x - 3.0) * sx, y: rect.minY + (y - 8.0) * sy)
    }
    func box(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> CGRect {
      CGRect(x: rect.minX + (x - 3.0) * sx, y: rect.minY + (y - 8.0) * sy, width: w * sx, height: h * sy)
    }
    path.addEllipse(in: box(25.5, 36.5, 15, 15))
    path.addEllipse(in: box(79.5, 36.5, 15, 15))
    path.move(to: pt(60, 51))
    path.addCurve(to: pt(35, 65.48), control1: pt(43, 51), control2: pt(35, 53.17))
    path.addCurve(to: pt(60, 87.21), control1: pt(35, 79.24), control2: pt(45, 87.21))
    path.addCurve(to: pt(85, 65.48), control1: pt(75, 87.21), control2: pt(85, 79.24))
    path.addCurve(to: pt(60, 51), control1: pt(85, 53.17), control2: pt(77, 51))
    path.closeSubpath()
    return path
  }
}
