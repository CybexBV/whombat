import { ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { CatalogConnectionRow } from '../../../connections/types';
import { slotProblems } from '../slots';
import {
  ACCESS_CHECKS,
  type AccessCtx,
  type AccessSnapshot,
  type AccessWeek,
  accessData,
  accessKpis,
  accessNotices,
  accessSkipped,
  accessUrl,
  accessView,
  doorButton,
  howWords,
  openingItems,
  openSinceOf,
  parseDevices,
  parseDoors,
  parseOpenings,
  parseUsers,
  ruleWords,
} from './access';
import { ACCESS_devices, ACCESS_doors, ACCESS_logs, ACCESS_rules, ACCESS_users } from './fixtures/access';

const NOW = new Date('2026-10-21T20:00:00Z');
const A2 = '0ed545f8-2fcd-4839-9021-b39e707f6aa9';
const TZ = 'Europe/Amsterdam';
const ROW = {
  id: 'con_access',
  access: 'manage',
  label: 'UniFi Access',
  catalogId: 'unifi_access',
  fields: { url: 'https://192.168.1.1:12445' },
  baseUrl: 'https://192.168.1.1:12445',
} as unknown as CatalogConnectionRow;

function snapshot(devices: unknown = ACCESS_devices): AccessSnapshot {
  const rules = new Map(Object.entries(ACCESS_rules).map(([id, r]) => [id, accessData(r)]));
  return {
    readAt: NOW,
    doors: parseDoors(accessData(ACCESS_doors), rules),
    devices: parseDevices(accessData(devices)),
    openings: parseOpenings(accessData(ACCESS_logs)),
    moreOpenings: false,
    openingsTotal: 2,
  };
}

const week = (over: Partial<AccessWeek> = {}): AccessWeek => ({
  days: [4, 6, 3, 8, 5, 7],
  before: 25,
  openings: [
    ...parseOpenings(accessData(ACCESS_logs)),
    {
      id: 'w1',
      at: new Date(NOW.getTime() - 86_400_000),
      door: 'Main Door',
      who: 'Sam Jansen',
      how: 'app',
      granted: true,
    },
    {
      id: 'w2',
      at: new Date(NOW.getTime() - 2 * 86_400_000),
      door: 'A2 Door',
      who: 'Sam Jansen',
      how: 'app',
      granted: true,
    },
  ],
  moreOpenings: false,
  users: parseUsers(ACCESS_users, NOW),
  ...over,
});

const ctx = (over: Partial<AccessCtx> = {}): AccessCtx => ({
  now: NOW,
  timeZone: TZ,
  openSince: new Map(),
  ...over,
});

describe('UniFi Access', () => {
  it('reads doors with their rules, devices and today’s openings', () => {
    const s = snapshot();
    expect(s.doors.map((d) => [d.name, d.locked, d.open, d.rule?.type])).toEqual([
      ['A2 Door', false, true, 'keep_unlock'],
      ['Door 3855', true, false, 'custom'],
      ['Main Door', true, null, 'keep_lock'],
    ]);
    expect(s.devices?.map((d) => d.online)).toEqual([null, null, null]);
    expect(s.openings?.map((o) => [o.door, o.who, o.how, o.granted])).toEqual([
      ['Main Door', 'Anna de Vries', 'PIN', true],
      ['Door 3855', null, 'card', false],
    ]);
  });

  it('refuses an answer that isn’t SUCCESS, even with status 200', () => {
    expect(() => accessData({ code: 'CODE_UNAUTHORIZED', msg: 'unauthorized', data: null })).toThrow(
      /permission/,
    );
    expect(() => accessData({ code: 'CODE_SYSTEM_ERROR' })).toThrow(/error/);
  });

  it('words lock rules and ways in', () => {
    const [a2, d3855, main] = snapshot().doors;
    expect(ruleWords(a2 as never, NOW, TZ)).toBe('Kept unlocked');
    expect(ruleWords(d3855 as never, NOW, TZ)).toBe('Unlocked until 23:00');
    expect(ruleWords(main as never, NOW, TZ)).toBe('Kept locked');
    expect(howWords('REMOTE_THROUGH_UAH')).toBe('remotely');
    expect(howWords('SOMETHING_NEW')).toBe('something new');
  });

  it('gives the figures, the readers’ online count only when the answer says it', () => {
    expect(accessKpis(snapshot()).map((k) => [k.key, k.value, k.rest ?? null])).toEqual([
      ['doors', '2', 'locked'],
      ['readers', '2', null],
      ['openings', '1', null],
      ['unlocked', '1', null],
    ]);
    const known = {
      code: 'SUCCESS',
      data: [
        [
          { id: 'a', name: 'R1', type: 'UA-G2-PRO', online: true },
          { id: 'b', name: 'R2', type: 'UA-G2-PRO', online: false },
        ],
      ],
    };
    const k = accessKpis(snapshot(known)).find((x) => x.key === 'readers');
    expect([k?.value, k?.rest, k?.tone]).toEqual(['1', 'of 2', 'warn']);
    expect(accessNotices(snapshot(known), ctx()).map((n) => n.id)).toContain('offline-b');
  });

  it('notices a door open over 10 minutes and one kept unlocked', () => {
    const s = snapshot();
    expect(accessNotices(s, ctx()).map((n) => n.id)).toEqual(['held-0ed545f8-2fcd-4839-9021-b39e707f6aa9']);
    const since = (min: number) =>
      ctx({ openSince: new Map([[A2, new Date(NOW.getTime() - min * 60_000)]]) });
    // Ten minutes is two health passes: a door held for a delivery isn't worth a look yet (QN-04).
    expect(accessNotices(s, since(10)).map((n) => n.check)).toEqual(['access.door_unlocked']);
    const open = accessNotices(s, since(15));
    expect(open[0]?.id).toBe('open-0ed545f8-2fcd-4839-9021-b39e707f6aa9');
    expect(open[0]?.detail).toContain('21:45');
    // Since when Whombat has seen it open: kept while it stays open.
    const first = openSinceOf('con_t', s);
    expect(first.get('0ed545f8-2fcd-4839-9021-b39e707f6aa9')).toEqual(NOW);
  });

  it('offers Back to schedule on a door held open, else Unlock, confirmed', () => {
    const b = { row: ROW };
    const [a2, d3855, main] = snapshot().doors;
    expect(doorButton(a2 as never, b)).toMatchObject({
      action: 'schedule',
      target: '0ed545f8-2fcd-4839-9021-b39e707f6aa9',
    });
    expect(doorButton(d3855 as never, b).action).toBe('schedule');
    expect(doorButton(main as never, b)).toMatchObject({ action: 'unlock', allowed: true });
    expect(doorButton(main as never, b).confirm).toBeDefined();
  });

  it('names who opened a door', () => {
    expect(openingItems(snapshot())[0]?.detail).toBe('Anna de Vries · PIN');
    expect(openingItems(snapshot())[1]).toMatchObject({ tone: 'warn', detail: 'Refused · card' });
  });

  it('says what each line is, which door or reader, and how Ignore ends (QN-01…QN-04)', () => {
    const known = {
      code: 'SUCCESS',
      data: [
        [
          { id: 'a', name: 'R1', type: 'UA-G2-PRO', online: true },
          { id: 'b', name: 'Garage reader', type: 'UA-G2-PRO', online: false },
        ],
      ],
    };
    const lines = accessNotices(
      snapshot(known),
      ctx({ openSince: new Map([[A2, new Date(NOW.getTime() - 20 * 60_000)]]) }),
    );
    expect(lines.map((n) => [n.check, n.nature, n.subject?.id, n.ignore?.lifts, n.confirm ?? null])).toEqual([
      ['access.door_open', 'you', `door:${A2}`, 'fixed', null],
      ['access.reader_offline', 'problem', 'reader:b', 'fixed', 2],
      ['access.door_unlocked', 'you', `door:${A2}`, 'fixed', null],
    ]);
    // Only a problem asks the assistant; a door is the person's (its row has the button).
    expect(lines.map((n) => n.link?.kind ?? null)).toEqual([null, 'ask', null]);
    expect(lines[0]?.ignore?.words).toBe('Until it’s closed.');
    expect(lines[1]?.subject?.name).toBe('Garage reader');
    // The head comes from the lines now: no “Needs a look” of its own.
    expect(accessView(snapshot(known), ctx(), { row: ROW }).status).toBeUndefined();
  });

  it('one line per reader, the rest past three on one line whose episode is their ids', () => {
    const many = {
      code: 'SUCCESS',
      data: [
        Array.from({ length: 11 }, (_, i) => ({
          id: `r${i}`,
          name: `Reader ${i}`,
          type: 'UA-G2',
          online: false,
        })),
      ],
    };
    const lines = accessNotices(snapshot(many), ctx()).filter((n) => n.check === 'access.reader_offline');
    expect(lines).toHaveLength(3);
    const more = lines[2];
    expect(more).toMatchObject({ title: '9 more readers offline', subject: { id: '+more' } });
    expect(more?.ignore?.lifts).toBe('newer');
    expect(more?.episode).toMatch(/^[0-9a-f]{8}$/);
  });

  it('leaves out of lifting what it couldn’t read (QN-S21)', () => {
    expect(accessSkipped(snapshot())).toEqual([]);
    expect(accessSkipped({ ...snapshot(), devices: null, rulesUnread: true })).toEqual([
      'access.reader_offline',
      'access.door_unlocked',
    ]);
    expect(ACCESS_CHECKS.map((c) => c.check)).toEqual([
      'access.door_open',
      'access.reader_offline',
      'access.door_unlocked',
    ]);
  });

  it('builds its Summary in slots: the doors with their buttons, In Access, the week, who came in', () => {
    const view = accessView(snapshot(), ctx(), { row: ROW }, week());
    expect(slotProblems(view)).toEqual([]);
    expect(view.kpis).toEqual([]);
    for (const p of view.panels) expect(ThingPagePanel.safeParse(p).success).toBe(true);
    expect(view.panels.map((p) => p.id)).toEqual(['doors', 'inventory', 'week', 'people', 'today']);

    const doors = view.panels[0];
    if (doors?.kind !== 'list') throw new Error('Doors is a list');
    expect(doors.meta).toBe('1 of 3 unlocked');
    // Held open first, with Back to schedule; no door is a desk figure.
    expect(doors.items.map((i) => [i.title, i.right, i.actions?.[0]?.action, i.tone ?? null])).toEqual([
      ['A2 Door', 'Unlocked', 'schedule', 'warn'],
      ['Door 3855', 'Locked', 'schedule', 'warn'],
      ['Main Door', 'Locked', 'unlock', null],
    ]);
    expect(doors.items.every((i) => !i.figure)).toBe(true);
    expect(doors.items[0]?.detail).toBe('Open · Kept unlocked');

    const inv = view.panels[1];
    if (inv?.kind !== 'list') throw new Error('In Access is a list');
    expect(inv.items.map((i) => [i.title, i.figure?.value, i.figure?.note ?? null])).toEqual([
      ['Doors', '3', '1 unlocked'],
      ['Readers', '2', null],
      ['Openings today', '1', '1 refused'],
      ['People', '2', '+1 this week'],
    ]);

    const trend = view.panels[2];
    if (trend?.kind !== 'chart') throw new Error('This week is a chart');
    expect(trend.series[0]?.values).toEqual([4, 6, 3, 8, 5, 7, 2]);
    expect(trend.figure?.value).toBe('35');
    expect(trend.stats?.[0]?.[0]?.text).toBe('+40 %');

    const who = view.panels[3];
    if (who?.kind !== 'bars') throw new Error('Who came in is bars');
    expect(who.meta).toBe('this week');
    expect(who.items.map((i) => [i.label, i.value, i.note])).toEqual([
      ['Sam Jansen', '2 times', 'Main Door · app'],
      ['Anna de Vries', '1 time', 'Main Door · PIN'],
    ]);
    expect(view.panels[4]).toMatchObject({ kind: 'list', place: 'main', title: 'Today' });
    expect(view.verdict).toBe('UniFi Access is fine: 1 of 3 doors are unlocked.');
    expect(accessUrl(ROW)).toBe('https://192.168.1.1/access/');
  });

  it('without the week: who came in today, no Trend, no People line', () => {
    const view = accessView(snapshot(), ctx(), { row: ROW }, null);
    expect(slotProblems(view)).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['doors', 'inventory', 'people', 'today']);
    expect(view.panels[2]).toMatchObject({ meta: 'today' });
    // The week before is left out until every day of this week was read.
    const partial = accessView(snapshot(), ctx(), { row: ROW }, week({ days: [null, null, null, 2, 5, 7] }));
    const t = partial.panels.find((p) => p.id === 'week');
    expect(t?.kind === 'chart' && t.stats).toBeUndefined();
  });

  it('counts people in Access: active ones and who came this week', () => {
    expect(parseUsers(ACCESS_users, NOW)).toEqual({ active: 2, added: 1, all: 3 });
    expect(() => parseUsers({ code: 'CODE_UNAUTHORIZED' }, NOW)).toThrow();
  });
});
