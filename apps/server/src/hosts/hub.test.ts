/**
 * The hub as Whombat reads it, the address question and pointing servers here, pure (backup-file.md BF-13…BF-16;
 * BF-S30…): `/hub` mapped, addresses as people read them, a server's level from its switches, the servers still
 * looking for the old address and BF-16's item, and which Vault SSH server a repoint signs in with.
 */
import { describe, expect, it } from 'vitest';
import { addressChangeOf, addressNeedsYou, agentAddresses, REPOINT_HREF, waitingServers } from './address';
import { addressChangeText, addressText, levelOfSwitches, sameAgentUrl, toHubInfo } from './hub';
import { type KeyServer, pickKeyServer, signInAddress, toAgentRow } from './repoint';

const CHANGED = '2026-10-21T10:00:00.000Z';

describe('the hub', () => {
  it('maps /hub: the resolved address first, the one before, a restore and a refused one', () => {
    const hub = toHubInfo({
      ca_sha256: 'E57C',
      agents_url: 'wss://10.100.1.158:8443',
      agent_url: 'auto',
      agent_url_previous: 'wss://10.100.1.160:8443',
      agent_url_changed_at: CHANGED,
      restored_at: CHANGED,
      restore_error: { at: CHANGED, code: 'newer_schema', message: 'A newer hub made it.' },
      servers: 5,
      database_bytes: 253952,
    });
    expect(hub).toMatchObject({
      caSha256: 'e57c',
      agentUrl: 'wss://10.100.1.158:8443',
      agentUrlPrevious: 'wss://10.100.1.160:8443',
      agentUrlChangedAt: CHANGED,
      restoredAt: CHANGED,
      restoreError: 'newer_schema',
      restoreErrorAt: CHANGED,
      servers: 5,
      databaseBytes: 253952,
    });
    // `agent_url` is what the hub tells its agents; an older hub's empty one (auto) falls back to the resolved one.
    expect(
      toHubInfo({ ca_sha256: 'x', agents_url: 'wss://10.0.0.5:8443', agent_url: 'wss://box.lan:9443' })
        .agentUrl,
    ).toBe('wss://box.lan:9443');
    expect(toHubInfo({ ca_sha256: 'x', agents_url: 'wss://box.lan:9443', agent_url: '' })).toMatchObject({
      agentUrl: 'wss://box.lan:9443',
      agentUrlPrevious: null,
      restoredAt: null,
      restoreError: null,
      servers: 0,
    });
  });

  it('reads addresses as people do and tells the same place from another', () => {
    expect(addressText('wss://10.100.1.160:8443')).toBe('10.100.1.160');
    expect(addressText('wss://whombat.lan:9443/agent')).toBe('whombat.lan:9443');
    expect(addressText('wss://[fd00::5]:8443')).toBe('fd00::5');
    expect(addressText('wss://[fd00::5]:9443')).toBe('[fd00::5]:9443');
    expect(addressText('wss://box.lan')).toBe('box.lan');
    expect(sameAgentUrl('wss://BOX.lan:8443', 'wss://box.lan:8443/')).toBe(true);
    expect(addressChangeText('wss://10.100.1.160:8443', 'wss://10.100.1.158:8443')).toEqual({
      from: '10.100.1.160',
      to: '10.100.1.158',
    });
    expect(addressChangeText('wss://10.100.1.160:8443', 'wss://10.100.1.160:8443')).toBeNull();
    expect(addressChangeText(null, 'wss://10.100.1.160:8443')).toBeNull();
  });

  it('gives a server the highest level both sides allow, never more', () => {
    const all = {
      console: true,
      power: true,
      host_shell: true,
      host_power: true,
      manage: true,
      diagnose: true,
    };
    expect(levelOfSwitches(all, all)).toBe('full');
    expect(levelOfSwitches(all, { ...all, host_power: false })).toBe('operate');
    expect(levelOfSwitches({ ...all, power: false }, all)).toBe('watch');
    expect(levelOfSwitches(all, null)).toBe('full');
    expect(levelOfSwitches(null, null)).toBe('watch');
  });
});

