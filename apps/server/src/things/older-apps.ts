/**
 * What an older app can't read of a thing's page or Home's things:
 *
 * - An app below session protocol minor 5 has no Timeline for a Find My connection and would show the tab empty, so its
 *   page leaves the tab out, and it opens on the Summary as before, in case it can't draw the Find My tab either
 *   (docs/decisions/findmy-timeline.md).
 * - An app below minor 7 has no page for an account: Home's Google, Microsoft 365, Email and GitHub open their page on
 *   the Connections tab as before, and Website feedback, which its sidebar never had, is left out
 *   (docs/decisions/connection-dashboards.md).
 *
 * - An app below minor 8 can't draw a 1Password connection's part or answer its Inbox card: the catalog it is offered
 *   leaves 1Password out, and a 1Password connection made from a newer app opens on its Summary without the 1Password
 *   tab, which it would show empty (docs/decisions/onepassword-sync.md).
 * - An app below minor 9 leaves Website or address out of the catalog because it can't draw the conditional fields.
 *
 * A newer app, and anything outside a session, gets the answer as it is.
 */
import {
  type ConnectionsCatalogStatus,
  FEEDBACK_THING_ID,
  FIND_MY_TIMELINE_TAB,
  type HomeOverview,
  type NeedsYouItem,
  ONEPASSWORD_TAB,
  type ThingPage,
  type ThingPageTab,
  type ThingSummary,
  UPTIME_ID,
} from '@whombat/core';
import {
  ACCOUNT_PAGES_MINOR,
  FIND_MY_TIMELINE_MINOR,
  LOOKS_AHEAD_INBOX_MINOR,
  ONEPASSWORD_SYNC_MINOR,
} from '@whombat/protocol/session';
import { mailThingHref } from '../home/mail-glance';
import { SUMMARY_TAB } from './panels';

/** Whether a session at `minor` draws a Find My connection's Timeline tab; outside a session (`undefined`), it does. */
export const readsFindMyTimeline = (minor: number | undefined) =>
  minor === undefined || minor >= FIND_MY_TIMELINE_MINOR;

/**
 * A thing's page as an app at `minor` reads it: below minor 5 without Find My's Timeline tab, below minor 8 without the
 * 1Password connection's own tab, and with the Summary first whenever a tab is left out.
 */
export function thingPageFor(page: ThingPage, minor: number | undefined): ThingPage {
  const timeline = readsFindMyTimeline(minor);
  const onePassword = readsOnePassword(minor);
  if (timeline && onePassword) return page;
  const kept = page.tabs.filter(
    (t) =>
      !(!timeline && t.key === FIND_MY_TIMELINE_TAB && t.server) &&
      !(!onePassword && t.key === ONEPASSWORD_TAB),
  );
  // Below minor 5 the Summary always came first, in case the app can't draw Find My's tab either.
  return kept.length === page.tabs.length && timeline ? page : summaryFirst(page, kept);
}

/** The page with these tabs, the Summary first. */
function summaryFirst(page: ThingPage, kept: ThingPageTab[]): ThingPage {
  const summary = kept.findIndex((t) => t.key === SUMMARY_TAB.key);
  const tabs = summary > 0 ? [kept[summary] as ThingPageTab, ...kept.filter((_, i) => i !== summary)] : kept;
  return tabs.length === page.tabs.length && summary <= 0 ? page : { ...page, tabs };
}

/** Whether a session at `minor` opens an account's own page; outside a session (`undefined`), it does. */
export const readsAccountPages = (minor: number | undefined) =>
  minor === undefined || minor >= ACCOUNT_PAGES_MINOR;

/** The accounts whose thing opened on the Connections tab before they had a page. */
const SETTINGS_PAGES = new Set(['google', 'microsoft', 'imap', 'github']);

/** Home's things as an app at `minor` reads them: below minor 7, accounts open on Settings and Website feedback is out. */
export function thingsFor(things: readonly ThingSummary[], minor: number | undefined): ThingSummary[] {
  if (readsAccountPages(minor)) return [...things];
  return things
    .filter((t) => t.id !== FEEDBACK_THING_ID)
    .map((t) =>
      t.kind === 'connection' &&
      t.catalogId &&
      SETTINGS_PAGES.has(t.catalogId) &&
      t.href.startsWith('/things/')
        ? { ...t, href: mailThingHref(t.catalogId as Parameters<typeof mailThingHref>[0]) }
        : t,
    );
}

/** Whether a session at `minor` is offered 1Password; outside a session (`undefined`), it is. */
export const readsOnePassword = (minor: number | undefined) =>
  minor === undefined || minor >= ONEPASSWORD_SYNC_MINOR;

/** Whether a session at `minor` knows Inbox Looks ahead findings (`kind: 'ahead'`). */
export const readsLooksAheadInbox = (minor: number | undefined) =>
  minor === undefined || minor >= LOOKS_AHEAD_INBOX_MINOR;

/** Adapts `kind: 'ahead'` Inbox items for older apps that do not recognize that enum member. */
function needsYouListFor(items: readonly NeedsYouItem[], minor: number | undefined): NeedsYouItem[] {
  if (readsLooksAheadInbox(minor)) return [...items];
  return items.map((item) => {
    if (item.kind !== 'ahead') return item;
    const { ahead: _ahead, ...rest } = item;
    // Map to `backup` (neither a watched line nor a waiting ask), so older apps show Settle, Remind me tomorrow,
    // and Talk to {assistant} (which promotes the finding cleanly via `needsYou.discuss`).
    return { ...rest, kind: 'backup' as const };
  });
}

const UPTIME_CATALOG_MINOR = 9;

/**
 * An op's answer as an app at `minor` reads it: `things.page`'s without the tabs it can't draw, `home.overview`'s things
 * and Inbox items as it reads them, and `connections.catalog` without entries whose forms it can't draw.
 */
export function thingAnswerFor(op: string, body: unknown, minor: number | undefined): unknown {
  if (!body || typeof body !== 'object') return body;
  if (op === 'connections.catalog' && minor !== undefined && minor < UPTIME_CATALOG_MINOR) {
    const status = body as ConnectionsCatalogStatus;
    if (!Array.isArray(status.entries)) return body;
    const entries = status.entries.filter(
      (e) => e.catalogId !== UPTIME_ID && (readsOnePassword(minor) || e.catalogId !== 'onepassword'),
    );
    return entries.length === status.entries.length ? body : { ...status, entries };
  }
  if (op === 'home.overview') {
    const overview = body as HomeOverview;
    const adaptThings = !readsAccountPages(minor) && Array.isArray(overview.things);
    const adaptAhead =
      !readsLooksAheadInbox(minor) &&
      ((Array.isArray(overview.needsYouList) && overview.needsYouList.some((i) => i.kind === 'ahead')) ||
        (Array.isArray(overview.needsYou) && overview.needsYou.some((i) => i.kind === 'ahead')));
    if (!adaptThings && !adaptAhead) return body;
    return {
      ...overview,
      ...(adaptThings ? { things: thingsFor(overview.things, minor) } : {}),
      ...(adaptAhead && Array.isArray(overview.needsYou)
        ? { needsYou: needsYouListFor(overview.needsYou, minor) }
        : {}),
      ...(adaptAhead && overview.needsYouList
        ? { needsYouList: needsYouListFor(overview.needsYouList, minor) }
        : {}),
    };
  }
  if (op !== 'things.page' || (readsFindMyTimeline(minor) && readsOnePassword(minor))) return body;
  return thingPageFor(body as ThingPage, minor);
}
