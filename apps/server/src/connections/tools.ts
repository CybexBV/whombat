/**
 * The two connection tools agents see (docs/decisions/connections-catalog.md CX-30): `connection_tools` (the guide and
 * the tools of one connection, refreshed when over an hour old) and `connection_call` (one call, decided by the keys
 * engine per call: `call.ts`). Both name a connection by the handle the agent's instructions list; a connection the turn
 * can't see is `unknown_connection`, whatever exists.
 *
 * A connection that looks only (docs/decisions/connections-setup.md CS-10): its guide starts with `lookOnlyText`, its
 * write tools are listed Off, `request` is listed as the read it can still be (CS-D14), and a write is refused before
 * anything is signed.
 */

import {
  accessTier,
  type CatalogEntry,
  CONNECTION_GUIDE_MAX,
  CONNECTION_OUTPUT_MAX,
  type ConnectionAccessLevel,
  type ConnectionToolView,
  canonicalJson,
  connectionGuide,
  conversationLabel,
  type JsonObject,
  lookOnlyText,
  type McpToolName,
  REQUEST_TOOL_NAME,
  requestCallTier,
  toolOffText,
} from '@whombat/core';
import { handWaitWhenQueued, slicedWaitArgs } from '../automations/turn-waits';
import { limitWordsFor } from '../devices/store';
import { withImage } from '../mcp/image';
import type { ToolContext, ToolHandler } from '../mcp/tools';
import { loadConversationRow } from '../read/conversations';
import { loadGrants, shortName } from '../read/principals';
import { dispatchPerson } from '../runtime/person';
import { followT3Call, t3CallArgs } from '../t3code/follow';
import { settleRefusal } from '../t3code/settle';
import { callT3 } from '../things/kinds/business/t3code';
import { type CallWords, callWordsFor } from './adapters/index';
import {
  callArgsAad,
  callConnectionTool,
  callTier,
  executeConnectionCall,
  needsReauthText,
  newCallId,
} from './call';
import { callTarget } from './call-target';
import { coversReads } from './call-access';
import { connectionByHandle, keyTierOf, type VisibleConnection } from './context';
import { limitsProblem } from './limits';
import {
  checkReportTurnCall,
  ownThreadList,
  reportTurnLists,
  strangerTextOf,
  subagentParentOfRead,
} from './report-turn';
import { ConnectionArgumentError, normaliseRequestArgs } from './request';
import { normaliseSocketArgs } from './socket/call';
import { ensureTools, toolRowAlwaysAsks } from './sync';
import type { CatalogConnectionRow, ConnectionToolRow } from './types';

/**
 * What happens after a yes, as the agent hears it while the yes is pending: a task Whombat follows (`task`: a backup, an
 * install; its card shows it running and the agent is woken when it ends, task-feedback.md TF-12), a call whose result
 * wakes the agent (`wake`, HR-04), or one Whombat tells itself (`said`: the server this Whombat runs on goes down with
 * it, TF-S10).
 */
export type AfterYes = 'task' | 'wake' | 'said';

/** Which `AfterYes` a connection's call has. */
export function afterYesOf(
  words: Pick<CallWords, 'startsTask' | 'saysItself'> | null | undefined,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): AfterYes {
  if (words?.startsTask?.(tool, args) === true) return 'task';
  return words?.saysItself?.(tool, args) === true ? 'said' : 'wake';
}

/**
 * What the agent hears when the person has to say yes first: when the call runs and what it hears after (`AfterYes`).
 * It promises only what happens (TF-05). `person`: their name (“Mara”), null when unknown.
 */
export function pendingApprovalText(person: string | null, after: AfterYes): string {
  const who = `${person ?? 'Your person'} has`;
  const where = 'here';
  if (after === 'task')
    return `${who} to approve this first. It starts once they say yes; a card ${where} shows it running, and you are woken ${where} when it ends to tell them how it went. No need to check on it.`;
  if (after === 'said')
    return `${who} to approve this first. It runs once they say yes, and Whombat says ${where} what happened.`;
  return `${who} to approve this first. It runs once they say yes, and you are woken with its result ${where} to tell them how it went.`;
}

