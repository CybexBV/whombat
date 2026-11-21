/**
 * Server agents that keep themselves up to date, Whombat's pure parts (agent-updates.md AU-03…AU-09;
 * agent-updates-server.md AU-S01…): the hub's update object and setting in the contract's shape, Update now's start and
 * refusals in words, Worth a look by state with the hub's `agent.outdated` not said twice, and who signs a finished
 * update. Words are checked by the facts they carry.
 */
import { HostAgentUpdate, HostServerSettings, thingHref, WatchItem } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  AGENT_FAILED_HINT,
  AGENT_INSTALL_HINT,
  AGENT_OUTDATED_HINT,
  type AgentUpdated,
  AgentUpdateFollow,
  agentUpdateHint,
  fleetHints,
  PRESSED_TTL_MS,
  startedState,
  toAgentSettings,
  toAgentUpdate,
  withAgentUpdateHints,
} from './agent-updates';
import { HostsError } from './client';
import { hostsErrorText } from './errors';
import { toHostServerDetail, toHostServerSettings } from './map';
import { hintWatch } from './sources';

const BUILD = '0.0.0-20261020080000.abc1234';

const outdated = (server: string) => ({
  serverId: server,
  kind: AGENT_OUTDATED_HINT,
  severity: 'info' as const,
  entity: 'host',
  title: `Agent x differs from the hub`,
  detail: 'The hub runs y.',
  section: 'agent',
});

describe('the hub’s update object (CT-511)', () => {
  it('maps every 0.99 field and parses as the contract', () => {
    const u = toAgentUpdate({
      available: false,
      version: BUILD,
      reason: 'This agent was installed without an update key',
      reason_code: 'no_key',
      auto: false,
      state: 'waiting',
      waiting_for: 'packages',
      failed_version: '0.0.0-20261019000000.def5678',
      updated_at: '2026-10-20T08:00:00Z',
      can_install: true,
    });
    expect(HostAgentUpdate.parse(u)).toEqual(u);
    expect(u).toMatchObject({
      reasonCode: 'no_key',
      state: 'waiting',
      waitingFor: 'packages',
      updatedAt: '2026-10-20T08:00:00.000Z',
      canInstall: true,
      auto: false,
    });
  });

  it('leaves out what it doesn’t know, and an older hub’s object maps as before', () => {
    const u = toAgentUpdate({
      available: true,
      version: BUILD,
      reason_code: 'later',
      state: 'odd',
      waiting_for: 'x',
    });
    expect(u).toEqual({ available: true, version: BUILD });
    // A wait only with `waiting`.
    expect(toAgentUpdate({ state: 'updating', waiting_for: 'console' })).not.toHaveProperty('waitingFor');
    const settings = toHostServerSettings(
      { id: 'pve-01', group: 'Lab', remote_control: {}, agent_policy: {} },
      {
        version: 'v1',
        update: { available: false, reason: 'Up to date.', state: 'failed', message: 'boom' },
      },
    );
    expect(HostServerSettings.parse(settings).agent?.update).toEqual({
      available: false,
      reason: 'Up to date.',
      state: 'failed',
      message: 'boom',
    });
  });

  it('reads the setting: on unless off, halted while it names a version', () => {
    expect(toAgentSettings({ auto_update: false, halted_version: null })).toEqual({
      autoUpdate: false,
      halted: false,
    });
    expect(toAgentSettings({ auto_update: true, halted_version: BUILD })).toEqual({
      autoUpdate: true,
      halted: true,
    });
    expect(toAgentSettings({})).toEqual({ autoUpdate: true, halted: false });
  });
});

