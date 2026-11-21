/**
 * The read side of automation plans (docs/decisions/automation-chat.md): a plan as its card shows it, and
 * for an automation the plan waiting for a yes and the thread where “Talk about it” goes. Kept apart from the commands
 * so the message reads can resolve a card without importing them.
 */
import {
  type AutomationDefinition,
  type AutomationPlanState,
  type AutomationPlanView,
  type AutomationTalk,
  automationPlanView,
} from '@whombat/core';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { automationPlans, automations, automationVersions } from '../db/schema/index';
import { iso, isoOrNull } from '../lib/time';
import { connectionLabels, definitionConnections } from '../trackers/store';
import { agentNameIn, definitionRooms, roomTitles } from './visibility';

/** Plans by id, as their cards show them; a plan that isn't there is left out. */
export async function automationPlanCards(
  db: Db | Tx,
  ids: readonly string[],
): Promise<Map<string, AutomationPlanView>> {
  const out = new Map<string, AutomationPlanView>();
  if (!ids.length) return out;
  const rows = await db
    .select({ plan: automationPlans, deletedAt: automations.deletedAt })
    .from(automationPlans)
    .innerJoin(automations, eq(automations.id, automationPlans.automationId))
    .where(inArray(automationPlans.id, [...new Set(ids)]));
  if (!rows.length) return out;
  const bases = new Map<string, AutomationDefinition>();
  for (const { plan } of rows)
    if (plan.baseVersion !== null) {
      const [v] = await db
        .select({ definition: automationVersions.definition })
        .from(automationVersions)
        .where(
          and(
            eq(automationVersions.automationId, plan.automationId),
            eq(automationVersions.n, plan.baseVersion),
          ),
        );
      if (v) bases.set(plan.id, v.definition);
    }
  const definitions = [...rows.map((r) => r.plan.definition), ...bases.values()];
  const titles = await roomTitles(
    db as Db,
    definitions.flatMap((d) => definitionRooms(d)),
  );
  const labels = await connectionLabels(
    db,
    definitions.flatMap((d) => definitionConnections(d)),
  );
  const agentNames = new Map<string, string>();
  for (const { plan, deletedAt } of rows) {
    let agent = agentNames.get(plan.burrowId);
    if (agent === undefined) {
      agent = await agentNameIn(db as Db, plan.burrowId);
      agentNames.set(plan.burrowId, agent);
    }
    const base = bases.get(plan.id);
    // A deleted automation's waiting or turned-on plan says so; one set aside or replaced keeps what happened to it.
    const state: AutomationPlanState =
      deletedAt && (plan.status === 'waiting' || plan.status === 'accepted') ? 'gone' : plan.status;
    out.set(
      plan.id,
      automationPlanView(
        {
          planId: plan.id,
          automationId: plan.automationId,
          name: plan.name,
          description: plan.description,
          state,
          definition: plan.definition,
          grants: plan.grants,
          base: base ? { definition: base, grants: plan.baseGrants ?? [] } : null,
          thinking: plan.thinking,
          decidedById: plan.decidedById,
          decidedAt: isoOrNull(plan.decidedAt),
          version: plan.version,
          createdAt: iso(plan.createdAt),
        },
        {
          agent,
          conversationTitle: (id) => titles.get(id),
          connectionLabel: (id) => labels.get(id),
        },
      ),
    );
  }
  return out;
}

/**
 * For each automation, the plan waiting for a yes and the thread of its latest plan: what the list's “Waiting
 * for you” and “Talk about it” open.
 */
export async function planFactsOf(
  db: Db | Tx,
  automationIds: readonly string[],
): Promise<Map<string, { waitingPlanId: string | null; talk: AutomationTalk | null }>> {
  const out = new Map<string, { waitingPlanId: string | null; talk: AutomationTalk | null }>();
  if (!automationIds.length) return out;
  const rows = await db
    .select({
      id: automationPlans.id,
      automationId: automationPlans.automationId,
      status: automationPlans.status,
      conversationId: automationPlans.conversationId,
      threadRootId: automationPlans.threadRootId,
      messageId: automationPlans.messageId,
    })
    .from(automationPlans)
    .where(inArray(automationPlans.automationId, [...new Set(automationIds)]))
    .orderBy(desc(automationPlans.createdAt));
  for (const r of rows) {
    const facts = out.get(r.automationId) ?? { waitingPlanId: null, talk: null };
    if (r.status === 'waiting' && !facts.waitingPlanId) facts.waitingPlanId = r.id;
    const root = r.threadRootId ?? r.messageId;
    if (!facts.talk && root) facts.talk = { conversationId: r.conversationId, threadRootId: root };
    out.set(r.automationId, facts);
  }
  return out;
}
