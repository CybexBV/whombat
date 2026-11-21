import { api } from '@whombat/core/contracts';
import { describe, expect, it } from 'vitest';
import { createAutomationFixtures } from './automations';

describe('the demo world’s automations (AP-6312)', () => {
  it('lists three valid automations, one with a run waiting for a yes', async () => {
    const world = createAutomationFixtures();
    const res = world.handle('automations.list', { burrow: 'burrow-hq' });
    const body = api.automations.list.response.parse(await res?.json());
    expect(body.automations.map((a) => a.glance?.source)).toEqual(['tracker', 'github', 'schedule']);
    // Each has a definition, so its page says what happens step by step.
    expect(body.automations.every((a) => a.definition !== null)).toBe(true);
    expect(body.automations.some((a) => a.lastRun?.waitingOn === 'approval')).toBe(true);
  });

  it('answers one automation and its runs, as the page reads them', async () => {
    const world = createAutomationFixtures();
    const one = api.automations.get.response.parse(
      await world.handle('automations.get', { burrow: 'burrow-hq', id: 'aut_tracker' })?.json(),
    );
    expect(one.automation.name).toContain('Acme Desk');
    const runs = api.automations.runs.response.parse(
      await world
        .handle(
          'automations.runs',
          { burrow: 'burrow-hq' },
          undefined,
          'http://x/automation-runs?automation=aut_tracker',
        )
        ?.json(),
    );
    expect(runs.runs.length).toBeGreaterThan(0);
    expect(runs.runs.every((r) => r.automationId === 'aut_tracker')).toBe(true);
  });

  it('switches one off in memory', async () => {
    const world = createAutomationFixtures();
    const off = world.handle(
      'automations.setEnabled',
      { burrow: 'burrow-hq', id: 'aut_morning' },
      {
        body: JSON.stringify({ enabled: false }),
      },
    );
    expect(api.automations.setEnabled.response.parse(await off?.json()).automation.status).toBe('disabled');
    const list = api.automations.list.response.parse(
      await world.handle('automations.list', { burrow: 'burrow-hq' })?.json(),
    );
    expect(list.automations.find((a) => a.id === 'aut_morning')?.status).toBe('disabled');
  });
});
