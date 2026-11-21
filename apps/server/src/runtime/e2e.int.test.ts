/**
 * Server + runner in one process with the scripted Hermes (hermes-engine.md HE-33), over real HTTP: a mention gets the
 * canned reply (thinking indicator, posted through MCP, signed as the agent), thread replies stay in the thread,
 * search questions get an answer with receipts, and Pause / Take over stop the turn and Resume continues it on the same
 * Hermes session.
 */
import { CANNED_REPLY } from '@whombat/agent-runtime/testing/hermes';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { askSearch } from '../commands/content';
import { sendMessage } from '../commands/messages';
import { pauseRun, resumeRun, takeOverRun } from '../commands/runs';
import { dispatches, messages, runLog, runs, searchAnswers } from '../db/schema/index';
import { enqueueDispatches } from '../domain/dispatch';
import { loadAgentRow } from '../read/principals';
import type { BusFrame } from '../realtime/bus';
import { IDS } from '../seed/test-world';
import { connectGitHubAs, signInsEnv } from '../test/github';
import { grantKey } from '../test/grants';
import { useTestServer } from '../test/harness';
import { chatWith } from '../test/rooms';
import { checkoutEnv, startTestRunner, type TestRunner, waitFor } from '../test/runner';
import { SCRIPTED_ENV } from '../test/scripted';

const t = useTestServer({
  seed: true,
  listen: true,
  env: { ...checkoutEnv(), ...SCRIPTED_ENV, ...signInsEnv() },
});
// Runs check their branch out on Mara's own GitHub sign-in, the burrow's connection (HE-S166).
beforeAll(() => connectGitHubAs(t.services, IDS.mara));
let runner: TestRunner;
const frames: BusFrame[] = [];

beforeAll(async () => {
  t.services.bus.onFrame((f) => frames.push(f));
  runner = await startTestRunner(t.baseUrl, { thinkMs: 60, tickMs: 120 });
});

afterAll(async () => {
  await runner?.stop();
});

async function say(actorId: string, conversationId: string, text: string, threadRootId?: string) {
  const res = await t.commit(actorId, sendMessage, {
    conversationId,
    text,
    ...(threadRootId ? { threadRootId } : {}),
  });
  if (res.status !== 'ok') throw new Error('send failed');
  return res.result.id;
}

async function replyAfter(conversationId: string, authorId: string, afterId: string) {
  const [after] = await t.services.db.select().from(messages).where(eq(messages.id, afterId));
  if (!after) return null;
  const [reply] = await t.services.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.authorId, authorId),
        gt(messages.ord, after.ord),
      ),
    )
    .orderBy(asc(messages.ord));
  return reply ?? null;
}

describe('the canned reply flow', () => {
  it('a message in a person’s Chat: "{name} is thinking", then the canned reply signed by the agent', async () => {
    const chat = await chatWith(t.services, t.burrowId, IDS.dusty, IDS.mara);
    const asked = await say(IDS.mara, chat, '@Dusty can you look at the PDF cache?');
    const reply = await waitFor(() => replyAfter(chat, IDS.dusty, asked), 10_000, 'Dusty’s reply');
    expect(reply.text).toBe(CANNED_REPLY);
    // In a person's Chat the answer goes in a thread under their message (chat-channel.md CHT-02).
    expect(reply.threadRootId).toBe(asked);
    const thinking = frames.filter(
      (f) =>
        f.event.type === 'typing' && f.event.principalId === IDS.dusty && f.event.conversationId === chat,
    );
    expect(thinking.some((f) => f.event.type === 'typing' && f.event.active)).toBe(true);
    await waitFor(
      () =>
        !t.services.typing.isActive({
          conversationId: chat,
          threadRootId: asked,
          principalId: IDS.dusty,
        }),
      5000,
      'the indicator to clear',
    );
    const [d] = await t.services.db
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.messageId, asked), eq(dispatches.agentId, IDS.dusty)));
    await waitFor(
      async () =>
        (
          await t.services.db
            .select()
            .from(dispatches)
            .where(eq(dispatches.id, d?.id ?? ''))
        ).at(0)?.state === 'done',
    );
  });

  it('a reply in a thread is answered in the thread; a DM gets an answer too', async () => {
    const root = await say(IDS.mara, IDS.billing, 'Who owns the PDF cache?');
    const asked = await say(IDS.mara, IDS.billing, '@Dusty can you add it to the plan?', root);
    const reply = await waitFor(
      async () => {
        const rows = await t.services.db
          .select()
          .from(messages)
          .where(and(eq(messages.threadRootId, root), eq(messages.authorId, IDS.dusty)));
        return rows[0];
      },
      10_000,
      'Dusty in the thread',
    );
    expect(reply.text).toBe(CANNED_REPLY);
    expect(asked).toBeTruthy();

    const dm = await say(IDS.mara, IDS.dmDusty, 'Anything new on invoice numbering?');
    const answer = await waitFor(() => replyAfter(IDS.dmDusty, IDS.dusty, dm), 10_000, 'Dusty in the DM');
    expect(answer.text).toBe(CANNED_REPLY);
  });

  it('two quick mentions coalesce into one turn and one reply', async () => {
    const first = await say(IDS.mara, IDS.incidents, '@Dusty did the nightly sync finish?');
    await say(IDS.mara, IDS.incidents, '@Dusty and were there retries?');
    await waitFor(() => replyAfter(IDS.incidents, IDS.dusty, first), 10_000, 'Dusty’s reply');
    await new Promise((r) => setTimeout(r, 400));
    const [row] = await t.services.db.select().from(messages).where(eq(messages.id, first));
    const replies = await t.services.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, IDS.incidents),
          eq(messages.authorId, IDS.dusty),
          gt(messages.ord, row?.ord ?? 0),
        ),
      );
    // One turn for the queued pair; a mention that lands mid-turn may add exactly one follow-up.
    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(replies.length).toBeLessThanOrEqual(2);
  });

  it('a search question gets the agent’s answer with its receipts', async () => {
    // The agent answers searches (one-agent.md OA-S46), holding “Search messages”.
    const agent = await loadAgentRow(t.services.db, t.burrowId);
    if (!agent) throw new Error('no agent');
    await grantKey(t, agent.id, 'messages.search');
    const asked = await t.commit(IDS.mara, askSearch, {
      q: 'have we seen this invoice rounding error before?',
    });
    if (asked.status !== 'ok') throw new Error('ask failed');
    const answer = await waitFor(
      async () => {
        const [row] = await t.services.db
          .select()
          .from(searchAnswers)
          .where(eq(searchAnswers.id, asked.result.answerId));
        return row?.status === 'ready' ? row : null;
      },
      10_000,
      'the answer',
    );
    expect(answer.agentId).toBe(agent.id);
    // The mock's answer (the fixtures' words), one marker per receipt.
    for (const fact of ['[1]', '[2]', '[3]', 'PR #482']) expect(answer.text).toContain(fact);
    expect(answer.citations.map((c) => c.resultId)).toEqual([
      'hist_thread-credit-note',
      'hist_pr-311',
      'hist_run-1882',
    ]);
  });
});

