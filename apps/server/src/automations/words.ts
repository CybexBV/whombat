/**
 * Automations take Whombat's new words by themselves (docs/decisions/automation-recipes.md). When a version of
 * Whombat words a recipe's steps differently, an automation that still has exactly the earlier version's own words gets
 * today's as a new version, once, when the server starts after the update. An automation whose words anyone changed
 * keeps them. Each is committed as the automation itself (`automation.words_updated`).
 */
import { recipeHasEarlierWords } from '@whombat/core';
import { and, eq, isNull } from 'drizzle-orm';
import { automations, automationVersions } from '../db/schema/index';
import type { Services } from '../services';
import { updateAutomationWords } from './commands';

/** Gives every automation that still has an earlier version's own words today's. How many it changed. */
export async function updateAutomationsWords(services: Services): Promise<number> {
  const rows = await services.db
    .select({
      id: automations.id,
      burrowId: automations.burrowId,
      principalId: automations.principalId,
      definition: automationVersions.definition,
    })
    .from(automations)
    .innerJoin(
      automationVersions,
      and(
        eq(automationVersions.automationId, automations.id),
        eq(automationVersions.n, automations.currentVersion),
      ),
    )
    .where(and(isNull(automations.deletedAt), isNull(automations.draftJson)));
  let changed = 0;
  for (const row of rows) {
    if (!recipeHasEarlierWords(row.definition)) continue;
    try {
      const res = await services.pipeline.commit(
        updateAutomationWords,
        { automationId: row.id },
        { burrowId: row.burrowId, actorId: row.principalId },
      );
      if (res.status === 'ok' && res.result.version !== null) changed++;
    } catch (err) {
      services.log.warn(
        { err: err instanceof Error ? err.message : String(err), automationId: row.id },
        'automations: an automation could not take the new wording',
      );
    }
  }
  if (changed) services.automations.nudge();
  return changed;
}
