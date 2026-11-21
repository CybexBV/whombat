import { type AnyEndpoint, api } from '@whombat/core/contracts';
import { burrow } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { createWebFixtureFetch } from './fixtureFetch';
import { DEFAULT_CHAT_ID } from './oneFixtures';
import { SCHEDULE_MESSAGE } from './resourcefulFixtures';

const B = `/api/v1/burrows/${burrow.slug}`;
/** The one agent's paths (one-agent.md AP-4921; contracts OA-19: no handle). */
const AGENT = '/agent';

function world(options: Parameters<typeof createWebFixtureFetch>[0] = { resourceful: true }) {
  const fetch = createWebFixtureFetch(options);
  async function call<E extends AnyEndpoint>(
    ep: E,
    path: string,
    init?: { method?: string; body?: unknown },
  ) {
    const res = await fetch(`http://fixtures.local${B}${path}`, {
      method: init?.method ?? ep.method,
      headers: { 'content-type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const body = await res.json();
    if (!res.ok) return { status: res.status, data: null, error: body as { error: { code: string } } };
    const parsed = ep.response.safeParse(body);
    if (!parsed.success) throw new Error(`${ep.id}: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`);
    return { status: res.status, data: parsed.data as ReturnType<E['response']['parse']>, error: null };
  }
  return { fetch, call };
}

describe('the resourceful agents’ fixture world (AP-686)', () => {
  it('answers what the agent remembers and its notes to the contract (CT-1200…CT-1205)', async () => {
    const { call } = world();
    const mine = await call(api.memory.mine, '/memory');
    expect(mine.data?.memory.used).toBeGreaterThan(0);
    const version = mine.data?.user.version ?? '';
    const written = await call(api.memory.write, '/memory/user', {
      body: { text: 'Prefers short answers.', ifVersion: version },
    });
    expect(written.data?.user.text).toBe('Prefers short answers.');
    const stale = await call(api.memory.write, '/memory/user', { body: { text: 'x', ifVersion: version } });
    expect(stale.error?.error.code).toBe('conflict');
    const notes = await call(api.memory.notes, `${AGENT}/notes`);
    expect(notes.data?.limit).toBeGreaterThan(0);
    const saved = await call(api.memory.setNotes, `${AGENT}/notes`, {
      body: { text: 'Ask before restarts.' },
    });
    expect(saved.data?.text).toBe('Ask before restarts.');
  });

  it('answers schedules and the LAN switch to the contract', async () => {
    const { call } = world({ resourceful: true });

    const schedules = await call(api.schedules.list, `${AGENT}/schedules`);
    expect(schedules.data?.schedules.map((s) => s.status)).toEqual(['active', 'active', 'paused', 'ended']);
    const paused = await call(api.schedules.pause, `${AGENT}/schedules/sch_backups/pause`);
    expect(paused.data?.schedule.status).toBe('paused');
    const resumed = await call(api.schedules.resume, `${AGENT}/schedules/sch_weekly/resume`);
    expect(resumed.data?.schedule).toMatchObject({ status: 'active', endedReason: null });
    const gone = await call(api.schedules.remove, `${AGENT}/schedules/sch_deploycheck`, {
      method: 'DELETE',
    });
    expect(gone.data?.schedule).toMatchObject({ status: 'ended', endedReason: 'cancelled' });

    const lan = await call(api.burrows.setAgentsReachLan, '/agents-reach-lan', {
      body: { agentsReachLan: false },
    });
    expect(lan.data?.burrow.agentsReachLan).toBe(false);
    expect((await call(api.conversations.bootstrap, '/bootstrap')).data?.burrow.agentsReachLan).toBe(false);
  });

  it('puts the weekday schedule’s card in Mara’s Chat only when seeded', async () => {
    const seeded = world();
    const page = await seeded.call(api.messages.list, `/conversations/${DEFAULT_CHAT_ID}/messages`);
    const card = page.data?.messages.find((m) => m.id === SCHEDULE_MESSAGE)?.card;
    expect(card).toMatchObject({ kind: 'schedule', scheduleId: 'sch_backups' });
    const plain = world({ resourceful: false });
    const none = await plain.call(api.messages.list, `/conversations/${DEFAULT_CHAT_ID}/messages`);
    expect(none.data?.messages.some((m) => m.id === SCHEDULE_MESSAGE)).toBe(false);
  });
});
