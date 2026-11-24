/**
 * The app's menus as iOS draws them (ios-message-menu.md AP-6260…AP-6263; ios-native.md): what `modules/whombat-menu`
 * shows. A message's menu comes from the same `messageMenu` the sheet uses — the quick reactions as a row of emoji with
 * “More reactions” under them, then the actions with the system's own symbols in groups (the thread, copying, changing,
 * deleting), and what answered an agent's reply as the menu's quiet title. The other menus hold what their sheets hold:
 * a settled thread's, a file's, a conversation's and a notice line's. Pure; a pick comes back as the id written here.
 */
import type { NeedsYouButton, NeedsYouButtonKind, QuietMenuView } from '@whombat/client';
import type { FileAction, FileActionKind } from './files';
import { type MessageActionKind, type MessageMenu, messageAction } from './messageActions';
import type { NotifyOption } from './notify';
import { reactionName } from './reactions';

/** Each action's SF Symbol: the one Apple's own apps use for it. */
export const ACTION_SYMBOLS: Record<MessageActionKind, string> = {
  settle: 'checkmark.circle',
  open_again: 'arrow.uturn.backward.circle',
  reply_thread: 'arrowshape.turn.up.left',
  copy_text: 'doc.on.doc',
  copy_link: 'link',
  save_prompt: 'text.badge.plus',
  share: 'square.and.arrow.up',
  share_from: 'square.and.arrow.up',
  edit: 'pencil',
  pin: 'pin',
  unpin: 'pin.slash',
  delete: 'trash',
};

/** The groups, with a line between them: the thread, copying, changing it, deleting it. */
const GROUP_OF: Record<MessageActionKind, number> = {
  settle: 0,
  open_again: 0,
  reply_thread: 0,
  copy_text: 1,
  copy_link: 1,
  save_prompt: 1,
  share: 1,
  share_from: 1,
  edit: 2,
  pin: 2,
  unpin: 2,
  delete: 3,
};

const REACT = 'react:';
const MORE = 'more';

export const MORE_REACTIONS = 'More reactions';

/** One line of a menu (`whombat-menu`'s `MenuSpec.Item`). */
export interface NativeMenuItem {
  id: string;
  title: string;
  /** A quiet line under the title. */
  subtitle?: string | null;
  /** An SF Symbol. */
  icon?: string | null;
  destructive?: boolean;
  disabled?: boolean;
  /** Ticked: the one chosen in its group. */
  checked?: boolean;
  /** A submenu: its groups, a line between them; the line itself is then no pick. */
  children?: NativeMenuItem[][] | null;
}

/** What `whombat-menu` reads (its `MenuSpec`). */
export interface NativeMenuSpec {
  title: string | null;
  reactions: { id: string; value: string; mine: boolean; label: string }[] | null;
  more: NativeMenuItem | null;
  sections: NativeMenuItem[][];
}

export function nativeMenuSpec(
  menu: MessageMenu,
  quick: readonly { value: string; mine: boolean }[] | null,
  detail: string | null,
): NativeMenuSpec {
  const sections: NativeMenuItem[][] = [];
  let group = -1;
  for (const a of menu.actions) {
    const item = {
      id: a.kind,
      title: a.label,
      icon: ACTION_SYMBOLS[a.kind],
      destructive: a.destructive,
      disabled: !!a.disabled,
    };
    if (GROUP_OF[a.kind] === group) sections.at(-1)?.push(item);
    else sections.push([item]);
    group = GROUP_OF[a.kind];
  }
  const react = menu.react && quick;
  return {
    title: detail || null,
    reactions: react
      ? quick.map((q) => ({
          id: `${REACT}${q.value}`,
          value: q.value,
          mine: q.mine,
          label: `${q.mine ? 'Take back' : 'React with'} ${reactionName(q.value)}`,
        }))
      : null,
    more: react
      ? { id: MORE, title: MORE_REACTIONS, icon: 'face.smiling', destructive: false, disabled: false }
      : null,
    sections,
  };
}

export type NativeMenuPick =
  | { kind: 'react'; value: string }
  | { kind: 'more' }
  | { kind: 'action'; action: MessageActionKind };

/** What an id from the menu asks for; null for one it never sent. */
export function parseNativeMenuPick(id: string): NativeMenuPick | null {
  if (id === MORE) return { kind: 'more' };
  if (id.startsWith(REACT) && id.length > REACT.length)
    return { kind: 'react', value: id.slice(REACT.length) };
  return id in GROUP_OF ? { kind: 'action', action: id as MessageActionKind } : null;
}

/** A menu of groups with a line between them, under a quiet title (a file's name) or none. */
export function plainMenu(sections: NativeMenuItem[][], title: string | null = null): NativeMenuSpec {
  return { title, reactions: null, more: null, sections: sections.filter((s) => s.length > 0) };
}

function actionItem(kind: MessageActionKind): NativeMenuItem {
  const a = messageAction(kind);
  return { id: kind, title: a.label, icon: ACTION_SYMBOLS[kind], destructive: a.destructive };
}

/**
 * A row of a room's Settled list, held or its ⋯ swiped to: Open again puts it back in the room, Reply in thread opens it
 * where the reply box is, and Copy link where the thread has a web address (not in the demo world).
 */
export function settledThreadMenu(canLink: boolean): NativeMenuSpec {
  return plainMenu([
    [actionItem('open_again'), actionItem('reply_thread')],
    canLink ? [actionItem('copy_link')] : [],
  ]);
}

