/**
 * What Whombat sees of a thing itself, whatever is quiet about it: what ends an outage and settles a watch waiting for a
 * return. An offline server whose look went (its alert quiet, or held back by its offline parent) is still down; a
 * check made before a hold ended says nothing; a fleet that wasn't read says nothing; a thing no longer there is gone.
 */
import type { HostServer } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { DeskFleet } from '../desk/glance';
import { type LiveLooks, observedOf, type RawFacts, rawSeen } from './looks';

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
  return { burrow: {} as LiveLooks['burrow'], thingList: [], fleet, serversRead, looks: [] };
}

function facts(more: Partial<RawFacts> = {}): RawFacts {
  return { connections: new Map(), devices: new Map(), held: new Set(), heldUntil: new Map(), ...more };
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
