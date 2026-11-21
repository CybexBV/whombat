/**
 * Outsiders' turns wait their turn (docs/decisions/outsiders-turns.md): they share Hermes's one outsiders' profile, so
 * the claim takes one at a time and keeps the next queued, a person's turn never waits for them, one that still found
 * the profile busy on the runner is queued again instead of failed, and an automation step's time counts from its turn's
 * claim, with the step saying why it waits meanwhile. Needs Postgres: the queue is the claim's SQL under its lock, and
 * the step reads its dispatch's rows.
 */
import { HERMES_PROFILE_BUSY } from '@whombat/agent-runtime/failures';
import { type AutomationDefinitionInput, newId } from '@whombat/core';
import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { dispatches } from '../db/schema/index';
import { IDS, useAutomationWorld } from '../test/automations';
import { accountOf } from '../test/tokens';
import { DEFAULT_RUNTIME_OPTIONS } from './service';

const w = useAutomationWorld();
const RUNNER = 'rnr_outsiders';

/** Nothing of an earlier test is queued or holds a place. */
async function drain() {
  await w.services.db
    .update(dispatches)
    .set({ state: 'done', leaseExpiresAt: null })
    .where(inArray(dispatches.state, ['queued', 'claimed', 'running']));
}

/** A queued turn of Dusty's at a conversation's top level: an outsiders' one, or the person's with `account`. */
async function queue(conversationId: string, account: string | null = null): Promise<string> {
  const id = newId('dispatch');
  await w.services.db.insert(dispatches).values({
    id,
    burrowId: w.burrowId,
    agentId: IDS.dusty,
    trigger: 'automation',
    mode: 'reply',
    conversationId,
    messageId: null,
    threadRootId: null,
    state: 'queued',
    onBehalfOfAccountId: account,
    createdAt: w.now(),
  });
  // Queued in this order: the claim takes the oldest first.
  w.advance(1000);
  return id;
}

async function claim(): Promise<string | null> {
  return (await w.services.runtime.claimOne(RUNNER, ['claude']))?.id ?? null;
}

async function stored(id: string) {
  const [row] = await w.services.db.select().from(dispatches).where(eq(dispatches.id, id));
  if (!row) throw new Error(`no dispatch ${id}`);
  return row;
}

describe('outsiders’ turns run one at a time', () => {
  it('keeps the next queued while one holds its place, and takes it once that one ends', async () => {
    await drain();
    const first = await queue(IDS.general);
    const second = await queue(IDS.incidents);
    expect(await claim()).toBe(first);
    // The second waits, queued: never claimed beside the first, never failed for it.
    expect(await claim()).toBeNull();
    expect((await stored(second)).state).toBe('queued');
    await w.services.runtime.finalize(first, { outcome: 'done' });
    expect(await claim()).toBe(second);
    await w.services.runtime.finalize(second, { outcome: 'done' });
  });

  it('a stopped turn its runner still holds keeps the next waiting until its lease ends', async () => {
    await drain();
    const first = await queue(IDS.general);
    const second = await queue(IDS.incidents);
    expect(await claim()).toBe(first);
    await w.services.db
      .update(dispatches)
      .set({ state: 'cancelled', stoppedById: IDS.mara })
      .where(eq(dispatches.id, first));
    expect(await claim()).toBeNull();
    w.advance(DEFAULT_RUNTIME_OPTIONS.leaseMs + 1000);
    expect(await claim()).toBe(second);
    await w.services.runtime.finalize(second, { outcome: 'done' });
  });

  it('never holds back a person’s turn', async () => {
    await drain();
    const mara = await accountOf(w.services, IDS.mara);
    const outsiders = await queue(IDS.general);
    const waiting = await queue(IDS.incidents);
    const persons = await queue(IDS.billing, mara);
    expect(await claim()).toBe(outsiders);
    // The other outsiders' turn is older, but only the person's may run beside the first.
    expect(await claim()).toBe(persons);
    expect((await stored(waiting)).state).toBe('queued');
    for (const id of [outsiders, persons]) await w.services.runtime.finalize(id, { outcome: 'done' });
    expect(await claim()).toBe(waiting);
    await w.services.runtime.finalize(waiting, { outcome: 'done' });
  });

  it('queues again, uncounted, an outsiders’ turn that found the profile busy; a person’s turn fails as before', async () => {
    await drain();
    const outsiders = await queue(IDS.general);
    for (let i = 0; i < DEFAULT_RUNTIME_OPTIONS.maxAttempts + 1; i++) {
      expect(await claim()).toBe(outsiders);
      await w.services.runtime.finalize(outsiders, { outcome: 'failed', error: HERMES_PROFILE_BUSY });
      const row = await stored(outsiders);
      expect(row).toMatchObject({ state: 'queued', attempts: 0, claimedAt: null });
      // After the backoff, not at once.
      expect(await claim()).toBeNull();
      w.advance(DEFAULT_RUNTIME_OPTIONS.retryBackoffMs + 1000);
    }
    expect(await claim()).toBe(outsiders);
    await w.services.runtime.finalize(outsiders, { outcome: 'done' });

    await drain();
    const persons = await queue(IDS.billing, await accountOf(w.services, IDS.mara));
    for (let i = 0; i < DEFAULT_RUNTIME_OPTIONS.maxAttempts; i++) {
      expect(await claim()).toBe(persons);
      await w.services.runtime.finalize(persons, { outcome: 'failed', error: HERMES_PROFILE_BUSY });
      w.advance(DEFAULT_RUNTIME_OPTIONS.retryBackoffMs + 1000);
    }
    expect((await stored(persons)).state).toBe('failed');
  });
});

