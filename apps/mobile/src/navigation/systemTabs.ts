/**
 * Which bar the tabs get, and what iOS's own tab bar shows on them (docs/app/decisions/native-feel.md). Pure,
 * so the rules are unit-tested; `GlassTabs.tsx` draws iOS's bar, `TabBar.tsx` our own.
 */
import { badgeText } from '../data/inbox';
import type { ScreenShape } from '../data/screenShape';
import type { Tab } from '../data/shell';
import { mobileTranslator } from '../i18n/translate';

/**
 * - `system`: iOS's own tab bar (UIKit's tab bar controller, Liquid Glass on iOS 26 and later), along the bottom of an
 *   iPhone;
 * - `bottom`: our bar along the bottom (Android);
 * - `side`: our tabs down the side, where the system keeps its own vertical bar (the iPhone Duo) and on wide windows.
 */
export type TabBarKind = 'system' | 'bottom' | 'side';

export function tabBarKind(tabs: ScreenShape['tabs'], os: string): TabBarKind {
  if (tabs !== 'bottom') return 'side';
  return os === 'ios' ? 'system' : 'bottom';
}

/** A tab's badge: a count, or a dot with what it means (Settings). */
export interface TabBadge {
  count: number;
  dot: boolean;
  /** The dot's or the count's colour in our own bar (Settings, the Inbox); the unread look without. */
  tone?: 'ok' | 'warn' | 'bad';
  /** What a screen reader hears after the tab's name while the dot shows, instead of “unread messages”. */
  spoken?: string;
}

/**
 * The SF Symbols closest to our bar's icons (a speech bubble, an inbox tray, a grid, a lightning bolt, a gear), filled as
 * iOS's own apps draw their tabs.
 */
export const TAB_SYMBOLS: Record<Tab, string> = {
  ChatRoom: 'message.fill',
  NeedsYou: 'tray.fill',
  Dashboard: 'square.grid.2x2.fill',
  Automations: 'bolt.fill',
  Settings: 'gearshape.fill',
};

/**
 * What iOS's bar shows in a tab's badge: the count as our bar writes it (“99+” past 99), or for a dot a badge without
 * words. UIKit has no dot of its own here (react-native-screens passes an empty badge on as none), so a zero-width
 * space makes iOS's smallest badge. Undefined: no badge.
 */
export const DOT_BADGE = '\u200B';

export function systemBadgeValue(badge: TabBadge | undefined): string | undefined {
  if (!badge) return undefined;
  if (badge.count > 0) return badgeText(badge.count);
  return badge.dot ? DOT_BADGE : undefined;
}

/**
 * What VoiceOver hears for a tab of iOS's bar: its name, what a dot means, since a dot has nothing to read, and that
 * something isn't working, since the badge's colour doesn't say it. A count iOS reads from the badge itself.
 */
export function systemTabLabel(label: string, badge: TabBadge | undefined, locale?: string): string {
  if (badge && badge.count === 0 && badge.dot && badge.spoken) return `${label}, ${badge.spoken}`;
  // Every badge is drawn alike on iPhone (`GlassTabs`): that something isn't working is said in words.
  if (badge && badge.count > 0 && badge.tone === 'bad')
    return `${label}, ${mobileTranslator(locale).t('places.broken')}`;
  return label;
}

/** What VoiceOver hears after the Inbox's name while something there isn't working. */
export const BROKEN_WORDS = 'something isn’t working';
