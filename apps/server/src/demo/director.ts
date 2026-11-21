/**
 * The demo storyline (DECISIONS B-01, runtime-server.md; one-agent.md OA-01): the agent's run #1907 reaches 41/41, the
 * person who asked for changes approves, the branch becomes ready and the approved-in-advance staging deploy goes out.
 *
 * The agent's part is played in the runner through MCP (the run) — by the scripted Hermes in the demo and in tests
 * (hermes-engine.md HE-33: `WHOMBAT_HERMES_BIN` set to `@whombat/agent-runtime`'s `scripted-hermes.ts`). The director
 * plays the rest of the world, through the same commands:
 * - `play()` queues a run-control dispatch for the agent (after rewinding the storyline to 11:22 when it is not
 *   mid-play), so the runner claims it and the scripted agent plays the LIVE timeline.
 * - When the run finishes, GitHub and CI play their part through FakeGitHub: the agent's push of 7be20f and green
 *   check runs on it land on the fake, and the poller mirrors them (the push signed by the agent under its branch
 *   key, through its push grant; the checks by the agent, the CI reporter); then the Whombat's person approves it
 *   (one-person.md OP-S01: their review and its words in the branch room, as `review_pr` records them).
 *   Without the fake (GitHub off or gh) the director records the push and checks directly.
 * - The staging deploy runs through a demo executor that reports the mock's 2m 14s and result URL.
 * - The agent writes the third rule of the plan canvas while the run plays and ends it when the run is done
 *   (`canvas-writer.ts`, through `canvas_edit`): the mock's "Dusty is writing" is live.
 * - `rewind()` puts the storyline rows back to the seed (a signed, hidden `demo.rewound` event by the
 *   person); the audit log keeps what happened before, as it must.
 */
