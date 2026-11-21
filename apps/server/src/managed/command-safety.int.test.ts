/**
 * Command safety over a session (docs/decisions/command-safety.md): an external effect ahead of the commit pins the
 * command (CS-01) and a crash after it reads as unknown (CS-02); `repos.create` keeps what an approval needs and
 * reclaims only its own orphans (CS-03); failures after the commit (CS-05) and a dead process's accepted command
 * (CS-06) answer “done, not kept”; a sign in once the service refused answers its words (`provision/run.ts`).
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalOrigin, localOriginPath } from '@whombat/agent-runtime/local-repos';
import { api } from '@whombat/core';
import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openPr, performAction } from '../commands/agent-tools';
import { setAgentKeys } from '../commands/agents';
import { sendMessage } from '../commands/messages';
import { mergePr, recordChecks, reviewPr } from '../commands/prs';
import { externalEffect, readingBack } from '../commit/scope';
import { defineCommand } from '../commit/types';
import {
  approvals,
  catalogConnections,
  commandReceipts,
  events,
  mergeIntents,
  pullRequests,
  repos,
  vaultNetworks,
} from '../db/schema/index';
import { recoverMergeIntents } from '../github/merge-intents';
import { ApiError, notFound } from '../lib/errors';
import { loadGrants } from '../read/principals';
import type { RouteDef } from '../routes/define';
import { IDS } from '../seed/test-world';
import type { Services } from '../services';
import { fakeOf, syncGitHub } from '../test/github';
import { useManagedRuntime } from '../test/managed';
import { useVaultNetForTests } from '../vault/net';
import { type RequestAnswer, RequestControl, SessionDispatcher } from './dispatcher';
import { CommandReceipts, ReceiptSettled } from './receipts';
import type { SessionPrincipal } from './trust';

const workspaces = mkdtempSync(join(tmpdir(), 'wb-cmd-safety-'));
const m = useManagedRuntime({ seed: true, env: { WHOMBAT_WORKSPACES: workspaces } });
let mara: Awaited<ReturnType<typeof m.enroll>>;

const REPO = 'whombat/billing';

beforeAll(async () => {
  mara = await m.enroll(IDS.mara);
});

async function principalOf(identity: { peerId: string; publicKey: string }): Promise<SessionPrincipal> {
  return m.runtime.trust.identify(identity.peerId, identity.publicKey);
}

/** Runs one request through a dispatcher directly, with a control the test can flip. */
async function dispatch(
  principal: SessionPrincipal,
  request: { id: string; op: string; input: unknown },
  control = new RequestControl(null),
  dispatcher: SessionDispatcher = m.runtime.dispatcher,
): Promise<{ answer: RequestAnswer; accepted: boolean }> {
  let answer: RequestAnswer | null = null;
  let accepted = false;
  await dispatcher.handle(
    principal,
    request,
    {
      accepted: () => {
        accepted = true;
      },
      result: (a) => {
        answer = a;
      },
    },
    control,
  );
  return { answer: answer as unknown as RequestAnswer, accepted };
}

async function receiptOf(requestId: string) {
  const [row] = await m.t.services.db
    .select()
    .from(commandReceipts)
    .where(eq(commandReceipts.requestId, requestId));
  return row;
}

/** A PR on (fake) GitHub whose checks passed and that a person approved: Mara may merge it. */
async function mergeablePr(branch: string): Promise<number> {
  const fake = fakeOf(m.t);
  const sha = randomUUID().replaceAll('-', '').padEnd(40, '0').slice(0, 40);
  await fake.simulatePush({ repo: REPO, branch, commits: [{ sha, message: `Work on ${branch}` }] });
  const opened = await m.t.commit(IDS.dusty, openPr, { repo: REPO, branch, title: `PR ${branch}`, body: '' });
  if (opened.status !== 'ok') throw new Error(`open_pr: ${opened.status}`);
  const number = opened.result.number;
  const passed = { name: 'unit', state: 'passed' as const, note: '', durationMs: 1, tests: null, url: null };
  await m.t.commit(IDS.dusty, recordChecks, { prNumber: number, repo: REPO, checks: [passed] });
  await m.t.commit(IDS.dusty, reviewPr, {
    prNumber: number,
    repo: REPO,
    decision: 'approve',
    body: '',
    comments: [],
  });
  return number;
}

const mergeInput = (number: number) => ({
  params: { burrow: 'burrow-hq', number },
  body: { repo: REPO, method: 'squash' },
});

async function prState(number: number) {
  const [row] = await m.t.services.db
    .select({ state: pullRequests.state })
    .from(pullRequests)
    .where(eq(pullRequests.number, number));
  return row?.state;
}

const onGitHub = (number: number) => fakeOf(m.t).repos.get(REPO)?.prs.get(number);

/** Makes the fake's next merges run `after` once GitHub merged (or refused). */
function afterGitHubMerge(after: () => void | Promise<void>): () => void {
  const fake = fakeOf(m.t);
  const original = fake.mergePullRequest.bind(fake);
  fake.mergePullRequest = async (merge) => {
    try {
      return await original(merge);
    } finally {
      await after();
    }
  };
  return () => {
    fake.mergePullRequest = original;
  };
}

