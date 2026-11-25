/**
 * What a mail run keeps of the email (docs/decisions/automation-recipes.md): its text — `body`, `snippet` and `text`
 * in the run's scope — stays only while a step that reads the trigger may still render it (it hasn't settled yet, or
 * waits to be tried again). Once none may, or the run ended (any outcome), the scope loses it, every step that isn't at
 * work loses the fenced email in what it stored (the agent's instructions, a posted message's text), and the Hermes
 * sessions its finished turns ran in are forgotten. Sender, subject and attachment names stay. A turn that tells its
 * session only after Whombat ended it, or after it was queued again, has its session forgotten then
 * (`forgetLateMailSession`).
 */
import { type JsonObject, type JsonValue, stepReads, withoutFencedMail } from '@whombat/core';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { TxSession } from '../commit/types';
import { automationRunSteps, automationRuns, dispatches } from '../db/schema/index';
import { homeOf } from '../hermes-home/housekeeping';
import { stripMailScopeContent } from '../mail-triggers/index';
import { dropSessions, finishedAutomationSessions, HERMES_SESSION } from '../runtime/sessions';
import { type AutomationRunRow, loadRunRow, loadStepRows } from './store';

const ENDED: readonly string[] = ['succeeded', 'failed', 'cancelled', 'skipped'];
/** A step in these states renders nothing again in this run. */
const SETTLED: readonly string[] = ['succeeded', 'skipped', 'failed', 'blocked', 'cancelled'];
/** A step in these states may still use what it was given (its turn, its call). */
const AT_WORK: readonly string[] = ['waiting', 'running'];

/**
 * The threads an agent step's turns ran in, its earlier attempts' included (kept on the step across attempts): where
 * they left Hermes sessions.
 */
export function turnThreadsOf(output: unknown): string[] {
  const kept = (output as { turnThreads?: unknown } | null)?.turnThreads;
  return Array.isArray(kept) ? kept.filter((x): x is string => typeof x === 'string') : [];
}

/** A JSON value with every fenced email block replaced by a note; the same value when it holds none. */
function withoutMail<T extends JsonValue>(value: T): T {
  if (typeof value === 'string') return withoutFencedMail(value) as T;
  if (Array.isArray(value)) {
    const items = value.map((v) => withoutMail(v));
    return items.some((v, i) => v !== value[i]) ? (items as T) : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = withoutMail(v as JsonValue);
      if (out[k] !== v) changed = true;
    }
    return changed ? (out as T) : value;
  }
  return value;
}

/** Forgets what the run no longer needs of the email, in the caller's transaction. True when it changed the run. */
export async function forgetMailText(session: TxSession, run: AutomationRunRow): Promise<boolean> {
  if (run.trigger.kind !== 'mail') return false;
  const tx = session.tx;
  const now = session.services.clock();
  const steps = await loadStepRows(tx, run.id);
  const ended = ENDED.includes(run.status);
  const needed =
    !ended &&
    run.definition.steps.some(
      (s, i) => stepReads(s).trigger && !SETTLED.includes(steps[i]?.state ?? 'pending'),
    );
  let changed = false;
  if (!needed) {
    const scope = stripMailScopeContent(run.scope as JsonObject);
    if (scope) {
      await tx.update(automationRuns).set({ scope }).where(eq(automationRuns.id, run.id));
      changed = true;
    }
  }
  for (const row of steps) {
    if (!ended && AT_WORK.includes(row.state)) continue;
    const output = withoutMail(row.output as JsonObject);
    if (output === row.output) continue;
    await tx
      .update(automationRunSteps)
      .set({ output, updatedAt: now })
      .where(and(eq(automationRunSteps.runId, run.id), eq(automationRunSteps.idx, row.idx)));
    changed = true;
  }
  if (!needed) {
    const sessions = await finishedAutomationSessions(tx, await turnThreads(tx, run, steps));
    await dropSessions(
      { tx, services: session.services, background: session.background.bind(session), now },
      sessions,
    );
  }
  return changed;
}

/**
 * Every thread the run's agent turns ran in: the run's own, and the ones its steps' turns answered in — a step placed
 * at the top of a room, or in another room, asks in a thread of its own — for every attempt (`turnThreadsOf`) and the
 * turn a step names now.
 */
export async function turnThreads(
  tx: TxSession['tx'],
  run: AutomationRunRow,
  steps: readonly { dispatchId: string | null; output: unknown }[],
): Promise<string[]> {
  const threads = new Set<string>(run.threadRootId ? [run.threadRootId] : []);
  for (const step of steps) for (const t of turnThreadsOf(step.output)) threads.add(t);
  const named = steps.flatMap((s) => (s.dispatchId ? [s.dispatchId] : []));
  if (named.length) {
    const turns = await tx
      .select({ threadRootId: dispatches.threadRootId })
      .from(dispatches)
      .where(inArray(dispatches.id, named));
    for (const t of turns) if (t.threadRootId) threads.add(t.threadRootId);
  }
  return [...threads];
}

/**
 * A turn's Hermes session told after the run's forgetting could see it (`finalize`): the runner reports a session at its
 * first beat, so a mail run stopped or timed out before that ended its turn with none recorded, and the runner's own
 * report afterwards finds the turn ended (or queued again, after a lost lease) and stores nothing. A session no turn
 * names is forgotten at once (an automation's step never resumes one); one stored on a turn whose run has ended is
 * forgotten with the run's others. Nothing for any other turn.
 */
export async function forgetLateMailSession(
  session: TxSession,
  dispatchId: string,
  providerSessionId: string | undefined,
): Promise<void> {
  if (!providerSessionId?.startsWith(HERMES_SESSION)) return;
  const tx = session.tx;
  const [turn] = await tx.select().from(dispatches).where(eq(dispatches.id, dispatchId));
  if (turn?.trigger !== 'automation') return;
  // The mail run whose step this turn is, or, for an earlier attempt of a step, the one whose thread it worked in: the
  // run's own, or one a step's turns answered in.
  const ownStep = sql`exists (select 1 from ${automationRunSteps} as s
    where s.run_id = ${automationRuns.id} and (s.dispatch_id = ${turn.id}${
      turn.threadRootId && turn.onBehalfOfAccountId === null
        ? sql` or s.output -> 'turnThreads' @> jsonb_build_array(${turn.threadRootId}::text)`
        : sql``
    }))`;
  const [found] = await tx
    .select({ id: automationRuns.id })
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.burrowId, turn.burrowId),
        sql`${automationRuns.trigger} ->> 'kind' = 'mail'`,
        or(
          ownStep,
          turn.threadRootId && turn.onBehalfOfAccountId === null
            ? eq(automationRuns.threadRootId, turn.threadRootId)
            : undefined,
        ),
      ),
    )
    .orderBy(desc(automationRuns.createdAt))
    .limit(1);
  if (!found) return;
  if (turn.providerSessionId !== providerSessionId) {
    const now = session.services.clock();
    await dropSessions(
      { tx, services: session.services, background: session.background.bind(session), now },
      [{ home: homeOf(turn.onBehalfOfAccountId), session: providerSessionId.slice(HERMES_SESSION.length) }],
    );
    return;
  }
  const run = await loadRunRow(tx, found.id);
  if (ENDED.includes(run.status)) await forgetMailText(session, run);
}
