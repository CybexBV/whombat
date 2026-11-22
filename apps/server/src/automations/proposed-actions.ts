/**
 * Proposed connection actions for outsiders' automation runs (docs/decisions/automation-recipes.md): the agent of a
 * `dispatch_agent` step with `proposeActions: true` (such as a mail-triggered run) cannot reach the person's
 * connections directly. Instead, it records proposed calls with `propose_connection_actions` during its turn, and a
 * follow-up `connection_actions` step validates them, ALWAYS asks the person on an approval card regardless of
 * standing connection or key settings, and runs them only after approval.
 */
import { createHash } from 'node:crypto';
import {
  type AutomationStep,
  type CatalogEntry,
  CONNECTOR_BINARY_MAX_BYTES,
  canonicalJson,
  catalogEntry,
  cutsOffReason,
  type JsonObject,
  lookOnlyText,
  ProposeConnectionActionsInput,
  type ProposedConnectionAction,
  REQUEST_TOOL_NAME,
  requestAllowed,
  sensitiveReason,
} from '@whombat/core';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import { callTier, needsReauthText } from '../connections/call';
import { connectionCallAccess } from '../connections/call-access';
import { callTarget } from '../connections/call-target';
import { keyTierOf } from '../connections/context';
import { limitsProblem } from '../connections/limits';
import { ConnectionArgumentError, normaliseRequestArgs, parseRequestUpload } from '../connections/request';
import type { ConnectionToolRow } from '../connections/types';
import type { Db, Tx } from '../db/client';
import {
  approvals,
  attachments,
  automationRunSteps,
  automationRuns,
  catalogConnections,
  connectionTools,
  dispatches,
} from '../db/schema/index';
import { limitWordsFor } from '../devices/store';
import type { AttachmentRow } from '../files/service';
import { callServerOf } from '../hosts/asks';
import { badRequest, conflict, forbidden } from '../lib/errors';
import { loadGrants } from '../read/principals';
import type { Services } from '../services';
import { automationAgent } from './authority';
import { handedOverFileIds } from './handed-files';
import {
  isProposableEntry,
  listedActionName,
  listedOffers,
  settleListed,
  whatMailCanDo,
} from './listed-actions';
import {
  type CardFile,
  type CardNames,
  cardNameKey,
  cardRefs,
  type DescribedAction,
  describePlannedAction,
  keptCardNames,
  type ProposalCard,
  proposalCard,
  TOO_MUCH_FOR_ONE_CARD,
} from './proposed-card';
import { type AutomationRunRow, type AutomationStepRow, publishRun } from './store';

export { isProposableEntry };

/**
 * `offered: false`: refused for what the person has, not for the arguments of an action the turn was offered — the kind
 * of connection, a call that is no listed action there, or a path the connection's own settings don't allow. An
 * outsiders' turn hears every such refusal in the same words (`notOfferedText`); the person's run page says why.
 */
export type OutsidersCall =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; reason: string; offered?: false };

/**
 * What an outsiders' turn hears for any action it wasn't offered, whatever the reason: no connection by that handle,
 * one that is signed out, looks only or can't take proposals, a tool it doesn't have or that is off, a call that is no
 * listed action. The same words every time, so a turn can't learn from them what the person has.
 */
export function notOfferedText(handle: string): string {
  const name = singleLine(handle).slice(0, 40);
  return `That action on “${name}” isn’t one listed for you, so it can’t be proposed. ${whatMailCanDo()}`;
}

/**
 * A call an outsiders' run proposes, as Whombat would send it, or why it can't be: only a listed action
 * (`listed-actions.ts`) on a kind of connection that has them, with every argument as its schema says, the create-only
 * parts and the person's account ids (a Moneybird administration, a Nextcloud user) set by Whombat; never a value named
 * like a password or key (an outsiders' turn has none, so it could only come from the email); and, as a second check,
 * never what the connection always asks about, what can cut the person off, or a read. Checked when the agent proposes,
 * when the card is made and again before anything runs, so the same arguments come out each time. `name` is how a
 * refusal names the connection: the handle the agent used, or the person's own label on their run page, and the path
 * as the call gave it, so what the agent hears never holds an account id the server filled in.
 */
