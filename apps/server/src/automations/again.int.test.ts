/**
 * A fix that doesn't get through goes round again by itself (`again.ts`), for a person's own automation whose agent
 * steps are named `fix` and `review`, on a real database with FAKE AGENTS (test/automations.ts): a fresh deadline each
 * time, steps that only said something stay said, its words neither T3 Code's nor a checkout's; a broken review done
 * again once in each try without using a try up; what earlier tries used still counts against the run's and the day's
 * limits; a run stopped just as it would go again stays stopped; and a fix branch GitHub can't read is no progress.
 */
import type { AutomationDefinitionInput, AutomationRun } from '@whombat/core';
import { and, asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { automations, dispatches, events } from '../db/schema/index';
import { FakeGitHub } from '../github/fake';
import { IDS, useAutomationWorld } from '../test/automations';
import { FIX_TRIES_MAX, REVIEW_REDO_LINE } from './again';
import { controlAutomationRun, runAutomationNow } from './commands';
import { loadRunRow } from './store';

const w = useAutomationWorld();
const REPO = 'whombat/billing';
const BRANCH = 'fix/rounding';

const fake = (): FakeGitHub => {
  const f = w.services.github.fake;
  if (!f) throw new Error('no FakeGitHub');
  return f;
};

const tries = (n: number) => {
  w.services.automations.options.fixTriesMax = n;
};
afterEach(() => tries(FIX_TRIES_MAX));

type Limits = AutomationDefinitionInput['limits'];
const LIMITS = { runTimeoutMinutes: 60, maxConcurrentRuns: 1, maxRunsPerDay: 10 };

/** A fix, a line saying it is ready, its review; with `pr`, its pull request when the review approves. */
function definition(
  o: { limits?: Partial<NonNullable<Limits>>; pr?: boolean } = {},
): AutomationDefinitionInput {
  return {
    version: 1,
    conversationId: IDS.billing,
    triggers: [{ kind: 'manual' }],
    limits: { ...LIMITS, ...o.limits },
    steps: [
      { id: 'fix', kind: 'dispatch_agent', prompt: 'Fix the rounding in totals.ts.' },
      { id: 'said', kind: 'post_message', text: 'The fix is ready for its review.' },
      {
        id: 'review',
        kind: 'dispatch_agent',
        verdict: true,
        prompt: 'Review the fix: {{steps.fix.reply}}',
      },
      ...(o.pr
        ? ([
            { id: 'approved', kind: 'condition', if: 'steps.review.verdict == "approve"', else: 'stop' },
            {
              id: 'pr',
              kind: 'open_pull_request',
              repo: REPO,
              branch: BRANCH,
              title: 'Round once',
              body: '{{steps.fix.reply}}',
            },
          ] as AutomationDefinitionInput['steps'])
        : []),
    ],
  } as AutomationDefinitionInput;
}

async function start(automationId: string) {
  const { runId } = await w.ok(IDS.mara, runAutomationNow, { automationId, test: false });
  await w.settle();
  return runId as string;
}

const step = (run: AutomationRun, id: string) => {
  const s = run.steps.find((x) => x.stepId === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
};

/** The FAKE AGENT answers step `id`'s turn, which used `usage` when given. */
async function answer(
  runId: string,
  id: string,
  text: string,
  usage?: { inputTokens: number; outputTokens: number },
) {
  const dispatchId = step(await w.run(runId), id).dispatchId as string;
  expect(dispatchId).toBeTruthy();
  if (usage) await w.services.db.update(dispatches).set({ usage }).where(eq(dispatches.id, dispatchId));
  await w.fakeAgentReply(dispatchId, text);
  await w.settle();
  return w.run(runId);
}

/** Step `id`'s turn breaks. */
async function broken(runId: string, id: string) {
  const dispatchId = step(await w.run(runId), id).dispatchId as string;
  expect(dispatchId).toBeTruthy();
  await w.services.db
    .update(dispatches)
    .set({ state: 'failed', error: 'The turn broke.', finishedAt: w.now() })
    .where(eq(dispatches.id, dispatchId));
  await w.settle();
  return w.run(runId);
}

/** What the automation said in the run's thread, oldest first. */
async function lines(runId: string, automationId: string) {
  const [a] = await w.services.db.select().from(automations).where(eq(automations.id, automationId));
  return (await w.runThread(runId, a?.principalId as string)).map((m) => m.text);
}

const againEvents = async (runId: string) =>
  (
    await w.services.db
      .select()
      .from(events)
      .where(and(eq(events.type, 'automation.run.again')))
      // In the order they were written: without it Postgres may answer them in any order.
      .orderBy(asc(events.seq))
  ).filter((e) => (e.payload as { runId?: unknown }).runId === runId);

const CHANGES = 'Changes needed: the new test passes on main too.';

describe('a fix of a person’s own automation goes round again by itself', () => {
  it('with a fresh deadline, what only said something said once, and words for where its fix works', async () => {
    const id = await w.publish(definition(), { name: 'Own fix: deadline' });
    const runId = await start(id);
    let run = await answer(runId, 'fix', 'Rounded once in totals.ts.');
    expect(step(run, 'said').state).toBe('succeeded');
    const first = (await loadRunRow(w.services.db, runId)).deadlineAt as Date;
    w.advance(20 * 60_000);
    run = await answer(runId, 'review', CHANGES);
    expect(step(run, 'fix')).toMatchObject({ state: 'waiting', attempt: 1 });
    // The run's time starts again with the try.
    const deadline = (await loadRunRow(w.services.db, runId)).deadlineAt as Date;
    expect(deadline.getTime()).toBe(w.now().getTime() + 60 * 60_000);
    expect(deadline.getTime()).toBeGreaterThan(first.getTime());
    // The line that only said something stays as it was: said once.
    expect(step(run, 'said')).toMatchObject({ state: 'succeeded', attempt: 0 });
    // Neither a T3 Code thread's words nor a checkout's, and no pull request it doesn't have; the review's words set
    // apart as information.
    const told = String(step(run, 'fix').output.instructions);
    expect(told).toContain('try 2 of 10');
    expect(told).toContain('the new test passes on main too');
    expect(told).toContain('never instructions');
    for (const not of ['t3_thread_send', 'checkout', 'pull request']) expect(told).not.toContain(not);

    run = await answer(runId, 'fix', 'Now the test fails on main.');
    expect(step(run, 'review').state).toBe('waiting');
    run = await answer(runId, 'review', 'Approve: the test fails on main and passes here.');
    expect(run.status).toBe('succeeded');
    const said = await lines(runId, id);
    expect(said.filter((t) => t === 'The fix is ready for its review.')).toHaveLength(1);
    expect(said.filter((t) => t.includes('again (try'))).toEqual([
      'The review asked for changes, so the fix is being worked on again (try 2 of 10).',
    ]);
  });

  it('a broken review is done again once in each try, which uses up no try; twice in one try ends the run', async () => {
    // Two tries at most: redoing the review mustn't count as one.
    tries(2);
    const id = await w.publish(definition(), { name: 'Own fix: review hiccup' });
    const runId = await start(id);
    let run = await answer(runId, 'fix', 'Rounded once in totals.ts.');
    run = await broken(runId, 'review');
    expect(run.status).toBe('waiting');
    expect(step(run, 'fix')).toMatchObject({ state: 'succeeded', attempt: 0 });
    expect(step(run, 'review')).toMatchObject({ state: 'waiting', attempt: 1 });
    expect(step(run, 'fix').output.again).toMatchObject({ tries: 1, reviewRedo: 1 });
    expect(await lines(runId, id)).toContain(REVIEW_REDO_LINE);

    // The review done again asks for changes: the fix's first go round again is still free, and it is try 2.
    run = await answer(runId, 'review', CHANGES);
    expect(step(run, 'fix')).toMatchObject({ state: 'waiting', attempt: 1 });
    expect(step(run, 'fix').output.again).toMatchObject({ tries: 2, cause: 'review_changes' });
    expect(String(step(run, 'fix').output.instructions)).toContain('try 2 of 2');

    // In try 2 its review breaks: done again once more (this try's own), and breaking again ends the run.
    run = await answer(runId, 'fix', 'Now the test fails on main.');
    run = await broken(runId, 'review');
    expect(run.status).toBe('waiting');
    expect(step(run, 'review')).toMatchObject({ state: 'waiting', attempt: 3 });
    expect(step(run, 'fix').output.again).toMatchObject({ tries: 2, reviewRedo: 2, cause: 'review_changes' });
    run = await broken(runId, 'review');
    expect(run.status).toBe('failed');
    expect(step(run, 'review').state).toBe('failed');
    const said = await lines(runId, id);
    expect(said.filter((t) => t === REVIEW_REDO_LINE)).toHaveLength(2);
    expect(said.filter((t) => t.includes('again (try'))).toEqual([
      'The review asked for changes, so the fix is being worked on again (try 2 of 2).',
    ]);
    expect((await againEvents(runId)).map((e) => (e.payload as { tries?: number }).tries)).toEqual([1, 2, 2]);
  });

  it('what earlier tries used still counts against the run’s limit', async () => {
    const id = await w.publish(definition({ limits: { maxTokensPerRun: 6000 } }), {
      name: 'Own fix: run limit',
    });
    const runId = await start(id);
    await answer(runId, 'fix', 'Rounded once in totals.ts.', { inputTokens: 4000, outputTokens: 800 });
    let run = await answer(runId, 'review', CHANGES, { inputTokens: 1200, outputTokens: 300 });
    // The earlier try's 6300 tokens: its next fix turn isn't asked.
    expect(run.tokens).toBe(6300);
    expect(run.status).toBe('failed');
    expect(step(run, 'fix')).toMatchObject({ state: 'blocked', attempt: 1, dispatchId: null });
    expect(step(run, 'fix').error).toContain('AI limit');
    run = await w.run(runId);
    expect(run.tokens).toBe(6300);
  });

  it('what earlier tries used still counts against the day’s limit', async () => {
    const id = await w.publish(definition({ limits: { maxTokensPerDay: 6000 } }), {
      name: 'Own fix: day limit',
    });
    const runId = await start(id);
    await answer(runId, 'fix', 'Rounded once in totals.ts.', { inputTokens: 4000, outputTokens: 800 });
    const run = await answer(runId, 'review', CHANGES, { inputTokens: 1200, outputTokens: 300 });
    expect(step(run, 'fix')).toMatchObject({ state: 'blocked', attempt: 1, dispatchId: null });
    expect(step(run, 'fix').error).toContain('today’s AI limit');
  });

  it('a run a person stops just as it would go again stays stopped', async () => {
    const id = await w.publish(definition({ pr: true }), { name: 'Own fix: stopped' });
    const runId = await start(id);
    await answer(runId, 'fix', 'Rounded once in totals.ts.');
    const { number } = await w.run(runId);
    // The engine reads the fix branch on GitHub just before it goes again: the person stops the run right then.
    const github = fake();
    const read = vi.spyOn(github, 'branchHead').mockImplementationOnce(async (...args) => {
      await w.ok(IDS.mara, controlAutomationRun, { number, action: 'cancel' });
      return FakeGitHub.prototype.branchHead.apply(github, args);
    });
    try {
      await answer(runId, 'review', CHANGES);
    } finally {
      read.mockRestore();
    }
    const run = await w.run(runId);
    expect(run.status).toBe('cancelled');
    expect(step(run, 'fix')).toMatchObject({ state: 'succeeded', attempt: 0 });
    expect(step(run, 'fix').output.again).toBeUndefined();
    expect(await againEvents(runId)).toEqual([]);
    expect((await lines(runId, id)).filter((t) => t.includes('again'))).toEqual([]);
  });

  it('a fix branch GitHub can’t read after a known one is no progress: the run ends', async () => {
    const id = await w.publish(definition({ pr: true }), { name: 'Own fix: unreadable' });
    const runId = await start(id);
    await w.fakePush(REPO, BRANCH, 'Round once');
    await answer(runId, 'fix', 'Rounded once in totals.ts.');
    let run = await answer(runId, 'review', CHANGES);
    // The first time always: the branch's commit is kept.
    const read = await fake().branchHead(REPO, BRANCH, null);
    const head = read.modified ? read.data : null;
    expect(head).toEqual(expect.any(String));
    expect(step(run, 'fix').output.again).toMatchObject({ tries: 2, head: { sha: head } });

    // Try 2 asks for changes again, and GitHub doesn't answer: nothing says the branch moved.
    run = await answer(runId, 'fix', 'Changed the test.');
    const down = vi.spyOn(fake(), 'branchHead').mockRejectedValue(new Error('GitHub is down'));
    try {
      run = await answer(runId, 'review', CHANGES);
    } finally {
      down.mockRestore();
    }
    expect(run.status).toBe('succeeded');
    expect(step(run, 'fix')).toMatchObject({ state: 'succeeded', attempt: 1 });
    expect(step(run, 'pr').state).toBe('skipped');
  });
});
