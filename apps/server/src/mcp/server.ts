import { hasCustomConnection } from '../connections/look';
import { providerMode } from '../connectors/providers';
import { councilConnection } from '../council/run';
/**
 * The Whombat MCP server at `/mcp` (ARCHITECTURE A-07): streamable HTTP, stateless (one MCP server +
 * transport per HTTP request, JSON responses), bearer = the per-dispatch agent token (`wat_…`) the runner
 * got on claim. Tools are every `MCP_TOOLS` entry in core, advertised with core's JSON Schemas; outputs are
 * `commitOutcome()` unions returned as `structuredContent` (no `outputSchema`: MCP wants an object schema
 * and ours are unions — see core-contracts.md). Calls are rate-limited per agent and per dispatch, and each one is an
 * activity row of its dispatch, from the outcome the server gave (`runtime/activity-mcp.ts`).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { ASSESSOR_TOOLS } from '@whombat/agent-runtime/feedback';
import {
  ARTIFACT_MAX_BYTES,
  type ConnectorProvider,
  type ErrorCode,
  FEEDBACK_ONLY_TOOL_NAMES,
  MCP_PATH,
  MCP_POSTING_TOOLS,
  MCP_SERVER_NAME,
  MCP_TOOLS,
  type McpToolName,
  mcpToolConnector,
  mcpToolPersonalOnly,
  TRACKER_RUN_TOOL_NAMES,
  VAULT_SELF_SERVE_TOOL_NAMES,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { commandsTurn } from '../agent-commands/context';
import { type AgentAuth, slideAgentToken, verifyAgentToken } from '../auth/agent-tokens';
import { bearerOf } from '../auth/request';
import { assessesInTurn, NOT_AN_ASSESSMENT } from '../automations/assessment';
import { NOT_PROPOSING_ACTIONS, proposesInTurn } from '../automations/proposed-actions';
import { HANDED_TURN_ENDED } from '../automations/turn-waits';
import { seesActiveConnection } from '../connections/context';
import { personalAccess, usableServices } from '../connectors/access';
import { connectionsForAgent } from '../connectors/lookup';
import { dispatches, repos, runs } from '../db/schema/index';
import { beforeTool } from '../github/visibility';
import { NOT_PERSONAL_GUIDE_TEXT } from '../guides/commands';
import { ApiError, zodFields } from '../lib/errors';
import { looksInTurn, NOT_A_LOOK } from '../looks/research';
import {
  AHEAD_TOOL_REFUSED,
  aheadThreadOf,
  aheadToolRan,
  aheadToolRefusal,
  NOT_AN_AHEAD_CHECK,
  NOT_AN_AHEAD_THREAD,
} from '../looks-ahead/turn';
import { loadPrincipalRow, type PrincipalRow } from '../read/principals';
import { withToolActivity } from '../runtime/activity-mcp';
import { type DispatchRow, dispatchCheckout } from '../runtime/context';
import { dispatchScopeOf, runInDispatchScope } from '../runtime/dispatch-scope';
import { outsidersTurn } from '../runtime/person';
import type { Services } from '../services';
import { teamReportsOffered } from '../team-reports/tool';
import { NOT_A_TRACKER_TURN, trackerToolsInTurn } from '../trackers/access';
import { vaultToolList } from '../vault/context';
import { imageOf } from './image';
import {
  loadSelection,
  OPTIONAL_EXECUTOR_ACTION_TYPES,
  type SelectionLoaders,
  type ServedSelection,
  servedTools,
  servesToolLazily,
  type TurnShape,
  toolEntry,
} from './served';
import { isToolName, onBehalfOf, outsideToolText, TOOL_HANDLERS, type ToolContext } from './tools';

export const MCP_SERVER_VERSION = '1.0.0';

/** Room for one `upload_file` call: the artifact as base64 plus the JSON-RPC envelope. */
export const MCP_BODY_LIMIT = Math.ceil(ARTIFACT_MAX_BYTES / 3) * 4 + 1024 * 1024;

