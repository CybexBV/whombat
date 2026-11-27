import ActivityKit
import SwiftUI
import UIKit
import WidgetKit

/// The Live Activity UI (Lock Screen and Dynamic Island) for `WhombatLiveAttributes`. It renders the
/// `LiveActivityDisplay` from `@whombat/core` as is: label, title, text, progress (segments for an
/// approval's conditions), the chip, and the actions as links into the app.
@main
struct WhombatLiveWidgetBundle: WidgetBundle {
  var body: some Widget {
    WhombatLiveActivityWidget()
    #if WHOMBAT_STATUS_WIDGET
    WhombatStatusWidget()
    #endif
  }
}

/// Colors from `@whombat/tokens` (theme `bg` / `sf` / `ink` / `ink2` / `mut` / `logo` / `btn` / `btnfg`,
/// the tone colors and the fixed run-progress color); `statusWidget.test.ts` checks them against the tokens.
enum Palette {
  static let bg = Color(light: 0xFBF9F5, dark: 0x1C1815)
  static let sf = Color(light: 0xFFFDF9, dark: 0x24201C)
  static let sf2 = Color(light: 0xF1ECE4, dark: 0x2E2925)
  static let ink = Color(light: 0x221D18, dark: 0xF1EBE3)
  static let ink2 = Color(light: 0x3D352E, dark: 0xD8CFC4)
  static let mut = Color(light: 0x6E655C, dark: 0xA0958A)
  static let logo = Color(light: 0x2B221D, dark: 0xF5F2ED)
  static let btn = Color(light: 0x221D18, dark: 0xF1EBE3)
  static let btnfg = Color(light: 0xF5F2ED, dark: 0x1C1815)
  static let ok = Color(light: 0x3E7B58, dark: 0x6FCF97)
  static let warn = Color(light: 0x8D6D2D, dark: 0xE0B75E)
  static let bad = Color(light: 0x9F5540, dark: 0xE59A85)
  static let progress = Color(light: 0x5AA37A, dark: 0x5AA37A)

  static func tone(_ tone: String) -> Color {
    switch tone {
    case "ok": return ok
    case "warn": return warn
    case "bad": return bad
    default: return mut
    }
  }
}

extension Color {
  init(light: UInt32, dark: UInt32) {
    self.init(
      uiColor: UIColor { traits in
        let hex = traits.userInterfaceStyle == .dark ? dark : light
        return UIColor(
          red: CGFloat((hex >> 16) & 0xFF) / 255,
          green: CGFloat((hex >> 8) & 0xFF) / 255,
          blue: CGFloat(hex & 0xFF) / 255,
          alpha: 1
        )
      }
    )
  }
}

struct WhombatLiveActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: WhombatLiveAttributes.self) { context in
      LockScreenView(state: context.state)
        .activityBackgroundTint(Palette.bg)
        .activitySystemActionForegroundColor(Palette.ink)
        .widgetURL(context.state.url)
    } dynamicIsland: { context in
      let state = context.state
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          LabelView(state: state)
        }
        DynamicIslandExpandedRegion(.trailing) {
          if let chip = state.chip {
            Text(chip).font(.system(size: 13, weight: .medium, design: .monospaced))
          }
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 8) {
            Text(state.title).font(.system(size: 15, weight: .semibold)).lineLimit(2)
            Text(state.text).font(.system(size: 13)).foregroundStyle(.secondary).lineLimit(1)
            ProgressBar(state: state)
            ActionsView(state: state)
          }
        }
      } compactLeading: {
        Circle().fill(Palette.tone(state.tone)).frame(width: 8, height: 8)
      } compactTrailing: {
        Text(state.chip ?? "").font(.system(size: 12, weight: .medium, design: .monospaced))
      } minimal: {
        Circle().fill(Palette.tone(state.tone)).frame(width: 8, height: 8)
      }
      .widgetURL(state.url)
    }
  }
}

struct LabelView: View {
  let state: WhombatLiveAttributes.ContentState

  var body: some View {
    HStack(spacing: 6) {
      Circle().fill(state.kind == "run" && state.ongoing ? Palette.progress : Palette.tone(state.tone))
        .frame(width: 7, height: 7)
      Text(state.label)
        .font(.system(size: 11, weight: .medium, design: .monospaced))
        .tracking(0.55)
        .foregroundStyle(Palette.tone(state.tone))
    }
  }
}

struct ProgressBar: View {
  let state: WhombatLiveAttributes.ContentState

  var body: some View {
    let segments = max(1, state.segments)
    let filled = segments > 1 ? Int((Double(state.progress) * Double(segments) / 100).rounded()) : 0
    let color = state.kind == "run" ? Palette.progress : Palette.tone(state.tone)
    if segments > 1 {
      HStack(spacing: 4) {
        ForEach(0..<segments, id: \.self) { index in
          Capsule().fill(index < filled ? color : Palette.sf2).frame(height: 6)
        }
      }
    } else {
      GeometryReader { geometry in
        ZStack(alignment: .leading) {
          Capsule().fill(Palette.sf2)
          Capsule().fill(color).frame(width: geometry.size.width * CGFloat(state.progress) / 100)
        }
      }
      .frame(height: 6)
    }
  }
}

struct ActionsView: View {
  let state: WhombatLiveAttributes.ContentState

  var body: some View {
    let actions = state.actions.filter { ["approve", "details", "open_run"].contains($0) }
    if !actions.isEmpty {
      HStack(spacing: 8) {
        ForEach(actions, id: \.self) { action in
          // Every button opens the activity's screen; `approve` (Review) opens the approval, where the person approves.
          if let url = state.url {
            Link(destination: url) {
              Text(state.actionLabel(action))
                .font(.system(size: 15, weight: action == "approve" ? .semibold : .medium))
                .frame(maxWidth: .infinity, minHeight: 44)
                .foregroundStyle(action == "approve" ? Palette.btnfg : Palette.ink)
                .background(
                  RoundedRectangle(cornerRadius: 12)
                    .fill(action == "approve" ? Palette.btn : Color.clear)
                )
                .overlay(
                  RoundedRectangle(cornerRadius: 12)
                    .stroke(action == "approve" ? Color.clear : Palette.mut.opacity(0.4), lineWidth: 1)
                )
            }
          }
        }
      }
    }
  }
}

struct LockScreenView: View {
  let state: WhombatLiveAttributes.ContentState

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        LabelView(state: state)
        Spacer()
        if let chip = state.chip {
          Text(chip)
            .font(.system(size: 12, weight: .medium, design: .monospaced))
            .foregroundStyle(Palette.mut)
        }
      }
      Text(state.title)
        .font(.system(size: 17, weight: .bold))
        .foregroundStyle(Palette.ink)
        .lineLimit(2)
      Text(state.text)
        .font(.system(size: 14))
        .foregroundStyle(Palette.ink2)
        .lineLimit(2)
      ProgressBar(state: state)
      if state.ongoing {
        ActionsView(state: state)
      }
    }
    .padding(16)
  }
}
