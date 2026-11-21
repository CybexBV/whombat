import ExpoModulesCore
import UIKit

/**
 * `WhombatMenu` (iOS): the app's menus as iOS draws its own (docs/app/decisions/ios-message-menu.md,
 * docs/app/decisions/ios-native.md). The view wraps what the menu is for. A long press on it (a message, a list's row)
 * opens the menu where it was held, a tap (a ⋯ button) opens the menu from it, as iOS's own controls do. A
 * message's menu has its quick reactions in a row on top and More reactions under them; any menu has groups of actions
 * with a line between them, submenus, ticks on the chosen one, a quiet second line, and Delete red. The menu comes as
 * JSON (`src/data/nativeMenu.ts`); a pick goes back as `onMenuAction` with its id once the menu has gone, so a sheet or
 * an alert it opens isn't presented over a menu still closing.
 */
public final class WhombatMenuModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WhombatMenu")

    View(WhombatMenuView.self) {
      Events("onMenuAction", "onMenuOpen")

      Prop("menu") { (view: WhombatMenuView, json: String?) in
        view.setMenu(json)
      }

      /** `longPress` (default): held, the menu opens where it was held; `tap`: from the view, as a ⋯ button's. */
      Prop("trigger") { (view: WhombatMenuView, trigger: String?) in
        view.setTrigger(trigger == "tap" ? .tap : .longPress)
      }

      /** What VoiceOver calls the button, with a tap. */
      Prop("label") { (view: WhombatMenuView, label: String?) in
        view.setLabel(label)
      }

      /** The reaction pills' “yours” fill and ring, on the viewer's own reactions in the row. */
      Prop("mineColor") { (view: WhombatMenuView, color: UIColor?) in
        view.mineColor = color
      }

      Prop("mineRingColor") { (view: WhombatMenuView, color: UIColor?) in
        view.mineRingColor = color
      }
    }
  }
}

struct MenuSpec: Decodable {
  struct Reaction: Decodable {
    let id: String
    let value: String
    let mine: Bool
    /** What VoiceOver says; the row shows only the emoji. */
    let label: String
  }

  struct Item: Decodable {
    let id: String
    let title: String
    /** A quiet line under the title. */
    let subtitle: String?
    /** An SF Symbol. */
    let icon: String?
    let destructive: Bool?
    let disabled: Bool?
    /** Ticked: the one chosen among its group. */
    let checked: Bool?
    /** A submenu: its groups, a line between them. The item itself is then no pick. */
    let children: [[Item]]?
  }

  /** A quiet line on top (what answered an agent's reply); none when empty. */
  let title: String?
  let reactions: [Reaction]?
  let more: Item?
  /** Groups of actions, a line between them. */
  let sections: [[Item]]
}

enum MenuTrigger {
  case longPress
  case tap
}

/**
 * The control that holds the menu. UIKit draws a control's menu the compact way — it keeps the keyboard up and doesn't
 * reshuffle the screen — where a plain view's context menu hides the keyboard first. With a tap it is the button over
 * the view; with a long press its interaction moves to the view and the button stays out of the way of the touches, so
 * the view's own taps and links still work.
 */
final class MenuButton: UIButton {
  weak var owner: WhombatMenuView?

  override func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    configurationForMenuAtLocation location: CGPoint
  ) -> UIContextMenuConfiguration? {
    guard let owner, owner.hasMenu, !owner.holdsText(at: location) else { return nil }
    return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak owner] _ in
      owner?.builtMenu()
    }
  }

  override func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    willDisplayMenuFor configuration: UIContextMenuConfiguration,
    animator: (any UIContextMenuInteractionAnimating)?
  ) {
    super.contextMenuInteraction(interaction, willDisplayMenuFor: configuration, animator: animator)
    owner?.menuWillShow()
  }

  override func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    willEndFor configuration: UIContextMenuConfiguration,
    animator: (any UIContextMenuInteractionAnimating)?
  ) {
    super.contextMenuInteraction(interaction, willEndFor: configuration, animator: animator)
    owner?.menuWillEnd(animator)
  }
}

final class WhombatMenuView: ExpoView {
  let onMenuAction = EventDispatcher()
  let onMenuOpen = EventDispatcher()
  var mineColor: UIColor?
  var mineRingColor: UIColor?

  private var json: String?
  private var spec: MenuSpec?
  private var trigger = MenuTrigger.longPress
  private let button = MenuButton(type: .custom)
  /** The menu is on screen or still closing; a pick waits for it to be gone, a new menu for the button too. */
  private var showing = false
  private var picked: String?

