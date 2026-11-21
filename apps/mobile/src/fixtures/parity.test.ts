/**
 * The demo world's parity data (mobile-parity.md MQ-01, MQ-05, MQ-07) through the real client and the fixture server:
 * the agent's schedules, notes, always-allowed command and services (Settings → Agent's parts, AP-4961, AP-5760) and the
 * writes that change them; the canvas text and the deployments `@whombat/fixtures` serves.
 */
import { api } from '@whombat/core';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { describe, expect, it } from 'vitest';
import { deployBoard } from '../data/deploys';
import { scheduleRows } from '../data/schedules';
import { serviceRows } from '../data/services';
import { demoClient } from '../demo/session';
import { createClock } from '../lib/time';
import { minutesAfterSeed, worldContext } from '../test/world';
import { createFixtureServer } from './fixture-server';

const burrow = 'burrow-hq';

function setup() {
  const now = createClock(minutesAfterSeed(0), Date.now());
  const server = createFixtureServer({ inner: createFixtureFetch(), now, setTimer: () => 0 });
  return demoClient(server.fetch);
}

describe('Settings → Agent’s parts in the demo world', () => {
  it('Neo’s schedules pause and resume, and Remove ends one', async () => {
    const client = setup();
    const ctx = worldContext();
    const list = await client.request(api.schedules.list, { params: { burrow } });
    if (list.status !== 'ok') throw new Error(list.status);
    const rows = scheduleRows(list.data.schedules, 'Neo', ctx.timeZone, ctx.now);
    expect(rows.map((r) => r.actions)).toEqual([
      ['pause', 'remove'],
      ['resume', 'remove'],
    ]);
    const paused = await client.request(api.schedules.pause, {
      params: { burrow, scheduleId: 'sch_backups' },
    });
    expect(paused.status === 'ok' && paused.data.schedule.status).toBe('paused');
    const removed = await client.request(api.schedules.remove, {
      params: { burrow, scheduleId: 'sch_incidents' },
    });
    expect(removed.status === 'ok' && removed.data.schedule.status).toBe('ended');
  });

  it('Neo’s notes are read and saved, and Mara’s memory is read and cleared (CT-1200…CT-1205)', async () => {
    const client = setup();
    const notes = await client.request(api.memory.notes, { params: { burrow } });
    expect(notes.status).toBe('ok');
    const saved = await client.request(api.memory.setNotes, {
      params: { burrow },
      body: { text: 'The NAS backs up at 2:00.' },
    });
    expect(saved.status === 'ok' && saved.data.used).toBe('The NAS backs up at 2:00.'.length);
    const mine = await client.request(api.memory.mine, { params: { burrow } });
    if (mine.status !== 'ok') throw new Error(mine.status);
    expect(mine.data.memory.used).toBeGreaterThan(0);
    const cleared = await client.request(api.memory.clear, { params: { burrow }, query: { file: 'user' } });
    expect(cleared.status === 'ok' && cleared.data.user.used).toBe(0);
  });

  it('the agent’s command goes, and a service it runs stops (OP-19)', async () => {
    const client = setup();
    const ctx = worldContext();
    const got = await client.request(api.services.list, { params: { burrow } });
    if (got.status !== 'ok') throw new Error(got.status);
    const rows = serviceRows(got.data.services, { now: ctx.now, timeZone: ctx.timeZone });
    const running = rows.find((r) => r.canStop);
    if (!running) throw new Error('no running service');
    expect(running.line).toContain('Running');
    const stopped = await client.request(api.services.stop, { params: { burrow }, body: { id: running.id } });
    expect(stopped.status === 'ok' && stopped.data.service.state).toBe('stopped');
    const allowances = await client.request(api.agent.commandAllowances, {
      params: { burrow },
    });
    expect(allowances.status === 'ok' && allowances.data.allowances).toHaveLength(1);
    const after = await client.request(api.agent.removeCommandAllowance, {
      params: { burrow, allowanceId: 'cma_staging' },
    });
    expect(after.status === 'ok' && after.data.allowances).toEqual([]);
  });

  it('serves a canvas’s text and the deploys board (contracts 0.55)', async () => {
    const client = setup();
    const canvases = await client.request(api.canvases.list, { params: { burrow } });
    if (canvases.status !== 'ok') throw new Error(canvases.status);
    const slug = canvases.data.canvases[0]?.slug ?? '';
    const content = await client.request(api.canvases.content, { params: { burrow, slug } });
    expect(content.status === 'ok' && content.data.markdown.length).toBeGreaterThan(0);
    const envs = await client.request(api.deployments.environments, { params: { burrow } });
    if (envs.status !== 'ok') throw new Error(envs.status);
    expect(deployBoard(envs.data.environments, worldContext()).map((e) => e.environment)).toContain(
      'production',
    );
  });
});