export function outsidersCall(
  entry: CatalogEntry,
  conn: { fields: Readonly<Record<string, string>> },
  tool: Pick<ConnectionToolRow, 'name' | 'access' | 'origin'>,
  raw: Readonly<Record<string, unknown>>,
  name: string,
  /** The server's own arguments, settled when the card was made (checked again before they run), not the agent's. */
  settled = false,
): OutsidersCall {
  if (!isProposableEntry(entry))
    return {
      ok: false,
      offered: false,
      reason: `Actions on ${name} can’t be proposed from an outsiders’ run. ${whatMailCanDo()}`,
    };
  let args: Record<string, unknown> = { ...raw };
  if (tool.origin === 'request') {
    try {
      args = normaliseRequestArgs(raw);
    } catch (err) {
      return {
        ok: false,
        reason: `${name}: ${err instanceof ConnectionArgumentError ? err.message : 'invalid request arguments.'}`,
      };
    }
  }
  const given = args;
  const listed = settleListed(entry.id, tool, args, conn.fields, settled);
  if (!listed.ok)
    return listed.listed
      ? { ok: false, reason: `${name}: ${listed.reason}` }
      : {
          ok: false,
          offered: false,
          reason: `${name}: a mail automation can’t propose this. ${listed.reason}`,
        };
  args = listed.args;
  if (
    tool.origin === 'request' &&
    !requestAllowed(entry, conn.fields, String(args.method), String(args.path))
  )
    return {
      ok: false,
      offered: false,
      reason: `${name} doesn’t allow ${String(given.method)} ${String(given.path)}.`,
    };
  // The second check reads what the call is (its method and path, or its tool), never the text in its values: those are
  // the listed action's own (a notification that mentions a door unlocks nothing).
  const what = tool.origin === 'request' ? { method: args.method, path: args.path } : {};
  const reason = sensitiveReason(entry, tool.name, what) ?? cutsOffReason(entry, tool.name, what);
  if (reason)
    return {
      ok: false,
      offered: false,
      reason: `${name}: an outsiders’ run can’t propose this (${reason.replace(/[.\s]+$/, '').toLowerCase()}).`,
    };
  if (connectionCallAccess(entry, tool, args) === 'read')
    return {
      ok: false,
      offered: false,
      reason: `${name}: read-only calls can’t be proposed because their results aren’t returned.`,
    };
  return { ok: true, args };
}

/** What a refused upload says: only the files that came with this email can be sent. */
export function notThisEmailsFile(name: string): string {
  return `That file didn’t come with this email, so it can’t be uploaded to ${name}. Only the email’s own attachments can.`;
}

/** The email's file a call sends, as the card names it, or why it can't be sent. */
async function proposedUpload(
  db: Db | Tx,
  run: Pick<AutomationRunRow, 'id' | 'burrowId' | 'threadRootId'>,
  args: Readonly<Record<string, unknown>>,
  name: string,
  maxUpload: number,
): Promise<{ ok: true; file: CardFile | null } | { ok: false; reason: string }> {
  const upload = parseRequestUpload(args.upload);
  if (!upload) return { ok: true, file: null };
  const att = await emailFile(db, run, upload.attachmentId);
  if (!att?.blobKey) return { ok: false, reason: notThisEmailsFile(name) };
  if (att.size > maxUpload) return { ok: false, reason: `${att.name} is too large to upload to ${name}.` };
  return { ok: true, file: { name: att.name, contentType: att.contentType, size: att.size } };
}

