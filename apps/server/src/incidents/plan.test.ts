/**
 * Incidents and their push (monitoring.md MON-06): opened after two passes in a row, ended after two without, amber never;
 * one push after 10 minutes for what opened together, never for what something else took down, nor past the caps.
 */
import { describe, expect, it } from 'vitest';
import type { DeskLook } from '../desk/shapes';
import {
  incidentPushText,
  type OpenIncident,
  PUSH_AFTER_MS,
  PUSHES_PER_DAY,
  PUSHES_PER_THING,
  type PushCandidate,
  planIncidents,
  planPush,
  type SeenLook,
} from './plan';
import { seenLookOf } from './watch';

const T0 = new Date('2026-11-24T14:00:00Z');
const MIN = 60_000;
const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN);

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

  it('ends one after two passes without it, at the first of them', () => {
    const open = [incident('connection:plex')];
    const once = planIncidents({
      looks: [],
      open,
      before: { at: at(5), things: new Set(['connection:plex']) },
      serversRead: true,
      now: at(6),
    });
    expect(once.ended).toEqual([]);
    const twice = planIncidents({ looks: [], open, before: once.seen, serversRead: true, now: at(7) });
    expect(twice.ended).toEqual([{ id: open[0]?.id, endedAt: at(6) }]);
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
