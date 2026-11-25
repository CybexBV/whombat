/**
 * Incidents and their push: opened after two passes in a row, ended after two without, amber never;
 * one push after 10 minutes for what opened together, never for what something else took down, nor past the caps.
 */
import { describe, expect, it } from 'vitest';
import type { DeskLook } from '../desk/shapes';
import {
  incidentPushText,
  type OpenIncident,
  type PassBefore,
  PUSH_AFTER_MS,
  PUSH_MAX,
  PUSHES_PER_DAY,
  PUSHES_PER_THING,
  type PushCandidate,
  planIncidents,
  planPush,
  type SeenLook,
  type ThingSeen,
} from './plan';
import { seenLookOf } from './watch';

const T0 = new Date('2026-11-24T14:00:00Z');
const MIN = 60_000;
const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN);
/** What Whombat saw of things themselves on a pass. */
const seenAs = (state: ThingSeen, ...things: string[]) => new Map(things.map((t) => [t, state] as const));

function look(thing: string, more: Partial<SeenLook> = {}): SeenLook {
  return {
    thing,
    kind: thing.startsWith('server:') ? 'server' : 'connection',
    name: thing.split(':')[1] ?? thing,
    nature: 'down',
    words: 'Not answering',
    check: null,
    subject: '',
    cause: null,
    since: null,
    ...more,
  };
}

function incident(thing: string, more: Partial<OpenIncident> = {}): OpenIncident {
  return {
    id: `inc_${thing.replace(/\W/g, '')}`,
    thing,
    kind: 'connection',
    name: thing.split(':')[1] ?? thing,
    nature: 'down',
    words: 'Not answering',
    startedAt: T0,
    cause: null,
    pushedAt: null,
    ...more,
  };
}