describe('an address change (BF-16)', () => {
  const hub = {
    agentUrl: 'wss://10.100.1.158:8443',
    agentUrlPrevious: 'wss://10.100.1.160:8443',
    agentUrlChangedAt: CHANGED,
  };
  const cards = [
    { id: 'pve-01', hostname: 'pve-01', agent_connected: false, last_seen: '2026-10-21T09:58:00Z' },
    { id: 'pve-02', hostname: 'pve-02', agent_connected: true, last_seen: '2026-10-21T10:06:00Z' },
    { id: 'blackbox', hostname: 'BlackBox', agent_connected: false, last_seen: null },
    // Back since the change, between two reports.
    { id: 'basalt', hostname: 'basalt', agent_connected: false, last_seen: '2026-10-21T10:02:00Z' },
  ];

  it('lists the servers not seen since the change, with their own addresses', () => {
    const waiting = waitingServers(
      cards,
      CHANGED,
      agentAddresses([{ server_id: 'pve-01', address: '10.100.1.11' }]),
    );
    expect(waiting.map((w) => [w.id, w.name, w.address])).toEqual([
      ['blackbox', 'BlackBox', null],
      ['pve-01', 'pve-01', '10.100.1.11'],
    ]);
  });

  it('waits five minutes, and is gone when they are back or the address is the same', () => {
    const at = (min: number) => new Date(Date.parse(CHANGED) + min * 60_000);
    expect(addressChangeOf(hub, cards, at(4))).toBeNull();
    const change = addressChangeOf(hub, cards, at(6));
    expect(change).toMatchObject({ from: '10.100.1.160', to: '10.100.1.158', changedAt: CHANGED });
    expect(change?.waiting).toHaveLength(2);
    const back = cards.map((c) => ({ ...c, agent_connected: true }));
    expect(addressChangeOf(hub, back, at(6))).toBeNull();
    expect(addressChangeOf({ ...hub, agentUrlPrevious: hub.agentUrl }, cards, at(6))).toBeNull();
    expect(addressChangeOf({ ...hub, agentUrlPrevious: null }, cards, at(6))).toBeNull();
  });

  it('is one Needs you item with Point them here, keyed by the change', () => {
    const found = addressChangeOf(hub, cards, new Date(Date.parse(CHANGED) + 600_000));
    if (!found) throw new Error('no change');
    const item = addressNeedsYou(found);
    expect(item.ref).toEqual({ kind: 'address_change', id: CHANGED });
    expect(item.kind).toBe('enrollment');
    expect(item.title).toContain('10.100.1.160');
    expect(item.title).toContain('10.100.1.158');
    expect(item.title).toContain('2 servers');
    expect(item.actions).toEqual([expect.objectContaining({ kind: 'open', href: REPOINT_HREF })]);
    const one = addressNeedsYou({ ...found, waiting: found.waiting.slice(0, 1) });
    expect(one.title).toContain('BlackBox');
    expect(one.actions[0]?.label).toBe('Point it here');
  });
});

describe('pointing a server here', () => {
  const key = (host: string, extra: Partial<KeyServer> = {}): KeyServer => ({
    entryId: `vlt_${host}`,
    host,
    port: 22,
    username: 'root',
    trusted: true,
    ...extra,
  });

  it('signs in with the Vault server at its address first, then its name', () => {
    const server = { id: 'pve-01', name: 'pve-01', address: '10.100.1.11' };
    expect(pickKeyServer([key('pve-01.lan'), key('10.100.1.11')], server)?.host).toBe('10.100.1.11');
    expect(pickKeyServer([key('pve-01.lan'), key('10.100.1.99')], server)?.host).toBe('pve-01.lan');
    expect(pickKeyServer([key('10.100.1.99')], server)).toBeNull();
    // A trusted host key first, then root.
    expect(
      pickKeyServer(
        [key('10.100.1.11', { trusted: false }), key('10.100.1.11', { username: 'ops', entryId: 'vlt_ops' })],
        server,
      )?.entryId,
    ).toBe('vlt_ops');
  });

  it('reads /agents rows and writes addresses as Sign in once does', () => {
    expect(
      toAgentRow({
        server_id: 'pve-01',
        hostname: 'pve-01',
        address: '10.100.1.11/24',
        connected: false,
        remote_control: { console: true },
        agent_policy: null,
      }),
    ).toMatchObject({ id: 'pve-01', address: '10.100.1.11', connected: false, agent: null });
    expect(toAgentRow({ hostname: 'x' })).toBeNull();
    expect(signInAddress('10.100.1.11', 22)).toBe('10.100.1.11');
    expect(signInAddress('10.100.1.11', 2222)).toBe('10.100.1.11:2222');
    expect(signInAddress('fd00::5', 2222)).toBe('[fd00::5]:2222');
  });
});