/**
 * What decides the tools a turn is served (PE-05): a personal agent, a search answer, a turn that reports on a run (a
 * run turn, or one with a writable checkout, which starts its run and reports in the same turn). Without a live
 * dispatch of this agent: a chat turn.
 */
async function turnShape(
  services: Services,
  agentId: string,
  dispatch: DispatchRow | undefined,
  agent: PrincipalRow | undefined,
  personal: boolean,
): Promise<TurnShape> {
  // The agent does all the work (one-agent.md OA-01; assistant-name.md AN-10).
  const teamWork = agent?.kind === 'agent';
  const code = agent ? codeWorkPossible(services, agent.burrowId) : Promise.resolve(true);
  if (!dispatch || dispatch.agentId !== agentId)
    return { personal, answer: false, run: false, teamWork, code: await code };
  const answer = dispatch.mode === 'answer' || dispatch.search !== null;
  const [canCode, run] = await Promise.all([
    code,
    (async () =>
      (!personal || teamWork) &&
      !answer &&
      (dispatch.mode === 'run' ||
        dispatch.runId !== null ||
        (await dispatchCheckout(services.db, dispatch))?.access === 'write' ||
        (await startedRun(services, dispatch.id))))(),
  ]);
  return {
    personal,
    answer,
    run,
    teamWork,
    code: canCode || run,
    outside: outsidersTurn(dispatch),
    ...(dispatch.trigger === 'ahead' ? { ahead: true } : {}),
  };
}

/**
 * Whether the turn started a run itself (`start_run`): it may report on it and finish it there (run-checkout.md RC-03),
 * so the run tools it is served from then on are also the ones it may call.
 */
async function startedRun(services: Services, dispatchId: string): Promise<boolean> {
  const [row] = await services.db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.dispatchId, dispatchId))
    .limit(1);
  return row !== undefined;
}

/**
 * Whether the burrow can do code work (turn-overhead.md TO-03): a repository is switched on for agents, or GitHub is
 * connected (`gh repo create` makes one there and switches it on, AGH-19). Without either there is nothing to run,
 * review, merge or deploy: a repository created on the Whombat is a person's doing (repositories.md RP-04).
 */
async function codeWorkPossible(services: Services, burrowId: string): Promise<boolean> {
  const [on] = await services.db
    .select({ id: repos.id })
    .from(repos)
    .where(and(eq(repos.burrowId, burrowId), eq(repos.enabled, true)))
    .limit(1);
  if (on) return true;
  return services.github.adapter !== null && (await services.github.isConnected(burrowId));
}

/**
 * What a Whombat Feedback assessment may list and call (feedback.md FB-21): the assessor's four tools. Its look at the
 * reported website is Hermes's browser (hermes-engine.md HE-S140).
 */
async function assessmentTools(
  _services: Services,
  _dispatch: DispatchRow | undefined,
): Promise<McpToolName[]> {
  return [...ASSESSOR_TOOLS];
}

/** Tools nobody but an assessment calls (FB-21): the assessor's own. */
const ASSESSMENT_ONLY_TOOLS: readonly McpToolName[] = FEEDBACK_ONLY_TOOL_NAMES;

/** Whether a dispatch is a Whombat Feedback assessment (feedback.md FB-21): its tools are restricted. */
function isAssessment(dispatch: DispatchRow | undefined): boolean {
  return dispatch?.trigger === 'feedback';
}

/** Whether the turn is an automation's own step (automation-chat.md). */
function automationStepTurn(dispatch: DispatchRow | undefined): boolean {
  return dispatch?.trigger === 'automation';
}

/** The person's connection providers whose services a turn may be served (connectors.md “Tools”). */
const SERVED_PROVIDERS = ['google', 'microsoft', 'imap'] as const satisfies readonly ConnectorProvider[];

