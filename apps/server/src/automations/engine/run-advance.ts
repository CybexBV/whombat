/**
 * Runs (bp-automations BP-C05): the active engine advances each active run under a lease with a fencing token, one
 * committed transition at a time — each step's effect and its new state commit together (steps.ts). A step with an
 * external effect is marked `running` first and done by this process in the same pass (`external.ts`); one this
 * process didn't mark is a dead process's, and is reconciled instead.
 */
import { type AutomationStep, EXTERNAL_STEP_KINDS } from '@whombat/core';
import { and, asc, eq, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { automationRuns, automations } from '../../db/schema/index';
import type { Services } from '../../services';
import { type GateFacts, gateFacts, readsGateFacts } from '../github-items';
import { newerRun } from '../release-gate';
import { runDeadline } from '../runs';
import { automationStep, definitionStep, type StepOp } from '../steps';
import {
  type AutomationRunRow,
  type AutomationStepRow,
  activeRunCount,
  loadRunRow,
  loadStepRows,
} from '../store';
import { runExternal } from './external';
import { noRerunOp, rerunChecks } from './merge-step';
import { observeStep } from './observe';
import type { EngineOptions } from './options';
import type { LeasedRun } from './step-ops';

/** The runs to advance, oldest first. */
export async function activeRunIds(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: automationRuns.id })
    .from(automationRuns)
    .where(inArray(automationRuns.status, ['queued', 'running', 'waiting']))
    .orderBy(asc(automationRuns.createdAt));
  return rows.map((r) => r.id);
}

/** Advances runs under the leases of one engine. */
export class RunAdvancer {
  /**
   * External steps this process is about to mark `running` (`run:idx:attempt`): it does their effect in the same
   * pass. A `running` step that is not in here was left by a process that died (or by a lost lease).
   */
  private readonly marked = new Set<string>();
  /** Each automation's principal, which signs its runs' commits. */
  private readonly principals = new Map<string, string>();

  constructor(
    private readonly services: Services,
    /** The engine's id: the owner of the leases it takes. */
    private readonly owner: string,
    /** The engine's own options, read as they are at each claim. */
    private readonly options: Pick<EngineOptions, 'leaseMs'>,
  ) {}

  /** At boot, as the lock holder: the leases of earlier engines belong to processes that are gone. */
  async releaseOthers(): Promise<void> {
    await this.services.db
      .update(automationRuns)
      .set({ leaseOwner: null, leaseExpiresAt: null })
      .where(and(isNotNull(automationRuns.leaseOwner), sql`${automationRuns.leaseOwner} <> ${this.owner}`));
  }

  /** Moves a run as far as it can go now (bounded), one committed transition at a time. */
  async advance(runId: string): Promise<void> {
    // A run of an automation the release the box would go back to can't run waits, kept as it is, until it may.
    if (
      !(await this.services.newerAutomations.ready()) &&
      newerRun(await loadRunRow(this.services.db, runId))
    )
      return;
    const fence = await this.claim(runId);
    if (fence === null) return;
    for (let guard = 0; guard < 40; guard++) {
      const run = await loadRunRow(this.services.db, runId);
      if (!['queued', 'running', 'waiting'].includes(run.status)) return;
      const now = this.services.clock();
      if (run.status === 'queued') {
        if (
          (await activeRunCount(this.services.db, run.automationId, run.id)) >=
          run.definition.limits.maxConcurrentRuns
        )
          return;
        await this.commit(run, fence, { op: 'start' });
        continue;
      }
      if (now > runDeadline(run)) {
        await this.commit(run, fence, {
          op: 'finish',
          status: 'failed',
          error: `It ran out of time (${run.definition.limits.runTimeoutMinutes} min).`,
        });
        return;
      }
      const steps = await loadStepRows(this.services.db, run.id);
      const idx = steps.findIndex((s) => s.state !== 'succeeded' && s.state !== 'skipped');
      if (idx < 0) {
        await this.commit(run, fence, { op: 'finish', status: 'succeeded', error: null });
        return;
      }
      const row = steps[idx] as AutomationStepRow;
      const step = definitionStep(run.definition, idx);
      const moved = await this.step(run, fence, row, step, now);
      if (!moved) return;
    }
  }

