/**
 * What Whombat sees of a thing itself, whatever is quiet about it: what ends an outage and settles a watch waiting for a
 * return. An offline server whose look went (its alert quiet, or held back by its offline parent) is still down, and one
 * whose critical alert the person ignored still has it; a check made before a hold ended says nothing; a fleet that
 * wasn't read, or a server still being added, says nothing; the person's accounts are read from their own records; a
 * thing no longer there is gone.
 */
import type { HostAlert, HostServer } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { type DeskFleet, deskFleetOf } from '../desk/glance';
import { type LiveLooks, observedOf, type RawFacts, rawSeen, unreadChecks } from './looks';
import { seenOf } from './watch';

const NOW = new Date('2026-11-25T10:00:00Z');
const MIN = 60_000;
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * MIN);

function live(servers: Record<string, HostServer['status']> | null, serversRead = true): LiveLooks {
  const fleet: DeskFleet | null = servers
    ? {
        cards: [],
        rows: new Map(Object.entries(servers).map(([id, status]) => [id, { id, status } as HostServer])),
      }
    : null;
  return {
    burrow: {} as LiveLooks['burrow'],
    person: {} as LiveLooks['person'],
    thingList: [],
    fleet,
    serversRead,
    looks: [],
  };
}

function facts(more: Partial<RawFacts> = {}): RawFacts {
  return {
    connections: new Map(),
    accounts: new Map(),
    devices: new Map(),
    held: new Set(),
    heldUntil: new Map(),
    ...more,
  };
}

const connection = (glance: object | null, at: Date | null = ago(1), status = 'active') =>
  new Map([['connection:plex', { status, glance, glanceAt: at }]]);

describe('a server itself', () => {
  it('is down while offline, also with no look; unread when the fleet wasn’t read; gone when it isn’t listed', () => {
    const seen = (l: LiveLooks, more?: Partial<RawFacts>) => rawSeen(l, 'server:nas', facts(more), NOW);
    expect(seen(live({ nas: 'offline' }))).toBe('down');
    expect(seen(live({ nas: 'ok' }))).toBe('fine');
    expect(seen(live({ nas: 'bad' }))).toBe('fine');
    expect(seen(live({ nas: 'offline' }, false))).toBe('unread');
    expect(seen(live(null))).toBe('unread');
    expect(seen(live({ other: 'ok' }))).toBe('gone');
    expect(seen(live({ nas: 'ok' }), { held: new Set(['server:nas']) })).toBe('held');
  });

  it('still has a critical alert the person ignored or snoozed; says nothing while it is being added', () => {
    const server = (id: string, status: HostServer['status']) =>
      ({ id, name: id, status, memory: {}, storage: {} }) as HostServer;
    const alert = (rule: string, more: Partial<HostAlert> = {}): HostAlert => ({
      id: `al_${rule}`,
      serverId: 'nas',
      severity: 'critical',
      title: 'A disk is failing',
      detail: '',
      openedAt: NOW.toISOString(),
      rule,
      state: 'open',
      attention: false,
      acknowledged: { at: NOW.toISOString(), by: 'mara', note: '', until: null },
      ...more,
    });
    const read = (servers: HostServer[], alerts: HostAlert[]) =>
      rawSeen({ ...live({}), fleet: deskFleetOf(servers, alerts) }, `server:${servers[0]?.id}`, facts(), NOW);
    // Ignored: its look went with it, yet the disk is still failing.
    expect(read([server('nas', 'ok')], [alert('disk.smart_failing')])).toBe('answering');
    expect(read([server('nas', 'ok')], [alert('disk.smart_failing', { state: 'resolved' })])).toBe('fine');
    expect(read([server('nas', 'ok')], [alert('disk.wear_high', { severity: 'warning' })])).toBe('fine');
    // A check's alert is its connection's.
    expect(read([server('nas', 'ok')], [alert('check.down')])).toBe('fine');
    expect(read([server('new-box', 'pending')], [])).toBe('unread');
    expect(read([server('nas', 'offline')], [])).toBe('down');
  });
});