/** A loader that runs once, the first time it is asked, and gives every later caller the same answer. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let loaded: Promise<T> | undefined;
  return () => {
    loaded ??= load();
    return loaded;
  };
}

/**
 * What one MCP request knows about its turn: the dispatch row, the agent and the parts of the selection built on them,
 * each read from the database once and only when it is first asked for. It lives for that request alone, so what a
 * turn is served is always read fresh.
 */
function turnFacts(services: Services, agentId: string, dispatchId: string | undefined) {
  const db = services.db;
  const dispatch = once(async (): Promise<DispatchRow | undefined> => {
    if (!dispatchId) return undefined;
    const [row] = await db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
    return row;
  });
  const agent = once(() => loadPrincipalRow(db, agentId));
  // The person's account; none in an outsiders' turn (one-person.md OP-S51).
  const account = once(async () => (await dispatch())?.onBehalfOfAccountId ?? null);
  const turn = once(async () => {
    const [row, agentRow, accountId] = await Promise.all([dispatch(), agent(), account()]);
    // The person's turn (one-person.md OP-S41): their guides and devices are served, whatever they connected.
    return turnShape(services, agentId, row, agentRow, accountId !== null);
  });
  const tracker = once(() => trackerToolsInTurn(db, agentId, dispatchId));
  const load: SelectionLoaders = {
    turn,
    // The person's connections; none in an outsiders' turn.
    usable: once(async () => {
      const [agentRow, accountId] = await Promise.all([agent(), account()]);
      const found = await connectionsForAgent(db, agentId, SERVED_PROVIDERS, accountId, agentRow);
      return [
        ...new Set(
          SERVED_PROVIDERS.flatMap((p) => usableServices(found.get(p) ?? null, providerMode(services, p))),
        ),
      ];
    }),
    browser: once(async () => {
      const [row, agentRow] = await Promise.all([dispatch(), agent()]);
      return browserServed(agentId, row, agentRow);
    }),
    connections: once(async () => {
      const [row, agentRow] = await Promise.all([dispatch(), agent()]);
      return seesActiveConnection(db, agentId, row, agentRow);
    }),
    assesses: once(() => assessesInTurn(db, agentId, dispatchId)),
    proposes: once(async () => {
      const row = await dispatch();
      return row?.trigger === 'automation' && row.agentId === agentId
        ? proposesInTurn(db, agentId, dispatchId)
        : false;
    }),
    looks: once(() => looksInTurn(db, agentId, dispatchId)),
    aheadThread: once(async () => {
      const row = await dispatch();
      return !!row && row.agentId === agentId && (await aheadThreadOf(db, row)) !== null;
    }),
    tracker,
    unavailableActions: async () =>
      OPTIONAL_EXECUTOR_ACTION_TYPES.filter((t) => !services.approvals.hasExecutor(t)),
    automationStep: once(async () => automationStepTurn(await dispatch())),
    council: once(async () => {
      const agentRow = await agent();
      return !!agentRow && !!(await councilConnection(db, agentRow.burrowId));
    }),
    customConnections: once(async () => {
      const agentRow = await agent();
      return !!agentRow && (await hasCustomConnection(db, agentRow.burrowId));
    }),
    teamReports: once(async () => {
      const agentRow = await agent();
      return !!agentRow && (await teamReportsOffered(services, agentRow.burrowId));
    }),
  };
  const assessment = once(async () => {
    const row = await dispatch();
    return isAssessment(row) ? assessmentTools(services, row) : null;
  });
  // The Vault's own: saving and adding servers in a person's own turns (vault-self-serve.md VS-12), never an outsiders'
  // or a Looks ahead check's.
  const vault = once(async () => {
    const [shape, tools] = await Promise.all([turn(), vaultToolList(db, agentId, dispatchId)]);
    return shape.outside || shape.ahead ? [] : tools;
  });
  return {
    dispatch,
    account,
    tracker,
    /** A Whombat Feedback assessment's tools (feedback.md FB-21), or null for any other turn. */
    assessment,
    /** The served list (`tools/list`). */
    async list(): Promise<Tool[]> {
      const assessing = await assessment();
      if (assessing) return assessing.map((name) => toolEntry(name));
      // The pure selection (`servedTools`, mcp/served.ts; turn-efficiency.md TE-05), then the Vault's.
      const [selection, vaultTools] = await Promise.all([loadSelection(load), vault()]);
      return [...servedTools(selection), ...vaultTools];
    },
    /** Whether the served list has `name`, reading only what the rules need for it. */
    async serves(name: McpToolName): Promise<boolean> {
      const assessing = await assessment();
      if (assessing) return assessing.includes(name);
      if ((VAULT_SELF_SERVE_TOOL_NAMES as readonly string[]).includes(name))
        return (await vault()).some((tool) => tool.name === name);
      return servesToolLazily(name, load);
    },
  };
}