/** Collapses line breaks and repeated whitespace so untrusted text stays on one line. */
function singleLine(text: string): string {
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

const OfferedAction = z.object({
  connectionId: z.string(),
  handle: z.string(),
  catalogId: z.string(),
  tool: z.string(),
  origin: z.enum(['request', 'adapter']),
  action: z.string(),
});
type OfferedAction = z.infer<typeof OfferedAction>;
const OfferedActions = z.array(OfferedAction);

/** Identify each proposal before reading any of the person's connection rows. */
function offeredAction(
  offers: readonly OfferedAction[],
  item: ProposedConnectionAction,
): OfferedAction | undefined {
  const handle = item.connection.trim().toLowerCase();
  return offers.find((offer) => {
    if (offer.handle !== handle || offer.tool !== item.tool) return false;
    let args = item.arguments;
    if (offer.origin === 'request') {
      try {
        args = normaliseRequestArgs(args);
      } catch (err) {
        // This handle and tool were offered. Explain malformed input before looking up the connection.
        throw forbidden(
          `${item.connection}: ${err instanceof ConnectionArgumentError ? err.message : 'invalid request arguments.'}`,
        );
      }
    }
    return (
      listedActionName(offer.catalogId, { name: offer.tool, origin: offer.origin }, args) === offer.action
    );
  });
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
      const kept = OfferedActions.safeParse((row.output as JsonObject).offeredActions);
      const offers = kept.success ? kept.data : [];
      const matched = input.actions.map((item) => {
        const offer = offeredAction(offers, item);
        if (!offer) throw forbidden(notOfferedText(item.connection));
        return { item, offer };
      });
      const rows = await tx
        .select()
        .from(catalogConnections)
        .where(
          and(
            eq(catalogConnections.burrowId, ctx.burrow.id),
            inArray(catalogConnections.id, [...new Set(matched.map(({ offer }) => offer.connectionId))]),
          ),
        );
      const byId = new Map(rows.map((connection) => [connection.id, connection]));
      const maxUpload = Math.min(CONNECTOR_BINARY_MAX_BYTES, ctx.services.files.maxBytes);
      const described: (DescribedAction & { label: string })[] = [];
      for (const { item, offer } of matched) {
        const conn = byId.get(offer.connectionId);
        const entry = conn ? catalogEntry(conn.catalogId) : null;
        // Only what the turn's instructions offered it (`proposableConnections`): anything else, whatever the
        // reason, is refused in the same words, so the refusal says nothing of what the person has.
        const notOffered = () => forbidden(notOfferedText(item.connection));
        if (
          !conn ||
          conn.catalogId !== offer.catalogId ||
          conn.handle.toLowerCase() !== offer.handle ||
          !entry ||
          !isProposableEntry(entry) ||
          conn.status !== 'active' ||
          conn.access === 'read'
        )
          throw notOffered();
        const [tool] = await tx
          .select()
          .from(connectionTools)
          .where(and(eq(connectionTools.connectionId, conn.id), eq(connectionTools.name, item.tool)));
        if (!tool || tool.origin !== offer.origin || tool.tier === 'off') throw notOffered();
        const call = outsidersCall(entry, conn, tool, item.arguments, item.connection);
        if (!call.ok) throw call.offered === false ? notOffered() : forbidden(call.reason);
        const args = call.args;
        const upload = await proposedUpload(tx, turn.run, args, item.connection, maxUpload);
        if (!upload.ok) throw forbidden(upload.reason);
        // The sizing answer must not depend on the private label or the length of a server-added account id.
        const publicArgs =
          tool.origin === 'request' ? { ...args, path: normaliseRequestArgs(item.arguments).path } : args;
        described.push({
          ...describePlannedAction({
            catalogId: conn.catalogId,
            label: item.connection,
            tool,
            args: publicArgs,
            uploadFile: upload.file,
            summary: item.summary,
          }),
          label: item.connection,
        });
      }
      // The agent hears now, while it can still propose less, when the card couldn't show it all.
      const card = proposalCard(described);
      if (!card.ok) throw badRequest(card.reason);
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
 * What a `proposeActions` step's agent may propose, appended to its instructions: for each active connection that
 * isn't look-only, the listed actions (`listed-actions.ts`) its enabled tools offer, by handle, each with the tool and
 * the shape of its arguments. Never credentials, the person's own connection labels or live data, and the turn still
 * has no `connection_call` or `connection_tools`.
 */
export async function proposableConnections(
  db: Db | Tx,
  burrowId: string,
): Promise<{ note: string; offeredActions: OfferedAction[] }> {
  const rows = await db
    .select()
    .from(catalogConnections)
    .where(eq(catalogConnections.burrowId, burrowId))
    .orderBy(asc(catalogConnections.createdAt), asc(catalogConnections.id));
  const offeredActions: OfferedAction[] = [];
  let note =
    'These are the only actions you can propose, each on the connection named first (each waits for the person’s yes on a card that shows every argument, so keep them few and short; a file must be one attached to this message):';
  for (const row of rows) {
    if (row.status !== 'active' || row.access === 'read') continue;
    const entry = catalogEntry(row.catalogId);
    if (!entry || !isProposableEntry(entry)) continue;
    const tools = await db
      .select({ name: connectionTools.name, tier: connectionTools.tier, origin: connectionTools.origin })
      .from(connectionTools)
      .where(eq(connectionTools.connectionId, row.id))
      .orderBy(asc(connectionTools.name));
    for (const { how, ...action } of listedOffers(
      row.catalogId,
      tools.filter((t) => t.tier !== 'off'),
    )) {
      const line = `\n- ${row.handle}: ${how}`;
      if (note.length + line.length > 4000) return { note, offeredActions };
      note += line;
      offeredActions.push({
        ...action,
        connectionId: row.id,
        catalogId: row.catalogId,
        handle: row.handle.toLowerCase(),
      });
    }
  }
  return { note: offeredActions.length ? note : '', offeredActions };
}

/**
 * Loads an attachment ONLY when the server handed it over from what started THIS run (`handedOverFileIds`: the email's
 * files, copied onto the run's first agent prompt and recorded there by id), so neither a prompt-injected email nor a
 * file the person added to the thread with the same name can be uploaded. The same rule decides what the run's
 * outsiders' turns are shown and may read (`files/access.ts`).
 */
export async function emailFile(
  db: Db | Tx,
  run: Pick<AutomationRunRow, 'id' | 'burrowId' | 'threadRootId'>,
  attachmentId: string,
): Promise<AttachmentRow | null> {
  if (!(await handedOverFileIds(db, run)).includes(attachmentId)) return null;
  const [found] = await db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.id, attachmentId),
        eq(attachments.burrowId, run.burrowId),
        eq(attachments.state, 'ready'),
      ),
    )
    .limit(1);
  return found ?? null;
}

