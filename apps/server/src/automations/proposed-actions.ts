/**
 * Proposed connection actions for outsiders' automation runs (docs/decisions/automation-recipes.md): the agent of a
 * `dispatch_agent` step with `proposeActions: true` (such as a mail-triggered run) cannot reach the person's
 * connections directly. Instead, it records proposed calls with `propose_connection_actions` during its turn, and a
 * follow-up `connection_actions` step validates them, ALWAYS asks the person on an approval card regardless of
 * standing connection or key settings, and runs them only after approval.
 */
import { createHash } from 'node:crypto';
import {
  type CatalogEntry,
  CONNECTOR_BINARY_MAX_BYTES,
  canonicalJson,
  catalogEntry,
  type JsonObject,
  lookOnlyText,
  ProposeConnectionActionsInput,
  type ProposedConnectionAction,
  REQUEST_TOOL_NAME,
  requestAllowed,
  resolveRequestPrefixes,
} from '@whombat/core';
import { and, asc, eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import { callTier, needsReauthText } from '../connections/call';
import { connectionCallAccess } from '../connections/call-access';
import { isCallableEntry } from '../connections/callable';
import { keyTierOf } from '../connections/context';
import { limitsProblem } from '../connections/limits';
import { ConnectionArgumentError, normaliseRequestArgs, parseRequestUpload } from '../connections/request';
import { normaliseSocketArgs } from '../connections/socket/call';
import type { ConnectionToolRow } from '../connections/types';
import type { Db, Tx } from '../db/client';
import {
  attachments,
  automationRunSteps,
  automationRuns,
  catalogConnections,
  connectionTools,
  dispatches,
  messages,
} from '../db/schema/index';
import { limitWordsFor } from '../devices/store';
import type { AttachmentRow } from '../files/service';
import { callServerOf } from '../hosts/asks';
import { badRequest, conflict, forbidden } from '../lib/errors';
import { loadGrants } from '../read/principals';
import type { Services } from '../services';
import { automationAgent } from './authority';
import { type AutomationRunRow, type AutomationStepRow, publishRun } from './store';

/** Built-in or powerful host-control catalog entries that outsiders' runs may never propose actions on. */
const DISALLOWED_PROPOSE_CATALOG_IDS: ReadonlySet<string> = new Set(['whombat_servers', 't3code']);

/** Tool or socket method names that delete resources (never proposable from an outsiders' run). */
const DELETE_TOOL_NAME = /(?:^|[._-])delete(?:$|[._-])/i;

/**
 * Whether an outsiders' run may propose actions on this catalog entry: never the box's own powerful connections
 * (Servers, T3 Code, devices, or any other built-in that runs commands or controls machines).
 */
export function isProposableEntry(entry: CatalogEntry): boolean {
  return (
    isCallableEntry(entry) &&
    entry.transport !== 'builtin' &&
    !DISALLOWED_PROPOSE_CATALOG_IDS.has(entry.id)
  );
}

/**
 * Plain-English refusal when a proposed call falls outside the narrow surface allowed for outsiders' runs (no
 * disallowed connections, no DELETE, no read-only GET/HEAD or read-only tools whose results are thrown away).
 */
export function proposeCallRefusal(
  entry: CatalogEntry,
  tool: Pick<ConnectionToolRow, 'name' | 'access' | 'origin'>,
  args: Readonly<Record<string, unknown>>,
  serviceName: string,
): string | null {
  if (!isProposableEntry(entry)) {
    return `Actions on ${serviceName} can’t be proposed from an outsiders’ run.`;
  }
  if (DELETE_TOOL_NAME.test(tool.name)) {
    return `${serviceName}: ${tool.name} can’t be proposed from an outsiders’ run.`;
  }
  if (tool.origin === 'request') {
    const method = String(args.method ?? '').toUpperCase();
    if (method === 'DELETE') {
      return `${serviceName}: DELETE requests can’t be proposed from an outsiders’ run.`;
    }
    if (method === 'GET' || method === 'HEAD') {
      return `${serviceName}: read-only ${method} requests can’t be proposed because their results aren’t returned.`;
    }
  }
  if (tool.origin === 'socket') {
    const method = String(args.method ?? '');
    if (DELETE_TOOL_NAME.test(method)) {
      return `${serviceName}: ${method} can’t be proposed from an outsiders’ run.`;
    }
  }
  if (connectionCallAccess(entry, tool, args) === 'read') {
    return `${serviceName}: read-only calls can’t be proposed because their results aren’t returned.`;
  }
  return null;
}

/** At most `max` characters, cut at a word boundary when possible. */
function clipTitle(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = /\s/.test(text.charAt(max - 1)) ? cut.length : cut.search(/\s\S*$/);
  const kept = (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '');
  return `${kept}…`;
}

/** What an agent hears when it calls `propose_connection_actions` outside a proposing turn. */
export const NOT_PROPOSING_ACTIONS =
  'propose_connection_actions only works in a turn where an automation asks you to propose actions for approval. Answer in the conversation instead.';

/** The proposing step a dispatch is the turn of (null when it isn't one). */
export async function proposeActionsTurn(
  db: Db,
  dispatchId: string,
): Promise<{
  dispatch: typeof dispatches.$inferSelect;
  run: AutomationRunRow;
  row: AutomationStepRow;
} | null> {
  const [found] = await db
    .select({ row: automationRunSteps, run: automationRuns, dispatch: dispatches })
    .from(automationRunSteps)
    .innerJoin(automationRuns, eq(automationRuns.id, automationRunSteps.runId))
    .innerJoin(dispatches, eq(dispatches.id, automationRunSteps.dispatchId))
    .where(eq(automationRunSteps.dispatchId, dispatchId))
    .limit(1);
  if (found?.dispatch.trigger !== 'automation') return null;
  const step = found.run.definition.steps[found.row.idx];
  if (step?.kind !== 'dispatch_agent' || !step.proposeActions) return null;
  return { dispatch: found.dispatch, run: found.run, row: found.row };
}

/** Whether `propose_connection_actions` is this agent's in this turn (listed and run only then). */
export async function proposesInTurn(
  db: Db,
  agentId: string,
  dispatchId: string | undefined,
): Promise<boolean> {
  if (!dispatchId) return false;
  const turn = await proposeActionsTurn(db, dispatchId);
  return !!turn && turn.dispatch.agentId === agentId;
}

/** Safely parses proposed actions stored on a step's output; empty list when absent or invalid. */
export function reportedProposedActions(kept: unknown): ProposedConnectionAction[] {
  const parsed = ProposeConnectionActionsInput.shape.actions.safeParse(kept);
  return parsed.success ? parsed.data : [];
}

/**
 * `automation.propose_actions` (the step's agent, `propose_connection_actions`): keeps proposed connection actions on
 * the step under the run's lock so the follow-up `connection_actions` step sees the last proposal. Content-free signed
 * event (never logs arguments or email content).
 */
export const proposeConnectionActions = defineCommand({
  name: 'automation.propose_actions',
  schema: z.object({ dispatchId: z.string(), input: ProposeConnectionActionsInput }),
  async apply(tx, ctx, { dispatchId, input }): Promise<{ count: number }> {
    if (ctx.actor.kind !== 'agent') throw forbidden(NOT_PROPOSING_ACTIONS);
    const turn = await proposeActionsTurn(tx, dispatchId);
    if (!turn || turn.dispatch.agentId !== ctx.actor.id || turn.run.burrowId !== ctx.burrow.id)
      throw forbidden(NOT_PROPOSING_ACTIONS);
    if (turn.dispatch.state !== 'claimed' && turn.dispatch.state !== 'running')
      throw conflict('This turn has ended, so its proposed actions can’t change any more.');
    const [run] = await tx
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, turn.run.id))
      .for('update');
    const [row] = await tx
      .select()
      .from(automationRunSteps)
      .where(and(eq(automationRunSteps.runId, turn.run.id), eq(automationRunSteps.idx, turn.row.idx)));
    if (!run || row?.state !== 'waiting' || row.dispatchId !== dispatchId)
      throw conflict('This step is finished, so its proposed actions can’t change any more.');
    if (input.actions.length > 0) {
      const allConnections = await tx
        .select()
        .from(catalogConnections)
        .where(eq(catalogConnections.burrowId, ctx.burrow.id));
      const byHandle = new Map(allConnections.map((c) => [c.handle.toLowerCase(), c]));
      for (const item of input.actions) {
        const handle = item.connection.trim().toLowerCase();
        const conn = byHandle.get(handle);
        const entry = conn ? catalogEntry(conn.catalogId) : null;
        if (!conn || !entry) {
          throw badRequest(`No connected service called “${item.connection}”.`);
        }
        if (!isProposableEntry(entry)) {
          throw forbidden(`Actions on ${item.connection} can’t be proposed from an outsiders’ run.`);
        }
        if (conn.access === 'read') {
          throw forbidden(lookOnlyText(item.connection));
        }
        const [tool] = await tx
          .select()
          .from(connectionTools)
          .where(and(eq(connectionTools.connectionId, conn.id), eq(connectionTools.name, item.tool)));
        if (!tool) {
          throw badRequest(`${item.connection} has no tool called “${item.tool}”.`);
        }
        if (tool.tier === 'off') {
          throw forbidden(`${tool.name} is turned off for ${item.connection}.`);
        }
        let args: Record<string, unknown> = { ...item.arguments };
        if (tool.origin === 'request') {
          try {
            args = normaliseRequestArgs(args);
          } catch (err) {
            throw badRequest(
              `${item.connection}: ${err instanceof ConnectionArgumentError ? err.message : 'invalid request arguments.'}`,
            );
          }
        } else if (tool.origin === 'socket') {
          try {
            args = normaliseSocketArgs(entry, args, item.connection);
          } catch (err) {
            throw badRequest(
              `${item.connection}: ${err instanceof ConnectionArgumentError ? err.message : 'invalid socket arguments.'}`,
            );
          }
        }
        const refused = proposeCallRefusal(entry, tool, args, item.connection);
        if (refused) throw forbidden(refused);
      }
    }
    await tx
      .update(automationRunSteps)
      .set({
        output: {
          ...(row.output as JsonObject),
          proposedActions: input.actions as unknown as JsonObject[],
        },
        updatedAt: ctx.now,
      })
      .where(and(eq(automationRunSteps.runId, run.id), eq(automationRunSteps.idx, row.idx)));
    const handles = [...new Set(input.actions.map((a) => a.connection.trim().toLowerCase()))];
    await ctx.emit({
      type: 'automation.actions_proposed',
      kind: 'System',
      text: null,
      where: null,
      payload: {
        runId: run.id,
        number: run.number,
        stepId: row.stepId,
        count: input.actions.length,
        handles,
      },
    });
    await publishRun(ctx, run.id);
    return { count: input.actions.length };
  },
});

