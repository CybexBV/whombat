/**
 * One connection tool call (docs/decisions/connections-catalog.md CX-20, CX-21, CX-23, CX-31…CX-36).
 *
 * The call is the agent's `call_connection_tool` command, so the keys engine decides with the real catalog key
 * (`connections.read` for a read, `connections.write` otherwise) and the tier of exactly this call: the stricter of the
 * agent's key and the tool's tier, Ask whatever both say for a sensitive call (`effectiveTier`), given to the engine as
 * the only grant that counts (`KeyRequirement.grants`). Off refuses before anything is signed
 * (`toolOffText`); a key the agent doesn't hold is Blocked (a signed event); Ask creates a `connection_call` approval
 * for the person where it was asked, that binds the tool's hash and holds the arguments sealed in the deferred command
 * (never in the log). A yes runs the call once and wakes the agent with its result where it was asked to answer in its
 * own words (home-redesign.md HR-04).
 *
 * The server makes every call itself (CX-36): MCP tools through the pool, typed tools through their adapter, `request`
 * through `request.ts`. Rate limits are `/mcp`'s per-agent limit; at most 4 calls run per connection at once.
 *
 * A connection that looks only (docs/decisions/connections-setup.md CS-10) makes every write Off whatever the tiers and
 * the key (`accessTier`), refused before anything is signed with `lookOnlyText`.
 */