  /** Takes (or renews) this engine's lease on a run; returns the fencing token, or null when another holds it. */
  private async claim(runId: string): Promise<number | null> {
    const now = this.services.clock();
    const [row] = await this.services.db
      .update(automationRuns)
      .set({
        leaseOwner: this.owner,
        leaseExpiresAt: new Date(now.getTime() + this.options.leaseMs),
        fence: sql`case when ${automationRuns.leaseOwner} = ${this.owner} then ${automationRuns.fence} else ${automationRuns.fence} + 1 end`,
      })
      .where(
        and(
          eq(automationRuns.id, runId),
          or(
            sql`${automationRuns.leaseOwner} is null`,
            eq(automationRuns.leaseOwner, this.owner),
            lte(automationRuns.leaseExpiresAt, now),
          ),
        ),
      )
      .returning({ fence: automationRuns.fence });
    return row?.fence ?? null;
  }

  /** One transition of the current step; false when it has to wait. */
  private async step(
    run: AutomationRunRow,
    fence: number,
    row: AutomationStepRow,
    step: AutomationStep,
    now: Date,
  ): Promise<boolean> {
    switch (row.state) {
      case 'pending': {
        if (row.wakeAt && row.wakeAt > now) return false;
        // A condition about who opened the issue, who is assigned and which pull requests link it reads them from
        // GitHub now, outside the transaction (AR-28): the auto-fix gate never decides on what it was at the start.
        const facts = step.kind === 'condition' ? await this.gateFacts(run, step.if) : null;
        // An external step comes back `running`: this process then does its effect right away (`external.ts`). A merge
        // step waits for its checks first (AR-46): it is marked running only when it merges (`merging`).
        await this.marking(
          run,
          row,
          () => this.commit(run, fence, { op: 'execute', idx: row.idx, ...(facts ? { facts } : {}) }),
          () => EXTERNAL_STEP_KINDS.includes(step.kind) && step.kind !== 'merge_pull_request',
        );
        return true;
      }
      case 'waiting': {
        const outcome = await observeStep(this.services, run, row, step, now);
        if (!outcome) return false;
        if (outcome.op === 'already_open') {
          // It may come back `running` with a comment to post: this process posts it right after (`external.ts`).
          await this.marking(
            run,
            row,
            () => this.commit(run, fence, outcome),
            (res) => res.status === 'ok' && res.result.status === 'commenting',
          );
          return true;
        }
        if (outcome.op === 'rerun_checks') {
          // A repository that re-runs only infrastructure faults may leave it for a person instead (read outside the
          // transaction). Else noted on the step first, then GitHub runs the failed jobs once more; the step keeps
          // waiting.
          const instead =
            step.kind === 'merge_pull_request'
              ? await noRerunOp(this.services, run, row, step, outcome.rerun.checks)
              : null;
          if (instead) {
            await this.commit(run, fence, instead);
            return true;
          }
          const res = await this.commit(run, fence, outcome);
          if (res.status === 'ok' && res.result.status === 'rerun' && step.kind === 'merge_pull_request')
            await rerunChecks(this.lease(run, fence), row, step, outcome.rerun.checks);
          return true;
        }
        if (outcome.op === 'merging' && outcome.state === 'running') {
          // Its checks let it merge: marked running, and this process merges right after (`external.ts`, AR-47).
          await this.marking(
            run,
            row,
            () => this.commit(run, fence, outcome),
            () => true,
          );
          return true;
        }
        await this.commit(run, fence, outcome);
        if (
          step.kind === 'request_approval' &&
          outcome.op === 'settle' &&
          outcome.state === 'succeeded' &&
          (outcome.output as { decision?: string } | undefined)?.decision === 'declined' &&
          step.onDecline === 'stop'
        ) {
          const who = (outcome.output as { decidedByName?: string }).decidedByName ?? 'A person';
          // The no is the person's own answer under the card: the run ends without telling the thread (AR-52).
          await this.commit(run, fence, {
            op: 'finish',
            status: 'cancelled',
            error: `${who} declined, so it stopped.`,
            quiet: true,
          });
          return false;
        }
        return true;
      }
      case 'running':
        return runExternal(this.lease(run, fence), row, step, this.marked.delete(markOf(run, row)));
      case 'failed': {
        await this.commit(run, fence, {
          op: 'finish',
          status: 'failed',
          error: `Step “${row.name}” failed${row.error ? `: ${row.error}` : '.'}`.slice(0, 1000),
        });
        return false;
      }
      case 'blocked': {
        await this.commit(run, fence, {
          op: 'finish',
          status: 'failed',
          error: (row.error ?? `Step “${row.name}” was refused.`).slice(0, 1000),
        });
        return false;
      }
      case 'uncertain':
      case 'cancelled':
        return false;
      default:
        return false;
    }
  }