/**
 * Short non-secret list of active writable catalog connections (handles, enabled write-capable tool names, allowed
 * REST prefixes and static catalog guides) appended to a `proposeActions` step's instructions. Never exposes
 * credentials, the person's own connection labels, live data, or powerful built-in/host-control connections, and the
 * turn still has no `connection_call` or `connection_tools`.
 */
export async function proposableConnectionsNote(db: Db | Tx, burrowId: string): Promise<string> {
  const rows = await db
    .select()
    .from(catalogConnections)
    .where(eq(catalogConnections.burrowId, burrowId))
    .orderBy(asc(catalogConnections.createdAt), asc(catalogConnections.id));
  const lines: string[] = [];
  for (const row of rows) {
    if (row.status !== 'active' || row.access === 'read') continue;
    const entry = catalogEntry(row.catalogId);
    if (!entry || !isProposableEntry(entry)) continue;
    const tools = await db
      .select({
        name: connectionTools.name,
        tier: connectionTools.tier,
        access: connectionTools.access,
      })
      .from(connectionTools)
      .where(eq(connectionTools.connectionId, row.id))
      .orderBy(asc(connectionTools.name));
    const enabled = tools
      .filter((t) => t.tier !== 'off' && t.access !== 'read' && !DELETE_TOOL_NAME.test(t.name))
      .map((t) => t.name);
    if (!enabled.length) continue;
    const prefixes = entry.request ? resolveRequestPrefixes(entry, row.fields) : [];
    const prefixPart = prefixes.length ? `; paths under ${prefixes.join(' or ')}` : '';
    const guidePart = entry.guide ? ` — ${entry.guide.slice(0, 320)}` : '';
    lines.push(`- ${row.handle}: tools [${enabled.join(', ')}]${prefixPart}${guidePart}`);
  }
  if (!lines.length) return '';
  return `Connections you can propose write actions for (no DELETE or read-only calls; each waits for the person’s approval card):\n${lines.join('\n')}`.slice(
    0,
    2500,
  );
}