export interface PlannedConnectionAction {
  connectionId: string;
  /** Where the connection's calls go and as whom when the card was made (`callTarget`): the yes is bound to it. */
  target: string;
  handle: string;
  label: string;
  tool: string;
  toolHash: string;
  /** Whombat's own words for the call (“Upload a document to Paperless-ngx”), never the agent's. */
  description: string;
  /** What the thread says once it ran (“uploaded a document to Paperless-ngx”). */
  done: string;
  /** Every line the card shows for it: the words, the method and path or tool, every argument, the agent's note. */
  lines: string[];
  /** Agent-written summary, shown only as a secondary note. */
  summary: string;
  args: Record<string, unknown>;
}

export type ConnectionActionsPlan =
  | {
      ok: true;
      actions: PlannedConnectionAction[];
      actionsHash: string;
      proposal: { title: string; details: string };
      /** The approval card: everything it shows (empty when nothing was proposed). */
      card: Extract<ProposalCard, { ok: true }> | null;
      /** The names of the ids the card shows, to keep on the step with it. */
      names: CardNames;
    }
  | { ok: false; fatal: boolean; reason: string };

/**
 * Validates every proposed connection action from step `from`, ensuring each is a listed action (`outsidersCall`) and
 * its connection, tool, limit, key (not `cannot`) and file (one the server handed over from this run's email) are
 * permitted, and that every id it names exists where the server could read it. Returns a deterministic `actionsHash`
 * (bound to where each call goes, `callTarget`) and plain-English approval proposal. `names` are the ids' names the server just read (`card-names.ts`); without
 * them, the ones kept on the step when its card was made, so the card reads the same each time it is made.
 */
