/**
 * A thing's page for an older app (docs/decisions/findmy-timeline.md): an app below session minor 5 gets a Find My
 * connection's page without the Timeline tab it can't draw; a newer one, and anything outside a session, gets it all.
 */
import { FIND_MY_TIMELINE_TAB, type ThingPage } from '@whombat/core';
import { FIND_MY_TIMELINE_MINOR } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { thingAnswerFor, thingPageFor } from './older-apps';

const page = {
  id: 'connection:con_findmy01',
  kind: 'connection',
  name: 'Find My',
  tabs: [
    { key: 'findmy', label: 'Find My', server: 'studio', panels: [] },
    { key: FIND_MY_TIMELINE_TAB, label: 'Timeline', server: 'studio', panels: [] },
    { key: 'overview', label: 'Summary', panels: [] },
  ],
} as unknown as ThingPage;

const keys = (p: unknown) => (p as ThingPage).tabs.map((t) => t.key);

describe('a thing’s page for an older app', () => {
  it('leaves the Timeline out below minor 5, keeps Find My and opens on the Summary', () => {
    expect(keys(thingAnswerFor('things.page', page, FIND_MY_TIMELINE_MINOR - 1))).toEqual([
      'overview',
      'findmy',
    ]);
  });

  it('is whole from minor 5 on, outside a session and for other ops', () => {
    expect(thingPageFor(page, FIND_MY_TIMELINE_MINOR)).toBe(page);
    expect(thingPageFor(page, undefined)).toBe(page);
    expect(thingAnswerFor('things.quiet', page, 0)).toBe(page);
  });
});