/**
 * The advertised tool list (names, titles, descriptions, input JSON Schemas, read-only hints): Whombat's own
 * tools, plus the connector tools (`MCP_TOOLS[n].connector`) of the services the person connected
 * (docs/decisions/connectors.md "Tools"). A Whombat Feedback assessment (`dispatchId` with trigger `feedback`) sees
 * exactly `FEEDBACK_DISPATCH_TOOLS`; no other dispatch sees the assessor's own tools. Any other outsiders' turn sees only
 * `OUTSIDERS_TOOLS` (docs/decisions/outsiders-turns.md). Only what the turn can use (prompt-efficiency.md PE-05,
 * `toolFitsTurn`): `post_answer` in search answers, the run reports in turns on a run, no runs or pull requests for a
 * personal agent, and the personal actions of `request_approval` / `perform_action` only in the person's turn, for a
 * service they connected. This list is also what the turn may call (`callTool`).
 */
export async function mcpToolList(services: Services, agentId: string, dispatchId?: string): Promise<Tool[]> {
  return turnFacts(services, agentId, dispatchId).list();
}

/**
 * The answer to a tool the turn isn't served, which never runs: a connector tool's own refusal with what would fix it
 * (“Mara hasn’t connected Google Calendar. …”; for an outsiders' turn, that mail, calendar and files aren't used there),
 * from the access check alone; the assessment tool's own words; else that the tool isn't part of this turn, and for an
 * outsiders' turn that its work came from outside.
 */
async function notServed(
  services: Services,
  auth: AgentAuth,
  name: McpToolName,
  row: DispatchRow | undefined,
): Promise<CallToolResult> {
  if (name === 'report_assessment') return errorResult('forbidden', NOT_AN_ASSESSMENT);
  if (name === 'propose_connection_actions') return errorResult('forbidden', NOT_PROPOSING_ACTIONS);
  if (name === 'look_report') return errorResult('forbidden', NOT_A_LOOK);
  if (name === 'ahead_report' || name === 'search_web' || name === 'read_web_page')
    return errorResult('forbidden', NOT_AN_AHEAD_CHECK);
  if (name === 'ahead_feedback') return errorResult('forbidden', NOT_AN_AHEAD_THREAD);
  if (row?.trigger === 'ahead') return errorResult('forbidden', AHEAD_TOOL_REFUSED);
  const account = row?.onBehalfOfAccountId ?? null;
  const connector = mcpToolConnector(name);
  if (connector) {
    try {
      await personalAccess(services, services.db, auth.agentId, connector, undefined, account);
    } catch (err) {
      if (err instanceof ApiError)
        return errorResult(err.code, err.message, {
          ...(err.extra.details !== undefined ? { details: err.extra.details } : {}),
        });
      // Refused either way: only the reason is lost.
      services.log.warn({ err: String(err), tool: name }, 'could not say why a tool isn’t served');
    }
  }
  return errorResult(
    'forbidden',
    row && outsidersTurn(row) ? outsideToolText(name) : `${name} isn’t available in this turn.`,
  );
}