describe('incidents from the looks', () => {
  it('opens one only on the second pass in a row, from the first', () => {
    const plex = look('connection:plex');
    const first = planIncidents({ looks: [plex], open: [], before: null, serversRead: true, now: at(0) });
    expect(first.opened).toEqual([]);
    const second = planIncidents({
      looks: [plex],
      open: [],
      before: first.seen,
      serversRead: true,
      now: at(1),
    });
    expect(second.opened.map((o) => [o.thing, o.startedAt])).toEqual([['connection:plex', at(0)]]);
    // Seen once and gone again: nothing opens.
    const blip = planIncidents({ looks: [], open: [], before: first.seen, serversRead: true, now: at(1) });
    expect(blip.opened).toEqual([]);
  });

  it('starts it when Whombat knows the trouble began, if earlier', () => {
    const before = { at: at(0), things: new Set(['server:pve-02']) };
    const plan = planIncidents({
      looks: [look('server:pve-02', { since: at(-30) })],
      open: [],
      before,
      serversRead: true,
      now: at(1),
    });
    expect(plan.opened[0]?.startedAt).toEqual(at(-30));
  });

  it('ends one after two passes that saw it fine, at the first of them', () => {
    const open = [incident('connection:plex')];
    const seen = seenAs('fine', 'connection:plex');
    const once = planIncidents({
      looks: [],
      open,
      before: { at: at(5), things: new Set(['connection:plex']) },
      serversRead: true,
      seen,
      now: at(6),
    });
    expect(once.ended).toEqual([]);
    const twice = planIncidents({ looks: [], open, before: once.seen, serversRead: true, seen, now: at(7) });
    expect(twice.ended).toEqual([{ id: open[0]?.id, endedAt: at(6) }]);
    // Without a look and without word of the thing itself, nothing ends.
    const unread = planIncidents({ looks: [], open, before: once.seen, serversRead: true, now: at(7) });
    expect(unread.ended).toEqual([]);
  });

  it('keeps one open while its thing is still bad underneath, and ends it only after two passes seen fine', () => {
    // Plex's down line ignored, or Plex held quiet: it leaves the looks, but it hasn't come back.
    const open = [incident('connection:plex')];
    let before: PassBefore = { at: at(5), things: new Set(['connection:plex']) };
    for (const minute of [6, 7, 8]) {
      const held = planIncidents({
        looks: [],
        open,
        before,
        serversRead: true,
        seen: seenAs('bad', 'connection:plex'),
        now: at(minute),
      });
      expect(held.ended).toEqual([]);
      before = held.seen;
    }
    const seen = seenAs('fine', 'connection:plex');
    const fine = planIncidents({ looks: [], open, before, serversRead: true, seen, now: at(9) });
    expect(fine.ended).toEqual([]);
    // Bad again in between: the count starts over.
    const relapse = planIncidents({
      looks: [],
      open,
      before: fine.seen,
      serversRead: true,
      seen: seenAs('bad', 'connection:plex'),
      now: at(10),
    });
    const again = planIncidents({
      looks: [],
      open,
      before: relapse.seen,
      serversRead: true,
      seen,
      now: at(11),
    });
    expect(again.ended).toEqual([]);
    const twice = planIncidents({
      looks: [],
      open,
      before: again.seen,
      serversRead: true,
      seen,
      now: at(12),
    });
    expect(twice.ended).toEqual([{ id: open[0]?.id, endedAt: at(11) }]);
  });

  it('counts a pass that couldn’t read the thing neither way', () => {
    const open = [incident('server:pve-02', { kind: 'server' })];
    const fine = seenAs('fine', 'server:pve-02');
    const first = planIncidents({
      looks: [],
      open,
      before: { at: at(5), things: new Set(['server:pve-02']) },
      serversRead: true,
      seen: fine,
      now: at(6),
    });
    // The fleet couldn't be read: the fine pass before still counts, and the end is dated at it.
    const unread = planIncidents({
      looks: [],
      open,
      before: first.seen,
      serversRead: false,
      seen: seenAs('unread', 'server:pve-02'),
      now: at(7),
    });
    expect(unread.ended).toEqual([]);
    const healthy = planIncidents({
      looks: [],
      open,
      before: unread.seen,
      serversRead: true,
      seen: fine,
      now: at(8),
    });
    expect(healthy.ended).toEqual([{ id: open[0]?.id, endedAt: at(6) }]);
    // Bad, unread, bad: still bad, nothing ends.
    const bad = { at: at(5), things: new Set(['server:pve-02']) };
    const gap = planIncidents({ looks: [], open, before: bad, serversRead: false, now: at(6) });
    const after = planIncidents({
      looks: [],
      open,
      before: gap.seen,
      serversRead: true,
      seen: fine,
      now: at(7),
    });
    expect(after.ended).toEqual([]);
  });

  it('opens one from the first pass that saw it, also when a pass in between couldn’t read it', () => {
    const nas = look('server:nas');
    const unread = planIncidents({
      looks: [],
      open: [],
      before: { at: at(1), things: new Set(['server:nas']) },
      serversRead: false,
      now: at(2),
    });
    expect(unread.opened).toEqual([]);
    const again = planIncidents({
      looks: [nas],
      open: [],
      before: unread.seen,
      serversRead: true,
      now: at(3),
    });
    expect(again.opened.map((o) => o.startedAt)).toEqual([at(1)]);
  });

  it('ends one whose thing was removed at once, as removed', () => {
    const open = [incident('connection:plex')];
    const plan = planIncidents({
      looks: [],
      open,
      before: { at: at(5), things: new Set(['connection:plex']) },
      serversRead: true,
      seen: seenAs('gone', 'connection:plex'),
      now: at(6),
    });
    expect(plan.ended).toEqual([{ id: open[0]?.id, endedAt: at(6), removed: true }]);
  });

  it('notes each bad check that begins counting on an open incident once', () => {
    const open = [incident('server:nas', { kind: 'server', nature: 'problem', checks: ['host.disk'] })];
    const problems = [
      { check: 'host.disk', words: 'A disk is failing' },
      { check: 'host.ups', words: 'The UPS battery is low' },
    ];
    const plan = planIncidents({
      looks: [look('server:nas', { nature: 'problem', check: 'host.disk', problems })],
      open,
      before: { at: at(5), things: new Set(['server:nas']) },
      serversRead: true,
      now: at(6),
    });
    expect(plan.noted).toEqual([{ id: open[0]?.id, check: 'host.ups', words: 'The UPS battery is low' }]);
    // Once signed, it is known; what something else took down notes nothing.
    const known = planIncidents({
      looks: [look('server:nas', { nature: 'problem', problems })],
      open: [{ ...open[0], checks: ['host.disk', 'host.ups'] } as OpenIncident],
      before: { at: at(6), things: new Set(['server:nas']) },
      serversRead: true,
      now: at(7),
    });
    expect(known.noted).toEqual([]);
    const caused = planIncidents({
      looks: [look('connection:plex', { cause: { thing: 'server:nas', name: 'NAS' }, problems })],
      open: [incident('connection:plex', { checks: [] })],
      before: { at: at(6), things: new Set(['connection:plex']) },
      serversRead: true,
      now: at(7),
    });
    expect(caused.noted).toEqual([]);
  });

  it('opens what the first pass after a start already saw as told, on a Whombat with no incidents yet', () => {
    const plex = look('connection:plex');
    const first = planIncidents({ looks: [plex], open: [], before: null, serversRead: true, now: at(0) });
    expect(first.seen.first).toBe(true);
    const inherited = planIncidents({
      looks: [plex],
      open: [],
      before: first.seen,
      serversRead: true,
      noneYet: true,
      now: at(1),
    });
    expect(inherited.opened[0]?.pushed).toBe(true);
    // With incidents kept already, or seen first on a later pass, it is news.
    const kept = planIncidents({
      looks: [plex],
      open: [],
      before: first.seen,
      serversRead: true,
      now: at(1),
    });
    expect(kept.opened[0]?.pushed).toBeUndefined();
    const later = planIncidents({ looks: [], open: [], before: first.seen, serversRead: true, now: at(1) });
    const news = planIncidents({
      looks: [plex],
      open: [],
      before: { ...later.seen, things: new Set(['connection:plex']) },
      serversRead: true,
      noneYet: true,
      now: at(2),
    });
    expect(news.opened.map((o) => [o.thing, o.pushed])).toEqual([['connection:plex', undefined]]);
  });

  it('knows nothing of a server whose cards weren’t read', () => {
    const open = [incident('server:pve-02', { kind: 'server' })];
    const plan = planIncidents({
      looks: [],
      open,
      before: { at: at(5), things: new Set() },
      serversRead: false,
      now: at(6),
    });
    expect(plan.ended).toEqual([]);
    // What the pass before saw of servers carries over.
    const kept = planIncidents({
      looks: [],
      open: [],
      before: { at: at(5), things: new Set(['server:nas']) },
      serversRead: false,
      now: at(6),
    });
    expect([...kept.seen.things]).toEqual(['server:nas']);
  });

  it('makes a problem that goes down a down one, and learns a cause', () => {
    const plan = planIncidents({
      looks: [
        look('connection:plex', { nature: 'down', words: 'Not answering' }),
        look('connection:ha', { nature: 'down', cause: { thing: 'server:pve-02', name: 'pve-02' } }),
      ],
      open: [
        incident('connection:plex', { nature: 'problem', words: 'A library is missing' }),
        incident('connection:ha'),
      ],
      before: { at: at(5), things: new Set(['connection:plex', 'connection:ha']) },
      serversRead: true,
      now: at(6),
    });
    expect(plan.changed.map((c) => [c.id, c.nature, c.worse, c.cause?.name ?? null])).toEqual([
      ['inc_connectionplex', 'down', true, null],
      ['inc_connectionha', 'down', false, 'pve-02'],
    ]);
    expect(plan.changed[0]?.downSince).toBe(at(6).toISOString());
  });

  it('uses the server’s known offline time when it went down during a problem', () => {
    const server = 'server:pve-02';
    const plan = planIncidents({
      looks: [look(server, { since: at(48) })],
      open: [incident(server, { kind: 'server', nature: 'problem' })],
      before: null,
      serversRead: true,
      now: at(50),
    });
    expect(plan.changed[0]?.downSince).toBe(at(48).toISOString());
  });

  it('weighs a desk look: amber opens nothing, its cause comes along', () => {
    const base: DeskLook = { key: 'connection:plex', kind: 'connection', name: 'Plex', state: 'look' };
    expect(seenLookOf(base, null)).toBeNull();
    expect(seenLookOf({ ...base, state: 'bad', reason: 'A disk is failing' }, null)).toMatchObject({
      nature: 'problem',
      words: 'A disk is failing',
    });
    expect(
      seenLookOf({ ...base, state: 'down', causedBy: { thing: 'server:pve-02', name: 'pve-02' } }, null),
    ).toMatchObject({ nature: 'down', cause: { thing: 'server:pve-02' } });
  });
});

