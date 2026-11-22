/**
 * What a mail run keeps of the email (docs/decisions/automation-recipes.md): its text — `body`, `snippet` and `text`
 * in the run's scope — stays only while a step that reads the trigger may still render it (it hasn't settled yet, or
 * waits to be tried again). Once none may, or the run ended (any outcome), the scope loses it, every step that isn't at
 * work loses the fenced email in what it stored (the agent's instructions, a posted message's text), and the Hermes
 * sessions its finished turns ran in are forgotten. Sender, subject and attachment names stay.
 */
import { type JsonObject, type JsonValue, stepReads, withoutFencedMail } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import type { TxSession } from '../commit/types';
import { automationRunSteps, automationRuns } from '../db/schema/index';
import { stripMailScopeContent } from '../mail-triggers/index';
import { dropSessions, finishedAutomationSessions } from '../runtime/sessions';
import { type AutomationRunRow, loadStepRows } from './store';

const ENDED: readonly string[] = ['succeeded', 'failed', 'cancelled', 'skipped'];
/** A step in these states renders nothing again in this run. */
const SETTLED: readonly string[] = ['succeeded', 'skipped', 'failed', 'blocked', 'cancelled'];
/** A step in these states may still use what it was given (its turn, its call). */
const AT_WORK: readonly string[] = ['waiting', 'running'];

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
  if (!needed && run.threadRootId) {
    const sessions = await finishedAutomationSessions(tx, run.threadRootId);
    await dropSessions(
      { tx, services: session.services, background: session.background.bind(session), now },
      sessions,
    );
  }
  return changed;
}
