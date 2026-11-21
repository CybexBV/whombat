/** REST read models and message actions against the seeded test world. */
import { keyRows, MESSAGE_MAX_LENGTH, MESSAGE_TOO_LONG, MessagePage, RunDetail } from '@whombat/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadGrants } from '../read/principals';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';

const t = useTestServer({ seed: true, app: true });
let mara = '';

beforeAll(async () => {
  mara = (await sessionFor(t.services, IDS.mara)).cookie;
});

const get = (url: string, cookie = mara) =>
  t.api.inject({ method: 'GET', url: `/api/v1/burrows/burrow-hq${url}`, headers: { cookie } });
const post = (url: string, payload: unknown, cookie = mara) =>
  t.api.inject({
    method: 'POST',
    url: `/api/v1/burrows/burrow-hq${url}`,
    headers: { cookie },
    payload: payload as object,
  });

describe('conversations and messages', () => {
  it('reads a conversation and pages top-level messages backwards with a cursor', async () => {
    const channel = await get(`/conversations/${IDS.billing}`);
    expect(channel.json()).toMatchObject({
      conversation: { id: IDS.billing, actions: [{ label: 'Plan canvas' }, { label: 'Branch room' }] },
    });
    const first = MessagePage.parse((await get(`/conversations/${IDS.billing}/messages?limit=3`)).json());
    expect(first.messages.map((m) => m.id)).toEqual([
      'msg_billing-waffle-1120',
      'msg_billing-banjo-1122',
      'msg_billing-neo-1125',
    ]);
    expect(first.hasMore).toBe(true);
    const second = MessagePage.parse(
      (await get(`/conversations/${IDS.billing}/messages?limit=3&before=${first.before}`)).json(),
    );
    expect(second.messages.map((m) => m.id)).toEqual([
      'msg_billing-toffee-0913',
      'msg_billing-dusty-0941',
      'msg_billing-joris-1002',
    ]);
    const cards = Object.fromEntries(first.messages.map((m) => [m.id, m.card?.kind ?? null]));
    expect(cards).toEqual({
      'msg_billing-waffle-1120': null,
      'msg_billing-banjo-1122': 'run',
      'msg_billing-neo-1125': 'approval',
    });
    const joris = second.messages.find((m) => m.id === 'msg_billing-joris-1002');
    expect(joris?.reactions).toEqual([{ value: '+1', count: 1, mine: false, principalIds: [IDS.dusty] }]);
    const dusty = second.messages.find((m) => m.id === 'msg_billing-dusty-0941');
    expect(dusty).toMatchObject({ replyCount: 2, threadParticipantIds: [IDS.mara, IDS.dusty] });
  });

  it('takes a long message up to 48 000 characters within 48 KiB of JSON (CT-151, UI-R15)', async () => {
    const long = await post(`/conversations/${IDS.billing}/messages`, {
      text: 'a'.repeat(MESSAGE_MAX_LENGTH),
    });
    expect(long.statusCode).toBe(201);
    const over = await post(`/conversations/${IDS.billing}/messages`, {
      text: 'a'.repeat(MESSAGE_MAX_LENGTH + 1),
    });
    expect(over.statusCode).toBe(400);
    // Quotes take two bytes of JSON each: short enough in characters, too big as JSON.
    const quoted = await post(`/conversations/${IDS.billing}/messages`, { text: '"'.repeat(30_000) });
    expect(quoted.statusCode).toBe(400);
    expect(JSON.stringify(quoted.json())).toContain(MESSAGE_TOO_LONG);
  });
});

describe('runs, approvals, agents', () => {
  it('serves the run page with the log tail and the agent’s keys', async () => {
    const run = RunDetail.parse((await get('/runs/1907')).json());
    expect(run.run).toMatchObject({ number: 1907, status: 'live', agentId: IDS.dusty, logCount: 5 });
    expect(run.log.map((l) => l.text).at(-1)).toContain('PR #482');
    // The agent's keys as it holds them (one key set, one-agent.md OA-05), allowed first, then asks, then no key.
    const held = await loadGrants(t.services.db, IDS.dusty);
    expect(run.grants.map((g) => `${g.keyId}:${g.tier}`).sort()).toEqual(
      held.map((g) => `${g.keyId}:${g.tier}`).sort(),
    );
    const marks = keyRows(run.grants).map((r) => r.mark);
    expect(marks).toEqual([...marks].sort((a, b) => '✓?×'.indexOf(a) - '✓?×'.indexOf(b)));
    const log = (await get('/runs/1907/log?after=2')).json();
    expect(log.lines.map((l: { seq: number }) => l.seq)).toEqual([3, 4]);
  });
});

describe('audit log', () => {
  it('walks the whole chain', async () => {
    const res = await get('/audit/verify');
    expect(res.json()).toMatchObject({ ok: true, failures: [] });
  });
});
