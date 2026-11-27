import type { AutomationDefinition, AutomationStep, JsonObject } from '@whombat/core';
import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client';
import { automationRunSteps, automationRuns } from '../../db/schema/index';
import { notFound } from '../../lib/errors';
import { outsidersRun } from '../runs';
import type { AutomationRunRow, AutomationStepRow } from '../store';

/** Default and ceiling minutes per step kind (a definition may shorten, never exceed, the ceiling). */
const STEP_TIMEOUTS: Record<AutomationStep['kind'], { default: number; max: number }> = {
  dispatch_agent: { default: 60, max: 24 * 60 },
  post_message: { default: 1, max: 5 },
  request_approval: { default: 7 * 24 * 60, max: 30 * 24 * 60 },
  wait: { default: 7 * 24 * 60, max: 7 * 24 * 60 },
  condition: { default: 1, max: 1 },
  open_pull_request: { default: 5, max: 30 },
  http_callback: { default: 1, max: 5 },
  github_comment: { default: 5, max: 30 },
  tracker_update: { default: 5, max: 30 },
  tracker_reply: { default: 5, max: 30 },
  // How long the person may take to answer a feature request (report-trackers.md TA-44): the run's own limit.
  tracker_decision: { default: 30 * 24 * 60, max: 30 * 24 * 60 },
  // How long a person may take to say yes when its key asks; the checks have their own wait (`waitMinutes`, AR-46).
  merge_pull_request: { default: 7 * 24 * 60, max: 30 * 24 * 60 },
  // Waiting for a person to approve proposed connection actions on a card.
  connection_actions: { default: 7 * 24 * 60, max: 30 * 24 * 60 },
};

export function stepTimeoutMs(step: AutomationStep): number {
  const t = STEP_TIMEOUTS[step.kind];
  if (step.kind === 'wait') return (step.minutes + 5) * 60_000;
  return Math.min(step.timeoutMinutes ?? t.default, t.max) * 60_000;
}

/** Retry backoff after a failure whose outcome is known: 30 s, 2 min, 8 min. */
export const retryBackoffMs = (attempt: number) => 30_000 * 4 ** Math.max(0, attempt);

/**
 * What templates and conditions read: `trigger.*`, `steps.<id>.*` (outputs + state: an agent step's `text` is all it
 * posted in its turn, `reply` its last message, an assessment step's `assessment`; a `connection_actions` step's only
 * `state`, `ran` and `count`), `run.*` (`number`, `id`, `test`; `today` comes from `stepScope`).
 */
export function runScope(
  run: AutomationRunRow,
  steps: readonly AutomationStepRow[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const outside = outsidersRun(run.trigger);
  for (const s of steps) {
    // The count of a fix's tries and what earlier tries used (`again.ts`) are the engine's, not for a template.
    const {
      offeredActions: _offered,
      again: _again,
      earlierTokens: _earlier,
      resultDispatchId,
      ...output
    } = s.output as JsonObject;
    if (outside && s.kind === 'dispatch_agent') {
      // A result this release collected says which turn it came from: one that isn't the step's turn any more is
      // dropped. A step the previous release finished keeps the result it collected then (it names no turn).
      if (typeof resultDispatchId === 'string' && resultDispatchId !== s.dispatchId) {
        delete output.text;
        delete output.reply;
        delete output.messageIds;
        delete output.verdict;
      }
      // Files never leave an outsiders' step, however it was collected (`outsidersStepFiles`).
      delete output.attachmentIds;
    }
    out[s.stepId] = s.kind === 'connection_actions' ? actionsScope(s) : { ...output, state: s.state };
  }
  return { trigger: run.scope, steps: out, run: { number: run.number, id: run.id, test: run.test } };
}

/**
 * Whether `step`'s files stay where they are: an agent step of an outsiders' run carries none onwards, also one the
 * previous release saved with the files its turn collected then (which could be another turn's).
 */
export function outsidersStepFiles(
  run: Pick<AutomationRunRow, 'trigger'>,
  step: Pick<AutomationStepRow, 'kind'>,
): boolean {
  return outsidersRun(run.trigger) && step.kind === 'dispatch_agent';
}

/**
 * A `connection_actions` step as templates and conditions read it: its state, whether its actions ran and how many.
 * Never its card's names, the paths with the person's account ids, the connections' labels, why it was refused or what
 * the services answered: those are what the server read from the person's services, and a template would carry them
 * into a later outsiders' turn or a message it reads.
 */
function actionsScope(s: AutomationStepRow): JsonObject {
  const o = (s.output ?? {}) as JsonObject;
  return {
    ...(typeof o.ran === 'boolean' ? { ran: o.ran } : {}),
    ...(typeof o.count === 'number' ? { count: o.count } : {}),
    state: s.state,
  };
}

/**
 * `runScope` as a step is evaluated (AR-29): with `run.today.<step>`, how many other runs of the automation created in
 * the 24 hours before `now` started that step — a number for every step of the definition, so a limit like
 * `run.today.fix < 5` never reads a missing count as zero.
 */
export async function stepScope(
  tx: Db,
  run: AutomationRunRow,
  steps: readonly AutomationStepRow[],
  now: Date,
): Promise<Record<string, unknown>> {
  const scope = runScope(run, steps);
  // Counted only for a definition that reads them (one query per step otherwise, for nothing).
  if (!JSON.stringify(run.definition.steps).includes('run.today')) return scope;
  return { ...scope, run: { ...(scope.run as JsonObject), today: await stepsStartedToday(tx, run, now) } };
}

/** Per step id of the run's definition: other runs of its automation in the last 24 hours that started it. */
export async function stepsStartedToday(
  tx: Db,
  run: Pick<AutomationRunRow, 'id' | 'automationId' | 'definition'>,
  now: Date,
): Promise<Record<string, number>> {
  const rows = await tx
    .select({
      stepId: automationRunSteps.stepId,
      n: sql<number>`count(distinct ${automationRunSteps.runId})::int`,
    })
    .from(automationRunSteps)
    .innerJoin(automationRuns, eq(automationRuns.id, automationRunSteps.runId))
    .where(
      and(
        eq(automationRuns.automationId, run.automationId),
        ne(automationRuns.id, run.id),
        sql`${automationRuns.createdAt} > ${new Date(now.getTime() - 86_400_000).toISOString()}::timestamptz`,
        isNotNull(automationRunSteps.startedAt),
      ),
    )
    .groupBy(automationRunSteps.stepId);
  const today: Record<string, number> = Object.fromEntries(run.definition.steps.map((s) => [s.id, 0]));
  for (const r of rows) if (r.stepId in today) today[r.stepId] = r.n;
  return today;
}

/**
 * The facts a condition step reads about the run's issue or pull request as GitHub has them now (AR-28): the engine
 * reads them just before it evaluates the condition (no network inside the transaction) and hands them to `execute`.
 */
export const GateFactsInput = z.object({
  trusted: z.boolean(),
  assigned: z.boolean(),
  linkedPr: z.boolean(),
  unreadable: z.string().max(300).optional(),
});

export function definitionStep(def: AutomationDefinition, idx: number): AutomationStep {
  const step = def.steps[idx];
  if (!step) throw notFound('Step');
  return step;
}

export type GateFacts = z.infer<typeof GateFactsInput>;
