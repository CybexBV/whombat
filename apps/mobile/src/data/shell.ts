/**
 * The phone's one layout (one-layout-android.md): the bar's tabs are Chat, Inbox, Overview, Automations and Settings,
 * on every Whombat and from the first frame. Overview is the `Dashboard` route in code and Chat the `ChatRoom` route.
 * Pure.
 */
import { CHAT_WORDS } from '@whombat/client';

/**
 * What the Overview tab and its page are called (sidebar-tabs.md; the web's sidebar row): the bar's word, the page's
 * title and the “‹ Overview” of a screen opened from it. Connections are what is connected: Overview's tab, Settings'.
 */
export const OVERVIEW_TITLE = CHAT_WORDS.dashboard;

/** The bar's tabs, in its order. The first is the one the app opens on (CHT-22). */
export const TABS = ['ChatRoom', 'NeedsYou', 'Dashboard', 'Automations', 'Settings'] as const;

export type Tab = (typeof TABS)[number];

/** Where the app opens: Chat. */
export const HOME_TAB = 'ChatRoom' satisfies Tab;

/**
 * Where “the inbox” of a link or a push lands when it names no item of its own (AP-1351): Needs you, where what needs
 * the person is (NYL-09).
 */
export const INBOX_TAB = 'NeedsYou' satisfies Tab;

/** What the bar calls each tab (CN-07, AP-2550). */
export const TAB_WORDS: Record<Tab, string> = {
  ChatRoom: 'Chat',
  NeedsYou: 'Inbox',
  Dashboard: OVERVIEW_TITLE,
  Automations: 'Automations',
  Settings: 'Settings',
};