/**
 * Whombat's browser tools (hermes-engine.md HE-20, HE-42, HE-S142): Hermes's own browser replaces them all but
 * `browser_preview`, served in a turn with commands (the agent's Chromium takes the screenshot) whatever the keys say.
 */
function browserServed(
  agentId: string,
  dispatch: DispatchRow | undefined,
  agent: PrincipalRow | undefined,
): ServedSelection['browser'] {
  if (!dispatch || dispatch.agentId !== agentId) return 'none';
  // Only a turn with commands: the agent's Chromium takes the screenshot.
  return agent && commandsTurn(agent, dispatch) ? 'preview' : 'none';
}

/** The answer to any other tool in an assessment turn. */
export const NOT_WHILE_ASSESSING = `That tool isn’t available while assessing a report. You can use ${ASSESSOR_TOOLS.join(', ')}.`;

/**
 * Agents read the text, not `structuredContent`: invalid arguments name each field and what is wrong with it
 * (`done.4: Too big: …`), so the agent can correct the call instead of giving up on it.
 */
function errorResult(code: ErrorCode, message: string, extra: Record<string, unknown> = {}): CallToolResult {
  const fields = extra.fields as Record<string, string[]> | undefined;
  const detail = fields
    ? Object.entries(fields)
        .map(([field, issues]) => `\n- ${field}: ${issues.join('; ')}`)
        .join('')
    : '';
  return {
    isError: true,
    content: [{ type: 'text', text: `${code}: ${message}${detail}` }],
    structuredContent: { error: { code, message, ...extra } },
  };
}

