/**
 * “Asks you first” per server, the pure parts (docs/decisions/server-asks.md SA-03, SA-06, SA-07; server-asks-server.md):
 * the tier of a Servers call with the server's setting, the server a call names from the fleet memory, and Whombat's
 * own tools reworded without a New mark.
 */
import { catalogEntry } from '@whombat/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type CallServerInfo, callTier } from '../connections/call';
import { mergeTools, type ToolDefinition } from '../connections/sync';
import { asksChangedText } from './asks';
import { knownServer, noteSelfServers, runsThisWhombat } from './self';

const servers = (() => {
  const e = catalogEntry('whombat_servers');
  if (!e) throw new Error('whombat_servers');
  return e;
})();

const tool = (name: string, tier: 'can' | 'ask' | 'off' = 'can', access: 'read' | 'write' = 'write') => ({
  name,
  tier,
  access,
  origin: 'adapter',
});

const lab: CallServerInfo = { id: 'lab', name: 'lab', asksFirst: 'risky', hostsThisWhombat: false };
const beast: CallServerInfo = {
  id: 'the-titan',
  name: 'The-Titan',
  asksFirst: 'risky',
  hostsThisWhombat: true,
};
const never = (s: CallServerInfo): CallServerInfo => ({ ...s, asksFirst: 'never' });
const cmd = { server: 'lab', command: 'uptime', reason: 'see' };

describe('the tier of a Servers call with the server’s setting (SA-06)', () => {
  it('asks on a server that asks before risky actions, and offers to stop asking there (SA-07)', () => {
    const t = callTier(servers, tool('server_command'), cmd, 'can', 'manage', lab);
    expect(t).toMatchObject({ tier: 'ask', sensitive: true, askServer: { id: 'lab', name: 'lab' } });
    // Without a known server: asks as before, nothing to offer.
    expect(callTier(servers, tool('server_command'), cmd, 'can')).toMatchObject({
      tier: 'ask',
      askServer: null,
    });
  });

  it('runs at Allowed on a server set to Never', () => {
    const t = callTier(servers, tool('server_command'), cmd, 'can', 'manage', never(lab));
    expect(t).toMatchObject({ tier: 'can', sensitive: false, askServer: null });
    const stop = callTier(
      servers,
      tool('guest_power'),
      { server: 'lab', guest: 'web', action: 'stop' },
      'can',
      'manage',
      never(lab),
    );
    expect(stop.tier).toBe('can');
  });

  it('keeps the key and tool tiers, Off and Look only on Never', () => {
    expect(callTier(servers, tool('server_command', 'ask'), cmd, 'can', 'manage', never(lab)).tier).toBe(
      'ask',
    );
    expect(callTier(servers, tool('server_command'), cmd, 'ask', 'manage', never(lab)).tier).toBe('ask');
    expect(callTier(servers, tool('server_command', 'off'), cmd, 'can', 'manage', never(lab)).tier).toBe(
      'off',
    );
    expect(callTier(servers, tool('server_command'), cmd, 'cannot', 'manage', never(lab)).tier).toBe('off');
    expect(callTier(servers, tool('server_command'), cmd, 'can', 'read', never(lab))).toMatchObject({
      tier: 'off',
      lookOnly: true,
    });
  });

  it('offers nothing when the call would still ask on Never (its tier or key asks)', () => {
    expect(callTier(servers, tool('server_command', 'ask'), cmd, 'can', 'manage', lab).askServer).toBeNull();
    expect(callTier(servers, tool('server_command'), cmd, 'ask', 'manage', lab).askServer).toBeNull();
  });

  it('still asks before powering the server this Whombat runs on, and offers nothing there (SA-03)', () => {
    const power = { server: 'the-titan', action: 'reboot' };
    expect(callTier(servers, tool('server_power'), power, 'can', 'manage', never(beast))).toMatchObject({
      tier: 'ask',
      sensitive: true,
    });
    expect(callTier(servers, tool('server_power'), power, 'can', 'manage', beast).askServer).toBeNull();
    // Commands there run without asking on Never, and the card offers to stop asking on risky.
    const there = { ...cmd, server: 'the-titan' };
    expect(callTier(servers, tool('server_command'), there, 'can', 'manage', never(beast)).tier).toBe('can');
    expect(callTier(servers, tool('server_command'), there, 'can', 'manage', beast).askServer).toEqual({
      id: 'the-titan',
      name: 'The-Titan',
    });
  });

  it('applies only to the Servers connection', () => {
    const ha = catalogEntry('homeassistant');
    if (!ha) throw new Error('homeassistant');
    const lock = callTier(
      ha,
      { name: 'HassTurnOn', tier: 'can', access: 'write', origin: 'mcp' },
      { name: 'lock.front_door' },
      'can',
      'manage',
      never(lab),
    );
    expect(lock).toMatchObject({ tier: 'ask', askServer: null });
  });
});

describe('the server a call names (SA-06)', () => {
  afterEach(() => noteSelfServers({ servers: [] }));

  it('finds a server by id or host name in any case, with its name and whether it runs Whombat', () => {
    noteSelfServers({
      servers: [
        { id: 'blackbox', hostname: 'BlackBox' },
        { id: 'the-titan', hostname: 'thetitan', hosts_this_whombat: true },
        { id: 'pve-02', hostname: 'blackbox' },
      ],
    });
    expect(knownServer('BLACKBOX')).toEqual({ id: 'blackbox', name: 'BlackBox', hostsThisWhombat: false });
    expect(knownServer(' TheTitan ')).toEqual({ id: 'the-titan', name: 'the-titan', hostsThisWhombat: true });
    expect(knownServer('pve-02')?.id).toBe('pve-02');
    expect(knownServer('nope')).toBeNull();
    expect(knownServer(42)).toBeNull();
    expect(runsThisWhombat('thetitan')).toBe(true);
  });
});

describe('Whombat’s own tools reworded (SA-S04)', () => {
  const def = (
    description: string,
    schema: ToolDefinition['inputSchema'] = { type: 'object' },
  ): ToolDefinition => ({
    name: 'server_command',
    description,
    inputSchema: schema,
    access: 'write',
    origin: 'adapter',
  });

  it('keeps the New mark as it was when only the description changed, and marks other changes New', () => {
    const [stored] = mergeTools([], [def('Runs a command.')], { firstSync: true }).upsert;
    if (!stored) throw new Error('no tool');
    const reworded = mergeTools([stored], [def('Runs a command. Asks first.')], {
      firstSync: false,
      quietWording: true,
    }).upsert[0];
    expect(reworded).toMatchObject({
      isNew: false,
      changed: true,
      description: 'Runs a command. Asks first.',
    });
    const reshaped = mergeTools([stored], [def('Runs a command.', { type: 'object', required: ['x'] })], {
      firstSync: false,
      quietWording: true,
    }).upsert[0];
    expect(reshaped?.isNew).toBe(true);
    // Another connection's tools: a new description is news.
    expect(
      mergeTools([stored], [def('Runs a command. Asks first.')], { firstSync: false }).upsert[0]?.isNew,
    ).toBe(true);
  });
});

describe('the words of a change', () => {
  it('says what changed in plain words', () => {
    expect(asksChangedText('BlackBox', 'never')).toBe('Whombat stopped asking first on BlackBox');
    expect(asksChangedText('BlackBox', 'risky')).toBe('Whombat asks before risky actions on BlackBox again');
  });
});
