/** Agent updates in the fixture worlds (agent-updates-app.md AP-2990): the five servers' states and a press. */
import { HostAgentSettings, HostServerSettings } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { agentUpdatesView } from './agent-updates';
import { createHostsFixtures } from './fixtures';
import { FIXTURE_AGENT_NEW, withAgentUpdatesFixtures } from './fixtures-au';

const NOW = Date.parse('2026-10-20T12:00:00Z');

function world() {
  let t = NOW;
  const handle = withAgentUpdatesFixtures(createHostsFixtures(NOW).handle, { now: NOW, clock: () => t });
  const call = (method: string, path: string, body: Record<string, unknown> = {}) =>
    handle({ method, path, query: {}, body });
  const view = (id: string, autoUpdate = true) => {
    // Checked against the schema (0.99.0's fields).
    const s = HostServerSettings.parse(call('GET', `/servers/${id}/settings`)?.body);
    return {
      version: s.agent?.version,
      row: agentUpdatesView({
        server: id,
        update: s.agent?.update,
        autoUpdate,
        connected: true,
        now: t,
      }),
    };
  };
  return { call, view, tick: (ms: number) => (t += ms) };
}

describe('the agent updates fixture world', () => {
  it('starts with each of the row’s cases', () => {
    const w = world();
    expect(w.view('pve-02').row?.updated).toMatch(/^updated 3/);
    expect(w.view('blackbox').row?.action?.kind).toBe('install');
    expect(w.view('pve-01').row?.command).toBe(true);
    expect(w.view('thetitan').row?.text).toContain('installing updates');
    expect(w.view('the-falcon').row?.action?.kind).toBe('retry');
    expect(HostAgentSettings.parse(w.call('GET', '/agents/settings')?.body)).toEqual({
      autoUpdate: true,
      halted: false,
    });
  });

  it('updates for a few seconds after a press, then runs the new version', () => {
    const w = world();
    expect(w.call('POST', '/servers/blackbox/agent/update')).toEqual({
      status: 202,
      body: { state: 'installing' },
    });
    expect(w.view('blackbox').row?.text).toContain('Updating');
    // A second press while it runs is refused.
    expect(w.call('POST', '/servers/blackbox/agent/update')?.status).toBe(409);
    w.tick(10_000);
    expect(w.view('blackbox')).toMatchObject({
      version: FIXTURE_AGENT_NEW,
      row: { text: 'Kept up to date' },
    });
    // Where Whombat may not run it, the install command is the way.
    w.view('pve-01');
    expect(w.call('POST', '/servers/pve-01/agent/update')?.status).toBe(409);
  });

  it('turned off, thetitan waits for Update now; on, it updates by itself once its updates are in', () => {
    const w = world();
    w.call('PATCH', '/agents/settings', { autoUpdate: false });
    expect(w.view('thetitan', false).row?.action?.kind).toBe('now');
    w.call('PATCH', '/agents/settings', { autoUpdate: true });
    w.tick(2 * 60_000);
    expect(w.view('thetitan').row?.text).toContain('Updating');
    w.tick(10_000);
    expect(w.view('thetitan').version).toBe(FIXTURE_AGENT_NEW);
  });
});