import {
  accessTier,
  type CatalogEntry,
  CONNECTION_CALL_WORDS_MAX,
  type ConnectionAccessLevel,
  ConnectionChangeText,
  ConversationId,
  catalogEntry,
  connectionCallKey,
  conversationLabel,
  effectiveTier,
  type Grant,
  isSensitiveCall,
  lookOnlyText,
  newId,
  requestCallTier,
  resolveMcpUrl,
  type SignInKind,
  serverAsksApply,
  type Tier,
  vaultStatusText,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { answerAfterApproval, grantedResult } from '../approvals/result';
import { approvalThread } from '../approvals/wake';
import { sendInThread } from '../commands/messages';
import { outsideCommandScope } from '../commit/scope';
import { defineCommand, type KeyRequirement } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { catalogConnections, connectionTools } from '../db/schema/index';
import { type DeviceCallContext, runDeviceTool } from '../devices/run';
import { limitWordsFor } from '../devices/store';
import { thePerson } from '../domain/the-person';
import { type CallServer, callServerOf, SERVERS_CATALOG } from '../hosts/asks';
import { approvalStartedTask } from '../hosts/followed';
import { type ApiError, conflict, forbidden, UnknownOutcomeError } from '../lib/errors';
import { ScopeNeededError } from '../mcp/client-pool';
import { loadConversationRow } from '../read/conversations';
import { loadGrants, loadPrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { VaultCallError, VaultEchoError } from '../vault/net';
import { adapterFor, callReaches, callWordsFor } from './adapters/index';
import { NOWHERE, signingOnlyAs } from './bound-targets';
import { connectionCallAccess, coversReads } from './call-access';
import {
  ConnectionChangedError,
  callTarget,
  changedSinceYesText,
  changedWhileAskedText,
} from './call-target';
import { isCallableEntry } from './callable';
import { type PreparedChange, prepareConnectionChange } from './changes';
import { keyTierOf } from './context';
import { type CallOutcome, finishConnectionTool, toolCalledFields } from './events';
import {
  CONNECTION_WITHHELD_TEXT,
  connectionDatagram,
  connectionLine,
  currentRow,
  signedConnectionFetch,
} from './http';
import { limitsProblem } from './limits';
import { connectionsFor } from './pool';
import { confirmRefusedCredential } from './refused';
import {
  type CallOutput,
  ConnectionArgumentError,
  ConnectionOutcomeUnknownError,
  type ResolveRequestUpload,
  runRequest,
} from './request';
import { runSocketCall, SocketCallError } from './socket/call';
import { askForScopes } from './step-up';
import { type CatalogConnectionRow, ConnectionAuthError, type ConnectionToolRow } from './types';

/** A call's words within the action's bound (a long command is cut with “…”). */
function clipWords(words: string): string {
  const w = words.trim();
  return w.length <= CONNECTION_CALL_WORDS_MAX
    ? w
    : `${w.slice(0, CONNECTION_CALL_WORDS_MAX - 1).trimEnd()}…`;
}

/** AAD of a call's sealed arguments (the deferred command's input holds them sealed, CX-21). */
export function callArgsAad(callId: string): string {
  return `connection_call:${callId}`;
}

/** Why a call gave no answer (`ConnectionFailure`). */
export type CallFailure =
  | 'unknown_connection'
  | 'needs_reauth'
  | 'unknown_tool'
  | 'invalid_arguments'
  | 'destination_refused'
  | 'unreachable'
  | 'timeout'
  | 'too_many_calls'
  | 'service_error'
  | 'needs_permission';

export type CallResult =
  | { kind: 'ok'; output: CallOutput }
  /** `changed`: the connection's address, account or sign-in changed since the yes the call was bound to (`target`). */
  | { kind: 'failed'; reason: CallFailure; message: string; changed?: true };

/** “Home Assistant · home.lan needs to be connected again; you can do that in Settings → Connections.” */
export function needsReauthText(row: Pick<CatalogConnectionRow, 'label'>): string {
  return `${row.label} needs you to sign in again; you can do that in Settings → Connections.`;
}

/** What decides one call: the connection, the tool, the arguments and the tier they come to. */
export interface CallPlan {
  row: CatalogConnectionRow;
  entry: CatalogEntry;
  tool: ConnectionToolRow;
  args: Record<string, unknown>;
  access: 'read' | 'write';
  keyId: 'connections.read' | 'connections.write';
  keyTier: Tier;
  toolTier: 'can' | 'ask' | 'off';
  sensitive: boolean;
  tier: 'can' | 'ask' | 'off';
  /** A write on a connection that looks only (CS-10): Off whatever else says. */
  lookOnly: boolean;
  /**
   * The server a Servers call asks about only for the sensitive rules, when setting it to Never would let the call run
   * (server-asks.md SA-07): the approval offers the person “Don’t ask again on {name}”. Null otherwise.
   */
  askServer: { id: string; name: string } | null;
  /** The server a Servers call names, with its “Asks you first” (SA-06); null for other calls or an unknown server. */
  server: CallServer | null;
}

/**
 * The tier of a call from what decides it (pure); `level` is the connection's Look only or Manage (CS-10). `server` is
 * the server a Servers call names with its “Asks you first” (server-asks.md SA-06, `callServerOf`): on Never the
 * catalog's sensitive rules don't make the call ask, but for `server_power` on the server this Whombat runs on (SA-03).
 */
export function callTier(
  entry: CatalogEntry,
  tool: Pick<ConnectionToolRow, 'name' | 'tier' | 'access' | 'origin'>,
  args: Readonly<Record<string, unknown>>,
  keyTier: Tier | ((keyId: 'connections.read' | 'connections.write') => Tier),
  level: ConnectionAccessLevel = 'manage',
  server: CallServerInfo | null = null,
): Pick<
  CallPlan,
  'access' | 'keyId' | 'keyTier' | 'toolTier' | 'sensitive' | 'tier' | 'lookOnly' | 'askServer'
> {
  const access = connectionCallAccess(entry, tool, args);
  const keyId = connectionCallKey(access);
  const held = typeof keyTier === 'function' ? keyTier(keyId) : keyTier;
  // `request` and a socket's `call` hold reads and writes in one tool: a read runs unless the tool is Off.
  const toolTier = coversReads(entry, tool) ? requestCallTier(tool.tier, access) : tool.tier;
  // A server's destructive hint doesn't ask (contracts CT-311); a read skips the rules on its arguments.
  const ruled = isSensitiveCall(entry, tool.name, args, { access });
  // A server set not to ask (SA-06) quiets the catalog's rules for its calls.
  const servers = entry.id === SERVERS_CATALOG && server !== null;
  const quiet = servers && !serverAsksApply(tool.name, server);
  // A device action its profile marks sensitive always asks too (one-whombat-devices.md).
  const sensitive = (ruled && !quiet) || tool.origin === 'device-sensitive';
  const tier = accessTier(level, access, effectiveTier(held, toolTier, sensitive));
  // Asks only for the rules, and Never would let it run (SA-07): the card may offer to stop asking there.
  const askServer =
    servers &&
    tier === 'ask' &&
    ruled &&
    tool.origin !== 'device-sensitive' &&
    accessTier(level, access, effectiveTier(held, toolTier, false)) === 'can' &&
    !serverAsksApply(tool.name, { asksFirst: 'never', hostsThisWhombat: server.hostsThisWhombat })
      ? { id: server.id, name: server.name }
      : null;
  return {
    access,
    keyId,
    keyTier: held,
    toolTier,
    sensitive,
    tier,
    lookOnly: level === 'read' && access === 'write',
    askServer,
  };
}

/** What `callTier` needs of the server a Servers call names (`CallServer` is one). */
export type CallServerInfo = Pick<CallServer, 'id' | 'name' | 'asksFirst' | 'hostsThisWhombat'>;

/** Loads and decides a call; null when the connection or the tool is gone or the agent may not use it. */
export async function planCall(
  db: Db | Tx,
  services: Services,
  agentId: string,
  input: { connectionId: string; tool: string; callId: string; argsEnc: string },
): Promise<CallPlan | null> {
  const [row] = await db
    .select()
    .from(catalogConnections)
    .where(eq(catalogConnections.id, input.connectionId));
  if (!row) return null;
  const entry = catalogEntry(row.catalogId);
  // A connection only automations use (a tracker, report-trackers.md TA-02) is never called for an agent.
  if (!entry || !isCallableEntry(entry)) return null;
  const agent = await loadPrincipalRow(db as Db, agentId);
  if (agent?.kind !== 'agent') return null;
  // The agent's own Whombat's connections only (the turn's rules are the tools').
  if (row.burrowId !== agent.burrowId) return null;
  const [tool] = await db
    .select()
    .from(connectionTools)
    .where(and(eq(connectionTools.connectionId, row.id), eq(connectionTools.name, input.tool)));
  if (!tool) return null;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(services.custody.open(callArgsAad(input.callId), input.argsEnc)) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
  const grants = await loadGrants(db as Db, agentId);
  const server = await callServerOf(db as Db, services, row.burrowId, row.catalogId, args);
  const decided = callTier(
    entry,
    tool,
    args,
    (keyId) => keyTierOf(agentId, grants, keyId),
    row.access,
    server,
  );
  return { row, entry, tool, args, server, ...decided };
}

const GRANT_TIER: Record<'can' | 'ask' | 'off', Tier> = { can: 'can', ask: 'ask', off: 'cannot' };

export const callConnectionTool = defineCommand({
  name: 'call_connection_tool',
  schema: z.object({
    connectionId: z.string().min(1).max(64),
    handle: z.string().min(1).max(40),
    tool: z.string().min(1).max(200),
    toolHash: z.string().regex(/^[0-9a-f]{64}$/),
    callId: z.string().min(1).max(64),
    /** The arguments, sealed (AAD `connection_call:<callId>`): never in the log, opened only to decide and to run. */
    argsEnc: z.string().min(1).max(200_000),
    conversationId: ConversationId.optional(),
    /** What the agent said the call changes (CT-401, home-redesign.md HR-02): a change's title when Whombat has none. */
    change: ConnectionChangeText.optional(),
    /**
     * Where the call goes and as whom when it was asked for (`callTarget`): a yes is bound to it, and the call runs only
     * while the connection still has it. Absent on a call asked before calls carried it.
     */
    target: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    /**
     * Where each other connection the call acts through went and as whom when it was asked for, by id (`callReaches`,
     * `otherTargetsOf`): the yes is bound to them too. Absent on a call asked before calls carried them.
     */
    others: z
      .record(z.string().min(1).max(64), z.string().regex(/^[0-9a-f]{64}$/))
      .refine((o) => Object.keys(o).length <= 8)
      .optional(),
  }),
  async requiredKey(input, { db, services, actor }): Promise<KeyRequirement | null> {
    const plan = await planCall(db, services, actor.id, input);
    // Gone or not this agent's to use: `apply` refuses with the reason.
    if (!plan) return null;
    const grants: Grant[] = [{ agentId: actor.id, keyId: plan.keyId, tier: GRANT_TIER[plan.tier] }];
    const conversation = input.conversationId ? await loadConversationRow(db, input.conversationId) : null;
    const room = conversation
      ? conversation.kind === 'dm'
        ? 'A DM'
        : conversationLabel(conversation)
      : null;
    const callWords = callWordsFor(plan.row.catalogId);
    const words = callWords?.ask(input.tool, plan.args) ?? null;
    const what = words ?? `use ${input.tool} on ${plan.row.label}`;
    const note = callWords?.note?.(input.tool, plan.args);
    const after = note ? ` ${note}` : '';
    return {
      keyId: plan.keyId,
      grants,
      attempt: what,
      action: {
        type: 'connection_call',
        params: {
          connectionId: plan.row.id,
          handle: input.handle,
          tool: input.tool,
          toolHash: input.toolHash,
          // The call in the server's own words (contracts 0.80.1, CT-347): the approval's title and WHAT HAPPENS say them.
          ...(words ? { words: clipWords(words) } : {}),
          // Owners may answer “Don’t ask again on {server}” (server-asks.md SA-07).
          ...(plan.askServer ? { server: plan.askServer } : {}),
        },
      },
      where: room,
      conversationId: conversation?.id ?? null,
      approval: {
        cardText: `I need your yes before I ${what}.${after}`,
        explainer: plan.sensitive
          ? plan.server
            ? `${plan.row.label} asks you before this on ${plan.server.name}. If you approve, it runs once.`
            : `${plan.row.label} always asks you before this. If you approve, it runs once.`
          : `${actor.shortName} asks before ${plan.access === 'write' ? 'changing things in' : 'reading'} ${plan.row.label}. If you approve, it runs once.`,
      },
    };
  },
  async apply(tx, ctx, input) {
    const agent = await loadPrincipalRow(tx as unknown as Db, ctx.actor.id);
    if (agent?.kind !== 'agent') throw forbidden('Only agents call connection tools.');
    const plan = await planCall(tx, ctx.services, agent.id, input);
    if (!plan) throw conflict('That connection or tool isn’t there any more.');
    if (plan.tool.hash !== input.toolHash)
      throw conflict(`${input.tool} changed since it was asked for; call it again.`);
    if (plan.row.status !== 'active') throw conflict(needsReauthText(plan.row));
    if (plan.lookOnly) throw forbidden(lookOnlyText(plan.row.label));
    if (plan.tier === 'off') throw forbidden(`${input.tool} is turned off for ${plan.row.label}.`);
    // The person's limits as they are now (one-whombat-devices.md ONE-DD04): an ask approved after they narrowed is refused.
    const outside = limitsProblem(plan.tool.limits, plan.args, await limitWordsFor(tx, plan.row, plan.tool));
    if (outside) throw forbidden(outside);
    const conversation = input.conversationId ? await loadConversationRow(tx, input.conversationId) : null;
    const where = conversation
      ? conversation.kind === 'dm'
        ? 'A DM'
        : conversationLabel(conversation)
      : null;
    const names = {
      connectionId: plan.row.id,
      tool: input.tool,
      handle: input.handle,
      label: plan.row.label,
    };
    await ctx.emit(
      toolCalledFields(
        names,
        {
          callId: input.callId,
          access: plan.access,
          tier: plan.tier,
          deferred: ctx.approvalId !== null,
          toolHash: input.toolHash,
        },
        where,
      ),
    );
    await tx
      .update(catalogConnections)
      .set({ lastUsedAt: ctx.now })
      .where(eq(catalogConnections.id, plan.row.id));
    if (ctx.approvalId) {
      // Approved after asking: the call runs once, after this commit, and the agent is woken with its result where it
      // was asked (chat-asks.md CA-01; HR-04). This commit's `connection.tool_called` is the call's saved intent, and the
      // call is a required continuation: how it went is how the approval ends (succeeded, failed or uncertain), never a
      // success for a call that didn't get through.
      const postIn = conversation?.id ?? null;
      const personId = ctx.onBehalfOf.principalId ?? (await thePerson(tx, ctx.burrow.id))?.id ?? null;
      const services = ctx.services;
      const burrowId = ctx.burrow.id;
      const approvalId = ctx.approvalId;
      ctx.complete(() =>
        runDeferredConnectionCall(services, {
          burrowId,
          agentId: agent.id,
          connectionId: plan.row.id,
          tool: input.tool,
          handle: input.handle,
          callId: input.callId,
          args: plan.args,
          where,
          postIn,
          conversationId: conversation?.id ?? null,
          personId,
          approvalId,
          ...(input.change ? { change: input.change } : {}),
          ...(input.target ? { target: input.target } : {}),
          ...(input.others ? { others: input.others } : {}),
        }),
      );
    }
    return { callId: input.callId, deferred: ctx.approvalId !== null };
  },
});

/** A failure in our own words (never the remote side's), and its outcome for the log. */
export function failureOf(err: unknown): { reason: CallFailure; message: string; outcome: CallOutcome } {
  if (err instanceof ConnectionChangedError)
    return { reason: 'destination_refused', message: err.message, outcome: 'refused' };
  if (err instanceof ConnectionOutcomeUnknownError)
    return { reason: 'timeout', message: err.message, outcome: 'timeout' };
  if (err instanceof ConnectionArgumentError)
    return { reason: 'invalid_arguments', message: err.message, outcome: 'refused' };
  if (err instanceof ConnectionAuthError)
    return {
      reason: 'needs_reauth',
      message: 'The connection’s sign-in was refused; it needs signing in again in Settings → Connections.',
      outcome: 'failed',
    };
  if (err instanceof VaultEchoError)
    return { reason: 'service_error', message: CONNECTION_WITHHELD_TEXT, outcome: 'refused' };
  // A socket's failure in our own words (CM-14): the service's own never.
  if (err instanceof SocketCallError)
    return {
      reason: err.reason === 'unreachable' ? 'unreachable' : 'service_error',
      message: err.message,
      outcome: 'failed',
    };
  if (err instanceof VaultCallError) {
    if (err.status === 401 && err.message === 'needs_reauth')
      return {
        reason: 'needs_reauth',
        message: 'The connection’s sign-in was refused; it needs signing in again in Settings → Connections.',
        outcome: 'failed',
      };
    switch (err.reason) {
      case 'timeout':
        return { reason: 'timeout', message: 'It didn’t answer within 30 seconds.', outcome: 'timeout' };
      case 'not_allowed':
        return {
          reason: 'destination_refused',
          message: 'This connection’s address isn’t allowed any more. Check the home-network list.',
          outcome: 'refused',
        };
      case 'unreachable':
        return { reason: 'unreachable', message: 'Couldn’t reach it.', outcome: 'failed' };
      case 'too_large':
        return { reason: 'service_error', message: 'Its answer was too large.', outcome: 'failed' };
      default:
        return {
          reason: 'service_error',
          message: err.status ? vaultStatusText(err.status) : 'The service didn’t answer as expected.',
          outcome: 'failed',
        };
    }
  }
  return { reason: 'service_error', message: 'The call failed on our side.', outcome: 'failed' };
}

/**
 * The other connections of the burrow a call of `tool` on `row` acts through as well (`callReaches`: a Servers backup
 * place on a TrueNAS), as they are stored now by id; null for one that isn't there (the tool refuses it).
 */
export async function reachedConnections(
  services: Services,
  row: Pick<CatalogConnectionRow, 'id' | 'burrowId' | 'catalogId'>,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<Map<string, CatalogConnectionRow | null>> {
  const out = new Map<string, CatalogConnectionRow | null>();
  for (const id of callReaches(row.catalogId, tool, args)) {
    if (id === row.id || out.has(id)) continue;
    const other = await currentRow(services, id);
    out.set(id, other && other.burrowId === row.burrowId ? other : null);
  }
  return out;
}

/** Where each other connection a call acts through goes and as whom now (`callTarget`), by id: what its yes binds. */
export async function otherTargetsOf(
  services: Services,
  row: Pick<CatalogConnectionRow, 'id' | 'burrowId' | 'catalogId'>,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [id, other] of await reachedConnections(services, row, tool, args))
    if (other) out[id] = callTarget(other);
  return out;
}

/**
 * The first other connection a call acts through that isn't where, or as whom, it was when the call was asked for: one
 * whose target changed, or one that is there now and wasn't then. Null when none changed.
 */
function changedOther(
  reached: ReadonlyMap<string, CatalogConnectionRow | null>,
  others: Readonly<Record<string, string>>,
): CatalogConnectionRow | null {
  for (const [id, now] of reached) {
    if (!now) continue;
    const was = others[id];
    if (was === undefined || callTarget(now) !== was) return now;
  }
  return null;
}

/** Runs an allowed call against the service and records how it went (`connection.tool_finished`). */
export async function executeConnectionCall(
  services: Services,
  call: {
    burrowId: string;
    agentId: string;
    connectionId: string;
    tool: string;
    handle: string;
    callId: string;
    args: Record<string, unknown>;
    where: string | null;
    /** The chat it was asked in, and the person it is for (a device action's change names them, ONE-08). */
    conversationId?: string | null;
    personId?: string | null;
    /** The thread of that chat where what follows is said (task-feedback.md TF-04); null or absent: none. */
    threadRootId?: string | null;
    /** What the agent said the call changes (`connection_call`'s `change`, HR-02). */
    change?: string | null;
    /** The approval whose yes runs it (a task it starts is known by it, task-feedback.md TF-10). */
    approvalId?: string | null;
    /** Optional resolver for authorized multipart attachment uploads in `request` calls. */
    uploadAttachment?: ResolveRequestUpload;
    /**
     * Where the call may go and as whom (`callTarget`), as it was when it was asked for or said yes to: checked on the
     * connection the request is made with, and nothing is sent when it differs.
     */
    target?: string;
    /**
     * The same for each other connection the call acts through, by id (`otherTargetsOf` when it was asked for). Absent
     * on a call asked before calls carried them: each is then signed only as it is when the call starts.
     */
    others?: Readonly<Record<string, string>>;
  },
): Promise<CallResult> {
  const started = Date.now();
  const row = await currentRow(services, call.connectionId);
  const entry = row ? catalogEntry(row.catalogId) : null;
  if (!row || !entry)
    return { kind: 'failed', reason: 'unknown_connection', message: 'That connection is gone.' };
  const [tool] = await services.db
    .select()
    .from(connectionTools)
    .where(and(eq(connectionTools.connectionId, row.id), eq(connectionTools.name, call.tool)));
  if (!tool) return { kind: 'failed', reason: 'unknown_tool', message: `${call.tool} isn’t there any more.` };
  const service = connectionsFor(services);
  let result: CallResult;
  let outcome: CallOutcome;
  let bytes = 0;
  let prepared: PreparedChange | null = null;
  // The other connections the call acts through, each bound to where it went when the call was asked for (or, for a
  // call asked before calls carried them, where it goes now): it signs as each only there.
  const reached = await reachedConnections(services, row, call.tool, call.args);
  const others = call.others;
  const bound: Record<string, string> = call.target !== undefined ? { [row.id]: call.target } : {};
  for (const [id, now] of reached)
    bound[id] = others ? (others[id] ?? NOWHERE) : now ? callTarget(now) : NOWHERE;
  // What a change the call records keeps of where the other connections went (`withDestination`).
  const kept = Object.fromEntries(
    Object.entries(bound).filter(([id, target]) => id !== row.id && target !== NOWHERE),
  );
  const changedLabel = (id: string | undefined) =>
    (id && id !== row.id ? reached.get(id)?.label : undefined) ?? row.label;
  const changedText = (label: string) =>
    call.approvalId ? changedSinceYesText(label) : changedWhileAskedText(label);
  const otherChanged = call.target !== undefined && others ? changedOther(reached, others) : null;
  if ((call.target !== undefined && callTarget(row) !== call.target) || otherChanged) {
    // Asked for, or said yes to, while the connection, or another it acts through, went elsewhere or as someone else:
    // checked on the very rows the requests would be made with, and nothing is sent (the agent that asked hears it and
    // may ask again).
    result = {
      kind: 'failed',
      reason: 'destination_refused',
      message: changedText(otherChanged && callTarget(row) === call.target ? otherChanged.label : row.label),
      changed: true,
    };
    outcome = 'refused';
  } else if (!service.acquire(row.id)) {
    result = {
      kind: 'failed',
      reason: 'too_many_calls',
      message: 'Too many calls to this connection at once. Try again in a moment.',
    };
    outcome = 'busy';
  } else {
    try {
      const { value, refused: changed } = await signingOnlyAs(bound, async () => {
        // A write that works becomes a change on Done recently, with its inverse where Whombat knows one (ONE-08): the
        // old state is read first, with the connection's own tools.
        const change = await prepareConnectionChange(
          services,
          row,
          entry,
          tool,
          call.args,
          (name, args) => readForChange(services, row, entry, name, args),
          call.change,
        ).catch(() => null);
        return {
          change,
          output: await runTool(services, row, entry, tool, call.args, { ...call, others: kept }),
        };
      });
      prepared = value.change;
      const output = value.output;
      // A write's HTTP response confirms completion only in the 2xx range, including for typed adapters.
      const status = output.httpStatus;
      if (
        status !== undefined &&
        (status < 200 || status >= 300) &&
        connectionCallAccess(entry, tool, call.args) !== 'read'
      )
        output.isError = true;
      // A tool that answered in its own words for a connection refused as changed (a TrueNAS that “didn’t answer”):
      // it changed, and nothing was signed as it.
      if (changed && output.isError) throw new ConnectionChangedError(changed);
      result = { kind: 'ok', output };
      outcome = output.isError ? 'error' : 'done';
      bytes = output.bytes;
      if (output.httpStatus === 401) refused(services, row.id);
    } catch (err) {
      if (err instanceof VaultCallError && err.status === 401 && err.message !== 'needs_reauth')
        refused(services, row.id);
      // The service wants the person to allow more for this (step-up): asked on a card, or said to the agent.
      const needs = err instanceof ScopeNeededError && row.signIn === 'mcp_oauth' ? err.scopes : null;
      const failure = needs
        ? {
            reason: 'needs_permission' as const,
            message: await askForScopes(services, row, entry, needs, call).catch(
              () => 'The service needs more permission for this. Tell the person.',
            ),
            outcome: 'refused' as const,
          }
        : failureOf(err);
      if (
        failure.reason === 'service_error' &&
        !(err instanceof VaultCallError) &&
        !(err instanceof VaultEchoError)
      )
        services.log.error(
          { err: err instanceof Error ? err.name : 'error', tool: 'connection' },
          'connection call failed',
        );
      result =
        err instanceof ConnectionChangedError
          ? {
              // The stored connection went elsewhere or as someone else after it was checked here: nothing was signed
              // with what it holds now, so nothing was sent (the agent that asked hears it and may ask again).
              kind: 'failed',
              reason: failure.reason,
              message: changedText(changedLabel(err.connectionId)),
              changed: true,
            }
          : { kind: 'failed', reason: failure.reason, message: failure.message };
      outcome = failure.outcome;
      // An answer that echoed the credential, or a session opened as the connection before it changed: the pooled
      // client goes, the next call reconnects.
      if (err instanceof VaultEchoError || err instanceof ConnectionChangedError) await service.evict(row.id);
    } finally {
      service.release(row.id);
    }
  }
  await services.pipeline
    .commit(
      finishConnectionTool,
      {
        callId: call.callId,
        connectionId: row.id,
        tool: call.tool.slice(0, 200),
        handle: call.handle.slice(0, 40),
        label: row.label.slice(0, 80),
        outcome,
        ms: Date.now() - started,
        bytes,
        where: call.where,
        ...(prepared && outcome === 'done'
          ? {
              change: {
                title: prepared.title,
                ...(prepared.detail ? { detail: prepared.detail } : {}),
                ...(prepared.undo ? { undo: prepared.undo } : {}),
                conversationId: call.conversationId ?? null,
              },
            }
          : {}),
      },
      { burrowId: call.burrowId, actorId: call.agentId },
    )
    .catch((err: unknown) =>
      services.log.warn(
        { err: err instanceof Error ? err.name : 'error' },
        'could not record a connection call',
      ),
    );
  return result;
}

/**
 * The service refused the connection's credential (401): the connect side checks it with the entry's check and marks it
 * `needs_reauth` when the check is refused too (`confirmRefusedCredential`), in the background.
 */
function refused(services: Services, connectionId: string): void {
  // Not part of the call's session command (CS-07): it signs its own change, if any.
  services.guides.track('connection refused', () =>
    outsideCommandScope(() => confirmRefusedCredential(services, connectionId)),
  );
}

/**
 * A read for a person's own view (a widget's refresh, one-whombat.md ONE-09): the tool runs as a call would, in one of
 * the connection's call slots, but with no agent and no tool events — the person reads what they may see anyway. Refuses
 * a write. Throws `ConnectionArgumentError` / `VaultCallError` as a call does; `null` when the slots are full.
 */
export async function runConnectionRead(
  services: Services,
  row: CatalogConnectionRow,
  entry: CatalogEntry,
  tool: ConnectionToolRow,
  args: Record<string, unknown>,
): Promise<CallOutput | null> {
  if (connectionCallAccess(entry, tool, args) !== 'read')
    throw new ConnectionArgumentError(`${tool.name} changes things, so it can’t feed a widget.`);
  const service = connectionsFor(services);
  if (!service.acquire(row.id)) return null;
  try {
    return await runTool(services, row, entry, tool, args);
  } finally {
    service.release(row.id);
  }
}

/** A read of the connection's own tool for a change's old state (a missing tool reads as an error). */
async function readForChange(
  services: Services,
  row: CatalogConnectionRow,
  entry: CatalogEntry,
  name: string,
  args: Record<string, unknown>,
): Promise<CallOutput> {
  const [tool] = await services.db
    .select()
    .from(connectionTools)
    .where(and(eq(connectionTools.connectionId, row.id), eq(connectionTools.name, name)));
  if (!tool) return { content: '', isError: true, truncated: false, bytes: 0 };
  return runTool(services, row, entry, tool, args);
}

/** One tool of a connection, by where it came from. */
async function runTool(
  services: Services,
  row: CatalogConnectionRow,
  entry: CatalogEntry,
  tool: ConnectionToolRow,
  args: Record<string, unknown>,
  /** Who the call is for: a device action records its change with it (a read for a change or a widget has none). */
  call?: DeviceCallContext & {
    threadRootId?: string | null;
    approvalId?: string | null;
    uploadAttachment?: ResolveRequestUpload;
    others?: Readonly<Record<string, string>>;
  },
): Promise<CallOutput> {
  // Every transport signs only while the stored connection still goes where `row`'s calls go and as whom: a refresh, a
  // new sign-in or a pooled session reads it again, and a token, account or address replaced since sends nothing.
  const target = callTarget(row);
  if (tool.origin === 'request')
    return runRequest(services, row, entry, args, {
      target,
      ...(call?.uploadAttachment ? { uploadAttachment: call.uploadAttachment } : {}),
    });
  // A socket's `call`: one method over the service's socket (docs/decisions/connections-more.md CM-14).
  if (tool.origin === 'socket') return runSocketCall(services, row, entry, args, target);
  // A device's tools run its profile through the built-in drivers (one-whombat.md ONE-16).
  if (tool.origin === 'device' || tool.origin === 'device-sensitive')
    return runDeviceTool(services, row, tool, args, call);
  if (tool.origin === 'adapter') {
    const adapter = adapterFor(row.catalogId);
    const run = adapter?.[tool.name];
    if (!run) throw new ConnectionArgumentError(`${tool.name} isn’t available on this connection.`);
    return run(
      {
        baseUrl: row.baseUrl.replace(/\/+$/, ''),
        fields: row.fields,
        bases: entry.request?.bases ?? {},
        send: (req, options) =>
          signedConnectionFetch(services, row, req, {
            target,
            ...(options?.truncateAt !== undefined ? { truncateAt: options.truncateAt } : {}),
          }),
        datagram: (port, payload) => connectionDatagram(services, row, port, payload),
        line: (port, command, idempotent) => connectionLine(services, row, port, command, idempotent),
        // A callable builtin acts as the agent (the Servers tools, one-whombat-servers.md ONE-DH14).
        ...(call
          ? {
              call: {
                services,
                burrowId: call.burrowId,
                agentId: call.agentId,
                connectionId: row.id,
                callId: call.callId,
                conversationId: call.conversationId ?? null,
                threadRootId: call.threadRootId ?? null,
                personId: call.personId ?? null,
                approvalId: call.approvalId ?? null,
                target,
                ...(call.others ? { others: call.others } : {}),
              },
            }
          : {}),
      },
      args,
    );
  }
  const url = resolveMcpUrl(entry, row.fields, row.signIn as SignInKind);
  if (!url) throw new ConnectionArgumentError('This connection has no MCP server.');
  const service = connectionsFor(services);
  const res = await service.pool.call(service.target(row, url), tool.name, args);
  if (res.scopeNeeded) throw new ScopeNeededError(res.scopeNeeded);
  return {
    content: res.text,
    ...(res.structured ? { structured: res.structured as CallOutput['structured'] } : {}),
    isError: res.isError,
    truncated: res.truncated,
    bytes: res.bytes,
  };
}

/** What the approval says when an approved call broke before it reached the service. */
const CALL_NOT_STARTED_TEXT =
  'Whombat couldn’t start it, so nothing happened. Undo and Approve to try again.';

/** What the approval says when the service didn't answer in time: the change may have been made. */
const CALL_UNANSWERED_TEXT =
  'It didn’t answer in time, so it may or may not have happened. Check, then Undo and Approve to try again.';

/** How an approved call's result ends its approval: null when it worked, else the error the approval fails with. */
function approvalFailureOf(result: CallResult): ApiError | null {
  if (result.kind === 'ok')
    return result.output.isError ? conflict('The service said it couldn’t do it.') : null;
  // A request that went out and got no answer may still have changed something: honest, never “nothing happened”.
  if (result.reason === 'timeout') return new UnknownOutcomeError(CALL_UNANSWERED_TEXT);
  return conflict(result.message);
}

/** An approved call, as its approval runs it. */
interface DeferredCall {
  burrowId: string;
  agentId: string;
  connectionId: string;
  tool: string;
  handle: string;
  callId: string;
  args: Record<string, unknown>;
  where: string | null;
  postIn: string | null;
  conversationId?: string | null;
  personId?: string | null;
  approvalId: string | null;
  change?: string;
  /** Where the call may go and as whom (`callTarget`), as it was when it was asked for. */
  target?: string;
  /** The same for each other connection it acts through, by id. */
  others?: Readonly<Record<string, string>>;
}

/**
 * A call a person approved: it runs once (CX-21, BP-D14), and the agent that asked is woken with its result where it
 * asked, to tell them in its own words (home-redesign.md HR-04); with nobody to wake, one plain line is posted (a
 * builtin's own words when it has them, ONE-DH21). A call that started a followed task says nothing now: its card is in
 * the thread and the agent is woken when it ends (task-feedback.md TF-10, TF-12). Only where the agent can't carry on
 * (the server this Whombat runs on goes down with the call) does a builtin say what happened itself (TF-S10). All of it
 * goes in the approval card's thread (TF-04). Then the approval ends as the call did (`approvalFailureOf`): this throws
 * for a call that failed or may not have happened, and the engine records that on the approval.
 */
async function runDeferredConnectionCall(services: Services, call: DeferredCall): Promise<readonly string[]> {
  const threadRootId =
    call.postIn && call.approvalId
      ? await approvalThread(services.db, call.approvalId, call.postIn).catch(() => null)
      : null;
  let result: CallResult;
  try {
    result = await executeConnectionCall(services, {
      ...call,
      conversationId: call.postIn,
      threadRootId,
    });
  } catch (err) {
    // It throws only before the service is called (the call's own failures come back as a result).
    services.log.error(
      { err: err instanceof Error ? err.name : 'error', tool: 'connection' },
      'approved connection call could not start',
    );
    result = { kind: 'failed', reason: 'service_error', message: CALL_NOT_STARTED_TEXT };
  }
  // Telling the agent can fail on its own; the call has run (or not) either way, and the approval says which.
  if (call.postIn)
    await tellAfterCall(services, { ...call, postIn: call.postIn }, threadRootId, result).catch(
      (err: unknown) =>
        services.log.warn(
          { err: err instanceof Error ? err.name : 'error' },
          'could not answer after a connection call',
        ),
    );
  const failure = approvalFailureOf(result);
  if (failure) throw failure;
  return [];
}

/** The agent that asked is woken with an approved call's result, or a builtin's own words are posted. */
async function tellAfterCall(
  services: Services,
  call: DeferredCall & { postIn: string },
  threadRootId: string | null,
  result: CallResult,
): Promise<void> {
  // A task it started has its card in that thread, and the agent is woken when it ends (task-feedback.md TF-10, TF-12).
  if (call.approvalId && (await approvalStartedTask(services.db, call.approvalId).catch(() => false))) return;
  const row = await currentRow(services, call.connectionId).catch(() => null);
  const words = row ? callWordsFor(row.catalogId) : null;
  const own =
    words?.done?.(
      call.tool,
      call.args,
      result.kind === 'ok'
        ? { ok: true, isError: result.output.isError, content: result.output.content }
        : { ok: false, message: result.message },
    ) ?? null;
  // Whombat's own words instead of the agent's only where the agent can't carry on after it: the server this Whombat
  // runs on goes down with it (task-feedback.md TF-S10).
  if (own && words?.saysItself?.(call.tool, call.args)) {
    await sendInThread(services, {
      burrowId: call.burrowId,
      actorId: call.agentId,
      conversationId: call.postIn,
      threadRootId,
      text: own.slice(0, 3000),
    }).catch((err: unknown) =>
      services.log.warn(
        { err: err instanceof Error ? err.name : 'error' },
        'could not post a connection call result',
      ),
    );
    return;
  }
  await answerAfterApproval(services, {
    burrowId: call.burrowId,
    agentId: call.agentId,
    approvalId: call.approvalId,
    postIn: call.postIn,
    threadRootId,
    result:
      result.kind === 'ok'
        ? grantedResult(
            result.output.isError ? 'error' : 'done',
            result.output.content,
            result.output.truncated,
          )
        : grantedResult('failed', result.message),
    // When it can't be woken there, a builtin's own words say what happened (ONE-DH21).
    fallback: own ? own.slice(0, 3000) : null,
  });
}

/** A new call id (the event-id shape, like pack calls). */
export function newCallId(): string {
  return newId('event');
}

export const CONNECTION_CALL_COMMANDS = [callConnectionTool, finishConnectionTool];
