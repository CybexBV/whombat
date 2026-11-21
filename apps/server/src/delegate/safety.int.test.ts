/**
 * Delegation safety across durable command transitions. Postgres matters here: a claim, a later stop or change,
 * and a late T3 reply must agree even though they commit separately.
 */
import { DelegationCard, type DelegationVerification, newId } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { CommandDef } from '../commit/types';
import { catalogConnections, delegations, delegationTasks, messages, pullRequests } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import * as t3Code from '../things/kinds/business/t3code';
import {
  type ClaimedTask,
  claimTasks,
  ensureFinal,
  finishDelegation,
  loadTasks,
  mergedElsewhere,
  mergeNext,
  offerDelegation,
  stopTaskByPerson,
  type TaskSpec,
  taskEnded,
  taskLaunched,
  taskLaunchFailed,
  updateDelegation,
} from './commands';
import { stopTaskThreads, workingPage } from './run';
import { eligibleIntegration } from './state';

const t = useTestServer({ seed: true });
const connectionId = 'cat_delegation_safety';
const revision = 'a'.repeat(40);
const base = 'b'.repeat(40);
const db = () => t.services.db;

async function commit<S extends z.ZodType, R>(
  command: CommandDef<S, R>,
  input: z.input<S>,
  actor: string = IDS.dusty,
) {
  const result = await t.commit(actor, command, input);
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error(`Command ${command.name} did not commit`);
  return result.result;
}

const spec = (title: string, extra: Partial<TaskSpec> = {}): TaskSpec => ({
  title,
  brief: `Implement ${title}.`,
  why: null,
  picked: true,
  after: null,
  provider: null,
  model: null,
  modelLabel: null,
  ...extra,
});

async function offer(tasks = [spec('First change')], merge = true) {
  const id = newId('delegation');
  await commit(offerDelegation, {
    id,
    conversationId: IDS.dmDusty,
    threadRootId: 'msg_dm-mara-1402',
    personId: IDS.mara,
    connectionId,
    project: { id: `project-${id}`, title: 'Safety project', root: '/workspace/safety' },
    title: 'Safe changes',
    intro: 'Handing these over.',
    atOnce: 2,
    pullRequests: true,
    merge,
    tasks,
    start: true,
  });
  return id;
}

async function update(id: string, changes: Partial<z.input<typeof updateDelegation.schema>>) {
  return commit(updateDelegation, {
    delegationId: id,
    note: null,
    title: null,
    atOnce: null,
    pullRequests: null,
    add: [],
    change: [],
    remove: [],
    order: [],
    start: false,
    stop: [],
    retry: [],
    send: [],
    ...changes,
  });
}

const rows = (id: string) => loadTasks(db(), id);
const ordinary = async (id: string) => (await rows(id)).filter((row) => row.kind === 'task');
async function finalOf(id: string) {
  const final = (await rows(id)).find((row) => row.kind === 'final');
  expect(final).toBeDefined();
  if (!final) throw new Error('Missing mandatory final check');
  return final;
}

async function launch(id: string, claim: ClaimedTask) {
  const threadId = `thread-${claim.task.id}-${claim.task.attempt}`;
  const result = await commit(taskLaunched, {
    delegationId: id,
    taskId: claim.task.id,
    withIds: claim.with.map((row) => row.id),
    threadId,
    title: claim.task.title,
    url: null,
    worktree: '/workspace/safety',
  });
  return { threadId, ...result };
}

const claim = (id: string) => commit(claimTasks, { delegationId: id });

async function sourceDone(id: string) {
  const started = await claim(id);
  expect(started.claimed).toHaveLength(1);
  const first = started.claimed[0];
  if (!first) throw new Error('Missing source claim');
  const { threadId } = await launch(id, first);
  await commit(taskEnded, {
    delegationId: id,
    threadId,
    state: 'done',
    // A lead thread says how each item went, by its number.
    answer:
      'Implemented the change.\nItem 1: It is in.\nItem 2: It is in.\nItem 3: It is in.\nChecks: passing',
    checks: 'passing',
    pr: 'https://github.com/acme/site/pull/901',
  });
  return first;
}