describe('prs.merge: saved intent before GitHub, recorded outcome afterwards', () => {
  it('the session drops once GitHub merged: the commit still records it, and status says completed', async () => {
    const number = await mergeablePr('feat/drop-after-merge');
    const principal = await principalOf(mara);
    const control = new RequestControl(null);
    const restore = afterGitHubMerge(() => {
      control.cancelled = true;
    });
    const id = 'merge_drop_000000000001';
    let out: Awaited<ReturnType<typeof dispatch>>;
    try {
      out = await dispatch(principal, { id, op: 'prs.merge', input: mergeInput(number) }, control);
    } finally {
      restore();
    }
    expect(onGitHub(number)?.merged).toBe(true);
    expect(out.answer).toMatchObject({ type: 'result', kind: 'ok' });
    expect(out.accepted).toBe(true);
    expect(await prState(number)).toBe('merged');
    expect(await receiptOf(id)).toMatchObject({ state: 'completed' });
    expect(await m.runtime.dispatcher.status(principal, id)).toMatchObject({
      state: 'completed',
      outcome: { kind: 'result', resultKind: 'ok' },
    });
  });

  it('the deadline passes once GitHub merged: the commit still records it', async () => {
    const number = await mergeablePr('feat/deadline-after-merge');
    const principal = await principalOf(mara);
    const services = m.t.services;
    const realClock = services.clock;
    const control = new RequestControl(new Date(realClock().getTime() + 60_000));
    const restore = afterGitHubMerge(() => {
      services.clock = () => new Date(realClock().getTime() + 120_000);
    });
    const id = 'merge_deadline_00000001';
    let out: Awaited<ReturnType<typeof dispatch>>;
    try {
      out = await dispatch(principal, { id, op: 'prs.merge', input: mergeInput(number) }, control);
    } finally {
      restore();
      services.clock = realClock;
    }
    expect(onGitHub(number)?.merged).toBe(true);
    expect(out.answer).toMatchObject({ type: 'result', kind: 'ok' });
    expect(await prState(number)).toBe('merged');
  });

  it('GitHub refuses the merge: rejected with its reason, and a cancel before any effect still rolls back', async () => {
    const number = await mergeablePr('feat/refused-merge');
    const principal = await principalOf(mara);
    // The head moved on GitHub: it refuses with 409.
    const pr = onGitHub(number);
    if (!pr) throw new Error('no PR on GitHub');
    const originalHead = pr.headSha;
    pr.headSha = 'f'.repeat(40);
    const refusedId = 'merge_refused_000000001';
    const refused = await dispatch(principal, { id: refusedId, op: 'prs.merge', input: mergeInput(number) });
    expect(refused.answer).toMatchObject({ type: 'error', code: 'conflict' });
    expect(await receiptOf(refusedId)).toMatchObject({ state: 'rejected' });
    expect(await prState(number)).toBe('open');
    pr.headSha = originalHead;

    const other = await mergeablePr('feat/cancel-before-merge');
    const control = new RequestControl(null);
    control.cancelled = true;
    const cancelledId = 'merge_cancelled_0000001';
    const cancelled = await dispatch(
      principal,
      { id: cancelledId, op: 'prs.merge', input: mergeInput(other) },
      control,
    );
    // Cancelled before GitHub was asked: nothing happened anywhere, and the same id may run later.
    expect(cancelled.answer).toMatchObject({ type: 'error', code: 'cancelled' });
    expect(onGitHub(other)?.merged).toBe(false);
    expect(await prState(other)).toBe('open');
    expect(await receiptOf(cancelledId)).toMatchObject({ state: 'not_executed' });
    expect(await m.runtime.dispatcher.status(principal, cancelledId)).toEqual({ state: 'not_found' });
  });

  it('the process dies once GitHub merged, before recording its outcome: a new process answers unknown, never not_found, and never merges again', async () => {
    const number = await mergeablePr('feat/crash-after-merge');
    const principal = await principalOf(mara);
    const fake = fakeOf(m.t);
    const original = fake.mergePullRequest.bind(fake);
    let merges = 0;
    let release!: () => void;
    const hang = new Promise<void>((resolve) => {
      release = resolve;
    });
    // GitHub merges, then the process “dies”: its command never gets further.
    fake.mergePullRequest = async (merge) => {
      merges++;
      const res = await original(merge);
      await hang;
      return res;
    };
    const id = 'merge_crash_00000000001';
    const first = dispatch(principal, { id, op: 'prs.merge', input: mergeInput(number) });
    try {
      await expect
        .poll(async () => (await receiptOf(id))?.outcome, { timeout: 10_000 })
        .toMatchObject({ kind: 'pending_result' });
      await expect.poll(async () => onGitHub(number)?.merged).toBe(true);
      expect(await receiptOf(id)).toMatchObject({ state: 'accepted' });
      // A new process: its own receipts (nothing in flight) and dispatcher.
      const reborn = new SessionDispatcher(
        m.t.services,
        m.runtime.trust,
        new CommandReceipts(m.t.services.db, m.t.services.clock),
      );
      expect(await reborn.status(principal, id)).toMatchObject({
        state: 'rejected',
        outcome: { kind: 'error', code: 'unknown_outcome' },
      });
      const retry = await dispatch(
        principal,
        { id, op: 'prs.merge', input: mergeInput(number) },
        new RequestControl(null),
        reborn,
      );
      expect(retry.answer).toMatchObject({ type: 'error', code: 'unknown_outcome' });
      expect(merges).toBe(1);
      expect(await receiptOf(id)).toMatchObject({ state: 'rejected' });
    } finally {
      release();
      await first;
      fake.mergePullRequest = original;
    }
  });
});

