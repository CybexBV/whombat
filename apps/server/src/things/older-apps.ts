/**
 * What an older app can't read of a thing's page (docs/decisions/findmy-timeline.md): an app below session protocol
 * minor 5 has no Timeline for a Find My connection and would show the tab empty, so its page leaves the tab out, and it
 * opens on the Summary as before, in case it can't draw the Find My tab either. A newer app, and anything outside a
 * session, gets the page as it is.
 */
import { FIND_MY_TIMELINE_TAB, type ThingPage, type ThingPageTab } from '@whombat/core';
import { FIND_MY_TIMELINE_MINOR } from '@whombat/protocol/session';
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

/** An op's answer as an app at `minor` reads it: `things.page`'s without what it can't draw, every other op's as it is. */
export function thingAnswerFor(op: string, body: unknown, minor: number | undefined): unknown {
  if (op !== 'things.page' || readsFindMyTimeline(minor) || !body || typeof body !== 'object') return body;
  return thingPageFor(body as ThingPage, minor);
}