import { agentCommitEmail, type Check, type ExecutionOutcome, type PlanStep, topics } from '@whombat/core';
import { LIVE_LOG_LINES, prApproved, RUN_STEPS_TIMELINE } from '@whombat/fixtures';
import { and, asc, eq, gt, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { nothingHappened } from '../approvals/unavailable';
import { recordPush } from '../commands/agent-tools';
import { recordChecks, reviewPr } from '../commands/prs';
import { publishRun } from '../commands/runs';
import { defineCommand } from '../commit/types';
import type { Tx } from '../db/client';
import {
  approvals,
  burrows,
  dispatches,
  messages,
  plans,
  prChecks,
  prCommits,
  principals,
  prReviewers,
  pullRequests,
  reactions,
  repos,
  runFiles,
  runLog,
  runSteps,
  runs,
  searchDocuments,
} from '../db/schema/index';
import { enqueueDispatches } from '../domain/dispatch';
import { ApiError, notFound } from '../lib/errors';
import { loadPrincipalRow, toAgent } from '../read/principals';
import { loadPlan, loadPullRequest, toApproval } from '../read/work';
import { shiftTimestamps } from '../seed/load';
import { seedWorldSource } from '../seed/source';
import type { ParsedSeedWorld } from '../seed/world';
import { SeedWorld } from '../seed/world';
import type { Services } from '../services';
import { CanvasWriter } from './canvas-writer';

/** The storyline, by the ids and numbers the seed uses. */
export const DEMO = {
  runNumber: 1907,
  branch: 'feat/invoice-pdf',
  prNumber: 482,
  approvalNumber: 12,
  repo: 'whombat/billing',
  /** The agent's push once the run is done (mock: "Pushed 7be20f"). */
  push: { sha: prApproved.headSha, message: 'Round VAT before formatting' },
  /** Checks on 7be20f: unit 41/41, pdf-snapshot passed. */
  checks: prApproved.checks as Check[],
  /** What the person says in the branch room when they approve 7be20f. */
  review: { body: 'Approved. Rounding order is right.' },
  /** "Deployed to staging in 2m 14s. Try it: staging.burrowhq.example/invoices/2026-000142.pdf" */
  deploy: {
    environment: 'staging',
    durationMs: 134_000,
    resultUrl: 'https://staging.burrowhq.example/invoices/2026-000142.pdf',
  },
} as const;

const LIVE_TEXTS = new Set(LIVE_LOG_LINES.map((l) => l.text));

export interface DemoOptions {
  /** How long the demo deploy "runs" before it reports (it reports the mock's 2m 14s either way). */
  deployDelayMs: number;
}

interface Storyline {
  burrowId: string;
  ownerId: string;
  run: typeof runs.$inferSelect;
  pr: typeof pullRequests.$inferSelect;
  roomId: string;
  /** The burrow's one agent, who plays every part. */
  agent: string;
}

export type PlayResult = {
  status: 'playing' | 'started' | 'continued';
  runNumber: number;
  dispatchId?: string;
};

export class DemoDirector {
  readonly options: DemoOptions;
  private armed = false;
  private readonly handled = new Set<string>();
  /** Background work kicked off by the storyline (tests await it). */
  private pending: Promise<unknown> = Promise.resolve();
  private offBus: (() => void) | null = null;
  /** The agent writing the plan canvas's third rule while the storyline plays. */
  readonly writer: CanvasWriter;

  constructor(
    private readonly services: Services,
    options: Partial<DemoOptions> = {},
  ) {
    this.options = { deployDelayMs: 1500, ...options };
    this.writer = new CanvasWriter(services);
  }

  /** Resolves the storyline in a burrow (by slug; defaults to the burrow holding run #1907 on feat/invoice-pdf). */
  async storyline(burrowSlug?: string): Promise<Storyline> {
    const db = this.services.db;
    const where = [eq(runs.number, DEMO.runNumber), eq(runs.branch, DEMO.branch)];
    if (burrowSlug) {
      const [b] = await db.select({ id: burrows.id }).from(burrows).where(eq(burrows.slug, burrowSlug));
      if (!b) throw notFound('Whombat');
      where.push(eq(runs.burrowId, b.id));
    }
    const [run] = await db
      .select()
      .from(runs)
      .where(and(...where))
      .orderBy(asc(runs.startedAt));
    if (!run)
      throw new ApiError(
        'not_found',
        'The demo storyline is not seeded here (no run #1907). Run pnpm db:seed.',
      );
    const [pr] = await db
      .select({ pr: pullRequests })
      .from(pullRequests)
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(
        and(
          eq(pullRequests.burrowId, run.burrowId),
          eq(pullRequests.number, DEMO.prNumber),
          eq(repos.fullName, DEMO.repo),
        ),
      );
    if (!pr) throw notFound('PR #482');
    const people = await db
      .select()
      .from(principals)
      .where(eq(principals.burrowId, run.burrowId))
      .orderBy(asc(principals.position));
    const agent = people.find((p) => p.kind === 'agent')?.id;
    const owner = people.find((p) => p.kind === 'person');
    if (!agent || !owner) throw notFound('The storyline agent');
    return {
      burrowId: run.burrowId,
      ownerId: owner.id,
      run,
      pr: pr.pr,
      roomId: pr.pr.conversationId,
      agent,
    };
  }

  /* Play ----------------------------------------------------------------------------------------- */

  /**
   * Plays the storyline: continues a run that is mid-timeline, otherwise rewinds to 11:22 and starts it.
   * The runner (the scripted Hermes) does the rest.
   */
  async play(burrowSlug?: string): Promise<PlayResult> {
    this.arm();
    let s = await this.storyline(burrowSlug);
    const [live] = await this.services.db
      .select({ id: dispatches.id })
      .from(dispatches)
      .where(
        and(eq(dispatches.runId, s.run.id), inArray(dispatches.state, ['queued', 'claimed', 'running'])),
      );
    if (live) return { status: 'playing', runNumber: DEMO.runNumber, dispatchId: live.id };
    const midPlay = s.run.status === 'live' && LIVE_TEXTS.has(s.run.activity);
    if (!midPlay) {
      if (s.run.status === 'live') {
        // At 11:22 (as seeded): keep everything a person did meanwhile (approve in advance), only lay out
        // the run's five steps. A finished, paused or taken-over storyline replays from a full rewind.
        await this.services.pipeline.commit(
          PrepareRun,
          { runId: s.run.id },
          { burrowId: s.burrowId, actorId: s.agent },
        );
      } else {
        await this.rewind(burrowSlug);
      }
      s = await this.storyline(burrowSlug);
    }
    this.handled.delete(s.run.id);
    const [queued] = await enqueueDispatches(this.services, {
      burrowId: s.burrowId,
      causedById: s.ownerId,
      conversationId: s.run.conversationId,
      messageId: s.run.messageId,
      threadRootId: null,
      requests: [{ agentId: s.agent, trigger: 'run_control', mode: 'run' }],
      at: this.services.clock(),
      runId: s.run.id,
    });
    void this.writer.start(s.burrowId).catch(() => {});
    return {
      status: midPlay ? 'continued' : 'started',
      runNumber: DEMO.runNumber,
      ...(queued ? { dispatchId: queued.dispatchId } : {}),
    };
  }

  /**
   * `WHOMBAT_DEMO=1` on startup: play while the storyline is still ahead (seeded at 11:22, or mid-play after
   * a restart). A finished storyline stays finished until `pnpm demo:play` / `demo:reset`.
   */
  async autoplay(burrowSlug?: string): Promise<PlayResult | { status: 'finished'; runNumber: number }> {
    this.arm();
    const s = await this.storyline(burrowSlug);
    if (s.run.status !== 'live') return { status: 'finished', runNumber: DEMO.runNumber };
    return this.play(burrowSlug);
  }

  /**
   * Listens for the storyline run finishing and installs the demo deploy executor — the storyline's own stand-in for
   * its one staging deploy; every other deploy is the real workflow's or none (essentials-agents.md EA-02). Idempotent.
   */
  arm(): void {
    if (this.armed) return;
    this.armed = true;
    const fallback = this.services.approvals.executorFor('deploy');
    this.services.approvals.setExecutor('deploy', async (approval, services) => {
      const a = approval.action;
      if (
        a.type !== 'deploy' ||
        a.params.ref !== DEMO.branch ||
        a.params.environment !== DEMO.deploy.environment
      )
        return fallback
          ? fallback(approval, services)
          : { ok: false, error: nothingHappened(approval.action) };
      await new Promise((r) => setTimeout(r, this.options.deployDelayMs));
      return {
        ok: true,
        resultUrl: DEMO.deploy.resultUrl,
        durationMs: DEMO.deploy.durationMs,
      } satisfies ExecutionOutcome;
    });
    this.offBus = this.services.bus.onFrame((frame) => {
      const ev = frame.event;
      if (ev.type !== 'run.updated' || !frame.topic.startsWith('run:')) return;
      if (ev.run.number !== DEMO.runNumber || ev.run.branch !== DEMO.branch || ev.run.status !== 'done')
        return;
      if (this.handled.has(ev.run.id)) return;
      this.handled.add(ev.run.id);
      this.pending = this.pending
        .then(() => this.afterRun(ev.run.burrowId))
        .catch((err) => this.services.log.error({ err: String(err) }, 'demo: after-run steps failed'));
    });
  }

  /** Resolves once the director's background steps (push, checks, re-review, the agent's canvas edits) are done. */
  settled(): Promise<unknown> {
    return Promise.all([this.pending, this.writer.settled()]);
  }

  /**
   * The agent's run is done: the GitHub mirror records its push, CI goes green on it, and the person approves it in the
   * branch room.
   */
  private async afterRun(burrowId: string): Promise<void> {
    const [b] = await this.services.db
      .select({ slug: burrows.slug })
      .from(burrows)
      .where(eq(burrows.id, burrowId));
    const s = await this.storyline(b?.slug);
    const { pipeline } = this.services;
    // The agent ends the rule it was writing.
    await this.writer.finish(burrowId).catch(() => {});
    const owner = await loadPrincipalRow(this.services.db, s.ownerId);
    const agentRow = await loadPrincipalRow(this.services.db, s.agent);
    const onBehalfOf = {
      text: `${owner?.name ?? 'The owner'}’s PR #${DEMO.prNumber}`,
      principalId: s.ownerId,
    };
    const fake = this.services.github.fake;
    if (fake) {
      // GitHub plays its part through FakeGitHub: the agent's runner pushes 7be20f with its push token (so the
      // mirrored push is signed by the agent under its branch key) and CI reports on it (signed by the agent).
      await this.services.github.recordPushGrant({
        burrowId,
        repo: DEMO.repo,
        branch: DEMO.branch,
        agentId: s.agent,
        dispatchId: null,
        onBehalfOf,
        sha: DEMO.push.sha,
        expiresAt: new Date(this.services.clock().getTime() + 60 * 60_000),
      });
      await fake.simulatePush({
        repo: DEMO.repo,
        branch: DEMO.branch,
        commits: [
          {
            sha: DEMO.push.sha,
            message: DEMO.push.message,
            authorName: agentRow?.name ?? 'Dusty',
            authorEmail: agentCommitEmail(agentRow?.handle ?? 'dusty', b?.slug ?? 'burrow-hq'),
          },
        ],
      });
      for (const check of DEMO.checks)
        await fake.simulateCheckRun({
          repo: DEMO.repo,
          sha: DEMO.push.sha,
          name: check.name,
          status: 'completed',
          conclusion:
            check.state === 'failed' ? 'failure' : check.state === 'skipped' ? 'skipped' : 'success',
          title: check.tests ? `${check.tests.passed} of ${check.tests.total} passed` : null,
          durationMs: check.durationMs,
          url: check.url,
        });
      // The poller reads it back from "GitHub" now, as it would every 30 seconds.
      await this.services.github.poller.pollNow({ burrowId });
    } else {
      await pipeline.commit(
        recordPush,
        { repo: DEMO.repo, branch: DEMO.branch, sha: DEMO.push.sha, message: DEMO.push.message },
        { burrowId, actorId: s.agent, onBehalfOf },
      );
      await pipeline.commit(
        recordChecks,
        { prNumber: DEMO.prNumber, repo: DEMO.repo, headSha: DEMO.push.sha, checks: [...DEMO.checks] },
        { burrowId, actorId: s.agent },
      );
    }
    // The person approves the fix (the mock's 11:38), as their review records it.
    await pipeline.commit(
      reviewPr,
      {
        prNumber: DEMO.prNumber,
        repo: DEMO.repo,
        decision: 'approve',
        body: DEMO.review.body,
        comments: [],
      },
      { burrowId, actorId: s.ownerId },
    );
  }

  /* Rewind --------------------------------------------------------------------------------------- */

  /** Puts the storyline back to how the seed left it (11:22), in one signed commit by the person. */
  async rewind(burrowSlug?: string): Promise<void> {
    this.writer.stop();
    const s = await this.storyline(burrowSlug);
    const { world } = await seedWorldSource();
    const parsed = SeedWorld.parse(world);
    const seedRun = parsed.runs.find((r) => r.number === DEMO.runNumber && r.branch === DEMO.branch);
    if (!seedRun) throw new ApiError('conflict', 'The seed world has no run #1907 to rewind to.');
    // `--relative` seeds are shifted: shift the seed slices the same way.
    const shiftMs = s.run.startedAt.getTime() - Date.parse(seedRun.startedAt);
    const seed = asOnePerson(shiftTimestamps(parsed, shiftMs), s.ownerId);
    await this.services.pipeline.commit(
      RewindStoryline,
      { seed, storyline: s },
      { burrowId: s.burrowId, actorId: s.ownerId },
    );
    this.handled.clear();
  }

  close(): void {
    this.writer.stop();
    this.offBus?.();
    this.offBus = null;
  }
}

/** The storyline's five run steps at tick 0 (the seed may carry fewer), step one active since the start. */
async function layOutSteps(tx: Tx, run: { id: string; startedAt: Date }): Promise<void> {
  await tx.delete(runSteps).where(eq(runSteps.runId, run.id));
  await tx.insert(runSteps).values(
    RUN_STEPS_TIMELINE.map((step, idx) => ({
      runId: run.id,
      idx,
      title: step.title,
      detail: step.detail,
      at: idx === 0 ? run.startedAt : null,
      state: idx === 0 ? ('active' as const) : ('queued' as const),
    })),
  );
}

/** Before the agent starts: the run shows the storyline's steps (signed by the agent, whose plan they are). */
const PrepareRun = defineCommand({
  name: 'demo.prepare_run',
  schema: z.object({ runId: z.string() }),
  async apply(tx, ctx, input) {
    const [run] = await tx.select().from(runs).where(eq(runs.id, input.runId));
    if (!run) throw notFound('Run');
    const steps = await tx
      .select()
      .from(runSteps)
      .where(eq(runSteps.runId, run.id))
      .orderBy(asc(runSteps.idx));
    if (steps.map((st) => st.title).join('\n') === RUN_STEPS_TIMELINE.map((st) => st.title).join('\n'))
      return {};
    await layOutSteps(tx, run);
    const event = await ctx.emit({
      type: 'run.step',
      kind: 'Code',
      text: null,
      where: `Run #${run.number}`,
      ref: { type: 'run', number: run.number },
      payload: { runId: run.id, steps: RUN_STEPS_TIMELINE.length },
    });
    await publishRun(ctx, run.id, event.id);
    return {};
  },
});

/**
 * The seed world as one person's (one-person.md OP-S01): a review or an ask it gives to someone else is the storyline's
 * person's. Contracts 2.1.0's fixtures still have other people; 3.0.0's world has one.
 */
function asOnePerson(seed: ParsedSeedWorld, personId: string): ParsedSeedWorld {
  const others = new Set(seed.people.map((p) => p.id).filter((id) => id !== personId));
  const one = (id: string) => (others.has(id) ? personId : id);
  return {
    ...seed,
    pullRequests: seed.pullRequests.map((pr) => ({
      ...pr,
      reviewers: pr.reviewers
        .map((r) => ({ ...r, principalId: one(r.principalId) }))
        .filter((r, i, all) => all.findIndex((x) => x.principalId === r.principalId) === i),
    })),
    approvals: seed.approvals.map((a) => ({
      ...a,
      conditions: a.conditions.map((c) =>
        c.kind === 'review_approved'
          ? { ...c, reviewerId: one(c.reviewerId) }
          : c.kind === 'person_approves'
            ? { ...c, approverIds: [...new Set(c.approverIds.map(one))] }
            : c,
      ),
    })),
  };
}

/** The rewind itself: storyline rows back to the seed, demo messages removed, a hidden signed event. */
const RewindStoryline = defineCommand({
  name: 'demo.rewind',
  schema: z.object({ seed: z.custom<ParsedSeedWorld>(), storyline: z.custom<Storyline>() }),
  async apply(tx, ctx, { seed, storyline: s }) {
    const now = ctx.now;
    const seedRun = seed.runs.find((r) => r.number === DEMO.runNumber && r.branch === DEMO.branch);
    const seedPr = seed.pullRequests.find((p) => p.number === DEMO.prNumber);
    if (!seedRun || !seedPr) throw new ApiError('conflict', 'The seed world has no storyline to rewind to.');

    // Stop anything still working on the storyline.
    await tx
      .update(dispatches)
      .set({ state: 'cancelled', finishedAt: now, error: 'demo_rewound', leaseExpiresAt: null })
      .where(
        and(
          inArray(dispatches.state, ['queued', 'claimed', 'running']),
          sql`(${dispatches.runId} = ${s.run.id} or ${dispatches.conversationId} = ${s.roomId})`,
        ),
      );

    // Run #1907: tick 0 with the five storyline steps, the base log and files.
    const baseLog = seedRun.log.length;
    await tx.delete(runLog).where(and(eq(runLog.runId, s.run.id), gte(runLog.seq, baseLog)));
    await layOutSteps(tx, s.run);
    await tx.delete(runFiles).where(eq(runFiles.runId, s.run.id));
    if (seedRun.files.length)
      await tx
        .insert(runFiles)
        .values(seedRun.files.map((f, position) => ({ runId: s.run.id, ...f, position })));
    await tx
      .update(runs)
      .set({
        status: seedRun.status,
        finishedAt: null,
        progress: seedRun.progress,
        activity: seedRun.activity,
        summary: seedRun.summary,
        tests: seedRun.tests,
        diff: seedRun.diff,
        keysUsed: seedRun.keysUsed,
        logCount: seedRun.logCount ?? baseLog,
        pausedById: null,
        takenOverById: null,
        updatedAt: now,
      })
      .where(eq(runs.id, s.run.id));

    // PR #482: head e9f114, checks 38/41, the reviewer's changes requested, the three seeded commits.
    await tx
      .update(pullRequests)
      .set({ headSha: seedPr.headSha, state: 'open', mergedAt: null, mergedById: null, updatedAt: now })
      .where(eq(pullRequests.id, s.pr.id));
    await tx.delete(prChecks).where(eq(prChecks.prId, s.pr.id));
    if (seedPr.checks.length)
      await tx
        .insert(prChecks)
        .values(seedPr.checks.map((c, position) => ({ prId: s.pr.id, ...c, position })));
    await tx.delete(prReviewers).where(eq(prReviewers.prId, s.pr.id));
    if (seedPr.reviewers.length)
      await tx.insert(prReviewers).values(
        seedPr.reviewers.map((r, position) => ({
          prId: s.pr.id,
          principalId: r.principalId,
          state: r.state,
          at: r.at ? new Date(r.at) : null,
          position,
        })),
      );
    const keep = seedPr.commits.map((c) => c.sha);
    const commits = await tx
      .select({ sha: prCommits.sha })
      .from(prCommits)
      .where(eq(prCommits.prId, s.pr.id));
    const drop = commits.map((c) => c.sha).filter((sha) => !keep.includes(sha));
    if (drop.length)
      await tx.delete(prCommits).where(and(eq(prCommits.prId, s.pr.id), inArray(prCommits.sha, drop)));

    // Approvals and plans the storyline touches.
    for (const a of seed.approvals) {
      await tx
        .update(approvals)
        .set({
          state: a.state,
          decidedById: a.decidedById,
          decidedAt: a.decidedAt ? new Date(a.decidedAt) : null,
          conditions: a.conditions,
          execution: a.execution,
          executedAt: a.executedAt ? new Date(a.executedAt) : null,
          updatedAt: now,
        })
        .where(and(eq(approvals.burrowId, s.burrowId), eq(approvals.number, a.number)));
    }
    const planIds: string[] = [];
    for (const p of seed.plans) {
      if (!p.steps.some((st: PlanStep) => st.runId === s.run.id)) continue;
      await tx.update(plans).set({ steps: p.steps, updatedAt: now }).where(eq(plans.id, p.id));
      planIds.push(p.id);
    }

    // Agents' status lines.
    for (const agentId of [s.agent]) {
      const seeded = seed.agents.find((a) => a.id === agentId);
      if (seeded)
        await tx
          .update(principals)
          .set({ status: seeded.status, doing: seeded.doing })
          .where(eq(principals.id, agentId));
    }

    // What the demo said in the branch room after 11:22: the agent's posts and the person's approval.
    const said = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, s.roomId),
          inArray(messages.authorId, [s.agent, s.ownerId]),
          gt(messages.createdAt, s.run.startedAt),
          sql`${messages.threadRootId} is null`,
        ),
      );
    const saidIds = said.map((m) => m.id);
    if (saidIds.length) {
      await tx.delete(reactions).where(inArray(reactions.messageId, saidIds));
      await tx.delete(searchDocuments).where(inArray(searchDocuments.id, saidIds));
      await tx.delete(messages).where(inArray(messages.id, saidIds));
    }

    const event = await ctx.emit({
      type: 'demo.rewound',
      kind: 'System',
      text: null,
      where: `Run #${DEMO.runNumber}`,
      payload: { runId: s.run.id, prId: s.pr.id, removedMessages: saidIds.length },
    });
    for (const id of saidIds)
      ctx.publish(
        topics.conversation(s.roomId),
        { type: 'message.deleted', conversationId: s.roomId, messageId: id },
        { eventId: event.id },
      );
    await publishRun(ctx, s.run.id, event.id);
    const [prRow] = await tx.select().from(pullRequests).where(eq(pullRequests.id, s.pr.id));
    if (prRow)
      ctx.publish(
        topics.burrow(s.burrowId),
        { type: 'pr.updated', pr: await loadPullRequest(tx, prRow) },
        { eventId: event.id },
      );
    const rows = await tx.select().from(approvals).where(eq(approvals.burrowId, s.burrowId));
    for (const row of rows.filter((r) => seed.approvals.some((a) => a.number === r.number)))
      ctx.publish(
        topics.burrow(s.burrowId),
        { type: 'approval.updated', approval: toApproval(row) },
        { eventId: event.id },
      );
    for (const id of planIds) {
      const plan = await loadPlan(tx, id);
      if (plan) ctx.publish(topics.burrow(s.burrowId), { type: 'plan.updated', plan }, { eventId: event.id });
    }
    for (const agentId of [s.agent]) {
      const row = await loadPrincipalRow(tx, agentId);
      if (row)
        ctx.publish(
          topics.burrow(s.burrowId),
          { type: 'agent.updated', agent: toAgent(row) },
          { eventId: event.id },
        );
    }
    return { removedMessages: saidIds.length };
  },
});