/** Save only the first transaction, as if the process stopped before the required continuation started. */
const saveMergeIntent = defineCommand({
  name: 'test_save_merge_intent',
  schema: mergePr.schema,
  requiredKey: mergePr.requiredKey,
  apply: (tx, ctx, input) => mergePr.apply(tx, { ...ctx, complete() {} }, input),
});

describe('durable GitHub merge recovery', () => {
  it('the mirror wins the race: one event keeps the requesting agent, key and on-behalf-of identity', async () => {
    const number = await mergeablePr('feat/mirror-merge-race');
    const before = await loadGrants(m.t.services.db, IDS.dusty);
    await m.t.commit(IDS.mara, setAgentKeys, {
      grants: before.map((g) => ({ ...g, tier: g.keyId === 'merge.main' ? 'can' : g.tier })),
    });
    const restore = afterGitHubMerge(() => syncGitHub(m.t).then(() => {}));
    try {
      const result = await m.t.services.pipeline.commit(
        mergePr,
        { number, repo: REPO },
        {
          burrowId: m.t.burrowId,
          actorId: IDS.dusty,
          onBehalfOf: { text: 'Mara in Chat', principalId: IDS.mara },
        },
      );
      expect(result.status).toBe('ok');
      const [pr] = await m.t.services.db.select().from(pullRequests).where(eq(pullRequests.number, number));
      expect(pr?.mergedById).toBe(IDS.dusty);
      const signed = await m.t.services.db
        .select()
        .from(events)
        .where(and(eq(events.type, 'pr.merged'), sql`${events.payload}->>'prId' = ${pr?.id}`));
      expect(signed).toHaveLength(1);
      expect(signed[0]).toMatchObject({
        actorId: IDS.dusty,
        onBehalfOfId: IDS.mara,
        onBehalfOf: 'Mara in Chat',
        keyUsed: { id: 'merge.main' },
      });
      if (result.status === 'ok') expect(result.eventIds).toContain(signed[0]?.id);
    } finally {
      restore();
      await m.t.commit(IDS.mara, setAgentKeys, { grants: before });
    }
  });

  it('releases the burrow lock while GitHub is waiting and prevents a concurrent second merge', async () => {
    const number = await mergeablePr('feat/merge-without-lock');
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakeOf(m.t);
    const original = fake.mergePullRequest.bind(fake);
    let calls = 0;
    fake.mergePullRequest = async (input) => {
      calls++;
      entered();
      await waiting;
      return original(input);
    };
    const first = m.t.commit(IDS.mara, mergePr, { number, repo: REPO });
    await ready;
    let committed = false;
    const unrelated = m.t
      .commit(IDS.mara, sendMessage, {
        conversationId: IDS.billing,
        text: 'Keep working while GitHub answers.',
      })
      .then(() => {
        committed = true;
      });
    try {
      await expect.poll(() => committed, { timeout: 2000 }).toBe(true);
      await expect(m.t.commit(IDS.mara, mergePr, { number, repo: REPO })).rejects.toMatchObject({
        code: 'conflict',
      });
      expect(calls).toBe(1);
      expect(onGitHub(number)?.merged).toBe(false);
    } finally {
      release();
      await first;
      await unrelated;
      fake.mergePullRequest = original;
    }
    expect(await prState(number)).toBe('merged');
  });

  it('resumes an intent saved before the call and records its original actor', async () => {
    const number = await mergeablePr('feat/saved-merge');
    await m.t.commit(IDS.mara, saveMergeIntent, { number, repo: REPO });
    expect(onGitHub(number)?.merged).toBe(false);
    await recoverMergeIntents(m.t.services, true);
    await m.t.services.background.settle();
    expect(await prState(number)).toBe('merged');
    const [row] = await m.t.services.db.select().from(pullRequests).where(eq(pullRequests.number, number));
    expect(row?.mergedById).toBe(IDS.mara);
    expect(
      await m.t.services.db
        .select()
        .from(mergeIntents)
        .where(eq(mergeIntents.prId, row?.id ?? '')),
    ).toMatchObject([{ state: 'merged', actorId: IDS.mara }]);
  });

  it('refuses a saved intent if the reviewed head changed before it starts', async () => {
    const number = await mergeablePr('feat/changed-saved-merge');
    await m.t.commit(IDS.mara, saveMergeIntent, { number, repo: REPO });
    await m.t.services.pipeline.transact(m.t.burrowId, async ({ tx }) => {
      await tx
        .update(pullRequests)
        .set({ headSha: 'a'.repeat(40) })
        .where(eq(pullRequests.number, number));
    });
    await recoverMergeIntents(m.t.services, true);
    await m.t.services.background.settle();
    expect(onGitHub(number)?.merged).toBe(false);
    const [row] = await m.t.services.db.select().from(pullRequests).where(eq(pullRequests.number, number));
    expect(
      await m.t.services.db
        .select()
        .from(mergeIntents)
        .where(eq(mergeIntents.prId, row?.id ?? '')),
    ).toMatchObject([{ state: 'refused' }]);
  });

  it('refuses a saved intent if its destination branch changed', async () => {
    const number = await mergeablePr('feat/retargeted-saved-merge');
    await m.t.commit(IDS.mara, saveMergeIntent, { number, repo: REPO });
    await m.t.services.pipeline.transact(m.t.burrowId, async ({ tx }) => {
      await tx.update(pullRequests).set({ baseBranch: 'release' }).where(eq(pullRequests.number, number));
    });
    await recoverMergeIntents(m.t.services, true);
    await m.t.services.background.settle();
    expect(onGitHub(number)?.merged).toBe(false);
    const [pr] = await m.t.services.db.select().from(pullRequests).where(eq(pullRequests.number, number));
    const [intent] = await m.t.services.db
      .select()
      .from(mergeIntents)
      .where(eq(mergeIntents.prId, pr?.id ?? ''));
    expect(intent?.state).toBe('refused');
  });

  it('refuses a saved agent merge after its permission is revoked', async () => {
    const number = await mergeablePr('feat/revoked-saved-merge');
    const before = await loadGrants(m.t.services.db, IDS.dusty);
    try {
      await m.t.commit(IDS.mara, setAgentKeys, {
        grants: before.map((g) => ({ ...g, tier: g.keyId === 'merge.main' ? 'can' : g.tier })),
      });
      const saved = await m.t.commit(IDS.dusty, saveMergeIntent, { number, repo: REPO });
      expect(saved.status).toBe('ok');
      await m.t.commit(IDS.mara, setAgentKeys, { grants: before });
      await recoverMergeIntents(m.t.services, true);
      await m.t.services.background.settle();
      expect(onGitHub(number)?.merged).toBe(false);
      const [pr] = await m.t.services.db.select().from(pullRequests).where(eq(pullRequests.number, number));
      const [intent] = await m.t.services.db
        .select()
        .from(mergeIntents)
        .where(eq(mergeIntents.prId, pr?.id ?? ''));
      expect(intent?.state).toBe('refused');
    } finally {
      await m.t.commit(IDS.mara, setAgentKeys, { grants: before });
    }
  });

  it('keeps a lost GitHub answer uncertain, never calls it again, and reconciles once the mirror proves success', async () => {
    const number = await mergeablePr('feat/lost-merge-answer');
    const fake = fakeOf(m.t);
    const original = fake.mergePullRequest.bind(fake);
    let calls = 0;
    fake.mergePullRequest = async (input) => {
      calls++;
      await original(input);
      throw new Error('connection lost');
    };
    try {
      await expect(m.t.commit(IDS.mara, mergePr, { number, repo: REPO })).rejects.toMatchObject({
        name: 'UnknownOutcomeError',
      });
      expect(await prState(number)).toBe('open');
      await recoverMergeIntents(m.t.services, true);
      await expect(m.t.commit(IDS.mara, mergePr, { number, repo: REPO })).rejects.toMatchObject({
        name: 'UnknownOutcomeError',
      });
      expect(calls).toBe(1);
      await syncGitHub(m.t);
      await recoverMergeIntents(m.t.services);
      const [row] = await m.t.services.db.select().from(pullRequests).where(eq(pullRequests.number, number));
      expect(row?.state).toBe('merged');
      expect(
        await m.t.services.db
          .select()
          .from(mergeIntents)
          .where(eq(mergeIntents.prId, row?.id ?? '')),
      ).toMatchObject([{ state: 'merged' }]);
      expect(calls).toBe(1);
    } finally {
      fake.mergePullRequest = original;
    }
  });

  it('perform_action waits for the merge outcome through the same continuation', async () => {
    const number = await mergeablePr('feat/perform-merge');
    const result = await m.t.commit(IDS.mara, performAction, {
      reason: 'Merge the reviewed work.',
      conversationId: IDS.billing,
      action: { type: 'merge_pr', params: { prNumber: number, repo: REPO, base: 'main' } },
    });
    expect(result.status).toBe('ok');
    expect(onGitHub(number)?.merged).toBe(true);
    expect(await prState(number)).toBe('merged');
  });
});