/** A settled thread's pick: one of `settledThreadMenu`'s actions, or null for an id it never sent. */
export function parseSettledPick(id: string): 'open_again' | 'reply_thread' | 'copy_link' | null {
  return id === 'open_again' || id === 'reply_thread' || id === 'copy_link' ? id : null;
}

/** Each file action's SF Symbol (Download opens the share sheet, so the share symbol). */
export const FILE_SYMBOLS: Record<FileActionKind, string> = {
  download: 'square.and.arrow.up',
  open_message: 'bubble.left',
  rename: 'pencil',
  move: 'folder',
  remove: 'trash',
};

const FILE_GROUP: Record<FileActionKind, number> = {
  download: 0,
  open_message: 0,
  rename: 1,
  move: 1,
  remove: 2,
};

/** A file's menu (the action sheet's): its name on top, then getting it, changing it and removing it. */
export function fileMenu(name: string, actions: readonly FileAction[]): NativeMenuSpec {
  const sections: NativeMenuItem[][] = [[], [], []];
  for (const a of actions)
    sections[FILE_GROUP[a.kind]]?.push({
      id: a.kind,
      title: a.label,
      icon: FILE_SYMBOLS[a.kind],
      destructive: a.destructive,
    });
  return plainMenu(sections, name);
}

const NOTIFY = 'notify:';

/** A link in a conversation's menu: Pinned messages, Plans, Files. */
export interface ConversationMenuLink {
  key: 'pins' | 'plans' | 'files';
  label: string;
}

const LINK_SYMBOLS: Record<ConversationMenuLink['key'], string> = {
  pins: 'pin',
  plans: 'checklist',
  files: 'folder',
};

/**
 * A conversation's ⋯ menu (the sheet's, AP-511): Notifications, its choices one level down with what each lets through
 * under it and the current one ticked (and named under Notifications), then its pinned messages, plans and files.
 */
export function conversationMenu(
  notify: readonly NotifyOption[],
  links: readonly ConversationMenuLink[],
): NativeMenuSpec {
  const current = notify.find((o) => o.selected);
  return plainMenu([
    [
      {
        id: 'notify',
        title: 'Notifications',
        subtitle: current?.label ?? null,
        icon: 'bell',
        children: [
          notify.map((o) => ({
            id: `${NOTIFY}${o.level}`,
            title: o.label,
            subtitle: o.detail,
            checked: o.selected,
          })),
        ],
      },
    ],
    links.map((l) => ({ id: l.key, title: l.label, icon: LINK_SYMBOLS[l.key] })),
  ]);
}

/** A conversation menu's pick: a notification level, or one of its links. */
export function parseConversationPick(
  id: string,
):
  | { kind: 'notify'; level: NotifyOption['level'] }
  | { kind: 'link'; key: ConversationMenuLink['key'] }
  | null {
  if (id.startsWith(NOTIFY)) {
    const level = id.slice(NOTIFY.length);
    return level === 'all' || level === 'mentions' || level === 'none' ? { kind: 'notify', level } : null;
  }
  return id === 'pins' || id === 'plans' || id === 'files' ? { kind: 'link', key: id } : null;
}

/**
 * A notice line's ⋯ menu (QN-10): its title on top, Ignore and Stop watching with what they mean under them; on a
 * server's line whose check has a limit, Change the limit with the limit now under it (Whombat monitoring.md MON-15).
 */
export function quietLineMenu(
  menu: QuietMenuView,
  title: string,
  limit: { label: string; words: string } | null = null,
): NativeMenuSpec {
  return plainMenu(
    [
      [
        { id: 'ignore', title: menu.ignore.label, subtitle: menu.ignore.words, icon: 'eye.slash' },
        { id: 'snooze', title: menu.snooze.label, icon: 'alarm' },
      ],
      // The gentler way out before Stop watching: warn later instead of never.
      limit ? [{ id: 'limit', title: limit.label, subtitle: limit.words, icon: 'slider.horizontal.3' }] : [],
      [{ id: 'stop', title: menu.stop.label, subtitle: menu.stop.words, icon: 'bell.slash' }],
    ],
    title,
  );
}

export function parseQuietPick(id: string): 'ignore' | 'snooze' | 'stop' | null {
  return id === 'ignore' || id === 'snooze' || id === 'stop' ? id : null;
}

/** Each Inbox button's SF Symbol in a row's More (inbox.md IBX-04). */
export const INBOX_SYMBOLS: Record<NeedsYouButtonKind, string> = {
  fix: 'wrench.and.screwdriver',
  askFix: 'wand.and.stars',
  action: 'arrow.right.circle',
  see: 'arrow.up.right.square',
  settle: 'checkmark.circle',
  handle: 'wand.and.stars',
  talk: 'bubble.left.and.bubble.right',
  snooze: 'clock',
  stop: 'eye.slash',
  back: 'arrow.uturn.backward',
};

/**
 * An Inbox row's More, iOS's own menu from its swipe's ⋯ or a long press: handing it over and talking it over, then
 * Remind me tomorrow, then Stop watching on its own (it switches a check off). A pick is the button's id.
 */
export function inboxMoreMenu(
  buttons: readonly NeedsYouButton[],
  title: string | null = null,
): NativeMenuSpec {
  const item = (b: NeedsYouButton): NativeMenuItem => ({
    id: b.id,
    title: b.label,
    icon: INBOX_SYMBOLS[b.kind],
  });
  const ask = buttons.filter((b) => b.kind !== 'snooze' && b.kind !== 'stop');
  return plainMenu(
    [
      ask.map(item),
      buttons.filter((b) => b.kind === 'snooze').map(item),
      buttons.filter((b) => b.kind === 'stop').map(item),
    ],
    title,
  );
}