/**
 * Loads an attachment ONLY when it belongs to a message in THIS run's thread (preventing a prompt-injected email from
 * naming another file in Chat Files or another thread).
 */
export async function threadAttachment(
  db: Db | Tx,
  run: Pick<AutomationRunRow, 'burrowId' | 'conversationId' | 'threadRootId'>,
  attachmentId: string,
): Promise<AttachmentRow | null> {
  if (!run.threadRootId) return null;
  const [found] = await db
    .select({ attachment: attachments })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .where(
      and(
        eq(attachments.id, attachmentId),
        eq(attachments.burrowId, run.burrowId),
        eq(attachments.state, 'ready'),
        eq(messages.conversationId, run.conversationId),
        or(eq(messages.id, run.threadRootId), eq(messages.threadRootId, run.threadRootId)),
      ),
    )
    .limit(1);
  return found?.attachment ?? null;
}

export interface PlannedConnectionAction {
  connectionId: string;
  handle: string;
  label: string;
  tool: string;
  toolHash: string;
  summary: string;
  args: Record<string, unknown>;
}

export type ConnectionActionsPlan =
  | {
      ok: true;
      actions: PlannedConnectionAction[];
      actionsHash: string;
      proposal: { title: string; details: string };
    }
  | { ok: false; fatal: boolean; reason: string };

