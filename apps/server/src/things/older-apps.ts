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
 * A newer app, and anything outside a session, gets the answer as it is.
 */
import {
  FEEDBACK_THING_ID,
  FIND_MY_TIMELINE_TAB,
  type HomeOverview,
  type ThingPage,
  type ThingPageTab,
  type ThingSummary,
} from '@whombat/core';
import { ACCOUNT_PAGES_MINOR, FIND_MY_TIMELINE_MINOR } from '@whombat/protocol/session';
import { mailThingHref } from '../home/mail-glance';
import { SUMMARY_TAB } from './panels';

/** Whether a session at `minor` draws a Find My connection's Timeline tab; outside a session (`undefined`), it does. */
export const readsFindMyTimeline = (minor: number | undefined) =>
  minor === undefined || minor >= FIND_MY_TIMELINE_MINOR;

/** A thing's page as an app at `minor` reads it: below minor 5 without the Timeline tab and with the Summary first. */
export function thingPageFor(page: ThingPage, minor: number | undefined): ThingPage {
  if (readsFindMyTimeline(minor)) return page;
  const kept = page.tabs.filter((t) => !(t.key === FIND_MY_TIMELINE_TAB && t.server));
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

/**
 * An op's answer as an app at `minor` reads it: `things.page`'s without what it can't draw, `home.overview`'s things as
 * it opens them, every other op's as it is.
 */
export function thingAnswerFor(op: string, body: unknown, minor: number | undefined): unknown {
  if (!body || typeof body !== 'object') return body;
  if (op === 'home.overview' && !readsAccountPages(minor)) {
    const overview = body as HomeOverview;
    return Array.isArray(overview.things) ? { ...overview, things: thingsFor(overview.things, minor) } : body;
  }
  if (op !== 'things.page' || readsFindMyTimeline(minor)) return body;
  return thingPageFor(body as ThingPage, minor);
}