describe('repos.create (CS-03)', () => {
  const create = (name: string) => ({ params: { burrow: 'burrow-hq' }, body: { name, description: '' } });

  it('the session drops once the origin exists: the commit still records the repository', async () => {
    const principal = await principalOf(mara);
    const control = new RequestControl(null);
    // The session closes after the origin is made, as the record is being committed.
    const pipeline = m.t.services.pipeline;
    const commit = pipeline.commit.bind(pipeline);
    pipeline.commit = ((...args: Parameters<typeof commit>) => {
      control.cancelled = true;
      return commit(...args);
    }) as typeof pipeline.commit;
    let out: Awaited<ReturnType<typeof dispatch>>;
    try {
      out = await dispatch(
        principal,
        { id: 'repo_drop_0000000000001', op: 'repos.create', input: create('Pinned') },
        control,
      );
    } finally {
      pipeline.commit = commit;
    }
    expect(out.answer).toMatchObject({ type: 'result' });
    const [row] = await m.t.services.db
      .select()
      .from(repos)
      .where(and(eq(repos.burrowId, m.t.burrowId), eq(repos.fullName, 'local/Pinned')));
    expect(row?.originPath).toBe(localOriginPath(workspaces, m.t.burrowId, 'Pinned'));
    expect(existsSync(localOriginPath(workspaces, m.t.burrowId, 'Pinned'))).toBe(true);
  });

  it('asked a person (202): the origin the approval points to stays, and no later request removes it', async () => {
    const principal = await principalOf(mara);
    const path = localOriginPath(workspaces, m.t.burrowId, 'Held');
    const approvalId = 'apr_held_origin_000001';
    // A person's `burrow.manage` never asks today; the pipeline answers as it would if it did.
    const pipeline = m.t.services.pipeline;
    const commit = pipeline.commit.bind(pipeline);
    pipeline.commit = (async (_command, input) => {
      const now = new Date();
      await m.t.services.db.insert(approvals).values({
        id: approvalId,
        burrowId: m.t.burrowId,
        number: 9901,
        requesterId: IDS.mara,
        keyId: 'burrow.manage',
        action: { type: 'custom', params: {} } as never,
        title: 'Create Held',
        question: 'Create Held?',
        conditions: [],
        execution: {
          state: 'idle',
          startedAt: null,
          finishedAt: null,
          durationMs: null,
          resultUrl: null,
        } as never,
        conversationId: IDS.general,
        command: { name: 'repos.create', input: input as Record<string, unknown> } as never,
        createdAt: now,
      });
      return {
        status: 'pending_approval',
        approvalId,
        approvalNumber: 9901,
        eventId: 'evt_held_origin_0000001',
        message: 'Asks a person first.',
      };
    }) as typeof pipeline.commit;
    let out: Awaited<ReturnType<typeof dispatch>>;
    try {
      out = await dispatch(principal, {
        id: 'repo_held_000000000001',
        op: 'repos.create',
        input: create('Held'),
      });
    } finally {
      pipeline.commit = commit;
    }
    expect(out.answer).toMatchObject({ type: 'result', kind: 'approval_required' });
    expect(existsSync(path)).toBe(true);
    // Another request for the name while the approval is open: refused, and the origin stays.
    const again = await dispatch(principal, {
      id: 'repo_held_000000000002',
      op: 'repos.create',
      input: create('Held'),
    });
    expect(again.answer).toMatchObject({ type: 'error', code: 'validation_failed' });
    expect(existsSync(path)).toBe(true);
    // Declined: nothing needs it any more, so the next request makes it again and records it.
    await m.t.services.db.update(approvals).set({ state: 'declined' }).where(eq(approvals.id, approvalId));
    const later = await dispatch(principal, {
      id: 'repo_held_000000000003',
      op: 'repos.create',
      input: create('Held'),
    });
    expect(later.answer).toMatchObject({ type: 'result', kind: 'ok' });
    expect(existsSync(path)).toBe(true);
  });

  it('an origin with history or other refs is kept, even when nothing records it, and the name refused', async () => {
    const author = { name: 'Mara Okafor', email: 'mara@example.com' };
    const git = (path: string, ...args: string[]) =>
      execFileSync('git', ['-c', `safe.directory=${path}`, ...args], {
        env: {
          ...process.env,
          GIT_DIR: path,
          GIT_AUTHOR_NAME: 'Mara',
          GIT_AUTHOR_EMAIL: 'm@x',
          GIT_COMMITTER_NAME: 'Mara',
          GIT_COMMITTER_EMAIL: 'm@x',
        },
      })
        .toString()
        .trim();
    // Another branch (pushed work the database no longer knows about, a restore from an older backup)…
    const branched = await createLocalOrigin({
      workspaces,
      burrowId: m.t.burrowId,
      name: 'Branched',
      author,
      now: new Date(),
    });
    git(branched.path, 'update-ref', 'refs/heads/feature', branched.head);
    // …or more history on main.
    const pushed = await createLocalOrigin({
      workspaces,
      burrowId: m.t.burrowId,
      name: 'Pushed',
      author,
      now: new Date(),
    });
    const tree = git(pushed.path, 'rev-parse', `${pushed.head}^{tree}`);
    const next = git(pushed.path, 'commit-tree', tree, '-p', pushed.head, '-m', 'Work');
    git(pushed.path, 'update-ref', 'refs/heads/main', next);
    const principal = await principalOf(mara);
    for (const [name, path, ref] of [
      ['Branched', branched.path, 'refs/heads/feature'],
      ['Pushed', pushed.path, 'refs/heads/main'],
    ] as const) {
      const out = await dispatch(principal, {
        id: `repo_kept_${name}_00000`,
        op: 'repos.create',
        input: create(name),
      });
      expect(out.answer, name).toMatchObject({ type: 'error', code: 'validation_failed' });
      expect(git(path, 'rev-parse', ref), name).toBe(name === 'Pushed' ? next : branched.head);
    }
  });

  it('an origin a dead process left behind, recorded nowhere, is made again', async () => {
    await createLocalOrigin({
      workspaces,
      burrowId: m.t.burrowId,
      name: 'Orphan',
      author: { name: 'Mara Okafor', email: 'mara@example.com' },
      now: new Date(),
    });
    const principal = await principalOf(mara);
    const out = await dispatch(principal, {
      id: 'repo_orphan_00000000001',
      op: 'repos.create',
      input: create('Orphan'),
    });
    expect(out.answer).toMatchObject({ type: 'result' });
  });
});