async function runningFinal(id: string) {
  await sourceDone(id);
  const started = await claim(id);
  expect(started.claimed).toHaveLength(1);
  const final = started.claimed[0];
  if (final?.task.kind !== 'final') throw new Error('Final check was not claimed');
  const launched = await launch(id, final);
  const proof: DelegationVerification = {
    revision,
    base,
    inputs: final.task.checkedInputs as string,
    generation: final.task.checkedGeneration as number,
    expected: ['check'],
    results: [{ name: 'check', revision, state: 'passing' }],
  };
  return { ...launched, proof, task: final.task };
}

async function certifiedFinal(id: string) {
  const final = await runningFinal(id);
  await commit(taskEnded, {
    delegationId: id,
    threadId: final.threadId,
    state: 'done',
    answer: `Checked the combined work.\nVerification: ${JSON.stringify(final.proof)}`,
    pr: 'https://github.com/acme/site/pull/902',
    checks: 'passing',
    verification: final.proof,
    verified: true,
  });
  return final;
}

beforeAll(async () => {
  await db().insert(catalogConnections).values({
    id: connectionId,
    burrowId: t.burrowId,
    catalogId: 't3code',
    label: 'Safety fixture',
    handle: 'safety-t3',
    transport: 'mcp',
    signIn: 'password',
    baseUrl: 'http://safety.invalid',
  });
});

beforeEach(async () => {
  // Each scenario has its own live card; this database belongs only to this test file.
  await db().delete(delegations);
});