describe('Update now', () => {
  it('starts the last install for an agent without the key, else a signed update; the hub’s own word wins', () => {
    const keyless = toAgentUpdate({ available: false, reason_code: 'no_key', can_install: true });
    expect(startedState({ servers: ['pve-01'] }, 'pve-01', keyless)).toBe('installing');
    expect(startedState({ servers: ['pve-01'] }, 'pve-01', toAgentUpdate({ available: true }))).toBe(
      'updating',
    );
    expect(startedState({ installing: ['pve-01'] }, 'pve-01', null)).toBe('installing');
    expect(startedState({ state: 'updating' }, 'pve-01', keyless)).toBe('updating');
  });

  it('says the hub’s refusals in words (update_running, needs_install, nothing to update by reason)', () => {
    const names = (agentReason?: 'up_to_date' | 'turned_off' | 'not_connected') => ({
      server: 'pve-01',
      op: 'agent.update',
      ...(agentReason ? { agentReason } : {}),
    });
    expect(
      hostsErrorText(new HostsError(409, 'update_running', 'An update is already running.'), names()),
    ).toMatch(/Another update is already running/);
    const install = hostsErrorText(new HostsError(409, 'needs_install', 'x'), names());
    expect(install).toContain('pve-01');
    expect(install).toMatch(/one more install/);
    expect(install).toMatch(/System tab/);
    const nothing = new HostsError(409, 'nothing_to_update', 'No agent can be updated.');
    expect(hostsErrorText(nothing, names('up_to_date'))).toMatch(/already up to date/);
    expect(hostsErrorText(nothing, names('turned_off'))).toMatch(/turned off on pve-01 itself/);
    expect(hostsErrorText(nothing, names('not_connected'))).toMatch(/isn’t connected/);
    expect(hostsErrorText(new HostsError(409, 'no_build', 'x'), names())).toMatch(
      /no new version of Whombat’s helper/,
    );
    // The shared ones keep their words.
    expect(hostsErrorText(new HostsError(409, 'agent_offline', null), names())).toMatch(/isn’t connected/);
    // Another op's nothing_to_update isn't this.
    expect(hostsErrorText(nothing, { server: 'pve-01' })).not.toMatch(/agent/);
  });
});