describe('after the commit (CS-05, CS-06)', () => {
  /** A dispatcher whose `host.recheckAgents` runs `handler` (a real commit, then whatever follows it). */
  function withHandler(handler: RouteDef['handler']) {
    return new SessionDispatcher(
      m.t.services,
      m.runtime.trust,
      new CommandReceipts(m.t.services.db, m.t.services.clock),
      [{ endpoint: api.host.recheckAgents, handler }],
    );
  }
  const recheck = { params: { burrow: 'burrow-hq' } };
  /** A commit that isn't the command's result: an account-level write (a “take”, the empty accept of MD-17). */
  const commitNothing = (services: Services) => services.pipeline.transactAccount(async () => {});
  /** The command itself committing `ok` (a do-nothing pipeline command as Mara). */
  const noop = defineCommand({ name: 'test_noop', schema: z.object({}), apply: async () => ({}) });
  const missing = defineCommand({
    name: 'test_missing',
    schema: z.object({}),
    apply: async () => {
      throw notFound('Person');
    },
  });
  const commitCommand = (services: Services, command = noop) =>
    services.pipeline.commit(command, {}, { burrowId: m.t.burrowId, actorId: IDS.mara });

  it('committed, then failed reading its result back: done, its result not kept — never rejected', async () => {
    const d = withHandler(async ({ services }) => {
      await commitCommand(services);
      throw new Error('the read-back failed');
    });
    const principal = await principalOf(mara);
    const id = 'readback_fail_000000001';
    const out = await dispatch(principal, { id, op: 'host.recheckAgents', input: recheck }, undefined, d);
    expect(out.accepted).toBe(true);
    expect(out.answer).toEqual({ type: 'redacted' });
    expect(await receiptOf(id)).toMatchObject({
      state: 'completed',
      outcome: { kind: 'result', redacted: true },
    });
    expect(await d.status(principal, id)).toMatchObject({ state: 'completed', outcome: { redacted: true } });
    const retry = await dispatch(principal, { id, op: 'host.recheckAgents', input: recheck }, undefined, d);
    expect(retry.answer).toEqual({ type: 'redacted' });
    // What the session sends for it: `outcome{completed, redacted}`.
    const c = await m.client(mara);
    c.send({ t: 'status', id });
    expect(await c.waitFor((x) => x.t === 'outcome' && x.id === id)).toMatchObject({
      state: 'completed',
      redacted: true,
    });
    expect(
      (await c.waitFor((x) => x.t === 'outcome' && x.id === id)) as { result?: unknown },
    ).not.toHaveProperty('result');
  });

  it('committed, then the object it wrote isn’t found: the same', async () => {
    const d = withHandler(async ({ services }) => {
      await commitCommand(services);
      throw notFound('Repo');
    });
    const out = await dispatch(
      await principalOf(mara),
      {
        id: 'readback_missing_000001',
        op: 'host.recheckAgents',
        input: recheck,
      },
      undefined,
      d,
    );
    expect(out.answer).toEqual({ type: 'redacted' });
  });

  it('a first commit that only takes something, then a failure before the command’s own: rejected (CS-12)', async () => {
    // As `packs.import`: the staged archive is taken (a commit), then reading it fails; nothing was imported.
    const d = withHandler(async ({ services }) => {
      await commitNothing(services);
      throw notFound('Staged archive');
    });
    const id = 'take_then_fail_00000001';
    const out = await dispatch(
      await principalOf(mara),
      { id, op: 'host.recheckAgents', input: recheck },
      undefined,
      d,
    );
    expect(out.answer).toMatchObject({ type: 'error', code: 'not_found' });
    expect(await receiptOf(id)).toMatchObject({ state: 'rejected' });
  });

  it('a command committed, then a later command refused with not_found: rejected (CS-12)', async () => {
    // As `me.updateProfile`: one burrow updated, the next one's command refuses.
    const d = withHandler(async ({ services }) => {
      await commitCommand(services);
      await commitCommand(services, missing);
      return {};
    });
    const id = 'second_command_fails_01';
    const out = await dispatch(
      await principalOf(mara),
      { id, op: 'host.recheckAgents', input: recheck },
      undefined,
      d,
    );
    expect(out.answer).toMatchObject({ type: 'error', code: 'not_found' });
    expect(await receiptOf(id)).toMatchObject({ state: 'rejected' });
  });

  it('a session-native write that says its result is decided, then the read-back fails: done (CS-12)', async () => {
    const d = withHandler(async ({ services }) => {
      await commitNothing(services);
      readingBack();
      throw new Error('the read-back failed');
    });
    const out = await dispatch(
      await principalOf(mara),
      { id: 'explicit_readback_00001', op: 'host.recheckAgents', input: recheck },
      undefined,
      d,
    );
    expect(out.answer).toEqual({ type: 'redacted' });
  });

  it('committed, then a later step refused on purpose: rejected with its reason', async () => {
    const d = withHandler(async ({ services }) => {
      await commitNothing(services);
      throw new ApiError('conflict', 'A backup is already running.', { details: { code: 'backup_busy' } });
    });
    const id = 'after_commit_refusal_01';
    const out = await dispatch(
      await principalOf(mara),
      { id, op: 'host.recheckAgents', input: recheck },
      undefined,
      d,
    );
    expect(out.answer).toMatchObject({ type: 'error', code: 'conflict', details: { code: 'backup_busy' } });
    expect(await receiptOf(id)).toMatchObject({ state: 'rejected' });
  });

  it('committed, then an external call failed unexpectedly: its failure, not a read-back (rejected)', async () => {
    const d = withHandler(async ({ services }) => {
      await commitNothing(services);
      await externalEffect('backup.checkpoint', async () => {
        throw new Error('the backup service hung up');
      });
      return {};
    });
    const id = 'after_commit_effect_001';
    const out = await dispatch(
      await principalOf(mara),
      { id, op: 'host.recheckAgents', input: recheck },
      undefined,
      d,
    );
    expect(out.answer).toMatchObject({ type: 'error', code: 'internal' });
    expect(await receiptOf(id)).toMatchObject({ state: 'rejected' });
  });

  it('an effect that failed before the commit with nothing recorded: unknown, and never run again', async () => {
    let runs = 0;
    const d = withHandler(async () => {
      runs++;
      await externalEffect('test.effect', async () => {
        throw new Error('GitHub hung up mid-answer');
      });
      return {};
    });
    const principal = await principalOf(mara);
    const id = 'effect_then_nothing_001';
    const out = await dispatch(principal, { id, op: 'host.recheckAgents', input: recheck }, undefined, d);
    expect(out.answer).toMatchObject({ type: 'error', code: 'unknown_outcome', retryable: false });
    expect(await d.status(principal, id)).toMatchObject({
      state: 'rejected',
      outcome: { code: 'unknown_outcome' },
    });
    const again = await dispatch(principal, { id, op: 'host.recheckAgents', input: recheck }, undefined, d);
    expect(again.answer).toMatchObject({ type: 'error', code: 'unknown_outcome', replayed: true });
    expect(runs).toBe(1);
  });
});

