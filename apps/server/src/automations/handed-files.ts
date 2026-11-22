/**
 * The files the server handed over from what started an automation run (docs/decisions/automation-recipes.md): the
 * email's for a mail run, copied onto the prompt of its first agent turn and kept on that step by id
 * (`triggerFileIds`); none for a tracker report's run, whose report reaches the turn only as text. An outsiders' turn of
 * the run is shown and may read only these (`files/access.ts`): a file the person or anyone else adds to the run's
 * thread stays theirs.
 */
import { and, eq } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { attachments, automationRunSteps, automationRuns } from '../db/schema/index';

/** The ids a step's output says the server handed over from what started the run, or null when it says none. */
function keptIds(output: unknown): string[] | null {
  const ids = (output as { triggerFileIds?: unknown } | null)?.triggerFileIds;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : null;
}

/**
 * The ids of the files handed over to `run`. A run started before the ids were kept counts the files on its first
 * prompt when that prompt started the run's thread, as only the server put files there.
 */
export async function handedOverFileIds(
  db: Db | Tx,
  run: { id: string; burrowId: string; threadRootId: string | null },
): Promise<string[]> {
  const steps = await db
    .select({ output: automationRunSteps.output, promptMessageId: automationRunSteps.promptMessageId })
    .from(automationRunSteps)
    .where(eq(automationRunSteps.runId, run.id));
  const kept = steps.map((s) => keptIds(s.output)).filter((ids): ids is string[] => ids !== null);
  if (kept.length) return [...new Set(kept.flat())];
  const root = run.threadRootId;
  if (!root || !steps.some((s) => s.promptMessageId === root)) return [];
  const onRoot = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(and(eq(attachments.messageId, root), eq(attachments.burrowId, run.burrowId)));
  return onRoot.map((a) => a.id);
}

/**
 * The files an automation step's turn may use: those handed over to the run whose step queued it (the step names the
 * turn while it is at work, a handed wait's next turn included). Empty when no run's step names it.
 */
export async function stepTurnFileIds(db: Db | Tx, dispatchId: string): Promise<string[]> {
  const [run] = await db
    .select({
      id: automationRuns.id,
      burrowId: automationRuns.burrowId,
      threadRootId: automationRuns.threadRootId,
    })
    .from(automationRunSteps)
    .innerJoin(automationRuns, eq(automationRuns.id, automationRunSteps.runId))
    .where(eq(automationRunSteps.dispatchId, dispatchId))
    .limit(1);
  return run ? handedOverFileIds(db, run) : [];
}
