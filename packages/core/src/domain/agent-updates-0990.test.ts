/**
 * Contracts 0.99.0, server agents keep themselves up to date (Whombat agent-updates.md AU-01…AU-10, CT-510…CT-516): the
 * agent's update in the server settings, the setting, and Update now.
 */
import { describe, expect, it } from 'vitest';
import { api } from '../contracts/index.js';
import {
  HOST_AGENT_UPDATE_REASON_CODES,
  HOST_AGENT_UPDATE_STATES,
  HOST_AGENT_UPDATE_WAITS,
  HostAgentSettings,
  HostAgentSettingsPatch,
  HostAgentUpdate,
  HostAgentUpdateAccepted,
  HostServerSettings,
} from './hosts.js';

const SETTINGS = {
  id: 'pve-01',
  group: 'Lab',
  location: null,
  remoteControl: { console: true, power: true },
  agentPolicy: { console: true, power: false },
};

describe('an agent’s update in the server settings (CT-510, CT-511)', () => {
  it('names the seven reasons, the four states and what it waits for', () => {
    expect(HOST_AGENT_UPDATE_REASON_CODES).toEqual([
      'no_build',
      'not_connected',
      'up_to_date',
      'no_key',
      'other_key',
      'turned_off',
      'newer_running',
    ]);
    // The two older states keep their place; the new ones are appended.
    expect(HOST_AGENT_UPDATE_STATES).toEqual(['updating', 'failed', 'waiting', 'halted']);
    expect(HOST_AGENT_UPDATE_WAITS).toEqual(['packages', 'console', 'task']);
  });

  it('reads an older hub’s update as before', () => {
    const old = { available: false, reason: 'no signed agent build', state: 'failed', message: 'timed out' };
    expect(HostAgentUpdate.parse(old)).toEqual(old);
    const parsed = HostServerSettings.parse({ ...SETTINGS, agent: { version: '1.4.0', update: old } });
    expect(parsed.agent?.update?.state).toBe('failed');
  });

  it('carries a waiting update, a failed one and the one last install', () => {
    const waiting = {
      available: true,
      version: '0.0.0-20261020101500.abc1234',
      reasonCode: 'up_to_date',
      auto: true,
      state: 'waiting',
      waitingFor: 'packages',
      updatedAt: '2026-10-19T08:00:00Z',
    };
    expect(HostAgentUpdate.parse(waiting)).toEqual(waiting);
    const failed = {
      available: true,
      state: 'failed',
      failedVersion: '0.0.0-20261020101500.abc1234',
      auto: false,
    };
    expect(HostAgentUpdate.parse(failed)).toEqual(failed);
    const keyless = { available: false, reasonCode: 'no_key', canInstall: true };
    const s = HostServerSettings.parse({ ...SETTINGS, agent: { version: null, update: keyless } });
    expect(s.agent?.update?.canInstall).toBe(true);
    expect(s.agent?.update?.reasonCode).toBe('no_key');
    expect(HostAgentUpdate.safeParse({ available: true, waitingFor: 'reboot' }).success).toBe(false);
    expect(HostAgentUpdate.safeParse({ available: true, reasonCode: 'too_old' }).success).toBe(false);
    expect(HostAgentUpdate.safeParse({ available: true, updatedAt: 'yesterday' }).success).toBe(false);
  });
});

describe('the setting and Update now (CT-512, CT-513)', () => {
  it('keeps “Keep server agents up to date” with whether it halted', () => {
    expect(HostAgentSettings.parse({ autoUpdate: true, halted: false })).toEqual({
      autoUpdate: true,
      halted: false,
    });
    expect(HostAgentSettings.safeParse({ autoUpdate: true }).success).toBe(false);
    expect(HostAgentSettingsPatch.safeParse({ autoUpdate: false }).success).toBe(true);
    expect(HostAgentSettingsPatch.safeParse({}).success).toBe(false);
  });

  it('answers whether it updates or does the last install', () => {
    expect(HostAgentUpdateAccepted.parse({ state: 'installing' })).toEqual({ state: 'installing' });
    expect(HostAgentUpdateAccepted.safeParse({ state: 'waiting' }).success).toBe(false);
  });

  it('has three endpoints at their paths', () => {
    const { agentSettings, updateAgentSettings, updateAgent } = api.hosts;
    expect([agentSettings.id, agentSettings.method, agentSettings.path]).toEqual([
      'hosts.agentSettings',
      'GET',
      '/burrows/:burrow/hosts/agents/settings',
    ]);
    expect(agentSettings.response).toBe(HostAgentSettings);
    expect([updateAgentSettings.id, updateAgentSettings.method, updateAgentSettings.path]).toEqual([
      'hosts.updateAgentSettings',
      'PATCH',
      '/burrows/:burrow/hosts/agents/settings',
    ]);
    expect(updateAgentSettings.body).toBe(HostAgentSettingsPatch);
    expect(updateAgentSettings.response).toBe(HostAgentSettings);
    expect([updateAgent.id, updateAgent.method, updateAgent.path, updateAgent.status]).toEqual([
      'hosts.updateAgent',
      'POST',
      '/burrows/:burrow/hosts/servers/:serverId/agent/update',
      202,
    ]);
    expect(updateAgent.response).toBe(HostAgentUpdateAccepted);
    expect(updateAgent.params.parse({ burrow: 'lumio-bv', serverId: 'pve-01' })).toEqual({
      burrow: 'lumio-bv',
      serverId: 'pve-01',
    });
  });
});