describe('sign in once over a session', () => {
  it('a password the service refused answers its words, never “this may have happened”', async () => {
    // An Unraid that refuses the password as Unraid does: its login page again, with the error on it.
    const seen: string[] = [];
    const unraid = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<p class="error">Invalid username or password</p>');
      });
    });
    await new Promise<void>((resolve) => unraid.listen(0, '127.0.0.1', resolve));
    const port = (unraid.address() as AddressInfo).port;
    useVaultNetForTests(m.t.services, {
      resolve: async (host) =>
        host === 'unraid.safety.test' ? [{ address: '192.168.79.40', family: 4 }] : [],
      dialAddress: (address) => (address === '192.168.79.40' ? '127.0.0.1' : address),
      deadlineMs: 5000,
    });
    await m.t.services.db.insert(vaultNetworks).values({
      id: 'vnw_cmd_safety_unraid',
      cidr: '192.168.79.0/24',
      ports: [port],
      note: 'Unraid stub',
      addedAt: m.t.services.clock(),
    });
    try {
      const principal = await principalOf(mara);
      const id = 'signin_refused_00000001';
      const out = await dispatch(principal, {
        id,
        op: 'connections.create',
        input: {
          params: { burrow: 'burrow-hq' },
          body: {
            catalogId: 'unraid',
            signIn: 'password',
            fields: { url: `http://unraid.safety.test:${port}` },
            login: { account: 'root', password: 'not-the-password' },
            access: 'read',
          },
        },
      });
      expect(seen).toEqual(['POST /login']);
      expect(out.answer).toMatchObject({
        type: 'error',
        details: { code: 'sign_in_refused', reason: 'password' },
      });
      expect(await receiptOf(id)).toMatchObject({ state: 'rejected' });
      const made = await m.t.services.db
        .select({ id: catalogConnections.id })
        .from(catalogConnections)
        .where(eq(catalogConnections.catalogId, 'unraid'));
      expect(made).toEqual([]);
    } finally {
      await new Promise((resolve) => unraid.close(resolve));
      await m.t.services.db.delete(vaultNetworks).where(eq(vaultNetworks.id, 'vnw_cmd_safety_unraid'));
    }
  });
});