  var hasMenu: Bool { spec != nil }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    button.owner = self
    button.frame = bounds
    button.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(button)
    apply()
  }

  func setMenu(_ json: String?) {
    // A list re-renders its rows often with the same menu; only a new one is built.
    guard json != self.json else { return }
    self.json = json
    spec = json.flatMap { try? JSONDecoder().decode(MenuSpec.self, from: Data($0.utf8)) }
    apply()
  }

  func setTrigger(_ trigger: MenuTrigger) {
    guard trigger != self.trigger else { return }
    self.trigger = trigger
    apply()
  }

  func setLabel(_ label: String?) {
    button.accessibilityLabel = label
  }

  /** The button's menu and where its interaction lives, for the trigger and the menu there are. */
  private func apply() {
    let tap = trigger == .tap
    let on = spec != nil
    // A tap's menu is the button's own, built now; a long press's is built when it opens (a chat's rows would otherwise
    // each draw their emoji up front). Reassigning a menu on screen closes it: a new one waits until it has gone.
    if !showing { button.menu = tap ? spec.map(menu) : nil }
    button.showsMenuAsPrimaryAction = tap
    button.isContextMenuInteractionEnabled = on
    button.isUserInteractionEnabled = tap && on
    button.isAccessibilityElement = tap && on
    // A long press's button only catches the hold over a message; out of the accessibility tree altogether, or tools
    // and screen readers meet a nameless button over every row (the message itself carries the name and the actions).
    button.accessibilityElementsHidden = !(tap && on)
    button.accessibilityTraits = .button
    guard let interaction = button.contextMenuInteraction else { return }
    let host: UIView = tap ? button : self
    if interaction.view !== host {
      interaction.view?.removeInteraction(interaction)
      host.addInteraction(interaction)
    }
  }

  override func didAddSubview(_ subview: UIView) {
    super.didAddSubview(subview)
    // React puts the view's children in; the button stays over them.
    if subview !== button { bringSubviewToFront(button) }
  }

  func builtMenu() -> UIMenu? {
    spec.map(menu)
  }

  /**
   * A hold on words that can be selected (iOS's text view in a message) is for selecting them: the menu opens from the
   * rest of the row, its name and what hangs under the words.
   */
  func holdsText(at location: CGPoint) -> Bool {
    var view = hitTest(location, with: nil)
    while let current = view, current !== self {
      if let text = current as? UITextView, text.isSelectable { return true }
      view = current.superview
    }
    return false
  }

  // MARK: - Showing and picking

  func menuWillShow() {
    showing = true
    onMenuOpen()
  }

  func menuWillEnd(_ animator: (any UIContextMenuInteractionAnimating)?) {
    let gone = { [weak self] in
      guard let self else { return }
      self.showing = false
      self.apply()
      if let id = self.picked {
        self.picked = nil
        self.onMenuAction(["id": id])
      }
    }
    if let animator {
      animator.addCompletion(gone)
    } else {
      gone()
    }
  }

  private func pick(_ id: String) {
    if showing {
      picked = id
    } else {
      onMenuAction(["id": id])
    }
  }

  // MARK: - The menu

  private func menu(_ spec: MenuSpec) -> UIMenu {
    var groups: [UIMenuElement] = []
    if let reactions = spec.reactions, !reactions.isEmpty {
      let row: [UIMenuElement] = reactions.map { reaction in
        UIAction(title: reaction.label, image: emojiImage(reaction.value, mine: reaction.mine)) { [weak self] _ in
          self?.pick(reaction.id)
        }
      }
      if #available(iOS 17.0, *) {
        groups.append(UIMenu(options: [.displayInline, .displayAsPalette], children: row))
      } else {
        let inline = UIMenu(options: .displayInline, children: row)
        inline.preferredElementSize = .small
        groups.append(inline)
      }
    }
    // A line of its own under the emoji: a palette shows six across and would scroll a seventh out of sight.
    if let more = spec.more {
      groups.append(UIMenu(options: .displayInline, children: [element(more)]))
    }
    groups.append(contentsOf: inlineGroups(spec.sections))
    return UIMenu(title: spec.title ?? "", children: groups)
  }

  private func inlineGroups(_ sections: [[MenuSpec.Item]]) -> [UIMenuElement] {
    sections.filter { !$0.isEmpty }.map { UIMenu(options: .displayInline, children: $0.map(element)) }
  }

  private func element(_ item: MenuSpec.Item) -> UIMenuElement {
    let image = item.icon.flatMap { UIImage(systemName: $0) }
    if let children = item.children {
      let submenu = UIMenu(title: item.title, image: image, children: inlineGroups(children))
      submenu.subtitle = item.subtitle
      return submenu
    }
    var attributes: UIMenuElement.Attributes = []
    if item.destructive == true { attributes.insert(.destructive) }
    if item.disabled == true { attributes.insert(.disabled) }
    return UIAction(
      title: item.title,
      subtitle: item.subtitle,
      image: image,
      attributes: attributes,
      state: item.checked == true ? .on : .off
    ) { [weak self] _ in
      self?.pick(item.id)
    }
  }

  /** An emoji drawn as its picture in the row; on the pills' “yours” circle when the viewer reacted with it. */
  private func emojiImage(_ value: String, mine: Bool) -> UIImage {
    let side: CGFloat = 36
    let box = CGRect(x: 0, y: 0, width: side, height: side)
    let image = UIGraphicsImageRenderer(size: box.size).image { _ in
      if mine {
        let circle = UIBezierPath(ovalIn: box.insetBy(dx: 1, dy: 1))
        (mineColor ?? .secondarySystemFill).setFill()
        circle.fill()
        (mineRingColor ?? tintColor).setStroke()
        circle.lineWidth = 1.5
        circle.stroke()
      }
      let text = NSAttributedString(string: value, attributes: [.font: UIFont.systemFont(ofSize: 22)])
      let size = text.size()
      text.draw(at: CGPoint(x: (side - size.width) / 2, y: (side - size.height) / 2))
    }
    // As drawn: a menu tints its pictures like symbols otherwise.
    return image.withRenderingMode(.alwaysOriginal)
  }
}