/**
 * What the agent hears when a call leaves out an argument its tool requires (the input schema's `required`; for
 * Whombat's own tools an empty text counts as left out, as they refuse it), null when nothing is missing. Checked
 * before anything is signed, so a call that can't run never reaches the person as a card to approve.
 */
export function missingArgsText(
  tool: Pick<ConnectionToolRow, 'name' | 'origin' | 'inputSchema'>,
  args: Readonly<Record<string, unknown>>,
): string | null {
  const required = tool.inputSchema?.required;
  if (!Array.isArray(required)) return null;
  const blank = (v: unknown) =>
    v === undefined || v === null || (tool.origin === 'adapter' && typeof v === 'string' && !v.trim());
  const missing = required.filter((k): k is string => typeof k === 'string' && blank(args[k]));
  if (!missing.length) return null;
  return `${missing.join(', ')}: ${tool.name} needs ${missing.length === 1 ? 'it' : 'them'}. Nothing ran and nobody was asked; call it again with ${missing.length === 1 ? 'it' : 'them'}.`;
}

/** What the agent hears for a handle it can't use. */
export function unknownConnectionText(handle: string): string {
  return `There is no connection “${handle}” you can use here. Your instructions list the ones you can.`;
}

async function visible(ctx: ToolContext, handle: string): Promise<VisibleConnection | null> {
  return connectionByHandle(ctx.services.db, ctx.agentId, ctx.dispatch, handle);
}

/**
 * A tool as `connection_tools` lists it at the connection's level (CS-10): on one that looks only a write tool is Off,
 * and `request` (reads and writes in one) is listed as the read it still is, at its read tier (CS-D14).
 */
export function toolViewAt(
  entry: CatalogEntry,
  t: ConnectionToolRow,
  level: ConnectionAccessLevel,
): ConnectionToolView {
  // `request` and a socket's `call` (CM-14) still read on a connection that looks only.
  const lookOnlyRequest = level === 'read' && coversReads(entry, t);
  return {
    name: t.name,
    description: t.description.slice(0, 1000),
    access: lookOnlyRequest ? 'read' : t.access,
    tier: lookOnlyRequest ? requestCallTier(t.tier, 'read') : accessTier(level, t.access, t.tier),
    sensitive: toolRowAlwaysAsks(entry, t),
    isNew: t.isNew,
    ...(t.inputSchema ? { inputSchema: t.inputSchema as JsonObject } : {}),
    // The person's limits, so the agent stays inside them (one-whombat-devices.md ONE-DD04).
    ...(t.limits ? { limits: t.limits } : {}),
  };
}

/**
 * Whether a call's text is its structured answer written out: MCP servers send both (T3 Code does for every tool), and
 * the agent then reads it once.
 */
export function textRepeatsStructured(text: string, structured: unknown): boolean {
  if (!text.trimStart().startsWith('{')) return false;
  try {
    return canonicalJson(JSON.parse(text)) === canonicalJson(structured);
  } catch {
    return false;
  }
}

/** The guide an agent reads, after the look-only sentence when the connection looks only (CS-10). */
function guideAt(entry: CatalogEntry, row: CatalogConnectionRow): string {
  const guide = connectionGuide(entry, row.fields);
  return row.access === 'read'
    ? `${lookOnlyText(row.label)}\n\n${guide}`.slice(0, CONNECTION_GUIDE_MAX)
    : guide;
}

const failed = <R extends string>(reason: R, message: string) => ({
  status: 'failed' as const,
  reason,
  message,
});

