/**
 * Cards that settle into a line (docs/decisions/card-settle.md QC-01, QC-02; contracts CT-261): a run says which thread
 * its card is in, a schedule card says which run it came out of. (Skill cards went with the skill store, HE-41.)
 */
import type { RealtimeEvent } from '@whombat/core';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AgentAuth } from '../auth/agent-tokens';
import { messages, runs } from '../db/schema/index';
import { callTool } from '../mcp/server';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { accountOf, agentTokenFor } from '../test/tokens';
import { loadMessage } from './messages';
import { loadRun } from './work';

const t = useTestServer({ seed: true, app: true });
const RUN = 'run_1907';
const RUN_CARD = 'msg_billing-banjo-1122';
const frames: RealtimeEvent[] = [];
let mara = '';

beforeAll(async () => {
  mara = await accountOf(t.services, IDS.mara);
  t.services.bus.onFrame((f) => frames.push(f.event));
});

type Out = Record<string, unknown> & { status?: string; proposalId?: string; messageId?: string };

/** A turn of Dusty's in #billing: on `runId` when given, in `threadRootId` when given, for Mara. */
async function turn(opts: { runId?: string | null; threadRootId?: string | null } = {}) {
  const { dispatchId } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.billing, {
    mode: opts.runId ? 'run' : 'reply',
    trigger: opts.runId ? 'run_control' : 'mention',
    runId: opts.runId ?? null,
    threadRootId: opts.threadRootId ?? null,
    onBehalfOfAccountId: mara,
  });
  const auth: AgentAuth = { dispatchId, agentId: IDS.dusty, burrowId: t.burrowId };
  const call = async (tool: 'schedule', args: Record<string, unknown>) =>
    (await callTool(t.services, auth, tool, args)).structuredContent as Out;
  return {
    dispatchId,
    schedule: () =>
      call('schedule', {
        action: 'create',
        when: { kind: 'every', minutes: 60 },
        prompt: 'Check the staging deploy.',
      }),
  };
}

describe('a run’s thread (QC-01)', () => {
  it('is null while its card is in the conversation itself', async () => {
    expect((await loadRun(t.services.db, RUN))?.threadRootId).toBeNull();
  });

  it('is the root of the thread its card is in, on the run and on the run card', async () => {
    const root = 'msg_billing-waffle-1120';
    await t.services.db.update(messages).set({ threadRootId: root }).where(eq(messages.id, RUN_CARD));
    try {
      expect((await loadRun(t.services.db, RUN))?.threadRootId).toBe(root);
      const card = (await loadMessage(t.services.db, RUN_CARD, IDS.mara))?.card;
      expect(card).toMatchObject({ kind: 'run', run: { id: RUN, threadRootId: root } });
    } finally {
      await t.services.db.update(messages).set({ threadRootId: null }).where(eq(messages.id, RUN_CARD));
    }
  });

  it('is null for a run without a card', async () => {
    await t.services.db.update(runs).set({ messageId: null }).where(eq(runs.id, RUN));
    try {
      expect((await loadRun(t.services.db, RUN))?.threadRootId).toBeNull();
    } finally {
      await t.services.db.update(runs).set({ messageId: RUN_CARD }).where(eq(runs.id, RUN));
    }
  });
});

describe('the run a schedule came out of (QC-02)', () => {
  it('is on a schedule card made in a run’s turn, and absent outside one', async () => {
    const inRun = await (await turn({ runId: RUN })).schedule();
    expect(inRun.status, JSON.stringify(inRun)).toBe('ok');
    const [made] = await t.services.db
      .select()
      .from(messages)
      .where(sql`${messages.card}->>'scheduleId' = ${(inRun.schedule as { id: string }).id}`);
    expect(made?.card).toMatchObject({ kind: 'schedule', runId: RUN });
    const resolved = (await loadMessage(t.services.db, made?.id as string, IDS.mara))?.card;
    expect(resolved).toMatchObject({
      kind: 'schedule',
      runId: RUN,
      schedule: { prompt: 'Check the staging deploy.' },
    });

    const outside = await (await turn()).schedule();
    expect(outside.status, JSON.stringify(outside)).toBe('ok');
    const [plain] = await t.services.db
      .select()
      .from(messages)
      .where(sql`${messages.card}->>'scheduleId' = ${(outside.schedule as { id: string }).id}`);
    expect(plain?.card).not.toHaveProperty('runId');
  });
});
