/**
 * Tailscale's page from a documented answer (service-dashboards.md SD-42; Tailscale API v2
 * `GET /api/v2/tailnet/-/devices?fields=all`, its OpenAPI example trimmed). Pure.
 */
import { ThingPageKpi, ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { slotProblems } from '../slots';
import { buttonsOf } from './fixtures/row';
import {
  approveButton,
  ownerName,
  parseDevices,
  parseUsers,
  TAILSCALE_CHECKS,
  type TailscaleSnapshot,
  tailscaleCardView,
  tailscaleKpis,
  tailscaleNotices,
  tailscaleRows,
  tailscaleStatus,
  tailscaleView,
} from './tailscale';

const NOW = new Date('2026-10-21T12:00:00Z');

/** `/api/v2/tailnet/-/devices?fields=all` (fields as documented; ids, names and people made up). */
export const TAILSCALE_DEVICES = {
  devices: [
    {
      addresses: ['100.64.74.78', 'fd7a:115c:a1e0::40:4a4e'],
      id: '92960230385',
      nodeId: 'n292kg92CNTRL',
      user: 'anna@example.com',
      name: 'laptop.tail1234.ts.net',
      hostname: 'laptop',
      clientVersion: '1.88.3-t5b1b8e4ab-g6c5d9fd70',
      updateAvailable: true,
      os: 'macOS',
      created: '2026-01-10T09:00:00Z',
      connectedToControl: true,
      keyExpiryDisabled: false,
      expires: '2026-10-24T09:00:00Z',
      authorized: true,
      isExternal: false,
      machineKey: 'mkey:x',
      nodeKey: 'nodekey:x',
      blocksIncomingConnections: false,
      tags: [],
    },
    {
      id: '92960230386',
      nodeId: 'n292kg92CNTRM',
      user: 'tagged-devices',
      name: 'nas.tail1234.ts.net',
      hostname: 'nas',
      clientVersion: '1.90.1-t1234567-g89abcdef',
      updateAvailable: false,
      os: 'linux',
      connectedToControl: true,
      keyExpiryDisabled: true,
      expires: '0001-01-01T00:00:00Z',
      authorized: true,
      isExternal: false,
      tags: ['tag:server'],
    },
    {
      id: '92960230387',
      nodeId: 'n292kg92CNTRN',
      user: 'john@example.com',
      name: 'old-pi.tail1234.ts.net',
      hostname: 'old-pi',
      clientVersion: '1.60.0-t1-g2',
      updateAvailable: true,
      os: 'linux',
      lastSeen: '2026-10-01T08:00:00Z',
      connectedToControl: false,
      keyExpiryDisabled: false,
      expires: '2026-10-15T08:00:00Z',
      authorized: true,
      isExternal: false,
      tags: [],
    },
    {
      id: '92960230388',
      nodeId: 'n292kg92CNTRP',
      user: 'john@example.com',
      name: 'new-phone.tail1234.ts.net',
      hostname: 'new-phone',
      clientVersion: '1.90.1-t1-g2',
      updateAvailable: false,
      os: 'android',
      lastSeen: '2026-10-21T11:58:00Z',
      connectedToControl: false,
      keyExpiryDisabled: false,
      expires: '2027-04-19T11:58:00Z',
      authorized: false,
      isExternal: false,
      tags: [],
    },
    {
      id: '92960230389',
      nodeId: 'n292kg92CNTRQ',
      user: 'friend@example.org',
      name: 'friends-server.other-tailnet.ts.net',
      hostname: 'friends-server',
      clientVersion: '1.80.0',
      updateAvailable: true,
      os: 'linux',
      connectedToControl: true,
      keyExpiryDisabled: false,
      expires: '2026-10-22T00:00:00Z',
      authorized: true,
      isExternal: true,
      tags: [],
    },
  ],
};

const snapshot: TailscaleSnapshot = { readAt: NOW, devices: parseDevices(TAILSCALE_DEVICES, NOW) };
const manager = buttonsOf('tailscale');

describe('parseDevices', () => {
  it('reads names, versions, keys and approval', () => {
    const [laptop, nas, pi, phone, friend] = snapshot.devices;
    expect(laptop).toMatchObject({
      id: 'n292kg92CNTRL',
      name: 'laptop',
      domain: 'tail1234.ts.net',
      version: '1.88.3',
      online: true,
      updateAvailable: true,
    });
    expect(nas).toMatchObject({ user: null, tagged: true, expires: null });
    expect(pi?.online).toBe(false);
    expect(pi?.lastSeen?.toISOString()).toBe('2026-10-01T08:00:00.000Z');
    expect(phone).toMatchObject({ authorized: false });
    expect(friend?.external).toBe(true);
  });

  it('counts a device seen in the last minutes as online without connectedToControl', () => {
    const [d] = parseDevices({ devices: [{ id: '1', name: 'x', lastSeen: '2026-10-21T11:57:00Z' }] }, NOW);
    expect(d?.online).toBe(true);
  });
});

describe('tailscale view', () => {
  it('has four figures without shared-in devices', () => {
    const kpis = tailscaleKpis(snapshot, NOW);
    for (const k of kpis) ThingPageKpi.parse(k);
    expect(kpis.map((k) => [k.key, k.value, k.rest ?? null])).toEqual([
      ['online', '2', 'of 4'],
      ['waiting', '1', null],
      ['keys', '2', 'in 14 days'],
      ['updates', '2', null],
    ]);
    expect(kpis.find((k) => k.key === 'keys')?.tone).toBe('bad');
    expect(kpis.find((k) => k.key === 'waiting')?.tone).toBe('warn');
  });

  it('says what is worth a look, worst first', () => {
    const notices = tailscaleNotices(snapshot, NOW);
    expect(notices.map((n) => [n.id, n.tone])).toEqual([
      ['key-n292kg92CNTRN', 'bad'],
      ['waiting-n292kg92CNTRP', 'warn'],
      ['key-n292kg92CNTRL', 'warn'],
      ['updates', 'info'],
      ['offline-long', 'info'],
    ]);
    expect(notices[0]?.title).toContain('old-pi');
    expect(notices[1]?.title).toContain('new-phone');
    expect(notices[2]?.title).toContain('laptop');
    expect(notices.map((n) => [n.check, n.nature, n.subject?.id.split(':')[0], n.ignore?.lifts])).toEqual([
      ['tailscale.key', 'you', 'device', 'newer'],
      ['tailscale.waiting', 'you', 'device', 'fixed'],
      ['tailscale.key', 'you', 'device', 'newer'],
      ['tailscale.updates', 'fyi', undefined, 'newer'],
      ['tailscale.offline', 'fyi', undefined, 'newer'],
    ]);
    // A renewed key ends later: its end date is the episode.
    expect(notices[2]?.episode).toBe('2026-10-24T09:00:00.000Z');
    for (const n of notices) expect(TAILSCALE_CHECKS.map((c) => c.check)).toContain(n.check);
    // The lines decide warn and bad (QN-S30).
    expect(tailscaleStatus(snapshot).status).toBe('ok');
  });

  it('makes an expired key on a device gone for a month a heads-up', () => {
    const later = new Date('2026-11-15T12:00:00Z');
    const pi = tailscaleNotices(snapshot, later).find((n) => n.title.includes('old-pi'));
    expect(pi).toMatchObject({ nature: 'fyi', tone: 'info', check: 'tailscale.key' });
    expect(pi?.badge).toBeUndefined();
  });

  it('shows each device’s owner, waiting devices first', () => {
    const forManager = tailscaleRows(snapshot, NOW, manager);
    expect(forManager.map((r) => r.id)[0]).toBe('n292kg92CNTRP');
    expect(forManager[0]?.cells.owner?.text).toBe('john@example.com');
    expect(forManager.find((r) => r.id === 'n292kg92CNTRM')?.cells.key?.text).toBe('Never');
  });

  it('builds its Summary in slots: online now, the tailnet, who’s on it', () => {
    const users = parseUsers({
      users: [
        { loginName: 'john@example.com', displayName: 'John Doe', created: '2026-10-19T08:00:00Z' },
        { loginName: 'anna@example.com', displayName: 'Anna de Vries', created: '2025-03-01T08:00:00Z' },
      ],
    });
    const view = tailscaleView({ snapshot: { ...snapshot, users }, now: NOW, ...manager });
    for (const p of view.panels) ThingPagePanel.parse(p);
    expect(slotProblems(view)).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['online', 'inventory', 'people']);
    // A cloud service: no machine card.
    expect(view.slots?.machine).toEqual([]);
    const live = view.panels[0];
    if (live?.kind !== 'gallery') throw new Error('live');
    // Waiting first with Approve, then the online ones, then the one seen last, greyed; the owner by name.
    expect(
      live.items.map((i) => [i.title, i.person?.name ?? null, i.badge?.text ?? null, i.noteEnd]),
    ).toEqual([
      ['new-phone', 'John Doe', 'Waiting', undefined],
      ['laptop', 'Anna de Vries', 'Key ends in 3 days', 'Online'],
      ['nas', null, null, 'Online'],
      ['old-pi', 'John Doe', 'Key expired', 'Seen 3 weeks ago'],
    ]);
    expect(live.items[0]?.actions?.[0]).toMatchObject({ action: 'approve', target: 'n292kg92CNTRP' });
    expect(live.items[3]?.muted).toBe(true);
    expect(live.meta).toBe('2 of 4 online');
    const inv = view.panels[1];
    if (inv?.kind !== 'list') throw new Error('inventory');
    expect(inv.items.map((i) => [i.title, i.figure?.value, i.figure?.note ?? null])).toEqual([
      ['Devices', '4', 'Nothing new'],
      ['People', '2', '+1 this week'],
      ['Tagged devices', '1', 'servers and the like'],
      ['Keys ending', '2', '1 expired'],
      ['Can update', '2', 'Tailscale itself'],
      ['Shared with you', '1', 'from other tailnets'],
    ]);
    const who = view.panels[2];
    if (who?.kind !== 'bars') throw new Error('people');
    expect(who.items.map((i) => [i.label, i.value, i.note])).toEqual([
      ['John Doe', '2 devices', 'all offline'],
      ['Anna de Vries', '1 device', '1 online'],
    ]);
    // The desk's Devices widget reads the table in its tab.
    expect(view.tabs.map((t) => [t.key, t.panels[0]?.id, t.panels[0]?.kind])).toEqual([
      ['devices', 'devices', 'table'],
    ]);
    expect(view.kpis).toEqual([]);
  });

  it('keeps two figures on the card, and names owners by their login without the users read', () => {
    expect(tailscaleCardView({ snapshot, now: NOW, ...manager }).kpis?.map((k) => k.key)).toEqual([
      'online',
      'waiting',
      'keys',
      'updates',
    ]);
    expect(ownerName(snapshot, 'anna@example.com')).toBe('anna');
    // One person: Inventory counts them, no People card.
    const one: TailscaleSnapshot = {
      readAt: NOW,
      devices: parseDevices({ devices: [TAILSCALE_DEVICES.devices[0]] }, NOW),
    };
    const view = tailscaleView({ snapshot: one, now: NOW, ...manager });
    expect(slotProblems(view)).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['online', 'inventory']);
  });

  it('offers Approve, disabled on Look only', () => {
    const phone = snapshot.devices.find((d) => !d.authorized);
    if (!phone) throw new Error('no waiting device');
    expect(approveButton(manager, phone)).toMatchObject({
      action: 'approve',
      target: 'n292kg92CNTRP',
      allowed: true,
    });
    expect(approveButton(manager, phone).confirm).toBeDefined();
    expect(approveButton(buttonsOf('tailscale', 'read'), phone)).toMatchObject({ allowed: false });
  });

  it('is fine when every device is online and nothing waits', () => {
    const calm: TailscaleSnapshot = {
      readAt: NOW,
      devices: parseDevices({ devices: [TAILSCALE_DEVICES.devices[1]] }, NOW),
    };
    expect(tailscaleNotices(calm, NOW)).toEqual([]);
    expect(tailscaleStatus(calm)).toEqual({ status: 'ok', badge: '1 of 1 online' });
  });
});