export const CONNECTION_TOOL_HANDLERS: {
  [N in Extract<McpToolName, 'connection_tools' | 'connection_call'>]: ToolHandler<N>;
} = {
  connection_tools: async (ctx, input) => {
    const c = await visible(ctx, input.connection);
    if (!c) return failed('unknown_connection', unknownConnectionText(input.connection));
    const { tools } = c.row.status === 'active' ? await ensureTools(ctx.services, c.row) : { tools: [] };
    // A turn on a report sees only what it may call.
    const listed = c.reportTurn ? tools.filter((t) => reportTurnLists(t.name)) : tools;
    const views = listed.map((t) => toolViewAt(c.entry, t, c.row.access));
    return {
      status: 'ok',
      connection: {
        handle: c.handle,
        label: c.row.label,
        catalogId: c.row.catalogId,
        status: c.row.status,
      },
      guide: c.row.status === 'active' ? guideAt(c.entry, c.row) : needsReauthText(c.row),
      tools: views,
    };
  },

  connection_call: async (ctx, input) => {
    const { services } = ctx;
    const raw = (input.arguments ?? {}) as Record<string, unknown>;
    if (JSON.stringify(raw).length > CONNECTION_OUTPUT_MAX)
      return failed('invalid_arguments', 'The arguments are larger than 64 KB.');
    const c = await visible(ctx, input.connection);
    if (!c) return failed('unknown_connection', unknownConnectionText(input.connection));
    if (c.row.status !== 'active') return failed('needs_reauth', needsReauthText(c.row));
    // A turn on a report reaches only its own work in T3 Code, refused before T3 Code is asked anything.
    let reportArgs: Record<string, unknown> | null = null;
    const reportPlace = c.reportTurn
      ? {
          agentId: ctx.agentId,
          connectionId: c.row.id,
          conversationId: ctx.dispatch.conversationId,
          threadRootId: ctx.dispatch.threadRootId ?? null,
        }
      : null;
    if (reportPlace) {
      const row = c.row;
      // Whose review a thread is, as T3 Code says: a read of one item, never shown to the turn.
      const parentOf = async (threadId: string) =>
        subagentParentOfRead(
          await callT3(services, row, 't3_thread_read', { threadId, limit: 1, maxCharsPerItem: 1 }),
        );
      const checked = await checkReportTurnCall(
        services.db,
        reportPlace,
        input.tool,
        raw,
        parentOf,
        await strangerTextOf(services.db, ctx.dispatch.id),
      );
      if (!checked.ok) return { status: 'blocked', eventId: null, message: checked.message };
      reportArgs = checked.args;
    }
    const { tools } = await ensureTools(services, c.row);
    const tool = tools.find((t) => t.name === input.tool);
    if (!tool)
      return failed(
        'unknown_tool',
        `${c.handle} has no tool called ${input.tool}. connection_tools lists what it has.`,
      );
    let args: Record<string, unknown>;
    try {
      args =
        tool.origin === 'socket'
          ? normaliseSocketArgs(c.entry, raw, c.row.label)
          : tool.name === REQUEST_TOOL_NAME
            ? normaliseRequestArgs(raw)
            : (reportArgs ?? raw);
    } catch (err) {
      if (err instanceof ConnectionArgumentError) return failed('invalid_arguments', err.message);
      throw err;
    }
    if (c.row.catalogId === 't3code')
      args = await t3CallArgs(
        services.db,
        { agentId: ctx.agentId, dispatch: ctx.dispatch, reportTurn: c.reportTurn },
        tool.name,
        args,
      );
    const missing = missingArgsText(tool, args);
    if (missing) return failed('invalid_arguments', missing);
    // The agent settles a thread it handed work to once the job is finished; settling one still at work would stop it.
    if (c.row.catalogId === 't3code' && tool.name === 't3_thread_organize') {
      const wait = await settleRefusal(services, c.row, args);
      if (wait) return { status: 'blocked', eventId: null, message: wait };
    }
    // Off refuses before anything is signed (CX-20): a write on a connection that looks only (CS-10), the tool is off,
    // or the agent holds no key for this call.
    const grants = await loadGrants(services.db, ctx.agentId);
    const decided = callTier(
      c.entry,
      tool,
      args,
      (keyId) => keyTierOf(ctx.agentId, grants, keyId),
      c.row.access,
    );
    if (decided.lookOnly) return { status: 'blocked', eventId: null, message: lookOnlyText(c.row.label) };
    if (decided.toolTier === 'off')
      return { status: 'blocked', eventId: null, message: toolOffText(tool.name, c.row.label) };
    // The person's limits (one-whombat-devices.md ONE-DD04): outside them, refused before anything is signed.
    const outside = limitsProblem(tool.limits, args, await limitWordsFor(services.db, c.row, tool));
    if (outside) return { status: 'blocked', eventId: null, message: outside };
    // A step's turn on a report doesn't hold the one outsiders' profile while T3 Code works and another customer's turn
    // waits: Whombat takes the wait over and the turn ends (docs/decisions/outsiders-turns.md).
    if (reportPlace && tool.name === 't3_thread_wait') {
      const handed = await handWaitWhenQueued(services, ctx.dispatch, c.row, args, ctx.burrowId);
      if (handed) return { status: 'ok', content: handed, isError: false, truncated: false };
      args = slicedWaitArgs(ctx.dispatch, args);
    }
    const callId = newCallId();
    const argsEnc = services.custody.seal(callArgsAad(callId), JSON.stringify(args));
    // Where it goes and as whom now: a yes is bound to it, and the call is sent only while the connection still has it.
    const target = callTarget(c.row);
    const res = await services.pipeline.commit(
      callConnectionTool,
      {
        connectionId: c.row.id,
        handle: c.handle,
        tool: tool.name,
        toolHash: tool.hash,
        callId,
        argsEnc,
        conversationId: ctx.dispatch.conversationId,
        ...(input.change ? { change: input.change } : {}),
        target,
      },
      { burrowId: ctx.burrowId, actorId: ctx.agentId, onBehalfOf: ctx.onBehalfOf },
    );
    if (res.status === 'blocked') return { status: 'blocked', eventId: res.eventId, message: res.message };
    // The person the turn is for (one-person.md OP-S40), also in a turn no message of theirs started (a schedule).
    const person = await dispatchPerson(services.db, ctx.dispatch);
    if (res.status === 'pending_approval')
      return {
        status: 'pending_approval',
        approvalId: res.approvalId,
        approvalNumber: res.approvalNumber,
        eventId: res.eventId,
        message: pendingApprovalText(
          person ? shortName(person) : null,
          afterYesOf(callWordsFor(c.row.catalogId), tool.name, args),
        ),
      };
    const conversation = await loadConversationRow(services.db, ctx.dispatch.conversationId);
    const where = conversation
      ? conversation.kind === 'dm'
        ? 'A DM'
        : conversationLabel(conversation)
      : null;
    const result = await executeConnectionCall(services, {
      burrowId: ctx.burrowId,
      agentId: ctx.agentId,
      connectionId: c.row.id,
      tool: tool.name,
      handle: c.handle,
      callId,
      args,
      where,
      conversationId: ctx.dispatch.conversationId,
      // What follows the call (a task's end) is said in the thread the turn works in (task-feedback.md TF-04).
      threadRootId: ctx.dispatch.threadRootId ?? null,
      personId: person?.id ?? ctx.onBehalfOf.principalId ?? null,
      change: input.change ?? null,
      target,
    });
    if (result.kind === 'failed') return failed(result.reason, result.message);
    let out = result.output;
    // A report turn's thread list shows only its own threads and their reviews (OT-12).
    if (reportPlace && tool.name === 't3_thread_list' && !out.isError) {
      let body: unknown = out.structured ?? null;
      if (!body)
        try {
          body = JSON.parse(out.content);
        } catch {
          body = null;
        }
      const own = await ownThreadList(services.db, reportPlace, body);
      if (!own)
        return failed(
          'service_error',
          'T3 Code answered with a thread list Whombat can’t read, so it isn’t shown.',
        );
      out = {
        ...out,
        content: JSON.stringify(own),
        structured: own as typeof out.structured,
        truncated: false,
      };
    }
    // Work handed to T3 Code wakes the agent where it was handed over when it finishes or asks.
    if (c.row.catalogId === 't3code')
      await followT3Call(services, {
        burrowId: ctx.burrowId,
        agentId: ctx.agentId,
        connectionId: c.row.id,
        dispatch: ctx.dispatch,
        personId: person?.id ?? null,
        tool: tool.name,
        args,
        output: out,
      });
    const answer = {
      status: 'ok' as const,
      content: out.content,
      ...(out.structured && !textRepeatsStructured(out.content, out.structured)
        ? { structured: out.structured }
        : {}),
      isError: out.isError,
      truncated: out.truncated,
      ...(out.httpStatus ? { httpStatus: out.httpStatus } : {}),
    };
    // A picture the tool attached (a Mac's screen) goes to the agent as MCP image content, as browser_preview's.
    return out.image ? withImage(answer, out.image.data, out.image.mimeType) : answer;
  },
};
