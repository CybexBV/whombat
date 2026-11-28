/**
 * The phone's one layout (one-layout-android.md): the bar's tabs are Chat, Inbox, Automations and Settings, on every
 * Whombat and from the first frame. Chat is the `ChatRoom` route in code and the Inbox the `NeedsYou` route. Servers
 * and Connections are list screens Places opens (`data/places.ts`). Pure.
 */

import { mobileTranslator } from '../i18n/translate';

/** The bar's tabs, in its order. The first is the one the app opens on (CHT-22). */
export const TABS = ['ChatRoom', 'NeedsYou', 'Automations', 'Settings'] as const;

export type Tab = (typeof TABS)[number];

/** Where the app opens: Chat. */
export const HOME_TAB = 'ChatRoom' satisfies Tab;

/**
 * Where “the inbox” of a link or a push lands when it names no item of its own (AP-1351): Needs you, where what needs
 * the person is (NYL-09).
 */
export const INBOX_TAB = 'NeedsYou' satisfies Tab;

/** What the bar calls each tab (CN-07, AP-2550). */
export function tabWords(locale?: string): Record<Tab, string> {
  const { t } = mobileTranslator(locale);
  return {
    ChatRoom: t('places.chat'),
    NeedsYou: t('places.inbox'),
    Automations: t('places.automations'),
    Settings: t('places.settings'),
  };
}
export const TAB_WORDS = tabWords();

/** A tab name kept from before (the Overview's `Dashboard`, gone): Chat; a tab of the bar as it is. */
export function knownTab(name: string | null | undefined): Tab {
  return (TABS as readonly string[]).includes(name ?? '') ? (name as Tab) : HOME_TAB;
}
