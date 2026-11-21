/**
 * The agent's notes (docs/decisions/hermes-engine.md HE-39, HE-S120): one text the person writes (Settings → Agent →
 * Notes), kept on the burrow (`burrows.agent_notes`) and put in the person's Hermes profile's prompt by the runner
 * (`DispatchContext.notes`, `whombat-notes.md`; never in an outsiders' turn). What the agent learns about the person is
 * in their memory (`person.ts`).
 */
import { AGENT_NOTES_MAX, AgentNotesText } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { burrows, type StoredAgentNotes } from '../db/schema/index';
import { forbidden, notFound } from '../lib/errors';
import { loadAgentRow } from '../read/principals';

/** The burrow's notes, or null when none are written. */
export async function agentNotesOf(db: Db | Tx, burrowId: string): Promise<StoredAgentNotes | null> {
  const [row] = await db.select({ notes: burrows.agentNotes }).from(burrows).where(eq(burrows.id, burrowId));
  return row?.notes?.text ? row.notes : null;
}

/** The text a turn gets: the notes, or null. */
export async function agentNotesText(db: Db | Tx, burrowId: string): Promise<string | null> {
  return (await agentNotesOf(db, burrowId))?.text ?? null;
}

/** The person saves the notes; an empty text clears them (`memory.setNotes`). */
export const setAgentNotes = defineCommand({
  name: 'set_agent_notes',
  schema: z.object({
    // A bound on the raw text before core's trims and counts it.
    text: z
      .string()
      .max(AGENT_NOTES_MAX * 4)
      .pipe(AgentNotesText),
  }),
  // People only: “Change the agent and its keys” is a people-only key (the agent is Blocked).
  requiredKey: () => ({
    keyId: 'agents.manage',
    attempt: 'change the agent’s notes',
    where: 'Settings · Agent',
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only you change the agent’s notes.');
    const agent = await loadAgentRow(tx, ctx.burrow.id);
    if (!agent) throw notFound('Agent');
    const before = (await agentNotesOf(tx, ctx.burrow.id))?.text ?? '';
    if (before === input.text) return { notes: await agentNotesOf(tx, ctx.burrow.id), eventId: null };
    const notes: StoredAgentNotes | null = input.text
      ? { text: input.text, updatedAt: ctx.at, updatedById: ctx.actor.id }
      : null;
    await tx.update(burrows).set({ agentNotes: notes }).where(eq(burrows.id, ctx.burrow.id));
    // Says that they changed, never what (the person reads them anyway, but the log shouldn't carry them).
    const event = await ctx.emit({
      type: 'agent.notes_changed',
      kind: 'Keys',
      text: notes ? `Changed ${agent.name}’s notes` : `Cleared ${agent.name}’s notes`,
      where: 'Settings · Agent',
      aboutId: agent.id,
      payload: { cleared: !notes },
    });
    return { notes, eventId: event.id as string | null };
  },
});