describe('the push', () => {
  const candidate = (thing: string, more: Partial<PushCandidate> = {}): PushCandidate => ({
    ...incident(thing),
    findingPushed: false,
    ...more,
  });
  const push = (open: PushCandidate[], now: Date, pushedToday = 0, of = new Map<string, number>()) =>
    planPush({ open, now, pushedToday, pushedTodayOf: of });

  it('waits 10 minutes, then names together what started within a few minutes', () => {
    const open = [
      candidate('connection:plex', { name: 'Plex' }),
      candidate('connection:nas', { name: 'The NAS', startedAt: at(3) }),
      candidate('connection:ha', { name: 'Home Assistant', startedAt: at(9) }),
    ];
    expect(push(open, new Date(T0.getTime() + PUSH_AFTER_MS - 1))).toEqual([]);
    expect(push(open, at(10)).map((c) => c.name)).toEqual(['Plex', 'The NAS']);
  });

  it('never pushes what something else took down, what a finding pushed about, or what is stale', () => {
    expect(push([candidate('connection:a', { cause: { thing: 'server:x', name: 'x' } })], at(11))).toEqual(
      [],
    );
    expect(push([candidate('connection:a', { findingPushed: true })], at(11))).toEqual([]);
    expect(push([candidate('connection:a', { pushedAt: at(10) })], at(11))).toEqual([]);
    expect(push([candidate('connection:a')], at(61))).toEqual([]);
  });

  it('counts from when a hold over it ended, when that is later than its start', () => {
    // pve-02 down since a report two hours ago, kept quiet until a minute ago.
    const held = candidate('server:pve-02', { startedAt: at(-120), heldUntil: at(-1) });
    expect(push([held], at(0))).toEqual([]);
    expect(push([held], at(9))).toHaveLength(1);
    expect(push([{ ...held, heldUntil: null }], at(9))).toEqual([]);
    // Down half an hour by its report, held until a minute ago: it waits for a research first.
    const recent = candidate('server:pve-02', { startedAt: at(-30), heldUntil: at(-1) });
    expect(push([recent], at(0))).toEqual([]);
    expect(push([recent], at(70))).toEqual([]);
  });

  it('names at most as many as a push takes', () => {
    const many = Array.from({ length: PUSH_MAX + 1 }, (_, i) =>
      candidate(`connection:c${i}`, { id: `inc_${i}`, name: `C${String(i).padStart(3, '0')}` }),
    );
    const group = push(many, at(11));
    expect(group).toHaveLength(PUSH_MAX);
    expect(incidentPushText(group)).toContain(`and ${PUSH_MAX - 3} more`);
  });

  it('keeps to the day’s cap and a thing’s', () => {
    const open = [candidate('connection:plex')];
    expect(push(open, at(11), PUSHES_PER_DAY)).toEqual([]);
    expect(push(open, at(11), 1, new Map([['connection:plex', PUSHES_PER_THING]]))).toEqual([]);
    expect(push(open, at(11), 1, new Map([['connection:plex', PUSHES_PER_THING - 1]]))).toHaveLength(1);
  });

  it('says it in short, plain words', () => {
    expect(incidentPushText([{ name: 'Plex', nature: 'down', words: 'Not answering' }])).toBe('Plex is down');
    expect(incidentPushText([{ name: 'The NAS', nature: 'problem', words: 'A disk is failing' }])).toBe(
      'The NAS: a disk is failing',
    );
    const three = incidentPushText(
      ['Plex', 'The NAS', 'Home Assistant'].map((name) => ({ name, nature: 'down' as const, words: '' })),
    );
    expect(three).toContain('3 things are down');
    expect(three).toContain('Plex, the NAS and Home Assistant');
    const mixed = incidentPushText([
      { name: 'Plex', nature: 'down', words: '' },
      { name: 'UniFi', nature: 'problem', words: 'Gateway offline' },
    ]);
    expect(mixed.startsWith('2 things')).toBe(true);
    const five = incidentPushText(
      ['A', 'B', 'C', 'D', 'E'].map((name) => ({ name, nature: 'down' as const, words: '' })),
    );
    expect(five).toContain('and 2 more');
  });
});
