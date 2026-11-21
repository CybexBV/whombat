/**
 * Runs that don't get stuck (docs/decisions/run-checkout.md RC-08…RC-11). After a coding turn Whombat itself does what
 * an agent could forget or never learn about:
 *
 * - `runtime.report_workspace`: what the runner could not do with the checkout (check it out, push, land the commits in
 *   the owner's clone) goes on the run's log and in the conversation, in Whombat's words, so nobody needs the runner log;
 * - `runtime.stall_run`: a run its agent left live, waiting on nobody, wakes the agent once; the next time it is marked
 *   for a person (`runs.attention`, a needs-you row for whoever asked);
 * - `retry_run`: Try again on a failed run — live again, a new run turn with its checkout, where the run was asked.
 *
 * Opening the pull request for pushed work is the ordinary `open_pr`, committed as the agent (`openPullRequestFor`).
 */
import { DispatchId, RunId, topics, WorkspaceProblem } from '@whombat/core';
import { and, asc, desc, eq, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import type { ApplyContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import { dispatches, runLog, runSteps, runs } from '../db/schema/index';
import { enqueueDispatches, enqueueInSession } from '../domain/dispatch';
import { postMessage } from '../domain/messages';
import { type NotificationDraft, notify } from '../domain/notify';
import { ApiError, forbidden } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { loadPrincipalRow } from '../read/principals';
import { cardThread } from '../runtime/dispatch-scope';
import { runWaitsOn } from '../runtime/run-waits';
import { awaitAnswer } from './run-answers';
import { publishRun } from './runs';

type RunRow = typeof runs.$inferSelect;

/** What the runner could not do, as people read it (RC-09). */
const STEP_TEXT: Record<WorkspaceProblem['step'], string> = {
  checkout: 'couldn’t check out the repository',
  push: 'couldn’t push my commits',
  land: 'couldn’t put my commits in the clone',
};

/**
 * “Whombat couldn’t push my commits: …” — one line per problem. The runner's “could not check out <repo>@<branch>: …”
 * reads “Whombat couldn’t check out <repo>@<branch>: …” (resourceful-agents.md RA-DS55).
 */
export function workspaceProblemLines(problems: readonly WorkspaceProblem[]): string[] {
  return problems.map((p) => {
    const checkout = p.step === 'checkout' && /^could not check out \S/.test(p.message);
    return checkout
      ? `Whombat couldn’t check out ${p.message.slice('could not check out '.length)}`
      : `Whombat ${STEP_TEXT[p.step]}: ${p.message}`;
  });
}

/** A line as one sentence: a period after it unless it already ends with one (or another stop) — never two (RA-DS55). */
export function asSentence(line: string): string {
  const text = line.trimEnd();
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/** The runs a turn worked on: the run it was a turn of, and the runs it started; `live` only those still live. */
async function runsOfTurn(ctx: ApplyContext, dispatchId: string, live: boolean): Promise<RunRow[]> {
  const [turn] = await ctx.tx.select().from(dispatches).where(eq(dispatches.id, dispatchId));
  if (!turn || turn.burrowId !== ctx.burrow.id || turn.agentId !== ctx.actor.id) return [];
  return ctx.tx
    .select()
    .from(runs)
    .where(
      and(
        turn.runId
          ? or(eq(runs.id, turn.runId), eq(runs.dispatchId, dispatchId))
          : eq(runs.dispatchId, dispatchId),
        eq(runs.agentId, ctx.actor.id),
        ...(live ? [eq(runs.status, 'live')] : []),
      ),
    );
}

/* runtime.report_workspace ----------------------------------------------------------------------- */

export const reportWorkspace = defineCommand({
  name: 'runtime.report_workspace',
  schema: z.object({ dispatchId: DispatchId, problems: z.array(WorkspaceProblem).min(1).max(5) }),
  async apply(tx, ctx, input) {
    const [turn] = await tx.select().from(dispatches).where(eq(dispatches.id, input.dispatchId));
    if (!turn || turn.burrowId !== ctx.burrow.id || turn.agentId !== ctx.actor.id) return { runs: 0 };
    // Once per run, not once per turn (RA-DS55): what a run's log says already isn't logged or posted again.
    const worked = await runsOfTurn(ctx, input.dispatchId, false);
    const known = worked.length
      ? new Set(
          (
            await tx
              .select({ text: runLog.text })
              .from(runLog)
              .where(
                inArray(
                  runLog.runId,
                  worked.map((r) => r.id),
                ),
              )
          ).map((l) => l.text),
        )
      : new Set<string>();
    const lines = [...new Set(workspaceProblemLines(input.problems))].filter((l) => !known.has(`✗ ${l}`));
    if (lines.length === 0) return { runs: 0 };
    const live = worked.filter((r) => r.status === 'live');
    for (const row of live) {
      const logged = lines.map((text, i) => ({ seq: row.logCount + i, at: ctx.now, text: `✗ ${text}` }));
      await tx.insert(runLog).values(logged.map((l) => ({ runId: row.id, ...l })));
      // The run's “Latest” is what went wrong: the agent's next turn on it reads it there too.
      await tx
        .update(runs)
        .set({ logCount: row.logCount + logged.length, activity: lines[0]?.slice(0, 280) ?? row.activity })
        .where(eq(runs.id, row.id));
      ctx.publish(topics.run(row.id), {
        type: 'run.log',
        runId: row.id,
        runNumber: row.number,
        lines: logged.map((l) => ({ seq: l.seq, at: ctx.at, text: l.text })),
      });
      await publishRun(ctx, row.id, null);
    }
    // Said where the agent was asked, in Whombat's words (never the agent's), so a person sees it without the log.
    const conversation = await loadConversationRow(tx, turn.conversationId);
    if (conversation) {
      await postMessage(ctx, {
        conversation,
        threadRootId: turn.threadRootId,
        text: lines.length === 1 ? asSentence(lines[0] as string) : lines.map((l) => `- ${l}`).join('\n'),
        dispatch: false,
      }).catch(() => null);
    }
    await ctx.emit({
      type: 'run.workspace_problem',
      kind: 'System',
      text: null,
      where: live[0] ? `Run #${live[0].number}` : null,
      payload: { dispatchId: input.dispatchId, problems: input.problems },
    });
    return { runs: live.length };
  },
});

/* runtime.stall_run ------------------------------------------------------------------------------ */

/** “Dusty stopped without finishing this run.” (`Run.attention`, RC-11). */
export function stalledText(agentName: string): string {
  return `${agentName} stopped without finishing this run.`;
}

/**
 * Recheck a live run under the commit lock. A turn end and the periodic safety pass use the same dependency checks.
 * The first time Whombat wakes the agent on the run (`stalledRun`); after that the run needs a person.
 */
export const stallRun = defineCommand({
  name: 'runtime.stall_run',
  schema: z.object({ runId: RunId, dispatchId: DispatchId, pushed: z.boolean().optional() }),
  async apply(tx, ctx, input): Promise<{ action: 'woken' | 'attention' | 'none' }> {
    const [row] = await tx.select().from(runs).where(eq(runs.id, input.runId)).for('update');
    if (!row || row.burrowId !== ctx.burrow.id || row.agentId !== ctx.actor.id || row.status !== 'live')
      return { action: 'none' };
    if (row.attention) return { action: 'none' };
    if (ctx.services.licence.lapsed) return { action: 'none' };
    const [turn] = await tx
      .select()
      .from(dispatches)
      .where(
        and(
          eq(dispatches.burrowId, row.burrowId),
          eq(dispatches.agentId, row.agentId),
          or(eq(dispatches.runId, row.id), row.dispatchId ? eq(dispatches.id, row.dispatchId) : undefined),
        ),
      )
      .orderBy(desc(dispatches.createdAt), desc(dispatches.id))
      .limit(1);
    // A stale callback cannot act for a later turn, or while a turn still owns the run.
    if (!turn || turn.id !== input.dispatchId || !['done', 'failed', 'cancelled'].includes(turn.state))
      return { action: 'none' };
    const waits = await runWaitsOn(tx, turn, row, input.pushed);
    if (waits?.question) {
      await awaitAnswer.apply(tx, ctx, { runId: row.id, messageId: waits.question, dispatchId: turn.id });
      return { action: 'attention' };
    }
    if (waits) return { action: 'none' };
    const services = ctx.services;
    const at = ctx.now;
    if (!row.stalledAt && turn.state === 'done') {
      await tx.update(runs).set({ stalledAt: ctx.now, updatedAt: ctx.now }).where(eq(runs.id, row.id));
      await ctx.emit({
        type: 'run.stalled',
        kind: 'Code',
        text: null,
        where: `Run #${row.number}`,
        ref: { type: 'run', number: row.number },
        payload: { runId: row.id, woken: true },
      });
      // Where the turn was asked (its message and thread), else the run's card; for the same person (VA-02).
      const cardThreadId = await cardThread(tx, row.messageId);
      await enqueueInSession(ctx, {
        burrowId: row.burrowId,
        causedById: row.agentId,
        conversationId: turn.conversationId,
        messageId: turn.messageId ?? row.messageId,
        threadRootId: turn.threadRootId ?? cardThreadId,
        requests: [{ agentId: row.agentId, trigger: 'run_control', mode: 'run' }],
        at,
        runId: row.id,
        onBehalfOfAccountId: turn.onBehalfOfAccountId,
      });
      return { action: 'woken' };
    }
    const agentName = ctx.actor.name;
    const attention = stalledText(agentName);
    await tx.update(runs).set({ attention, updatedAt: ctx.now }).where(eq(runs.id, row.id));
    const event = await ctx.emit({
      type: 'run.stalled',
      kind: 'Code',
      text: `${agentName} stopped without finishing run #${row.number}`,
      where: `Run #${row.number}`,
      ref: { type: 'run', number: row.number },
      payload: { runId: row.id, woken: false },
    });
    await publishRun(ctx, row.id, event.id);
    // Whoever asked for the run, when that is a person (an agent's handoff reports back its own way).
    const asker = await loadPrincipalRow(tx, row.askedById);
    const conversation = await loadConversationRow(tx, row.conversationId);
    if (asker?.kind === 'person' && conversation) {
      const draft: NotificationDraft = {
        burrowId: ctx.burrow.id,
        burrowSlug: ctx.burrow.slug,
        principalId: asker.id,
        kind: 'needs_you',
        actorId: row.agentId,
        where: `Run #${row.number}`,
        text: `${agentName} stopped without finishing run #${row.number} “${row.title}”.`.slice(0, 500),
        link: { type: 'run', number: row.number },
        createdAt: at,
        dedupKey: `run-stalled:${row.id}:${at.toISOString()}`,
      };
      ctx.after(() => notify(services, [draft]));
    }
    return { action: 'attention' };
  },
});

/* retry_run -------------------------------------------------------------------------------------- */

/**
 * A failed run goes live again (RC-10): the step it stopped on is active again (later failed ones wait), its summary,
 * attention and stall cleared, signed `run.retried` “Tried Dusty’s run #2 again” by the person who asked. The caller
 * queues its run turn. Also Try again on the failure of a turn on the run (resourceful-agents.md RA-DS54).
 */
export async function reopenRun(ctx: ApplyContext, row: RunRow): Promise<void> {
  const tx = ctx.tx;
  const agent = await loadPrincipalRow(tx, row.agentId);
  const agentName = agent?.name ?? 'the agent';
  const steps = await tx.select().from(runSteps).where(eq(runSteps.runId, row.id)).orderBy(asc(runSteps.idx));
  let first = true;
  for (const s of steps) {
    if (s.state !== 'failed') continue;
    await tx
      .update(runSteps)
      .set({ state: first ? 'active' : 'queued' })
      .where(and(eq(runSteps.runId, row.id), eq(runSteps.idx, s.idx)));
    first = false;
  }
  await tx
    .update(runs)
    .set({
      status: 'live',
      finishedAt: null,
      summary: null,
      attention: null,
      stalledAt: null,
      pausedById: null,
      activity: 'Trying again',
      updatedAt: ctx.now,
    })
    .where(eq(runs.id, row.id));
  const event = await ctx.emit({
    type: 'run.retried',
    kind: 'Code',
    text: `Tried ${agentName}’s run #${row.number} again`,
    where: `Run #${row.number}`,
    aboutId: row.agentId,
    ref: { type: 'run', number: row.number },
    payload: { runId: row.id },
  });
  await publishRun(ctx, row.id, event.id);
}

/**
 * Try again (RC-10): a failed run goes live again and its agent gets a new run turn — with the run's checkout, where the
 * run was asked (the turn that started it), the person's (one-person.md OP-17).
 */
export const retryRun = defineCommand({
  name: 'retry_run',
  // A new agent turn: the run retry of LC-10.
  licence: 'agentTurn',
  schema: z.object({ number: z.coerce.number().int().positive() }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only a person can try a run again.');
    const [row] = await tx
      .select()
      .from(runs)
      .where(and(eq(runs.burrowId, ctx.burrow.id), eq(runs.number, input.number)))
      .for('update');
    if (!row) throw new ApiError('not_found', `Run #${input.number} not found.`);
    if (row.status !== 'failed') throw new ApiError('conflict', 'Only a failed run can be tried again.');
    await reopenRun(ctx, row);
    const [origin] = row.dispatchId
      ? await tx
          .select({ messageId: dispatches.messageId, threadRootId: dispatches.threadRootId })
          .from(dispatches)
          .where(eq(dispatches.id, row.dispatchId))
      : [];
    const cardThreadId = await cardThread(tx, row.messageId);
    const services = ctx.services;
    const at = ctx.now;
    ctx.after(async () => {
      await enqueueDispatches(services, {
        burrowId: row.burrowId,
        causedById: ctx.actor.id,
        conversationId: row.conversationId,
        messageId: origin?.messageId ?? row.messageId,
        threadRootId: origin?.threadRootId ?? cardThreadId,
        requests: [{ agentId: row.agentId, trigger: 'run_control', mode: 'run' }],
        at,
        runId: row.id,
      });
    });
    return { runId: row.id };
  },
});