  /**
   * Commits a transition that may mark the step `running` for this process's own effect (`marked`): marked before the
   * commit, forgotten again when the commit fails or `keep` says no effect of this process follows.
   */
  private async marking<T>(
    run: AutomationRunRow,
    row: AutomationStepRow,
    commit: () => Promise<T>,
    keep: (result: T) => boolean,
  ): Promise<T> {
    const key = markOf(run, row);
    this.marked.add(key);
    let result: T;
    try {
      result = await commit();
    } catch (err) {
      this.marked.delete(key);
      throw err;
    }
    if (!keep(result)) this.marked.delete(key);
    return result;
  }

  /**
   * `trigger.trusted`, `assigned` and `linkedPr` as GitHub has them now, for a condition that reads them in a run about
   * an issue or pull request (AR-28); null for any other condition or run. GitHub not answering gives not trusted,
   * assigned and linked (`UNREADABLE_FACTS`), so a gate that would fix on its own asks a person instead.
   */
  private async gateFacts(run: AutomationRunRow, condition: string): Promise<GateFacts | null> {
    const scope = run.scope as { kind?: unknown; item?: unknown; repo?: unknown; number?: unknown };
    if (scope.kind !== 'github' || !readsGateFacts(condition)) return null;
    if (typeof scope.repo !== 'string' || typeof scope.number !== 'number') return null;
    const item = scope.item === 'pull_request' ? 'pull_request' : 'issue';
    return gateFacts(this.services.github.adapter, run.burrowId, {
      item,
      repo: scope.repo,
      number: scope.number,
    });
  }

  /** The run under this lease, as a step's effect works with it. */
  private lease(run: AutomationRunRow, fence: number): LeasedRun {
    return {
      services: this.services,
      run,
      fence,
      owner: this.owner,
      principal: () => this.principalOf(run.automationId),
      commit: (op) => this.commit(run, fence, op),
    };
  }

  /** One transition of the run, fenced by its lease and signed by the automation (`automationStep`). */
  private async commit(run: AutomationRunRow, fence: number, op: StepOp) {
    const principalId = await this.principalOf(run.automationId);
    return this.services.pipeline.commit(
      automationStep,
      { runId: run.id, fence, owner: this.owner, ...op },
      { burrowId: run.burrowId, actorId: principalId },
    );
  }

  private async principalOf(automationId: string): Promise<string> {
    const cached = this.principals.get(automationId);
    if (cached) return cached;
    const [row] = await this.services.db
      .select({ principalId: automations.principalId })
      .from(automations)
      .where(eq(automations.id, automationId));
    if (!row) throw new Error(`automation ${automationId} is gone`);
    this.principals.set(automationId, row.principalId);
    return row.principalId;
  }
}

/** A step attempt as `marked` knows it. */
function markOf(run: AutomationRunRow, row: AutomationStepRow): string {
  return `${run.id}:${row.idx}:${row.attempt}`;
}