function okResult(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

/**
 * A browser tool's answer (BT-03, BT-D04): the structured answer as text, a screenshot as MCP image content beside it
 * (providers that take no images in tool results read the text part), and refusals flagged as errors.
 */
function browserResult(value: Record<string, unknown>): CallToolResult {
  const result = withImageContent(okResult(value), value);
  if (value.status === 'refused' || value.status === 'failed') result.isError = true;
  return result;
}

/** A picture the answer carries (`withImage`) as MCP image content after the text. */
function withImageContent(result: CallToolResult, value: Record<string, unknown>): CallToolResult {
  const image = imageOf(value);
  if (image) result.content.push({ type: 'image', data: image.data, mimeType: image.mimeType });
  return result;
}

/** Runs one tool call for an authenticated agent. Exported for tests. */
export async function callTool(
  services: Services,
  auth: AgentAuth,
  name: string,
  args: unknown,
): Promise<CallToolResult> {
  if (!isToolName(name)) return errorResult('not_found', `There is no tool called ${name}.`);
  // What this call reads about its turn, once (the served check and the tool share it).
  const facts = turnFacts(services, auth.agentId, auth.dispatchId);
  // A Whombat Feedback assessment calls only its four tools (feedback.md FB-21); nobody else calls the assessor's.
  const assessing = await facts.assessment();
  if (assessing && !assessing.includes(name)) return errorResult('forbidden', NOT_WHILE_ASSESSING);
  if (!assessing && ASSESSMENT_ONLY_TOOLS.includes(name))
    return errorResult('forbidden', 'That tool is only available while assessing a report.');
  // A tracker run's tools only in its turns, `tracker_read` only in a granted one (report-trackers.md TA-09, TA-10).
  if (TRACKER_RUN_TOOL_NAMES.includes(name)) {
    const served = await facts.tracker();
    if (!(name === 'tracker_item' ? served.report : served.read))
      return errorResult(
        'forbidden',
        name === 'tracker_read' && served.report
          ? 'This step has no access to the reporting organization.'
          : NOT_A_TRACKER_TURN,
      );
  }
  if (mcpToolPersonalOnly(name) && !(await facts.account()))
    return errorResult('forbidden', NOT_PERSONAL_GUIDE_TEXT);
  const limited = services.runtime.mcpLimiter.take(auth.agentId, auth.dispatchId);
  if (!limited.ok) {
    return errorResult(
      'rate_limited',
      `Too many tool calls for this ${limited.scope}. Try again in ${limited.retryAfter}s.`,
      { retryAfter: limited.retryAfter, scope: limited.scope },
    );
  }
  // Only what the turn is served runs in it: a tool left out of its list (an outsiders' turn's above all) can't be
  // called by name instead. Decided by the rules the list is made with (`servesTool`).
  if (!(await facts.serves(name))) return notServed(services, auth, name, await facts.dispatch());
  const def = MCP_TOOLS[name];
  const parsed = def.input.safeParse(args ?? {});
  if (!parsed.success) {
    return errorResult('validation_failed', 'Some arguments are not valid.', {
      fields: zodFields(parsed.error),
    });
  }
  const dispatch = await facts.dispatch();
  if (!dispatch) return errorResult('unauthorized', 'This dispatch is gone.');
  // A step's turn that handed its T3 Code wait to Whombat has ended its part: nothing more runs in it, so it can't act
  // twice with the turn that goes on (docs/decisions/outsiders-turns.md).
  if (dispatch.waitsOn) return errorResult('forbidden', HANDED_TURN_ENDED);
  // A Looks ahead check reads the person's calendar and mail only where the keys say Allowed: nobody is there to ask
  // (looks-ahead.md).
  if (dispatch.trigger === 'ahead') {
    const refusal = await aheadToolRefusal(services, dispatch, name);
    if (refusal) return errorResult('forbidden', refusal);
  }
  const ctx: ToolContext = {
    services,
    agentId: auth.agentId,
    burrowId: auth.burrowId,
    dispatch,
    onBehalfOf: await onBehalfOf(services, dispatch),
  };
  try {
    const handler = TOOL_HANDLERS[name] as (c: ToolContext, i: unknown) => Promise<Record<string, unknown>>;
    // What the tool posts or queues is this dispatch's work, for its person (CT-69, `dispatch-scope.ts`).
    const out = await runInDispatchScope(dispatchScopeOf(dispatch), async () => {
      await beforeTool(ctx, name, parsed.data);
      return handler(ctx, parsed.data);
    });
    if (services.config.NODE_ENV !== 'production') {
      const check = def.output.safeParse(out);
      if (!check.success) {
        services.log.error(
          { tool: name, issues: check.error.issues.slice(0, 5) },
          'MCP output does not match contract',
        );
        return errorResult('internal', `The ${name} result does not match the contract.`);
      }
    }
    // The mails a Looks ahead check read may be named as its sources.
    if (out.status === 'ok') await aheadToolRan(services, dispatch, name, out);
    // A post waiting for approval or blocked by a key said nothing yet.
    if (MCP_POSTING_TOOLS.has(name) && out.status === 'ok')
      await services.runtime.markPosted(auth.dispatchId);
    if (name === 'browser_preview' || name === 'page_preview' || name === 'show_pages')
      return browserResult(out);
    // A connection tool's picture (a Mac's screen) beside its answer; the call's own status says how it went.
    if (name === 'connection_call') return withImageContent(okResult(out), out);
    return okResult(out);
  } catch (err) {
    if (err instanceof ApiError) {
      return errorResult(err.code, err.message, {
        ...(err.extra.fields ? { fields: err.extra.fields } : {}),
        ...(err.extra.details !== undefined ? { details: err.extra.details } : {}),
      });
    }
    // A Vault call logs only the kind of error (VT-04): nothing it touched may reach the log.
    services.log.error(
      (VAULT_SELF_SERVE_TOOL_NAMES as readonly string[]).includes(name)
        ? { err: err instanceof Error ? err.name : 'error', tool: name }
        : { err, tool: name },
      'MCP tool failed',
    );
    return errorResult('internal', 'Something went wrong on our side.');
  }
}

function buildServer(services: Services, auth: AgentAuth): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      capabilities: { tools: { listChanged: false } },
      // No “stop” (docs/decisions/resourceful-agents.md RA-12): the person's answer wakes the agent, and an Off key is
      // asked for once while the rest of the task goes on. “On Whombat”: the agent's own shell and files stay its own.
      instructions:
        'Whombat belongs to one person; you are their agent and share its Chat, threads, runs and approvals with them. ' +
        'Act on Whombat only through these tools: each call is signed with your key and checked against your keys. ' +
        'If a tool answers pending_approval, the person was asked to say yes: do what doesn’t depend on it, and their answer wakes you. ' +
        'If it answers blocked, that key is Off for you: ask for it in one line with request_approval (action grant_key) and carry on with what you can do without it.',
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await mcpToolList(services, auth.agentId, auth.dispatchId),
  }));
  // The server's own record of the call is its activity row (the runner reports only other tools).
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    withToolActivity(services, auth, req.params.name, req.params.arguments, () =>
      callTool(services, auth, req.params.name, req.params.arguments),
    ),
  );
  return server;
}

