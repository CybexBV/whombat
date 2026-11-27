import SwiftUI
import WidgetKit

/// Saved calm status written by the main app into the shared App Group (`group.com.whombat.mobile`).
/// The widget never fetches on its own: it stores the status timestamp and formats the “as of” label
/// when drawing (“as of 14:05” today, “as of yesterday 23:50”, or “as of 21 Nov” for older dates).
private struct StatusWidgetSnapshot: Decodable {
  let applianceId: String?
  let source: String?
  let boxName: String
  let status: String
  let tone: String
  let timeZone: String?
  let updatedAt: Double
  let locale: String?
  let labels: Labels?

  struct Labels: Decodable {
    let asOfTemplate: String
    let asOfYesterdayTemplate: String
  }

  private static let shortMonths = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ]

  private static let utcCalendar: Calendar = {
    var cal = Calendar(identifier: .gregorian)
    if let utc = TimeZone(secondsFromGMT: 0) {
      cal.timeZone = utc
    }
    return cal
  }()

  func resolvedTimeZone() -> TimeZone {
    timeZone
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .flatMap { $0.isEmpty ? nil : TimeZone(identifier: $0) } ?? .current
  }

  private func zonedCalendar() -> Calendar {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = resolvedTimeZone()
    return cal
  }

  private static func dayDiff(from atParts: DateComponents, to nowParts: DateComponents) -> Int? {
    let from = DateComponents(year: atParts.year, month: atParts.month, day: atParts.day)
    let to = DateComponents(year: nowParts.year, month: nowParts.month, day: nowParts.day)
    guard let fromDate = utcCalendar.date(from: from),
          let toDate = utcCalendar.date(from: to)
    else { return nil }
    return Int(round(toDate.timeIntervalSince(fromDate) / 86_400.0))
  }

  func asOfLabel(at now: Date) -> String {
    let cal = zonedCalendar()
    let atDate = Date(timeIntervalSince1970: updatedAt / 1000.0)
    let atParts = cal.dateComponents([.year, .month, .day, .hour, .minute], from: atDate)
    let nowParts = cal.dateComponents([.year, .month, .day], from: now)
    let tag = locale ?? LiveWidgetLocale.shared
    let dutch = LiveWidgetLocale.isDutch(tag)
    guard let atYear = atParts.year,
          let atMonth = atParts.month,
          let atDay = atParts.day,
          let atHour = atParts.hour,
          let atMinute = atParts.minute,
          let nowYear = nowParts.year,
          let diff = Self.dayDiff(from: atParts, to: nowParts)
    else {
      return StatusWidgetEmpty.asOf(dutch: dutch)
    }
    let clock = String(format: "%02d:%02d", atHour, atMinute)
    if diff == 0 {
      return asOf(clock, dutch: dutch)
    }
    if diff == 1 {
      if let template = labels?.asOfYesterdayTemplate, template.contains("{clock}") {
        return template.replacingOccurrences(of: "{clock}", with: clock)
      }
      return dutch ? "van gisteren \(clock)" : "as of yesterday \(clock)"
    }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: tag ?? "nl-NL")
    formatter.timeZone = cal.timeZone
    formatter.dateFormat = "MMM"
    let month = dutch
      ? formatter.string(from: atDate).trimmingCharacters(in: CharacterSet(charactersIn: "."))
      : (1...12).contains(atMonth) ? Self.shortMonths[atMonth - 1] : ""
    let day = "\(atDay) \(month)"
    let date = atYear == nowYear ? day : "\(day) \(atYear)"
    return asOf(date, dutch: dutch)
  }

  private func asOf(_ label: String, dutch: Bool) -> String {
    if let template = labels?.asOfTemplate, template.contains("{when}") {
      return template.replacingOccurrences(of: "{when}", with: label)
    }
    return dutch ? "van \(label)" : "as of \(label)"
  }

  private func nextBoundary(after date: Date, calendar cal: Calendar) -> Date? {
    let atDate = Date(timeIntervalSince1970: updatedAt / 1000.0)
    let atParts = cal.dateComponents([.year, .month, .day], from: atDate)
    let nowParts = cal.dateComponents([.year, .month, .day], from: date)
    guard let atYear = atParts.year,
          let nowYear = nowParts.year,
          let diff = Self.dayDiff(from: atParts, to: nowParts)
    else { return nil }
    if diff == 0 || diff == 1 {
      let startOfToday = cal.startOfDay(for: date)
      guard let nextDay = cal.date(byAdding: .day, value: 1, to: startOfToday) else { return nil }
      let startOfNext = cal.startOfDay(for: nextDay)
      return startOfNext > date ? startOfNext : cal.date(byAdding: .day, value: 1, to: startOfNext)
    }
    if diff < 0 {
      let target = atYear > nowYear
        ? cal.date(from: DateComponents(year: atYear, month: 1, day: 1))
        : cal.date(from: DateComponents(year: atYear, month: atParts.month, day: atParts.day))
      return target.flatMap { $0 > date ? $0 : nil }
    }
    if atYear == nowYear {
      return cal.date(from: DateComponents(year: nowYear + 1, month: 1, day: 1))
    }
    return nil
  }

  /// Future instants when `asOfLabel` changes (today -> yesterday -> date -> date with year),
  /// so WidgetKit rolls over locally without fetching anything.
  func rolloverDates(after now: Date) -> [Date] {
    let cal = zonedCalendar()
    var dates: [Date] = []
    var cursor = now
    for _ in 0..<3 {
      let before = asOfLabel(at: cursor)
      guard let next = nextBoundary(after: cursor, calendar: cal) else { break }
      if asOfLabel(at: next) != before {
        dates.append(next)
      }
      cursor = next
    }
    return dates
  }
}