describe('durable delegation safety', () => {
  it('reserves the thirteenth card row for the final check when twelve tasks are handed over', async () => {
    const id = await offer(Array.from({ length: 12 }, (_, n) => spec(`Change ${n + 1}`)));
    expect(await ordinary(id)).toHaveLength(12);
    expect(await rows(id)).toHaveLength(13);
    expect((await rows(id)).at(-1)?.kind).toBe('final');
    const [d] = await db().select().from(delegations).where(eq(delegations.id, id));
    const [message] = await db()
      .select()
      .from(messages)
      .where(eq(messages.id, d?.messageId ?? ''));
    expect(DelegationCard.parse(message?.card).tasks).toHaveLength(13);
  });

  it('repairs an upgraded live checklist whose mandatory final row is missing', async () => {
    const id = await offer();
    await db()
      .delete(delegationTasks)
      .where(eq(delegationTasks.id, (await finalOf(id)).id));
    await commit(ensureFinal, { delegationId: id });
    expect(await finalOf(id)).toMatchObject({ state: 'queued', kind: 'final' });
    await commit(ensureFinal, { delegationId: id });
    expect((await rows(id)).filter((row) => row.kind === 'final')).toHaveLength(1);
  });

  it('stops every durable group member before the launch returns and rejects the late launch', async () => {
    const id = await offer([spec('First change'), spec('Second change', { after: 1 })]);
    const started = await claim(id);
    const first = started.claimed[0];
    if (!first) throw new Error('Missing group claim');
    expect(first.with).toHaveLength(1);
    const members = await ordinary(id);
    expect(new Set(members.map((row) => row.groupId)).size).toBe(1);
    expect(members[0]?.groupId).toBeTruthy();
    expect(members.every((row) => row.threadId === null)).toBe(true);
    await commit(stopTaskByPerson, { delegationId: id, taskId: first.with[0]?.id as string }, IDS.mara);
    expect((await ordinary(id)).map((row) => row.state)).toEqual(['stopped', 'stopped']);
    expect((await launch(id, first)).cancelled).toBe(true);
    expect((await ordinary(id)).map((row) => row.state)).toEqual(['stopped', 'stopped']);
  });

  it('keeps a whole shared branch out of integration when its nonleader is kept', async () => {
    const id = await offer([spec('First change'), spec('Second change', { after: 1 })]);
    await sourceDone(id);
    expect(eligibleIntegration(await rows(id))).toHaveLength(2);
    await update(id, { change: [{ n: 2, merge: false }] });
    expect((await ordinary(id)).map((row) => row.mergeState)).toEqual(['kept', 'kept']);
    expect(eligibleIntegration(await rows(id))).toEqual([]);
    expect((await claim(id)).claimed).toEqual([]);
  });

  it('releases every group stop guard when its cancelled launch created no thread, so retry can start safely', async () => {
    const id = await offer([spec('First change'), spec('Second change', { after: 1 })]);
    const started = (await claim(id)).claimed[0];
    if (!started) throw new Error('Missing group claim');
    await commit(stopTaskByPerson, { delegationId: id, taskId: started.task.id }, IDS.mara);
    expect((await ordinary(id)).map((row) => [row.state, row.stopPending, row.threadId])).toEqual([
      ['stopped', true, null],
      ['stopped', true, null],
    ]);
    await update(id, { retry: [2] });
    expect((await ordinary(id)).map((row) => row.state)).toEqual(['stopped', 'stopped']);
    await commit(taskLaunchFailed, {
      delegationId: id,
      taskId: started.task.id,
      withIds: started.with.map((row) => row.id),
    });
    expect((await ordinary(id)).map((row) => [row.state, row.stopPending, row.threadId])).toEqual([
      ['stopped', false, null],
      ['stopped', false, null],
    ]);
    await update(id, { retry: [2] });
    const retried = (await claim(id)).claimed;
    expect(retried).toHaveLength(1);
    expect(retried[0]?.with).toHaveLength(1);
    expect((await ordinary(id)).map((row) => [row.state, row.stopPending, row.attempt])).toEqual([
      ['working', false, 2],
      ['working', false, 2],
    ]);
  });

  it('retries all members of a durable group when its nonleader is retried', async () => {
    const id = await offer([spec('First change'), spec('Second change', { after: 1 })]);
    await sourceDone(id);
    const oldGroup = (await ordinary(id))[0]?.groupId;
    await update(id, { retry: [2] });
    expect((await ordinary(id)).map((row) => [row.state, row.pr, row.answer])).toEqual([
      ['queued', null, null],
      ['queued', null, null],
    ]);
    const retried = await claim(id);
    expect(retried.claimed).toHaveLength(1);
    expect(retried.claimed[0]?.with).toHaveLength(1);
    const members = await ordinary(id);
    expect(members.map((row) => row.attempt)).toEqual([2, 2]);
    expect(members[0]?.groupId).toBe(members[1]?.groupId);
    expect(members[0]?.groupId).not.toBe(oldGroup);
  });

  it.each(['missing', 'failing'] as const)(
    'cannot finish as Done with %s verification proof',
    async (kind) => {
      const id = await offer();
      const final = await runningFinal(id);
      const verification =
        kind === 'missing'
          ? null
          : {
              ...final.proof,
              results: [{ name: 'check', revision, state: 'failing' as const }],
            };
      await commit(taskEnded, {
        delegationId: id,
        threadId: final.threadId,
        state: 'done',
        answer: 'Everything is done.\nChecks: passing\nMerged: yes',
        pr: null,
        checks: 'passing',
        merged: true,
        verification,
        verified: true,
      });
      expect(await finalOf(id)).toMatchObject({
        state: 'failed',
        checks: 'failing',
        mergeState: 'not_merged',
      });
      await commit(finishDelegation, {
        delegationId: id,
        summary: 'The final check needs attention.',
        stopped: false,
      });
      const [d] = await db().select().from(delegations).where(eq(delegations.id, id));
      expect(d).toMatchObject({ stage: 'done', outcome: 'incomplete' });
      expect((await ordinary(id))[0]?.mergeState).not.toBe('merged');
    },
  );

  it('invalidates old proof and advances the generation when a kept source is selected for merging', async () => {
    const id = await offer();
    await certifiedFinal(id);
    await update(id, { change: [{ n: 1, merge: false }] });
    const before = await finalOf(id);
    // Fixture of a prior completed check while this source was kept, before the person selects it again.
    await db()
      .update(delegationTasks)
      .set({
        state: 'done',
        checkedRevision: revision,
        checkedBase: base,
        checkedInputs: 'c'.repeat(64),
        checkedGeneration: before.checkGeneration,
      })
      .where(eq(delegationTasks.id, before.id));
    await update(id, { change: [{ n: 1, merge: true }] });
    expect(await finalOf(id)).toMatchObject({
      state: 'queued',
      checkedRevision: null,
      checkedBase: null,
      checkedInputs: null,
      checkedGeneration: null,
      checkGeneration: before.checkGeneration + 1,
    });
    expect((await commit(mergeNext, { delegationId: id, verifiedRevision: revision })).task).toBeNull();
  });

  it('keeps the completed review when existing merge and selection choices are repeated', async () => {
    const id = await offer();
    await certifiedFinal(id);
    const checked = await finalOf(id);
    await update(id, { merge: true, pullRequests: true, change: [{ n: 1, merge: true, picked: true }] });
    expect(await finalOf(id)).toEqual(checked);
  });

  it('clears an ended outcome note when work is reopened', async () => {
    const id = await offer();
    const final = await runningFinal(id);
    await commit(taskEnded, {
      delegationId: id,
      threadId: final.threadId,
      state: 'failed',
      answer: 'Needs a fix.',
      pr: null,
    });
    await commit(finishDelegation, {
      delegationId: id,
      summary: 'Some work is still incomplete.',
      stopped: false,
    });
    await update(id, { retry: [2] });
    const [d] = await db().select().from(delegations).where(eq(delegations.id, id));
    expect(d).toMatchObject({ stage: 'working', outcome: null, note: null, endedAt: null });
  });

  it('queues a working final check again and stops its obsolete run when more tasks are added', async () => {
    const id = await offer();
    const final = await runningFinal(id);
    await update(id, { add: [spec('Later change')] });
    expect(await finalOf(id)).toMatchObject({
      state: 'queued',
      stopPending: true,
      checkedInputs: null,
      checkedGeneration: null,
      checkGeneration: final.task.checkGeneration + 1,
    });
    const late = await commit(taskEnded, {
      delegationId: id,
      threadId: final.threadId,
      state: 'done',
      answer: 'The obsolete check passed.',
      pr: null,
      checks: 'passing',
      verification: final.proof,
      verified: true,
    });
    expect(late.handled).toBe(false);
    expect((await finalOf(id)).state).toBe('queued');
  });

  it('reopens a finished list and queues a new final check when a source PR is merged externally', async () => {
    const id = await offer();
    const final = await runningFinal(id);
    await commit(taskEnded, {
      delegationId: id,
      threadId: final.threadId,
      state: 'failed',
      answer: 'Needs a fix.',
      pr: null,
    });
    await commit(finishDelegation, {
      delegationId: id,
      summary: 'The combined check needs a fix.',
      stopped: false,
    });
    const source = (await ordinary(id))[0];
    await db()
      .insert(pullRequests)
      .values({
        id: newId('pullRequest'),
        burrowId: t.burrowId,
        repoId: 'rep_billing',
        number: 901,
        branch: source?.branch as string,
        title: 'First change',
        state: 'merged',
        headSha: revision,
        conversationId: IDS.dmDusty,
        openedAt: t.services.clock(),
        mergedAt: t.services.clock(),
        url: source?.pr,
      });
    expect(await commit(mergedElsewhere, { delegationId: id })).toMatchObject({ changed: true });
    const [d] = await db().select().from(delegations).where(eq(delegations.id, id));
    expect(d).toMatchObject({ stage: 'working', outcome: null, endedAt: null, note: null });
    expect(await finalOf(id)).toMatchObject({
      state: 'queued',
      checkedRevision: null,
      checkGeneration: final.task.checkGeneration + 1,
    });
    expect((await ordinary(id))[0]?.mergeState).toBe('merged');
    expect((await claim(id)).claimed[0]?.task.kind).toBe('final');
  });

  it('stops a working final check and leaves it skipped after acknowledgement when automatic merging is switched off', async () => {
    const id = await offer();
    const final = await runningFinal(id);
    await update(id, { merge: false });
    expect(await finalOf(id)).toMatchObject({
      state: 'skipped',
      picked: false,
      stopPending: true,
      checkedInputs: null,
      checkedGeneration: null,
      checkGeneration: final.task.checkGeneration + 1,
    });
    expect((await claim(id)).claimed).toEqual([]);
    const [d] = await db().select().from(delegations).where(eq(delegations.id, id));
    if (!d) throw new Error('Missing delegation');
    // Only the transport is stubbed: exercise the real stop acknowledgement and durable claim afterwards.
    const interrupt = vi.spyOn(t3Code, 'callT3').mockResolvedValue({});
    try {
      await stopTaskThreads(t.services, d, [await finalOf(id)], 'Automatic merging was switched off.');
      expect(interrupt).toHaveBeenCalledWith(
        t.services,
        expect.anything(),
        't3_thread_interrupt',
        expect.objectContaining({ threadId: final.threadId }),
        'things.action',
      );
    } finally {
      interrupt.mockRestore();
    }
    expect(await finalOf(id)).toMatchObject({ state: 'skipped', picked: false, stopPending: false });
    await commit(ensureFinal, { delegationId: id });
    expect((await claim(id)).claimed).toEqual([]);
    expect((await finalOf(id)).state).toBe('skipped');
  });

  it('keeps the final check when its own merge lands the source pull requests before its thread ends', async () => {
    const id = await offer();
    const final = await certifiedFinal(id);
    const picked = await commit(mergeNext, { delegationId: id, verifiedRevision: revision });
    expect(picked.task).toMatchObject({ id: final.task.id, mergeState: 'merging' });
    // GitHub marks the source pull request merged as the candidate merges, before T3 Code's thread has answered.
    const source = (await ordinary(id))[0];
    await db()
      .insert(pullRequests)
      .values({
        id: newId('pullRequest'),
        burrowId: t.burrowId,
        repoId: 'rep_billing',
        number: 902,
        branch: source?.branch as string,
        title: 'First change',
        state: 'merged',
        headSha: revision,
        conversationId: IDS.dmDusty,
        openedAt: t.services.clock(),
        mergedAt: t.services.clock(),
        url: source?.pr,
      });
    expect(await commit(mergedElsewhere, { delegationId: id })).toMatchObject({ changed: true });
    expect((await ordinary(id))[0]?.mergeState).toBe('merged');
    // The merge goes on as it was: same run, same generation, nothing to stop.
    expect(await finalOf(id)).toMatchObject({
      state: 'working',
      mergeState: 'merging',
      stopPending: false,
      checkedRevision: revision,
      checkGeneration: final.task.checkGeneration,
    });
  });

  it('merges only the verified final candidate and requires its exact verified revision', async () => {
    const id = await offer();
    const final = await certifiedFinal(id);
    expect((await ordinary(id))[0]).toMatchObject({ state: 'done', mergeState: 'waiting' });
    expect(await finalOf(id)).toMatchObject({
      state: 'done',
      mergeState: 'waiting',
      checkedRevision: revision,
    });
    expect((await commit(mergeNext, { delegationId: id })).task).toBeNull();
    expect((await commit(mergeNext, { delegationId: id, verifiedRevision: base })).task).toBeNull();
    const picked = await commit(mergeNext, { delegationId: id, verifiedRevision: revision });
    expect(picked.task).toMatchObject({
      id: final.task.id,
      kind: 'final',
      state: 'working',
      mergeState: 'merging',
    });
    expect((await ordinary(id))[0]).toMatchObject({ state: 'done', mergeState: 'waiting' });
  });
});

describe('the watcher’s pass over working delegations', () => {
  it('gives every working delegation its turn, beyond one page, though a pass changes none of them', async () => {
    const at = new Date('2026-01-01T00:00:00Z');
    const ids = [0, 1, 2, 3, 4].map(() => newId('delegation'));
    await db()
      .insert(delegations)
      .values(
        ids.map((id) => ({
          id,
          burrowId: t.burrowId,
          conversationId: IDS.dmDusty,
          agentId: IDS.dusty,
          personId: IDS.mara,
          connectionId,
          title: 'Long work',
          stage: 'working' as const,
          atOnce: 1,
          createdAt: at,
          updatedAt: at,
        })),
      );
    const working = (await db().select().from(delegations).where(eq(delegations.stage, 'working'))).length;
    // Pages of two: every one is seen within one round, and the round after starts again.
    const seen = new Set<string>();
    for (let pass = 0; pass <= Math.ceil(working / 2); pass++)
      for (const d of await workingPage(t.services, 2)) seen.add(d.id);
    for (const id of ids) expect(seen).toContain(id);
    expect(seen.size).toBe(working);
  });
});