/**
 * Validates every proposed connection action from step `from`, ensuring each target connection, tool, path, limit,
 * key (not `cannot`), and uploaded attachment (on this run's thread) is permitted. Returns a deterministic
 * `actionsHash` and plain-English approval proposal.
 */
export async function planConnectionActions(
  db: Db | Tx,
  services: Services,
  run: AutomationRunRow,
  steps: readonly AutomationStepRow[],
  step: { from: string },
): Promise<ConnectionActionsPlan> {
  const fromRow = steps.find((s) => s.stepId === step.from);
  const proposed = reportedProposedActions((fromRow?.output as JsonObject | undefined)?.proposedActions);
  if (proposed.length === 0) {
    return { ok: true, actions: [], actionsHash: '', proposal: { title: '', details: '' } };
  }
  const agent = await automationAgent(db, run.burrowId);
  if (!agent) return { ok: false, fatal: true, reason: 'The burrow’s agent isn’t available.' };
  const grants = await loadGrants(db as Db, agent.id);
  const allConnections = await db
    .select()
    .from(catalogConnections)
    .where(eq(catalogConnections.burrowId, run.burrowId));
  const byHandle = new Map(allConnections.map((c) => [c.handle.toLowerCase(), c]));
  const maxUpload = Math.min(CONNECTOR_BINARY_MAX_BYTES, services.files.maxBytes);

  const planned: PlannedConnectionAction[] = [];
  for (const item of proposed) {
    const handle = item.connection.trim().toLowerCase();
    const row = byHandle.get(handle);
    const entry = row ? catalogEntry(row.catalogId) : null;
    if (!row || !entry) {
      return { ok: false, fatal: false, reason: `No connected service called “${item.connection}”.` };
    }
    if (!isProposableEntry(entry)) {
      return {
        ok: false,
        fatal: false,
        reason: `Actions on ${row.label} can’t be proposed from an outsiders’ run.`,
      };
    }
    if (row.status !== 'active') {
      return { ok: false, fatal: false, reason: needsReauthText(row) };
    }
    const [tool] = await db
      .select()
      .from(connectionTools)
      .where(and(eq(connectionTools.connectionId, row.id), eq(connectionTools.name, item.tool)));
    if (!tool) {
      return { ok: false, fatal: false, reason: `${row.label} has no tool called “${item.tool}”.` };
    }
    let args: Record<string, unknown> = { ...item.arguments };
    if (tool.origin === 'request') {
      try {
        args = normaliseRequestArgs(args);
      } catch (err) {
        return {
          ok: false,
          fatal: false,
          reason: `${row.label}: ${err instanceof ConnectionArgumentError ? err.message : 'invalid request arguments.'}`,
        };
      }
      const refused = proposeCallRefusal(entry, tool, args, row.label);
      if (refused) return { ok: false, fatal: false, reason: refused };
      const method = String(args.method);
      const path = String(args.path);
      if (!requestAllowed(entry, row.fields, method, path)) {
        return {
          ok: false,
          fatal: false,
          reason: `${row.label} doesn’t allow ${method} ${path}.`,
        };
      }
      const upload = parseRequestUpload(args.upload);
      if (upload) {
        const att = await threadAttachment(db, run, upload.attachmentId);
        if (!att?.blobKey) {
          return {
            ok: false,
            fatal: false,
            reason: `That attachment isn’t part of this email’s thread, so it can’t be uploaded to ${row.label}.`,
          };
        }
        if (att.size > maxUpload) {
          return {
            ok: false,
            fatal: false,
            reason: `${att.name} is too large to upload to ${row.label}.`,
          };
        }
      }
    } else if (tool.origin === 'socket') {
      try {
        args = normaliseSocketArgs(entry, args, row.label);
      } catch (err) {
        return {
          ok: false,
          fatal: false,
          reason: `${row.label}: ${err instanceof ConnectionArgumentError ? err.message : 'invalid socket arguments.'}`,
        };
      }
      const refused = proposeCallRefusal(entry, tool, args, row.label);
      if (refused) return { ok: false, fatal: false, reason: refused };
    } else {
      const refused = proposeCallRefusal(entry, tool, args, row.label);
      if (refused) return { ok: false, fatal: false, reason: refused };
    }
    const server = await callServerOf(db as Db, services, row.burrowId, row.catalogId, args);
    const decided = callTier(
      entry,
      tool,
      args,
      (keyId) => keyTierOf(agent.id, grants, keyId),
      row.access,
      server,
    );
    if (decided.lookOnly) return { ok: false, fatal: false, reason: lookOnlyText(row.label) };
    if (decided.toolTier === 'off')
      return { ok: false, fatal: false, reason: `${tool.name} is turned off for ${row.label}.` };
    if (decided.keyTier === 'cannot')
      return { ok: false, fatal: false, reason: `${agent.name} isn’t allowed to use ${row.label}.` };
    const outside = limitsProblem(tool.limits, args, await limitWordsFor(db, row, tool));
    if (outside) return { ok: false, fatal: false, reason: outside };

    planned.push({
      connectionId: row.id,
      handle: row.handle,
      label: row.label,
      tool: tool.name,
      toolHash: tool.hash,
      summary: item.summary.trim(),
      args,
    });
  }

  const actionsHash = createHash('sha256')
    .update(
      canonicalJson(
        planned.map((a) => ({
          connectionId: a.connectionId,
          tool: a.tool,
          toolHash: a.toolHash,
          summary: a.summary,
          args: a.args,
        })),
      ),
    )
    .digest('hex');

  const proposal =
    planned.length === 1 && planned[0]
      ? {
          title: clipTitle(planned[0].summary, 160),
          details: `${planned[0].label}: ${planned[0].summary}.`.slice(0, 2000),
        }
      : {
          title: `Approve ${planned.length} actions from this email`,
          details: planned
            .map((a) => `${a.label}: ${a.summary}`)
            .join('\n\n')
            .slice(0, 2000),
        };

  return { ok: true, actions: planned, actionsHash, proposal };
}

/** Short plain-English confirmation posted in the run thread after approved actions finish. */
export function actionsDoneLine(actions: readonly { label: string; summary: string }[]): string {
  if (actions.length === 0) return 'Done.';
  if (actions.length === 1 && actions[0]) return `Done: ${actions[0].summary}.`;
  return `Done: ${actions.map((a) => a.summary).join('; ')}.`.slice(0, 1000);
}

export { REQUEST_TOOL_NAME };
