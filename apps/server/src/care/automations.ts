/**
 * *Go ahead* on a care plan turns on its automations (docs/decisions/care-plan.md): the weekly updates and the weekly
 * backup of QEMU/KVM machines, written by Whombat from the step (never by the assistant) with the quiet hours of that
 * moment, published as the person in the same commit as their go-ahead — the press is the yes for exactly what the card
 * said — and written down on the server, so a later plan doesn't offer them again.
 */
import { careAutomation, definitionGrants } from '@whombat/core';
import { sql } from 'drizzle-orm';
import { cap, insertAutomation, mayPublish, publishVersion, writeGrants } from '../automations/commands';
import { loadAutomationRow, publishAutomation } from '../automations/store';
import { loadBurrowRow } from '../commit/pipeline';
import type { ApplyContext } from '../commit/types';
import { type LookPlanStepRow, serverCares } from '../db/schema/index';
import { forbidden } from '../lib/errors';
import { serverKey } from './commands';
import { changeWindowOf } from './window';

/** The step as the turn after Go ahead reads it: Whombat did it already. */
export function turnedOnStep(name: string): string {
  return `Whombat turned this on as the automation “${name}” when the person said go ahead: nothing for you to do.`;
}

/**
 * Turns on the automation of each step that has one; returns the steps with their words for the turn after it. Steps
 * without an automation come back as they were.
 */
export async function turnOnCareAutomations(
  ctx: ApplyContext,
  conversationId: string,
  plan: readonly LookPlanStepRow[],
): Promise<LookPlanStepRow[]> {
  if (!plan.some((p) => p.automation)) return [...plan];
  if (!mayPublish(ctx)) throw forbidden('Only you can turn on an automation.');
  const burrow = await loadBurrowRow(ctx.tx, ctx.burrow.id);
  const window = changeWindowOf(burrow);
  const out: LookPlanStepRow[] = [];
  for (const p of plan) {
    const recipe = p.automation;
    if (!recipe) {
      out.push(p);
      continue;
    }
    const made = careAutomation(recipe.kind, {
      server: recipe.server,
      window,
      timeZone: burrow?.timeZone ?? 'UTC',
      conversationId,
      ...(recipe.guests ? { guests: recipe.guests } : {}),
    });
    const id = await insertAutomation(ctx, { name: made.name, description: made.description, draft: null });
    const row = await loadAutomationRow(ctx.tx, ctx.burrow.id, id);
    await ctx.emit({
      type: 'automation.created',
      kind: 'System',
      text: `Created the automation “${cap(made.name)}”`,
      where: null,
      payload: { automationId: id, source: 'care' },
    });
    await writeGrants(
      ctx,
      { id, name: row.name, principalId: row.principalId },
      definitionGrants(made.definition),
    );
    await publishVersion(ctx, { id, name: row.name, currentVersion: null }, made.definition, true);
    await publishAutomation(ctx, ctx.burrow.id, id);
    const step = p.care ?? recipe.kind;
    await ctx.tx
      .insert(serverCares)
      .values({
        burrowId: ctx.burrow.id,
        serverId: serverKey(recipe.server.id),
        state: 'known',
        self: recipe.server.self,
        automations: { [step]: id },
        createdAt: ctx.now,
      })
      .onConflictDoUpdate({
        target: [serverCares.burrowId, serverCares.serverId],
        set: { automations: sql`${serverCares.automations} || ${JSON.stringify({ [step]: id })}::jsonb` },
      });
    out.push({ text: p.text, step: turnedOnStep(row.name), ...(p.care ? { care: p.care } : {}) });
  }
  return out;
}