/** One agent step with a five-minute timeout, started by a message in #billing that says `word`. */
function stepDefinition(word: string): AutomationDefinitionInput {
  return {
    version: 1,
    conversationId: IDS.billing,
    triggers: [{ kind: 'message_posted', conversationId: IDS.billing, contains: [word] }],
    steps: [{ id: 'look', kind: 'dispatch_agent', prompt: 'Look into it.', timeoutMinutes: 5, retries: 0 }],
    limits: { runTimeoutMinutes: 600, maxConcurrentRuns: 1, maxRunsPerDay: 20 },
  };
}

/** The run's one step after the engine looked again. */
async function stepOf(automationId: string) {
  await w.settle();
  const [run] = await w.runs(automationId);
  const step = run?.steps[0];
  if (!step?.dispatchId) throw new Error('the step has no turn');
  return { run, step, dispatch: await stored(step.dispatchId) };
}

describe('an agent step whose turn waits', () => {
  it('uses none of its time while queued, says why, and has its whole time from the claim', async () => {
    await drain();
    const id = await w.publish(stepDefinition('sluggish'), { name: 'Queued look' });
    await w.ok(IDS.mara, sendMessage, { conversationId: IDS.billing, text: 'The export is sluggish' });
    let { step, dispatch } = await stepOf(id);
    expect(step.state).toBe('waiting');
    const asked = step.inputSummary;
    // Its turn is an outsiders' one, and another outsiders' turn holds the profile.
    await w.services.db
      .update(dispatches)
      .set({ onBehalfOfAccountId: null })
      .where(eq(dispatches.id, dispatch.id));
    const ahead = await queue(IDS.general);
    await w.services.db
      .update(dispatches)
      .set({ createdAt: new Date(w.now().getTime() - 60 * 60_000) })
      .where(eq(dispatches.id, ahead));
    expect(await claim()).toBe(ahead);

    ({ step } = await stepOf(id));
    expect(step.inputSummary).toContain(asked);
    expect(step.inputSummary).toMatch(/customer report/);
    // Twice the step's five minutes in the queue: still waiting, its turn still queued.
    w.advance(10 * 60_000);
    ({ step, dispatch } = await stepOf(id));
    expect(step.state).toBe('waiting');
    expect(dispatch.state).toBe('queued');

    // The turn ahead ends; the step's turn is taken, and says only what it asked again.
    await w.services.runtime.finalize(ahead, { outcome: 'done' });
    expect(await claim()).toBe(dispatch.id);
    ({ step } = await stepOf(id));
    expect(step.inputSummary).toBe(asked);
    expect(step.output.queuedBehind).toBeUndefined();
    // Four of its five minutes since the claim: still at work.
    w.advance(4 * 60_000);
    ({ step } = await stepOf(id));
    expect(step.state).toBe('waiting');
    // Past them: the turn is stopped and the step fails for time.
    w.advance(2 * 60_000);
    ({ step, dispatch } = await stepOf(id));
    expect(step.state).toBe('failed');
    expect(step.error).toMatch(/in time/);
    expect(dispatch).toMatchObject({ state: 'cancelled', error: 'automation_timeout' });
  });

  it('a failed turn’s step says why when its turn does', async () => {
    await drain();
    const id = await w.publish(stepDefinition('stalled'), { name: 'Failed look' });
    await w.ok(IDS.mara, sendMessage, { conversationId: IDS.billing, text: 'The export stalled' });
    const { dispatch } = await stepOf(id);
    expect(await claim()).toBe(dispatch.id);
    // Its last try: the failure is final.
    await w.services.db
      .update(dispatches)
      .set({ attempts: DEFAULT_RUNTIME_OPTIONS.maxAttempts })
      .where(eq(dispatches.id, dispatch.id));
    await w.services.runtime.finalize(dispatch.id, {
      outcome: 'failed',
      error: 'managed:wall_time',
    });
    const { step } = await stepOf(id);
    expect(step.state).toBe('failed');
    expect(step.error).toMatch(/^Dusty couldn’t finish because/);
    expect(step.error).toMatch(/too long/);
  });
});