describe('Postgres errors inside a transaction (CS-09)', () => {
  it('a read-only refusal raised inside a transaction answers unavailable, not internal', async () => {
    const d = new SessionDispatcher(
      m.t.services,
      m.runtime.trust,
      new CommandReceipts(m.t.services.db, m.t.services.clock),
      [
        {
          endpoint: api.host.recheckAgents,
          // As on a read-only appliance (an update's checkpoint): the write inside the transaction is refused (25006),
          // and drizzle wraps the driver's error (`DrizzleQueryError`, the code on its `cause`).
          handler: async ({ services }) =>
            services.db.transaction(async (tx) => {
              await tx.execute(sql`set transaction read only`);
              await tx.update(repos).set({ description: 'x' }).where(eq(repos.id, 'repo_none'));
              return {};
            }),
        },
      ],
    );
    const id = 'read_only_in_tx_0000001';
    const out = await dispatch(
      await principalOf(mara),
      { id, op: 'host.recheckAgents', input: { params: { burrow: 'burrow-hq' } } },
      undefined,
      d,
    );
    expect(out.answer).toMatchObject({ type: 'error', code: 'unavailable', retryable: true });
    expect(await receiptOf(id)).toMatchObject({ state: 'not_executed' });
  });
});

describe('receipt edge cases (CS-13)', () => {
  const key = (requestId: string) => ({ principalId: 'acc_cs13', op: 'host.recheckAgents', requestId });
  const done = {
    state: 'completed' as const,
    outcome: { kind: 'result' as const, resultKind: 'ok' as const, output: {} },
  };

  it('a mark that can’t be written starts nothing: not executed, never an unknown outcome', async () => {
    const receipts = new CommandReceipts(m.t.services.db, m.t.services.clock);
    receipts.markEffect = async () => {
      throw new Error('the database blinked');
    };
    let acted = 0;
    const d = new SessionDispatcher(m.t.services, m.runtime.trust, receipts, [
      {
        endpoint: api.host.recheckAgents,
        handler: async () => {
          await externalEffect('test.effect', async () => {
            acted++;
          });
          return {};
        },
      },
    ]);
    const principal = await principalOf(mara);
    const id = 'mark_fails_00000000001';
    const out = await dispatch(
      principal,
      { id, op: 'host.recheckAgents', input: { params: { burrow: 'burrow-hq' } } },
      undefined,
      d,
    );
    expect(acted).toBe(0);
    expect(out.answer).toMatchObject({ type: 'error', code: 'internal', retryable: true });
    expect(await receiptOf(id)).toMatchObject({ state: 'not_executed' });
  });

  it('a second process never resets a receipt the first marked meanwhile, so the effect runs once', async () => {
    const db = m.t.services.db;
    const k = key('xproc_reset_000000001');
    await db.insert(commandReceipts).values({ ...k, digest: 'd1', state: 'received', createdAt: new Date() });
    // Process B reads the row before A's mark lands, and tries to take it over after.
    let injected = false;
    const stale = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'select' && !injected)
          return () => ({
            from: (table: typeof commandReceipts) => ({
              where: async (
                cond: Parameters<ReturnType<ReturnType<typeof target.select>['from']>['where']>[0],
              ) => {
                injected = true;
                const rows = await target.select().from(table).where(cond);
                await target
                  .update(commandReceipts)
                  .set({ outcome: { kind: 'effect', label: 'github.merge', at: new Date().toISOString() } })
                  .where(eq(commandReceipts.requestId, k.requestId));
                return rows;
              },
            }),
          });
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db;
    let ran = 0;
    const b = new CommandReceipts(stale, m.t.services.clock);
    const answer = await b.execute(
      k,
      'd1',
      { endpointId: null, deadlineAt: null },
      async () => {
        ran++;
        return done;
      },
      () => {},
    );
    expect(ran).toBe(0);
    expect(answer).toMatchObject({
      kind: 'outcome',
      state: 'rejected',
      outcome: { code: 'unknown_outcome' },
    });
  });

  it('a command another process settled neither commits nor overwrites that answer', async () => {
    const db = m.t.services.db;
    const clock = m.t.services.clock;
    const a = new CommandReceipts(db, clock);
    const b = new CommandReceipts(db, clock);
    const k = key('xproc_settle_00000001');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let marked!: () => void;
    const wasMarked = new Promise<void>((resolve) => {
      marked = resolve;
    });
    let accept: unknown = null;
    const first = a.execute(
      k,
      'd2',
      { endpointId: null, deadlineAt: null },
      async () => {
        await a.markEffect(k, 'github.merge');
        marked();
        await gate;
        accept = await db.transaction((tx) => a.markAccepted(tx, k)).catch((err) => err);
        return done;
      },
      () => {},
    );
    await wasMarked;
    // B takes A for dead and settles the receipt as unknown.
    expect(
      await b.execute(
        k,
        'd2',
        { endpointId: null, deadlineAt: null },
        async () => done,
        () => {},
      ),
    ).toMatchObject({
      state: 'rejected',
      outcome: { code: 'unknown_outcome' },
    });
    release();
    await first;
    // A's transaction was refused, and its result didn't replace the answer B gave.
    expect(accept).toBeInstanceOf(ReceiptSettled);
    expect(await receiptOf(k.requestId)).toMatchObject({
      state: 'rejected',
      outcome: { code: 'unknown_outcome' },
    });
  });
});
