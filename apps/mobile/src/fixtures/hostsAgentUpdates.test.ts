/** Agent updates in the demo world (agent-updates-app.md AP-2993): the endpoints answer as the hosts service does. */
import { type AnyEndpoint, api, type HostAgentSettings, type HostServerSettings } from '@whombat/core';
import { at } from '@whombat/fixtures';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { describe, expect, it } from 'vitest';
import { FIXTURE_ORIGIN } from '../data/config';
import { createClock } from '../lib/time';
import { createFixtureServer } from './fixture-server';

const burrow = 'burrow-hq';

function world() {
  const server = createFixtureServer({
    inner: createFixtureFetch(),
    now: createClock(new Date(at('14:05')), Date.now()),
    setTimer: () => undefined,
    assistant: true,
    chat: false,
  });
  /** The answer, checked against the endpoint's response schema. */
  const call = async <T>(ep: AnyEndpoint, path: string, init?: RequestInit): Promise<T> => {
    const res = await server.fetch(`${FIXTURE_ORIGIN}/api/v1/burrows/${burrow}${path}`, init);
    const parsed = ep.response.safeParse(await res.json());
    if (!parsed.success) throw new Error(`${ep.id}: ${parsed.error.message}`);
    return parsed.data as T;
  };
  return { call };
}

describe('agent updates in the demo world', () => {
  it('reads each server’s agent update and the switch, and starts an update', async () => {
    const w = world();
    const blackbox = await w.call<HostServerSettings>(
      api.hosts.serverSettings,
      '/hosts/servers/blackbox/settings',
    );
    expect(blackbox.agent?.update).toMatchObject({ reasonCode: 'no_key', canInstall: true });
    const pve01 = await w.call<HostServerSettings>(
      api.hosts.serverSettings,
      '/hosts/servers/pve-01/settings',
    );
    expect(pve01.agent?.update).toMatchObject({ reasonCode: 'no_key', canInstall: false });
    const dragon = await w.call<HostServerSettings>(
      api.hosts.serverSettings,
      '/hosts/servers/the-falcon/settings',
    );
    expect(dragon.agent?.update?.state).toBe('failed');
    expect(await w.call<HostAgentSettings>(api.hosts.agentSettings, '/hosts/agents/settings')).toEqual({
      autoUpdate: true,
      halted: false,
    });
    const off = await w.call<HostAgentSettings>(api.hosts.updateAgentSettings, '/hosts/agents/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autoUpdate: false }),
    });
    expect(off.autoUpdate).toBe(false);
    const started = await w.call<{ state: string }>(
      api.hosts.updateAgent,
      '/hosts/servers/blackbox/agent/update',
      { method: 'POST' },
    );
    expect(started.state).toBe('installing');
  });
});
