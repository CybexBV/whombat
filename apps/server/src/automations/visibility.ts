/**
 * How an automation reads (docs/decisions/bp-automations.md; one-person.md OP-S69): its trigger summary, its
 * one-sentence summary and its glance, naming its rooms by title. Everything on the box is the person's, so every
 * frame and read carries an automation and its runs in full.
 */
import {
  type AutomationDefinition,
  type AutomationGlance,
  automationGlance,
  conversationLabel,
  describeAutomation,
  recipeOf,
  triggerSummary,
} from '@whombat/core';
import { inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { conversations } from '../db/schema/index';
import { loadAgentRow } from '../read/principals';

/** Trigger rooms of a definition. */
function triggerRooms(definition: AutomationDefinition | null): string[] {
  if (!definition) return [];
  return definition.triggers.flatMap((t) => ('conversationId' in t ? [t.conversationId] : []));
}

/** The summary of the live triggers. */
export function summaryAs(
  definition: AutomationDefinition | null,
  titles: ReadonlyMap<string, string>,
  connections: ReadonlyMap<string, string> = new Map(),
): string {
  if (!definition) return '';
  return triggerSummary(
    definition.triggers,
    (id) => titles.get(id),
    // A tracker trigger names its connection's label (report-trackers.md TA-04).
    (id) => connections.get(id),
  );
}

/**
 * The rooms a sentence or a glance about a definition may name: its triggers', its own room (where the glance says it
 * answers, automation-list.md AL-S01) and, for a recipe, its channel.
 */
export function definitionRooms(definition: AutomationDefinition | null): string[] {
  if (!definition) return [];
  const recipe = recipeOf(definition);
  return [...triggerRooms(definition), definition.conversationId, ...(recipe ? [recipe.conversationId] : [])];
}

/** The agent's name, which a definition's sentence uses (one-agent.md OA-15). */
export async function agentNameIn(db: Db, burrowId: string): Promise<string> {
  return (await loadAgentRow(db, burrowId))?.name ?? 'the agent';
}

/** `Automation.summary` (automation-recipes.md): what it does in one sentence (`describeAutomation`). */
export function describeAs(
  definition: AutomationDefinition | null,
  titles: ReadonlyMap<string, string>,
  agent: string,
  connections: ReadonlyMap<string, string> = new Map(),
): string {
  if (!definition) return '';
  return describeAutomation(definition, {
    agent,
    conversationTitle: (id) => titles.get(id),
    connectionLabel: (id) => connections.get(id),
  });
}

/**
 * `Automation.glance` (automation-list.md AL-S01): the definition at a glance (`automationGlance`), naming rooms and
 * tracker connections exactly as `describeAs` does. Null without a definition.
 */
export function glanceAs(
  definition: AutomationDefinition | null,
  titles: ReadonlyMap<string, string>,
  connections: ReadonlyMap<string, string> = new Map(),
): AutomationGlance | null {
  if (!definition) return null;
  return automationGlance(definition, {
    conversationTitle: (id) => titles.get(id),
    connectionLabel: (id) => connections.get(id),
  });
}

/** Titles (“#billing-v2”) of these conversations. */
export async function roomTitles(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select()
    .from(conversations)
    .where(inArray(conversations.id, [...new Set(ids)]));
  return new Map(rows.map((c) => [c.id, conversationLabel(c)]));
}
