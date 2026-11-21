/** Server agents keep themselves up to date: the Updates row and the switch (Whombat agent-updates.md AU-06, AU-08). */
import { describe, expect, it } from 'vitest';
import {
  AGENT_UPDATE_WORDS,
  type AgentUpdatesInput,
  agentSettingsView,
  agentUpdatesView,
} from './agent-updates';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const HOUR = 3600_000;

const input = (
  update: AgentUpdatesInput['update'],
  over: Partial<AgentUpdatesInput> = {},
): AgentUpdatesInput => ({
  server: 'pve-01',
  update,
  autoUpdate: true,
  connected: true,
  now: NOW,
  ...over,
});

describe('the Updates row', () => {
  it('shows nothing before it is read, without a build or a connection', () => {
    expect(agentUpdatesView(input(null))).toBeNull();
    expect(agentUpdatesView(input({ available: false, reasonCode: 'no_build' }))).toBeNull();
    expect(agentUpdatesView(input({ available: false, reasonCode: 'not_connected' }))).toBeNull();
    const u = { available: false, reasonCode: 'up_to_date' } as const;
    expect(agentUpdatesView(input(u, { connected: false }))).toBeNull();
  });

  it('says it is kept up to date, or only up to date when automatic updates are off', () => {
    const kept = agentUpdatesView(input({ available: false, reasonCode: 'up_to_date' }));
    expect([kept?.text, kept?.tone, kept?.action, kept?.command]).toEqual([
      AGENT_UPDATE_WORDS.kept,
      'ok',
      null,
      false,
    ]);
    const off = agentUpdatesView(
      input({ available: false, reasonCode: 'up_to_date' }, { autoUpdate: false }),
    );
    expect(off?.text).toBe(AGENT_UPDATE_WORDS.upToDate);
    // A newer agent than the build is never downgraded: up to date as well.
    expect(agentUpdatesView(input({ available: false, reasonCode: 'newer_running' }))?.text).toBe(
      AGENT_UPDATE_WORDS.kept,
    );
  });

  it('says when it was last updated, for a week', () => {
    const at = (h: number) => new Date(NOW - h * HOUR).toISOString();
    expect(agentUpdatesView(input({ available: false, updatedAt: at(2) }))?.updated).toMatch(/^updated 2/);
    expect(agentUpdatesView(input({ available: false, updatedAt: at(8 * 24) }))?.updated).toBeNull();
  });

  it('is updating while the rollout runs, with no button', () => {
    const v = agentUpdatesView(input({ available: true, state: 'updating' }));
    expect([v?.text, v?.tone, v?.action]).toEqual([AGENT_UPDATE_WORDS.updating, 'mut', null]);
  });

  it('names what it waits for (AU-04)', () => {
    expect(
      agentUpdatesView(input({ available: true, state: 'waiting', waitingFor: 'packages' }))?.text,
    ).toContain('pve-01 has finished installing updates');
    expect(
      agentUpdatesView(input({ available: true, state: 'waiting', waitingFor: 'console' }))?.text,
    ).toContain('console');
    expect(
      agentUpdatesView(input({ available: true, state: 'waiting', waitingFor: 'task' }))?.text,
    ).toContain('task');
  });

  it('offers Try again after a failed update (AU-05)', () => {
    const v = agentUpdatesView(input({ available: true, state: 'failed', failedVersion: 'v2' }));
    expect([v?.text, v?.tone, v?.action?.kind, v?.action?.label]).toEqual([
      AGENT_UPDATE_WORDS.failed,
      'bad',
      'retry',
      'Try again',
    ]);
  });

  it('offers Update now where another server stopped the rollout', () => {
    const v = agentUpdatesView(input({ available: true, state: 'halted' }));
    expect([v?.tone, v?.action?.kind]).toEqual(['warn', 'now']);
  });

  it('offers Update the agent where Whombat may do the last install, else the install command (AU-07)', () => {
    for (const reasonCode of ['no_key', 'other_key'] as const) {
      const may = agentUpdatesView(input({ available: false, reasonCode, canInstall: true }));
      expect([may?.text, may?.action?.kind, may?.command]).toEqual([
        AGENT_UPDATE_WORDS.needsInstall,
        'install',
        false,
      ]);
      const mayNot = agentUpdatesView(input({ available: false, reasonCode, canInstall: false }));
      expect([mayNot?.action, mayNot?.command]).toEqual([null, true]);
    }
    // A last install that failed: Try again where Whombat may, the command where it may not.
    expect(
      agentUpdatesView(input({ available: false, reasonCode: 'no_key', canInstall: true, state: 'failed' }))
        ?.action?.kind,
    ).toBe('retry');
    const failedNoShell = agentUpdatesView(
      input({ available: false, reasonCode: 'no_key', state: 'failed' }),
    );
    expect([failedNoShell?.action, failedNoShell?.command]).toEqual([null, true]);
  });

  it('says the server itself turned updates off, without a button', () => {
    const v = agentUpdatesView(input({ available: true, reasonCode: 'turned_off', state: 'failed' }));
    expect([v?.text, v?.action, v?.command]).toEqual([
      'Updates are turned off on pve-01 itself.',
      null,
      false,
    ]);
  });

  it('offers Update now when automatic updates are off and a new version waits', () => {
    const v = agentUpdatesView(input({ available: true, auto: false }, { autoUpdate: false }));
    expect([v?.text, v?.action?.kind]).toEqual([AGENT_UPDATE_WORDS.autoOff, 'now']);
    // On, the round takes it in a few minutes.
    expect(agentUpdatesView(input({ available: true, auto: true }))?.text).toBe(AGENT_UPDATE_WORDS.soon);
  });
});

describe('the switch', () => {
  it('is on, off or stopped', () => {
    expect(agentSettingsView({ autoUpdate: true, halted: false })).toMatchObject({
      title: AGENT_UPDATE_WORDS.switchTitle,
      on: true,
      tone: 'ok',
    });
    expect(agentSettingsView({ autoUpdate: false, halted: false }).meta).toBe(AGENT_UPDATE_WORDS.switchOff);
    expect(agentSettingsView({ autoUpdate: true, halted: true })).toMatchObject({
      meta: AGENT_UPDATE_WORDS.switchHalted,
      tone: 'warn',
    });
  });
});