describe('pause, resume and take over', () => {
  async function logCount() {
    const [row] = await t.services.db.select().from(runs).where(eq(runs.number, 1907));
    return row?.logCount ?? 0;
  }

  async function playRun() {
    const [queued] = await enqueueDispatches(t.services, {
      burrowId: t.burrowId,
      causedById: IDS.mara,
      conversationId: IDS.billing,
      messageId: null,
      threadRootId: null,
      requests: [{ agentId: IDS.dusty, trigger: 'run_control', mode: 'run' }],
      at: new Date(),
      runId: 'run_1907',
    });
    return queued?.dispatchId ?? '';
  }

  it('pause stops the turn mid-run; resume continues on the same session from the last line', async () => {
    const base = await logCount();
    const first = await playRun();
    await waitFor(async () => (await logCount()) >= base + 2, 10_000, 'two live lines');
    await t.commit(IDS.mara, pauseRun, { number: 1907 });
    const paused = await waitFor(
      async () => {
        const [d] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, first));
        return d?.state === 'cancelled' ? d : null;
      },
      10_000,
      'the turn to stop',
    );
    expect(paused.cancelReason).toBe('paused');
    // The run's Hermes session, kept for Resume.
    const session = paused.providerSessionId;
    expect(session).toMatch(/^hermes:local-[0-9a-f]{64}$/);
    const atPause = await logCount();
    await new Promise((r) => setTimeout(r, 400));
    expect(await logCount()).toBe(atPause);

    await t.commit(IDS.mara, resumeRun, { number: 1907 });
    const done = await waitFor(
      async () => {
        const [r] = await t.services.db.select().from(runs).where(eq(runs.number, 1907));
        return r?.status === 'done' ? r : null;
      },
      20_000,
      'the run to finish',
    );
    expect(done.logCount).toBe(base + 8);
    const lines = await t.services.db
      .select()
      .from(runLog)
      .where(eq(runLog.runId, 'run_1907'))
      .orderBy(asc(runLog.seq));
    expect(lines.at(-1)?.text).toMatch(/^Pushed 7be20f/);
    // No line played twice across the pause.
    const live = lines.slice(base).map((l) => l.text);
    expect(new Set(live).size).toBe(live.length);
    // The run page and run card streamed it: log lines on `run:`, the run on `run:` and `burrow:`.
    const streamed = frames.flatMap((f) =>
      f.event.type === 'run.log' && f.topic === 'run:run_1907' ? f.event.lines.map((l) => l.text) : [],
    );
    expect(streamed).toEqual(live);
    const cardFrames = frames.filter(
      (f) =>
        f.event.type === 'run.updated' &&
        f.topic === `burrow:${t.burrowId}` &&
        f.event.run.conversationId === IDS.billing,
    );
    expect(cardFrames.length).toBeGreaterThan(8);
    const [resumed] = await t.services.db
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.runId, 'run_1907'), eq(dispatches.trigger, 'run_control')))
      .orderBy(desc(dispatches.createdAt));
    expect(resumed?.providerSessionId).toBe(session);
  });

  it('take over stops the agent and hands the run to the person', async () => {
    const [started] = await t.services.db.select().from(runs).where(eq(runs.number, 1907));
    // Put the run back to live for this test (the previous one finished it).
    await t.services.db
      .update(runs)
      .set({ status: 'live', activity: 'Reading Dusty’s review on PR #482', finishedAt: null })
      .where(eq(runs.id, started?.id ?? ''));
    const base = await logCount();
    const dispatchId = await playRun();
    await waitFor(async () => (await logCount()) >= base + 1, 10_000, 'a live line');
    await t.commit(IDS.mara, takeOverRun, { number: 1907 });
    await waitFor(
      async () => {
        const done = runner.outcomes.find((o) => o.dispatchId === dispatchId);
        return done ? done : null;
      },
      10_000,
      'the turn to stop',
    );
    const outcome = runner.outcomes.find((o) => o.dispatchId === dispatchId)?.outcome;
    expect(outcome).toMatchObject({ outcome: 'cancelled', reason: 'taken_over' });
    const after = await logCount();
    await new Promise((r) => setTimeout(r, 400));
    expect(await logCount()).toBe(after);
    const [run] = await t.services.db.select().from(runs).where(eq(runs.number, 1907));
    expect(run).toMatchObject({ status: 'taken_over', takenOverById: IDS.mara });
  });
});
