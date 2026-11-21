/**
 * What the agent reads of the person's automations (MCP `automation_read`, docs/decisions/automation-chat.md):
 * each one in a line, and one in full to change it — its live definition, the plan waiting for a yes and its keys. Only
 * in the person's own turns, like `draft_automation`.
 */
import {
  type AgentAutomationDetail,
  type AgentAutomationSummary,
  type AgentTrackerConnection,
  AUTOMATION_AUTHORING_GUIDE,
  AUTOMATION_PLAN_NOT_HERE,
  type Automation,
  type JsonObject,
  type McpToolOutput,
} from '@whombat/core';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { automationPlans, automations, catalogConnections } from '../db/schema/index';
import { forbidden } from '../lib/errors';
import type { ToolContext } from '../mcp/tools';
import { outsidersTurn } from '../runtime/person';
import { TRACKER_CATALOG_ID } from '../trackers/connection';
import { loadAutomationRow, toAutomation } from './store';

function summaryOf(a: Automation): AgentAutomationSummary {
  return {
    id: a.id,
    name: a.name,
    state: a.currentVersion === null ? 'waiting' : a.status === 'published' ? 'on' : 'off',
    description: a.description,
    summary: a.summary,
    lastRun: a.lastRun
      ? {
          number: a.lastRun.number,
          status: a.lastRun.status,
          at: a.lastRun.finishedAt ?? a.lastRun.startedAt,
        }
      : null,
  };
}

/**
 * The burrow's tracker connections, for a tracker trigger's `connectionId`: an agent's own connections leave them out
 * (it never calls a tracker itself), so without this list it can't name one.
 */
async function trackerConnectionsOf(db: Db, burrowId: string): Promise<AgentTrackerConnection[]> {
  const rows = await db
    .select({
      id: catalogConnections.id,
      label: catalogConnections.label,
      baseUrl: catalogConnections.baseUrl,
      status: catalogConnections.status,
    })
    .from(catalogConnections)
    .where(
      and(eq(catalogConnections.burrowId, burrowId), eq(catalogConnections.catalogId, TRACKER_CATALOG_ID)),
    )
    .orderBy(asc(catalogConnections.createdAt));
  return rows.map((r) => ({
    connectionId: r.id,
    label: r.label,
    address: r.baseUrl,
    working: r.status === 'active',
  }));
}

export async function automationsForAgent(
  ctx: ToolContext,
  input: { automationId?: string | undefined },
): Promise<McpToolOutput<'automation_read'>> {
  const turn = ctx.dispatch;
  if (turn.trigger === 'automation' || turn.trigger === 'feedback' || outsidersTurn(turn))
    throw forbidden(AUTOMATION_PLAN_NOT_HERE);
  const db = ctx.services.db;
  if (input.automationId) {
    const row = await loadAutomationRow(db, ctx.burrowId, input.automationId);
    const automation = await toAutomation(db, row);
    const [waiting] = await db
      .select({ id: automationPlans.id, definition: automationPlans.definition })
      .from(automationPlans)
      .where(and(eq(automationPlans.automationId, row.id), eq(automationPlans.status, 'waiting')));
    const detail: AgentAutomationDetail = {
      ...summaryOf(automation),
      definition: (automation.definition as unknown as JsonObject | null) ?? null,
      waitingPlan: waiting
        ? { planId: waiting.id, definition: waiting.definition as unknown as JsonObject }
        : null,
      keys: automation.grants,
    };
    return { automation: detail };
  }
  const rows = await db
    .select()
    .from(automations)
    .where(and(eq(automations.burrowId, ctx.burrowId), isNull(automations.deletedAt)))
    .orderBy(asc(automations.createdAt));
  const list: AgentAutomationSummary[] = [];
  for (const row of rows) list.push(summaryOf(await toAutomation(db, row)));
  return {
    automations: list,
    trackerConnections: await trackerConnectionsOf(db, ctx.burrowId),
    guide: AUTOMATION_AUTHORING_GUIDE,
  };
}