describe('Worth a look (AU-08)', () => {
  it('a failed update, on the server where it failed; halted alone is not that server’s failure', () => {
    const failed = agentUpdateHint('pve-01', toAgentUpdate({ version: BUILD, state: 'failed' }));
    expect(failed).toMatchObject({ kind: AGENT_FAILED_HINT, severity: 'warning', section: 'system' });
    expect(failed?.title).toMatch(/Whombat’s helper didn’t update/);
    expect(failed?.detail).toMatch(/version it had.*Try again/);
    // The failed mark for the build stays after the state is gone; for an older build it doesn't count.
    expect(agentUpdateHint('pve-01', toAgentUpdate({ version: BUILD, failed_version: BUILD }))?.kind).toBe(
      AGENT_FAILED_HINT,
    );
    expect(agentUpdateHint('pve-01', toAgentUpdate({ version: BUILD, failed_version: 'old' }))).toBeNull();
    expect(agentUpdateHint('pve-02', toAgentUpdate({ version: BUILD, state: 'halted' }))).toBeNull();
  });

  it('an agent that needs its last install: the button where Whombat may, else the install command', () => {
    const may = agentUpdateHint('pve-01', toAgentUpdate({ reason_code: 'no_key', can_install: true }));
    expect(may).toMatchObject({ kind: AGENT_INSTALL_HINT, severity: 'warning' });
    expect(may?.title).toMatch(/Whombat’s helper needs one more install/);
    expect(may?.detail).toMatch(/Update it on the System tab/);
    const mayNot = agentUpdateHint('pve-01', toAgentUpdate({ reason_code: 'other_key', can_install: false }));
    expect(mayNot?.detail).toMatch(/install command/);
    for (const code of ['up_to_date', 'turned_off', 'not_connected', 'no_build', 'newer_running'])
      expect(agentUpdateHint('pve-01', toAgentUpdate({ reason_code: code }))).toBeNull();
  });

  it('the hub’s agent.outdated is not said twice, nor where the agent updates itself', () => {
    const hints = [outdated('pve-01'), outdated('pve-02')];
    const install = withAgentUpdateHints(hints, 'pve-01', toAgentUpdate({ reason_code: 'no_key' }));
    expect(install.map((h) => [h.serverId, h.kind])).toEqual([
      ['pve-01', AGENT_INSTALL_HINT],
      ['pve-02', AGENT_OUTDATED_HINT],
    ]);
    for (const raw of [{ available: true, auto: true }, { state: 'updating' }, { state: 'waiting' }])
      expect(withAgentUpdateHints(hints, 'pve-01', toAgentUpdate(raw)).map((h) => h.serverId)).toEqual([
        'pve-02',
      ]);
    // Nothing updates it by itself: the hub's hint stays.
    for (const raw of [
      { reason_code: 'turned_off' },
      { available: true, auto: false },
      { reason_code: 'no_build' },
    ])
      expect(withAgentUpdateHints(hints, 'pve-01', toAgentUpdate(raw))).toHaveLength(2);
    // An older hub (no update object): as the hub gave them.
    expect(withAgentUpdateHints(hints, 'pve-01', null)).toEqual(hints);
    // Fleet hints the same way, server by server (QN-S51).
    const rows = [{ server_id: 'pve-01', update: { reason_code: 'no_key' } }];
    expect(fleetHints(hints, rows).map((h) => [h.serverId, h.kind])).toEqual([
      ['pve-01', AGENT_INSTALL_HINT],
      ['pve-02', AGENT_OUTDATED_HINT],
    ]);
  });

  it('the server’s detail carries them from its /agents row', () => {
    const d = toHostServerDetail(
      { server: { id: 'pve-01', name: 'pve-01' }, hints: [{ ...outdated('pve-01'), server: 'pve-01' }] },
      [],
      { server_id: 'pve-01', update: { version: BUILD, state: 'failed' } },
      new Date('2026-10-20T08:00:00Z'),
    );
    expect(d.hints.map((h) => h.kind)).toEqual([AGENT_FAILED_HINT]);
  });

  it('Watch links each to the System tab', () => {
    const hints = fleetHints(
      [],
      [
        { server_id: 'pve-01', update: { reason_code: 'no_key', can_install: true } },
        {
          server_id: 'pve-02',
          update: { version: BUILD, state: 'failed', updated_at: '2026-10-19T10:00:00Z' },
        },
        { server_id: 'pve-03', update: { available: true, auto: true } },
        { server_id: 'pve-04' },
      ],
    );
    const items = hints.map((h) => hintWatch(h, '2026-10-20T08:00:00.000Z', []));
    expect(items.map((i) => WatchItem.parse(i))).toHaveLength(2);
    expect(items.map((i) => [i.serverId, i.href, i.severity, i.nature])).toEqual([
      ['pve-01', `${thingHref('server', 'pve-01')}?tab=system`, 'warn', 'you'],
      ['pve-02', `${thingHref('server', 'pve-02')}?tab=system`, 'warn', 'you'],
    ]);
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
  });
});

describe('who signs a finished update (AU-S04)', () => {
  function follow() {
    let now = 1_000_000;
    const signed: AgentUpdated[] = [];
    const f = new AgentUpdateFollow(
      async (u) => {
        signed.push(u);
      },
      () => now,
    );
    return { f, signed, tick: (ms: number) => (now += ms) };
  }

  it('the person who pressed Update now, once; else Whombat', async () => {
    const { f, signed } = follow();
    f.pressed('pve-01', 'p-john', 'burrow-hq');
    await f.heard({ server: 'pve-01', state: 'updating' });
    await f.heard({ server: 'pve-01', state: 'updated', from: 'a', to: BUILD });
    await f.heard({ server: 'pve-01', state: 'updated', from: 'a', to: BUILD });
    await f.heard({ server: 'pve-02', state: 'updated', from: 'a', to: BUILD });
    expect(signed).toEqual([
      { serverId: 'pve-01', from: 'a', to: BUILD, personId: 'p-john', burrowId: 'burrow-hq' },
      { serverId: 'pve-02', from: 'a', to: BUILD, personId: null, burrowId: null },
    ]);
  });

  it('a press long ago is forgotten', async () => {
    const { f, signed, tick } = follow();
    f.pressed('pve-01', 'p-john', 'burrow-hq');
    tick(PRESSED_TTL_MS + 1);
    await f.heard({ server: 'pve-01', state: 'updated', to: BUILD });
    expect(signed[0]?.personId).toBeNull();
  });
});
