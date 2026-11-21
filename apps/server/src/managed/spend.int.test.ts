/**
 * Spend over a managed session (docs/decisions/spend.md SP-01, SP-02, SP-D07): `spend.overview`, `spend.week` and
 * `spend.daily` (box-status.md BS-07) are allowlisted by the protocol (every `api.<area>.<action>`) and answered by the
 * REST handlers in-process: the person sees the burrow's.
 */
import type { SpendAgentWeek, SpendDaily, SpendOverview } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { dispatches, principals } from '../db/schema/index';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';

const m = useManagedRuntime({ seed: true });
let mara: Awaited<ReturnType<typeof m.enroll>>;
const B = { burrow: 'burrow-hq' };

type Out<T> = { t: string; output?: T; code?: string };

beforeAll(async () => {
  mara = await m.enroll(IDS.mara);
  const accountOf = async (id: string) =>
    (await m.t.services.db.select().from(principals).where(eq(principals.id, id)))[0]?.accountId ?? null;
  const at = new Date(m.t.services.clock().getTime() - 3_600_000);
  for (const [id, person, tokens] of [
    ['sp_mgd-mara', IDS.mara, 4000],
    ['sp_mgd-dusty', IDS.mara, 600],
  ] as const)
    await m.t.services.db.insert(dispatches).values({
      id,
      burrowId: TEST_BURROW_ID,
      agentId: IDS.dusty,
      trigger: 'mention',
      conversationId: IDS.billing,
      state: 'done',
      attempts: 1,
      createdAt: at,
      finishedAt: at,
      usage: { inputTokens: tokens, outputTokens: 0 },
      onBehalfOfAccountId: await accountOf(person),
    });
});

describe('spend over a session', () => {
  it('serves the overview: the burrow', async () => {
    const answer = (await (
      await m.client(mara)
    ).request('spend.overview', { params: B })) as Out<SpendOverview>;
    expect(answer.t).toBe('result');
    expect(answer.output).toMatchObject({ totals: { week: { turns: 2, inputTokens: 4600 } } });
  });

  it('serves the agent’s week (one-agent.md OA-S36)', async () => {
    const answer = (await (await m.client(mara)).request('spend.week', { params: B })) as Out<SpendAgentWeek>;
    expect(answer.output).toMatchObject({ week: { turns: 2 } });
  });

  it('serves the turns per day (BS-07)', async () => {
    // Both turns finished an hour ago: today, or yesterday just after midnight.
    const total = (d: SpendDaily | undefined) => ({
      turns: d?.days.reduce((n, day) => n + day.turns, 0),
      inputTokens: d?.days.reduce((n, day) => n + day.inputTokens, 0),
    });
    const answer = (await (await m.client(mara)).request('spend.daily', { params: B })) as Out<SpendDaily>;
    expect(answer.t).toBe('result');
    expect(answer.output?.days).toHaveLength(30);
    expect(total(answer.output)).toEqual({ turns: 2, inputTokens: 4600 });
  });
});