/// Mirrors `WIDGET_EMPTY_COPY` in `@whombat/client` (verified by `statusWidget.test.ts`).
private enum StatusWidgetEmpty {
  static let boxName = "Whombat"
  static let status = "Open Whombat"
  static func asOf(dutch: Bool) -> String {
    dutch ? "Tik om de status te zien" : "Tap to see status"
  }
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
      asOf: StatusWidgetEmpty.asOf(dutch: LiveWidgetLocale.isDutch(LiveWidgetLocale.shared)),
      isEmpty: true
    )
  }

  static func sample(at date: Date) -> WhombatStatusEntry {
    let dutch = LiveWidgetLocale.isDutch(LiveWidgetLocale.shared)
    return WhombatStatusEntry(
      date: date,
      boxName: dutch ? "Thuis" : "Home",
      status: dutch ? "Alles in orde" : "All good",
      tone: "ok",
      asOf: dutch ? "van 14:05" : "as of 14:05",
      isEmpty: false
    )
  }
}

struct WhombatStatusProvider: TimelineProvider {
  private static let appGroupInfoKey = "WhombatStatusWidgetAppGroup"
  private static let defaultAppGroup = "group.com.whombat.mobile"
  private static let defaultsKey = "com.whombat.live.widget.status"

  private static var groupDefaults: UserDefaults? {
    let group = (Bundle.main.object(forInfoDictionaryKey: appGroupInfoKey) as? String)
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .flatMap { $0.isEmpty ? nil : $0 } ?? defaultAppGroup
    return UserDefaults(suiteName: group)
  }

  private static func readSnapshot() -> StatusWidgetSnapshot? {
    guard let raw = groupDefaults?.string(forKey: defaultsKey),
          let data = raw.data(using: .utf8),
          let snapshot = try? JSONDecoder().decode(StatusWidgetSnapshot.self, from: data),
          !snapshot.boxName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          !snapshot.status.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          snapshot.updatedAt.isFinite,
          snapshot.updatedAt > 0
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
    var entries = [
      WhombatStatusEntry(
        date: now,
        boxName: snapshot.boxName,
        status: snapshot.status,
        tone: snapshot.tone,
        asOf: snapshot.asOfLabel(at: now),
        isEmpty: false
      )
    ]
    for date in snapshot.rolloverDates(after: now) {
      entries.append(
        WhombatStatusEntry(
          date: date,
          boxName: snapshot.boxName,
          status: snapshot.status,
          tone: snapshot.tone,
          asOf: snapshot.asOfLabel(at: date),
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
    .description(Text(LiveWidgetLocale.isDutch(LiveWidgetLocale.shared)
      ? "Toont de laatste status van je Whombat en opent de app."
      : "Shows your Whombat’s last status and opens the app."))
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
        .minimumScaleFactor(0.8)
        .padding(.top, 4)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(entry.accessibilityLabel)
    .accessibilityHint(Text(LiveWidgetLocale.isDutch(LiveWidgetLocale.shared) ? "Opent Whombat" : "Opens Whombat"))
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