export async function planConnectionActions(
  db: Db | Tx,
  services: Services,
  run: AutomationRunRow,
  steps: readonly AutomationStepRow[],
  step: { id: string; from: string },
  names?: CardNames,
): Promise<ConnectionActionsPlan> {
  const fromRow = steps.find((s) => s.stepId === step.from);
  const proposed = reportedProposedActions((fromRow?.output as JsonObject | undefined)?.proposedActions);
  const known = names ?? keptCardNames(steps.find((s) => s.stepId === step.id)?.output);
  if (proposed.length === 0) {
    return {
      ok: true,
      actions: [],
      actionsHash: '',
      proposal: { title: '', details: '' },
      card: null,
      names: {},
    };
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
    const call = outsidersCall(entry, row, tool, item.arguments, row.label);
    if (!call.ok) return { ok: false, fatal: false, reason: call.reason };
    const args = call.args;
    const upload = await proposedUpload(db, run, args, row.label, maxUpload);
    if (!upload.ok) return { ok: false, fatal: false, reason: upload.reason };
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

    // An id the service says it doesn't have goes on the card with a line that says so, and one it couldn't read shows
    // as it is: never a refusal, so what a later step can read of this one is the same whether the id is there or not.
    const named: Record<string, string> = {};
    const missing: string[] = [];
    for (const ref of cardRefs(row.catalogId, tool, args)) {
      const found = known[cardNameKey(row, ref.kind, ref.id)];
      if (found && 'missing' in found) missing.push(`${ref.kind}:${ref.id}`);
      else if (found) named[`${ref.kind}:${ref.id}`] = found.name;
    }

    const summary = singleLine(item.summary);
    const described = describePlannedAction({
      catalogId: row.catalogId,
      label: row.label,
      tool,
      args,
      uploadFile: upload.file,
      summary,
      names: named,
      missing,
    });

    planned.push({
      connectionId: row.id,
      target: callTarget(row),
      handle: row.handle,
      label: row.label,
      tool: tool.name,
      toolHash: tool.hash,
      description: described.ask,
      done: described.done,
      lines: described.lines,
      summary,
      args,
    });
    if (described.overflow) return { ok: false, fatal: false, reason: TOO_MUCH_FOR_ONE_CARD };
  }

  // The card shows every action whole, or the batch is refused: the person never approves something partly shown.
  const card = proposalCard(planned.map((a) => ({ ...a, ask: a.description, overflow: false })));
  if (!card.ok) return { ok: false, fatal: false, reason: card.reason };
  const actionsHash = hashPlannedActions(planned);
  return {
    ok: true,
    actions: planned,
    actionsHash,
    proposal: { title: card.title, details: card.details },
    card,
    names: known,
  };
}

/**
 * Deterministic SHA-256 hash binding a batch of planned connection actions to its approval card: what runs, and where
 * each call goes and as whom (`callTarget`), so a connection given another address or sign-in needs a new yes.
 */
export function hashPlannedActions(
  planned: readonly {
    connectionId: string;
    target: string;
    tool: string;
    toolHash: string;
    description: string;
    summary: string;
    args: Record<string, unknown>;
  }[],
): string {
  return createHash('sha256')
    .update(
      canonicalJson(
        planned.map((a) => ({
          connectionId: a.connectionId,
          target: a.target,
          tool: a.tool,
          toolHash: a.toolHash,
          description: a.description,
          summary: a.summary,
          args: a.args,
        })),
      ),
    )
    .digest('hex');
}

/**
 * Whether `approvalId` is an approved card for this exact run step, attempt, and planned `actionsHash` (binding what
 * runs to what the person actually approved).
 */
export async function approvedActionsRequest(
  db: Db | Tx,
  approvalId: string,
  runId: string,
  step: Pick<AutomationStep, 'id'>,
  attempt: number,
  actionsHash: string,
): Promise<boolean> {
  if (!actionsHash) return false;
  const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
  const binding = row?.actionBinding;
  const approvedHash =
    row?.command?.name === 'automation.continue_step' &&
    typeof row.command.input === 'object' &&
    row.command.input !== null
      ? (row.command.input as { actionsHash?: unknown }).actionsHash
      : null;
  return (
    row?.state === 'approved' &&
    binding?.runId === runId &&
    binding.stepId === `${step.id}#${attempt}` &&
    approvedHash === actionsHash
  );
}

export { REQUEST_TOOL_NAME };
