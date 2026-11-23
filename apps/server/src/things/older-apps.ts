/**
 * What an older app can't read of a thing's page (docs/decisions/findmy-timeline.md): an app below session protocol
 * minor 5 has no Timeline for a Find My connection and would show the tab empty, so its page leaves the tab out. A newer
 * app, and anything outside a session, gets the page as it is.
 */
import { FIND_MY_TIMELINE_TAB, type ThingPage } from '@whombat/core';
import { FIND_MY_TIMELINE_MINOR } from '@whombat/protocol/session';

/** Whether a session at `minor` draws a Find My connection's Timeline tab; outside a session (`undefined`), it does. */
export const readsFindMyTimeline = (minor: number | undefined) =>
  minor === undefined || minor >= FIND_MY_TIMELINE_MINOR;

/** A thing's page as an app at `minor` reads it: without the Timeline tab below minor 5. */
export function thingPageFor(page: ThingPage, minor: number | undefined): ThingPage {
  if (readsFindMyTimeline(minor)) return page;
  const tabs = page.tabs.filter((t) => !(t.key === FIND_MY_TIMELINE_TAB && t.server));
  return tabs.length === page.tabs.length ? page : { ...page, tabs };
}

/** An op's answer as an app at `minor` reads it: `things.page`'s without what it can't draw, every other op's as it is. */
export function thingAnswerFor(op: string, body: unknown, minor: number | undefined): unknown {
  if (op !== 'things.page' || readsFindMyTimeline(minor) || !body || typeof body !== 'object') return body;
  return thingPageFor(body as ThingPage, minor);
}
