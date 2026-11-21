/**
 * Overview on the phone (docs/decisions/overview-one-page.md; connections-page.md CN-03 before it): the phone's own
 * parts — its words, the jump chips under the title and where a jump stops, and where a connection's tile goes. The
 * sections, their counts, dots and summary lines and what a tile says are the shared `overviewSections` and
 * `overviewTiles` (`@whombat/client`); the server cards' rows are `overviewServerRows`. What needs the person is the
 * Inbox's (`data/needsYou.ts`). Pure; the screen is `screens/HomeScreen.tsx` (the `Dashboard` route).
 */
import { type AgentWords, CONNECTIONS_TAB_WORDS, type OverviewSectionView } from '@whombat/client';
import { catalogEntry, type ThingSummary } from '@whombat/core';
import { OVERVIEW_TITLE } from './shell';

/* Words ------------------------------------------------------------------------------------------------------------- */

/** Overview's words (CN-01…CN-03; AP-2553; sidebar-tabs.md). */
export const CONNECTIONS_COPY = {
  title: OVERVIEW_TITLE,
  needsYou: 'Inbox',
  /** Everything connected that isn't a server (sidebar-tabs.md; the web's tab). */
  services: CONNECTIONS_TAB_WORDS.services,
  failed: `${OVERVIEW_TITLE} didn’t load.`,
  loading: 'Loading your connections',
  opensSheet: 'Shows what you can do',
  opens: 'Opens its page',
  /** The headline's red sentence when it names an Inbox item. */
  opensInbox: 'Opens it in the Inbox',
  /** A Needs you item's page, once the item has left Needs you. */
  needsYouGone: 'This doesn’t need you any more.',
  addConnection: 'Add a connection',
  addConnectionLine: 'A service, a device or an account',
  empty: (w: Pick<AgentWords, 'name'>) =>
    `Nothing here yet. Ask ${w.name} to add a server, a connection or a device.`,
} as const;

/* Sections and jump chips --------------------------------------------------------------------------------------- */

/**
 * The jump chips under the title (overview-one-page.md OVP-01, OVP-11): one per section, each scrolling to it; none
 * when there is only one section, which its heading already names.
 */
export function overviewChips(sections: readonly OverviewSectionView[]): OverviewSectionView[] {
  return sections.length > 1 ? [...sections] : [];
}

/**
 * Where a scroll to a section stops: its heading a little under the top of the list, never above the list's start.
 */
export const JUMP_MARGIN = 8;
export function jumpOffset(sectionY: number): number {
  return Math.max(0, sectionY - JUMP_MARGIN);
}

/* Connections ------------------------------------------------------------------------------------------------------- */

/**
 * The address a Services row follows instead of the thing's page (AP-2814): a connection of a builtin entry — the
 * server makes no page for one (`things.page` answers 404: Google's and Email (IMAP)'s mail, which live in
 * `connectors.status`) — goes where its `href` says, unless that is a thing's page itself. Servers, devices, catalog
 * connections and entries this phone doesn't know (a newer server's) open their page.
 */
export function serviceRowOpens(thing: Pick<ThingSummary, 'kind' | 'catalogId' | 'href'>): string | null {
  if (thing.kind !== 'connection' || !thing.catalogId) return null;
  if (catalogEntry(thing.catalogId)?.transport !== 'builtin') return null;
  return /^\/(?:[^/]+\/)?things\//.test(thing.href) ? null : thing.href;
}
