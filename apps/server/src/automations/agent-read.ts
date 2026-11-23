/**
 * What the agent reads of the person's automations (MCP `automation_read`, docs/decisions/automation-chat.md):
 * each one in a line, and one in full to change it — its live definition, the plan waiting for a yes and its keys. Only
 * in the person's own turns, like `draft_automation`.
 */
import {
  type AgentAutomationDetail,
  type AgentAutomationSummary,
  type AgentFindMyPerson,
  type AgentMailConnection,
  type AgentTrackerConnection,
  AUTOMATION_AUTHORING_GUIDE,
  AUTOMATION_PLAN_NOT_HERE,
  type Automation,
  CONNECTOR_PROVIDER_LABELS,
  type JsonObject,
  type McpToolOutput,
} from '@whombat/core';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { automationPlans, automations, catalogConnections } from '../db/schema/index';
import { findMyFor } from '../hosts/findmy';
import { findMyConnections, macOf } from '../hosts/findmy-connection';
import { keptPlaces } from '../hosts/findmy-places';
import { forbidden } from '../lib/errors';
import { personMailConnections } from '../mail-triggers/index';
import type { ToolContext } from '../mcp/tools';
import { outsidersTurn } from '../runtime/person';
import { TRACKER_CATALOG_ID } from '../trackers/connection';
import { ACTION_AUTOMATIONS_LATER, FIND_MY_AUTOMATIONS_LATER, MAIL_AUTOMATIONS_LATER } from './release-gate';
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

/** The person's connected mailboxes, for a mail trigger's `connectionId`. */
async function mailConnectionsOf(db: Db, burrowId: string): Promise<AgentMailConnection[]> {
  const rows = await personMailConnections(db, burrowId);
  return rows.map((r) => ({
    connectionId: r.id,
    provider: r.provider,
    email: r.email,
    label: `${CONNECTOR_PROVIDER_LABELS[r.provider]} (${r.email})`,
    working: r.status === 'active',
  }));
}

/**
 * The people the person's Find My connections know, for a findmy trigger's `connectionId`, `person` and `name`: from
 * the last read of each connection's Mac in the box's memory, and the places kept for its automations (someone the
 * last read didn't have). Their place as Find My words it; never a street or coordinates.
 */
async function findMyPeopleOf(ctx: ToolContext): Promise<AgentFindMyPerson[]> {
  const out: AgentFindMyPerson[] = [];
  for (const c of await findMyConnections(ctx.services.db, { burrowId: ctx.burrowId })) {
    const mac = macOf(c);
    const read = mac ? (findMyFor(ctx.services).peek(mac)?.people ?? []) : [];
    const seen = new Set<string>();
    for (const p of read) {
      seen.add(p.id);
      out.push({ connectionId: c.id, person: p.id, name: p.name, place: p.place?.slice(0, 200) || null });
    }
    for (const k of await keptPlaces(ctx.services.db, c.id))
      if (!seen.has(k.person))
        out.push({ connectionId: c.id, person: k.person, name: k.name, place: k.place });
  }
  return out.slice(0, 500);
}

/**
 * The guide while automations the release before them can't run wait for the next update (release-gate.ts): what the
 * person is told when they ask for one, before the rest. draft_automation refuses them with the same line.
 */
const LATER_GUIDE = `Not on this Whombat yet: ${MAIL_AUTOMATIONS_LATER} ${ACTION_AUTOMATIONS_LATER} Draft neither until then; when the person asks for one, tell them that line.

${AUTOMATION_AUTHORING_GUIDE}`;

/** The guide while only findmy automations wait for the next update. */
const FIND_MY_LATER_GUIDE = `Not on this Whombat yet: ${FIND_MY_AUTOMATIONS_LATER} Don’t draft one until then; when the person asks for one, tell them that line.

${AUTOMATION_AUTHORING_GUIDE}`;

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
    mailConnections: await mailConnectionsOf(db, ctx.burrowId),
    findMyPeople: await findMyPeopleOf(ctx),
    guide: !(await ctx.services.newerAutomations.ready())
      ? LATER_GUIDE
      : (await ctx.services.newerAutomations.findMyReady())
        ? AUTOMATION_AUTHORING_GUIDE
        : FIND_MY_LATER_GUIDE,
  };
}