/** The agent a request authenticated as, set by the `onRequest` hook before the body is read. */
const authenticated = new WeakMap<FastifyRequest, AgentAuth>();

/**
 * Runs before Fastify reads the body (security review SEC-MCP-BODY): anything but POST gets 405 and a request
 * without a live agent token gets 401 here, so only an authenticated agent can make the server buffer and parse
 * a body up to {@link MCP_BODY_LIMIT} (sized for `upload_file`).
 */
async function authenticate(services: Services, req: FastifyRequest, reply: FastifyReply) {
  if (req.method !== 'POST') {
    // Stateless server: no standalone SSE stream and no sessions to delete.
    return reply
      .code(405)
      .header('allow', 'POST')
      .header('connection', 'close')
      .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  }
  const token = bearerOf(req.headers);
  const auth = token ? await verifyAgentToken(services, token) : null;
  if (!auth) {
    return (
      reply
        .code(401)
        .header('www-authenticate', 'Bearer realm="whombat-mcp"')
        // The body is never read: close the connection instead of draining up to the limit.
        .header('connection', 'close')
        .send({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'A live agent token is required.' },
          id: null,
        })
    );
  }
  authenticated.set(req, auth);
  // A tool call keeps a long turn's token alive (docs/decisions/essentials-agents.md EA-04); never fails the call.
  await slideAgentToken(services, auth.dispatchId).catch((err: unknown) =>
    services.log.warn({ err: String(err), dispatchId: auth.dispatchId }, 'could not slide an agent token'),
  );
}

async function handle(services: Services, req: FastifyRequest, reply: FastifyReply) {
  const auth = authenticated.get(req);
  if (!auth) throw new ApiError('unauthorized', 'A live agent token is required.');
  const server = buildServer(services, auth);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  reply.hijack();
  reply.raw.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  } catch (err) {
    services.log.error({ err }, 'MCP request failed');
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(500, { 'content-type': 'application/json' });
      reply.raw.end(
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }),
      );
    }
  }
}

export function registerMcp(app: FastifyInstance, services: Services): void {
  app.route({
    method: ['POST', 'GET', 'DELETE'],
    url: MCP_PATH,
    // `upload_file` carries up to ARTIFACT_MAX_BYTES as base64 (docs/decisions/bp-attachments.md); only an
    // authenticated request gets that far (`onRequest` answers everything else before the body is read).
    bodyLimit: MCP_BODY_LIMIT,
    onRequest: (req, reply) => authenticate(services, req, reply),
    handler: (req, reply) => handle(services, req, reply),
  });
}