describe('a connection itself', () => {
  const seen = (more: Partial<RawFacts>) => rawSeen(live({}), 'connection:plex', facts(more), NOW);

  it('reads its last check’s outcome and lines, not what they came to', () => {
    const line = { check: 'conn.answers', tone: 'bad', nature: 'problem', title: 'Not answering' } as const;
    expect(seen({ connections: connection({ status: 'ok', outcome: 'offline', facts: [] }) })).toBe('down');
    expect(
      seen({
        connections: connection({ status: 'ok', facts: [], lines: [{ ...line, offline: true, seen: 1 }] }),
      }),
    ).toBe('down');
    expect(seen({ connections: connection({ status: 'ok', facts: [], lines: [line] }) })).toBe('answering');
    expect(
      seen({ connections: connection({ status: 'warn', outcome: 'error', facts: [], lines: [] }) }),
    ).toBe('answering');
    expect(seen({ connections: connection({ status: 'bad', facts: [] }, ago(1), 'needs_reauth') })).toBe(
      'answering',
    );
    expect(seen({ connections: connection({ status: 'ok', facts: [], lines: [] }) })).toBe('fine');
  });

  it('says nothing from a check made before a hold ended, nor one that couldn’t run', () => {
    const fine = connection({ status: 'ok', facts: [], lines: [] }, ago(10));
    expect(seen({ connections: fine, heldUntil: new Map([['connection:plex', ago(5)]]) })).toBe('unread');
    expect(seen({ connections: fine, heldUntil: new Map([['connection:plex', ago(15)]]) })).toBe('fine');
    expect(seen({ connections: connection({ status: 'unknown', facts: [] }) })).toBe('unread');
    expect(seen({ connections: connection(null, null) })).toBe('unread');
    expect(seen({ connections: fine, held: new Set(['connection:plex']) })).toBe('held');
    expect(seen({})).toBe('gone');
    // Held says nothing of whether it is still there.
    expect(seen({ held: new Set(['connection:plex']) })).toBe('held');
  });

  it('reads the person’s accounts from their own records, not as removed', () => {
    const account = (state: 'fine' | 'signed_out' | 'unread') => ({
      accounts: new Map([['connection:plex', state] as const]),
    });
    expect(seen(account('fine'))).toBe('fine');
    // Needing a new sign-in, it still answers: its incident stays open, a watch for its return is settled.
    expect(seen(account('signed_out'))).toBe('answering');
    expect(seen(account('unread'))).toBe('unread');
    expect(seen({ ...account('signed_out'), held: new Set(['connection:plex']) })).toBe('held');
  });

  it('knows which of an incident’s checks its last check didn’t read', () => {
    const at = ago(1);
    const glance = (more: object = {}) => ({
      glance: { status: 'ok', facts: [], lines: [], ...more },
      glanceAt: at,
    });
    const checks = ['conn.answers', 'plex.library'];
    // It answered and its details couldn't be read: the kind's own checks weren't read.
    expect([...unreadChecks(glance({ readFailedSince: ago(30).toISOString() }), [], checks)]).toEqual([
      'plex.library',
    ]);
    // A line kept from an earlier pass wasn't read on this one; one renewed now was.
    expect([...unreadChecks(glance(), [{ checkId: 'plex.library', lastSeen: ago(6) }], checks)]).toEqual([
      'plex.library',
    ]);
    expect([...unreadChecks(glance(), [{ checkId: 'plex.library', lastSeen: at }], checks)]).toEqual([]);
    expect([...unreadChecks(glance(), [], checks)]).toEqual([]);
    // Seen fine while a check of its incident wasn't read counts neither way.
    expect(seenOf('fine', true)).toBe('unread');
    expect(seenOf('fine', false)).toBe('fine');
    expect(seenOf('answering', true)).toBe('bad');
  });
});

describe('a device itself', () => {
  it('is down while its reads fail, fine with a fresh read after any hold', () => {
    const device = (lastReadAt: Date | null, lastReadError: string | null) =>
      new Map([['device:con_1', { lastReadAt, lastReadError }]]);
    const seen = (more: Partial<RawFacts>) => rawSeen(live({}), 'device:con_1', facts(more), NOW);
    expect(seen({ devices: device(ago(30), 'timeout') })).toBe('down');
    expect(seen({ devices: device(ago(1), null) })).toBe('fine');
    expect(seen({ devices: device(ago(60), null) })).toBe('unread');
    expect(seen({ devices: device(ago(3), null), heldUntil: new Map([['device:con_1', ago(2)]]) })).toBe(
      'unread',
    );
    expect(seen({})).toBe('gone');
  });
});

it('counts a thing with a critical line as answering for someone waiting for it', () => {
  expect(observedOf('bad')).toBe('up');
  expect(observedOf('offline')).toBe('down');
  expect(observedOf('unknown')).toBe('unknown');
});
