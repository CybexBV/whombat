/**
 * What Whombat's MCP server serves an agent (docs/decisions/prompt-efficiency.md PE-05): input schemas without
 * validation-only keywords, the `action` unions narrowed to what the agent can ask for, and only the tools its turn can
 * use. A model call resends every served schema, so this is paid on every call of every turn.
 *
 * Nothing is lost: `callTool` still validates every call with the tool's full zod schema and answers the exact problem
 * (“done.4: Too big: …”). A tool the turn isn't served is refused when called (`server.ts`), so the list is also what the
 * turn may do; an action variant or card kind left out of a served tool's schema still runs. Pure: no database.
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  AHEAD_TOOL_NAMES,
  type ApprovalActionType,
  BROWSER_PREVIEW_TOOL,
  COUNCIL_TOOL_NAMES,
  type ConnectorService,
  DELEGATE_TOOL_NAMES,
  FEEDBACK_ONLY_TOOL_NAMES,
  inputJsonSchema,
  MCP_TOOL_NAMES,
  MCP_TOOLS,
  type McpToolName,
  mcpToolConnector,
  mcpToolPersonalOnly,
  PAGE_PREVIEW_TOOL,
  PERSONAL_ACTION_TYPES,
  type PersonalActionType,
  SHOW_PAGES_TOOL,
  VAULT_SELF_SERVE_TOOL_NAMES,
} from '@whombat/core';
import { servedToolDescription } from './descriptions';

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/* Lean schemas ---------------------------------------------------------------------------------- */

/** A `maxLength` this large only validates: no model writes that much into one argument by accident. */
export const LEAN_MAX_LENGTH = 1000;
/** A `maxItems` this large only validates. */
export const LEAN_MAX_ITEMS = 100;

/** Keywords whose value is one schema (or, for `items` in older drafts, a list of them). */
const SCHEMA_KEYS = new Set([
  'items',
  'additionalItems',
  'additionalProperties',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
]);
/** Keywords whose value is a list of schemas. */
const SCHEMA_LIST_KEYS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);
/** Keywords whose value maps names to schemas (the names are data, never keywords). */
const SCHEMA_MAP_KEYS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);

/**
 * Whether a keyword only validates (PE-05): `$schema`; the regex of a string that names its `format` (date-time, date,
 * email: 4.6k tokens of regex for a team agent); zod's safe-integer bounds (±2^53−1 on every integer); “not empty”
 * (`minLength`/`minItems` 1); and limits no argument reaches by accident (`maxLength` ≥ 1000, `maxItems` ≥ 100). Bounds
 * that guide what the model writes (a 160-character title, 3 suggestions, 1–100 results, positive numbers) and id
 * patterns (`msg_…`, which say which id goes where) stay.
 */
function validationOnly(key: string, value: unknown, node: JsonObject): boolean {
  switch (key) {
    case '$schema':
      return true;
    case 'pattern':
      return typeof node.format === 'string';
    case 'minimum':
    case 'exclusiveMinimum':
      return value === Number.MIN_SAFE_INTEGER;
    case 'maximum':
    case 'exclusiveMaximum':
      return value === Number.MAX_SAFE_INTEGER;
    case 'minLength':
    case 'minItems':
      return value === 1;
    case 'maxLength':
      return typeof value === 'number' && value >= LEAN_MAX_LENGTH;
    case 'maxItems':
      return typeof value === 'number' && value >= LEAN_MAX_ITEMS;
    case 'additionalProperties':
      return value === false;
    default:
      return false;
  }
}

/** A JSON Schema without its validation-only keywords (`validationOnly`); values (`const`, `enum`, `default`) as they are. */
export function leanJsonSchema<T>(schema: T): T {
  if (!isObject(schema)) return schema;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (validationOnly(key, value, schema)) continue;
    if (SCHEMA_KEYS.has(key))
      out[key] = Array.isArray(value) ? value.map((v) => leanJsonSchema(v)) : leanJsonSchema(value);
    else if (SCHEMA_LIST_KEYS.has(key) && Array.isArray(value))
      out[key] = value.map((v) => leanJsonSchema(v));
    else if (SCHEMA_MAP_KEYS.has(key) && isObject(value))
      out[key] = Object.fromEntries(Object.entries(value).map(([name, v]) => [name, leanJsonSchema(v)]));
    else out[key] = value;
  }
  return out as T;
}

/* Narrowed action unions ------------------------------------------------------------------------ */

/**
 * The person's service each personal action runs on (its connector tools): a personal agent is served the variant only
 * while the person's connection includes the service, and a team agent never (they are asked of the person, PA-09).
 */
export const PERSONAL_ACTION_SERVICES: Record<PersonalActionType, ConnectorService> = {
  mail_send: 'mail',
  calendar_invite: 'calendar',
  files_share: 'files',
  files_trash: 'files',
};

/** The personal action variants an agent isn't served: all for a team agent, those of unconnected services otherwise. */
export function hiddenActionTypes(
  personal: boolean,
  usable: readonly ConnectorService[],
): PersonalActionType[] {
  return PERSONAL_ACTION_TYPES.filter((t) => !personal || !usable.includes(PERSONAL_ACTION_SERVICES[t]));
}

/** The `type` (or another discriminator) a union variant stands for (`{properties: {type: {const}}}`), if it says. */
function variantType(variant: unknown, discriminator = 'type'): string | null {
  if (!isObject(variant) || !isObject(variant.properties)) return null;
  const type = variant.properties[discriminator];
  if (!isObject(type)) return null;
  if (typeof type.const === 'string') return type.const;
  return Array.isArray(type.enum) && type.enum.length === 1 && typeof type.enum[0] === 'string'
    ? type.enum[0]
    : null;
}

/** `$defs` nothing refers to any more (a removed variant was their only user), dropped. */
function withoutUnusedDefs(schema: JsonObject): JsonObject {
  const defs = schema.$defs;
  if (!isObject(defs)) return schema;
  const { $defs: _, ...rest } = schema;
  const used = new Set<string>();
  const refsIn = (node: unknown) => {
    for (const m of JSON.stringify(node).matchAll(/"\$ref":"#\/\$defs\/([^"]+)"/g)) {
      const name = m[1] as string;
      if (used.has(name)) continue;
      used.add(name);
      refsIn(defs[name]);
    }
  };
  refsIn(rest);
  const kept = Object.entries(defs).filter(([name]) => used.has(name));
  return kept.length ? { ...rest, $defs: Object.fromEntries(kept) } : rest;
}

/** A schema without the variants of `types` in the union at `properties[property]`, told apart by `discriminator`. */
export function withoutVariants(
  schema: JsonObject,
  property: string,
  discriminator: string,
  types: readonly string[],
): JsonObject {
  if (types.length === 0 || !isObject(schema.properties) || !isObject(schema.properties[property]))
    return schema;
  const union = schema.properties[property] as JsonObject;
  const key = Array.isArray(union.oneOf) ? 'oneOf' : Array.isArray(union.anyOf) ? 'anyOf' : null;
  if (!key) return schema;
  const variants = (union[key] as unknown[]).filter(
    (v) => !types.includes(variantType(v, discriminator) ?? ''),
  );
  return withoutUnusedDefs({
    ...schema,
    properties: { ...schema.properties, [property]: { ...union, [key]: variants } },
  });
}

/** The card kinds of `post_card` (core's `PostableCard`), each told apart by `kind`. */
export const POSTABLE_CARD_KINDS = [
  'plan',
  'research',
  'review',
  'commits',
  'pill',
  'answer',
  'digest',
] as const;

/**
 * The tools with a union served narrower for some turns, and where it is: the action tools' `action` (by `type`), and
 * `post_card`'s `card` (by `kind`, turn-efficiency.md TE-11).
 */
const NARROWED: Partial<
  Record<McpToolName, { property: string; discriminator: string; names: readonly string[] }>
> = {
  request_approval: { property: 'action', discriminator: 'type', names: [] },
  perform_action: { property: 'action', discriminator: 'type', names: [] },
  post_card: { property: 'card', discriminator: 'kind', names: POSTABLE_CARD_KINDS },
};

/**
 * The served input schema of one of Whombat's tools: narrowed (the action tools' actions, `post_card`'s cards, each
 * without the variants named in `hidden`) and lean, computed once per shape. `hidden` lists action types and card kinds
 * together (they never share a name); each tool takes the ones of its own union.
 */
const servedCache = new Map<string, JsonObject>();

/**
 * Arguments a tool takes but isn't served with, to keep the list lean (all-skills-agent.md): still accepted when called
 * (`callTool` parses with the full schema). `source` is attribution, and five matches are enough. A skill is named by
 * its name alone since contracts 0.113 (skill-store.md SST-02): no tool takes a pack.
 */
export const SERVED_HIDDEN_PROPERTIES: Partial<Record<McpToolName, readonly string[]>> = {};

/** A schema without the top-level properties named. */
function withoutProperties(schema: JsonObject, names: readonly string[]): JsonObject {
  if (!names.length || !isObject(schema.properties)) return schema;
  const properties = Object.fromEntries(
    Object.entries(schema.properties).filter(([k]) => !names.includes(k)),
  );
  const required = Array.isArray(schema.required)
    ? schema.required.filter((k) => !names.includes(String(k)))
    : undefined;
  return { ...schema, properties, ...(required ? { required } : {}) };
}

export function servedInputSchema(
  name: McpToolName,
  hidden: readonly string[] = [],
  noCode = false,
): JsonObject {
  const narrowed = NARROWED[name];
  // `post_card`'s receipt links without pull requests and runs when the burrow can't do code work (TO-03).
  const links = noCode && name === 'post_card' ? NO_CODE_LINKS : [];
  const mine = narrowed
    ? hidden
        .filter((h) =>
          narrowed.property === 'card'
            ? narrowed.names.includes(h)
            : !POSTABLE_CARD_KINDS.includes(h as never),
        )
        .sort()
    : [];
  const key = `${name}|${mine.join(',')}|${links.join(',')}`;
  let schema = servedCache.get(key);
  if (!schema) {
    const full = withoutProperties(inputJsonSchema(name), SERVED_HIDDEN_PROPERTIES[name] ?? []);
    const variants = narrowed ? withoutVariants(full, narrowed.property, narrowed.discriminator, mine) : full;
    schema = leanJsonSchema(links.length ? withoutLinkTypes(variants, links) : variants);
    servedCache.set(key, schema);
  }
  return schema;
}

/**
 * Approval actions whose key no personal agent may hold (core's `personalAgentMayHold`: deploys, refunds, branches,
 * merges, channels, outside messages), so an assistant is never served them (turn-efficiency.md TE-11, PA-07).
 */
export const TEAM_ONLY_ACTION_TYPES = [
  'deploy',
  'refund',
  'push_shared_branch',
  'merge_pr',
  'message_external',
] as const satisfies readonly ApprovalActionType[];

/**
 * The action variants and card kinds a turn of this shape isn't served (turn-efficiency.md TE-11), on top of the
 * personal actions of services not connected (`hiddenActionTypes`):
 * - a personal agent: the team-only actions (`TEAM_ONLY_ACTION_TYPES`) and the code cards (`review`, `commits`): it
 *   holds no branch, merge or deploy key and starts no run (PA-07) — except in the assistant shell (`teamWork`, AN-10);
 * - a team agent: the `digest` card, a personal assistant's roundup of the person's mail, meetings and files (RM-08);
 * - a team turn not on a run: `push_shared_branch` — without a checkout nothing is pushed, and a run's pushes ask
 *   through the runner.
 * A variant not served still validates and runs when called (`callTool` parses with the full schema).
 */
export function hiddenVariants(turn: TurnShape, usable: readonly ConnectorService[]): string[] {
  return [
    ...hiddenActionTypes(turn.personal, usable),
    ...(turn.personal ? (turn.teamWork ? [] : [...TEAM_ONLY_ACTION_TYPES, 'review', 'commits']) : ['digest']),
    ...((!turn.personal || turn.teamWork) && !turn.run ? ['push_shared_branch'] : []),
    ...(turn.code === false ? NO_CODE_HIDDEN : []),
  ];
}

/**
 * The card kinds and action types about code (turn-overhead.md TO-03): a pull request's review and commits cards, and
 * asking to deploy, merge or push a branch. Not served when the burrow can't do code work.
 */
export const NO_CODE_HIDDEN = ['review', 'commits', 'deploy', 'merge_pr', 'push_shared_branch'] as const;

/** The link kinds of `post_card`'s receipts (and the rooms they are in) about code: not served without code work. */
export const NO_CODE_LINKS = ['pr', 'run'] as const;

/**
 * `schema` with every union member whose `type` is one of `types` removed, at any depth (`post_card`'s receipt links
 * and the rooms a message, approval or plan is in); a union left with one member keeps it as its only choice.
 */
export function withoutLinkTypes(schema: JsonObject, types: readonly string[]): JsonObject {
  const prune = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(prune);
    if (!isObject(node)) return node;
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] =
        (k === 'anyOf' || k === 'oneOf') && Array.isArray(v)
          ? v.filter((m) => !types.includes(variantType(m) ?? '')).map(prune)
          : prune(v);
    }
    return out;
  };
  return withoutUnusedDefs(prune(schema) as JsonObject);
}

/* Tools a turn can use -------------------------------------------------------------------------- */

/** What decides which of Whombat's tools a turn is served. */
export interface TurnShape {
  /** A personal agent: a turn for the person (its dispatch's account; not an outsiders' turn, one-person.md OP-S41). */
  personal: boolean;
  /** A search answer (`mode: answer`): the one turn that posts with `post_answer`. */
  answer: boolean;
  /**
   * A turn that reports on a run: a run turn (`mode: run`, or one that carries a run on), or a turn with a writable
   * checkout, which starts its run with `start_run` and reports in the same turn (run-checkout.md RC-01). A turn without
   * one starts the run and leaves it to the run turn.
   */
  run: boolean;
  /**
   * A person's assistant in the assistant shell (assistant-name.md AN-10): it does what the crew did and may hold a team
   * agent's keys, so it is served the code tools, the team actions and the code cards as a team agent is. Absent: no.
   */
  teamWork?: boolean;
  /**
   * The burrow can do code work (turn-overhead.md TO-03): a repository is switched on for agents, GitHub is connected, or
   * the turn is on a run. `false`: no code tools (`CODE_TOOLS`, `record_deploy`), code cards and actions
   * (`NO_CODE_HIDDEN`), or pull-request and run links in `post_card` (`NO_CODE_LINKS`). Absent: yes.
   */
  code?: boolean;
  /**
   * An outsiders' turn (queued for nobody, `runtime/person.ts`): what a tracker customer's report or reply starts, and
   * whatever else strangers' input starts. Served only `OUTSIDERS_TOOLS`. A Feedback assessment has its own list
   * (`server.ts`). Absent: no.
   */
  outside?: boolean;
  /**
   * A Looks ahead check (trigger `ahead`; docs/decisions/looks-ahead.md): Whombat's quiet turn about something on the
   * person's calendar, which reads strangers' text (mail, web pages) while it holds the person's. Served only
   * `AHEAD_TOOLS`. Absent: no.
   */
  ahead?: boolean;
  /**
   * A Looks ahead triage pass (a check whose source is `triage`): it only picks from the new mail it was shown, so it
   * is served `ahead_triage` alone, which no other check is served. Absent: no.
   */
  aheadTriage?: boolean;
}

/**
 * Everything a Looks ahead check may be served (docs/decisions/looks-ahead.md): read the calendar and the mail, search
 * and read public web pages, and say what it found. Nothing that writes, sends, remembers or reaches anything else: no
 * other room, memory, notes, settings, Vault, connection, server, browser or command. Anything new stays out until it is
 * added here.
 */
export const AHEAD_TOOLS: readonly McpToolName[] = AHEAD_TOOL_NAMES;

/** The tools only a Looks ahead check is served. */
const AHEAD_ONLY_TOOLS: readonly McpToolName[] = [
  'search_web',
  'read_web_page',
  'ahead_read_docs',
  'ahead_report',
  'ahead_triage',
];

/**
 * Everything an outsiders' turn may be served (docs/decisions/outsiders-turns.md). What strangers send may shape only
 * the reply in the turn's own thread: it reads and replies there, reads the files of what it was shown, checks its own
 * work, and uses what its automation step owns (the assessment it is asked for, the tracker report, a pull request from
 * the branch its step checked out), and on a tracker report T3 Code through the connection tools (OT-11). Nothing else:
 * no other room, Home, status, schedule, plan, canvas, approval, action, run, review, merge, deploy, other connection,
 * Vault or person's account. Anything new stays out until it is added here.
 */
export const OUTSIDERS_TOOLS = [
  'read_conversation',
  'reply_in_thread',
  'read_attachment',
  'completion_evidence',
  'report_assessment',
  'propose_connection_actions',
  'tracker_item',
  'tracker_read',
  'open_pull_request',
  'connection_tools',
  'connection_call',
] as const satisfies readonly McpToolName[];

/** The assistant's settings tools (assistant-settings.md): the person's own turns only. */
export const SETTINGS_TOOL_NAMES = [
  'settings_find',
  'settings_read',
  'settings_change',
  'settings_open',
] as const satisfies readonly McpToolName[];

/** The tools that make and change automations (automation-chat.md): the person's own turns only. */
export const AUTOMATION_CHAT_TOOLS = [
  'draft_automation',
  'automation_read',
] as const satisfies readonly McpToolName[];

/** The tools that report on a run the turn is in. */
export const RUN_REPORT_TOOLS = [
  'run_step',
  'run_log',
  'run_tests',
  'run_files',
  'finish_run',
] as const satisfies readonly McpToolName[];

/** Runs and pull requests: never a personal agent's (it holds no branch key and starts no run, PA-07). */
export const CODE_TOOLS = [
  'start_run',
  ...RUN_REPORT_TOOLS,
  'open_pull_request',
  'review_pull_request',
  'merge_pull_request',
] as const satisfies readonly McpToolName[];

/** Whether a turn of this shape is served the tool (PE-05); the other listing rules (keys, connectors) still apply. */
export function toolFitsTurn(name: McpToolName, turn: TurnShape): boolean {
  // A triage pass reads nothing but what Whombat gave it: it only picks.
  if (turn.ahead)
    return turn.aheadTriage ? name === 'ahead_triage' : AHEAD_TOOLS.includes(name) && name !== 'ahead_triage';
  if (AHEAD_ONLY_TOOLS.includes(name)) return false;
  if (turn.outside) {
    if (!(OUTSIDERS_TOOLS as readonly string[]).includes(name)) return false;
    // A pull request only from the checkout its automation step was given (the handler checks the branch).
    if (name === 'open_pull_request') return turn.run && turn.code !== false;
    return true;
  }
  if (name === 'post_answer') return turn.answer;
  // Nothing to run, review, merge or deploy without a repository or GitHub (TO-03).
  if (turn.code === false && (name === 'record_deploy' || (CODE_TOOLS as readonly string[]).includes(name)))
    return false;
  const personalOnly = turn.personal && !turn.teamWork;
  // Deploys are a team agent's (and the assistant shell's assistant's), never a search answer's (RF-02).
  if (name === 'record_deploy') return !turn.answer && !personalOnly;
  // Chat has threads, not titled chats (chat-channel.md CHT-02, CHT-S): the assistant shell's assistant names none.
  if (name === 'set_chat_title') return !(turn.personal && turn.teamWork);
  // A search answer finishes no task of its own (done-today.md DN-01).
  if (name === 'report_done') return !turn.answer;
  if (personalOnly && (CODE_TOOLS as readonly string[]).includes(name)) return false;
  if ((RUN_REPORT_TOOLS as readonly string[]).includes(name)) return turn.run;
  return true;
}

/* The list a turn is served ------------------------------------------------------------------- */

/**
 * One of Whombat's tools as served (prompt-efficiency.md PE-05): its input schema without validation-only keywords, and
 * for `request_approval` / `perform_action` without the action variants in `hiddenActions` (and `post_card` without
 * pull-request and run links when `noCode`, TO-03). `callTool` validates with the full schema. Its description is the contract's with Whombat's addition (`descriptions.ts`, HE-S37).
 */
export function toolEntry(name: McpToolName, hidden: readonly string[] = [], noCode = false): Tool {
  const def = MCP_TOOLS[name];
  return {
    name,
    title: def.title,
    description: servedToolDescription(name, def.description),
    inputSchema: servedInputSchema(name, hidden, noCode) as Tool['inputSchema'],
    annotations: { title: def.title, readOnlyHint: def.readOnly, openWorldHint: false },
  };
}

/** The connections catalog's two tools (connections-catalog.md CX-30): listed only with a connection to use. */
export const CONNECTION_TOOL_NAMES = [
  'connection_tools',
  'connection_call',
] as const satisfies readonly McpToolName[];

/**
 * Everything besides the turn's shape that decides which of Whombat's own tools an ordinary turn (not an assessment) is
 * served. `mcpToolList` reads it from the database.
 */
export interface ServedSelection {
  turn: TurnShape;
  /** The connector services the agent can use: the person connected them (connectors.md “Tools”). */
  usable: readonly ConnectorService[];
  /** The browser (browser.md BT-02, BT-48): `browser_preview` with a turn; none without one. */
  browser: 'preview' | 'none';
  /** The agent can use a connection in this turn (connections-catalog.md CX-30): the two connection tools. */
  connections: boolean;
  /**
   * The turn is an automation's assessment step (automation-recipes.md AR-24): `report_assessment`. No other turn lists
   * it, and calling it elsewhere is refused.
   */
  assesses?: boolean;
  /**
   * The turn is an automation step that proposes connection actions for approval (`proposeActions: true`):
   * `propose_connection_actions`. No other turn lists it, and calling it elsewhere is refused.
   */
  proposes?: boolean;
  /**
   * The turn looks into a look or takes the person's step on one (triggers `look`, `look_fix`; look-research.md LR-05):
   * `look_report`. No other turn lists it, and calling it elsewhere is refused.
   */
  looks?: boolean;
  /**
   * The turn is an agent turn of an automation run that started from a tracker report (report-trackers.md TA-09,
   * TA-10): `tracker_item` (`report`), and `tracker_read` when the step was granted access to the reporting organization
   * (`read`). No other turn lists them, and calling them elsewhere is refused.
   */
  tracker?: { report: boolean; read: boolean };
  /**
   * Action types nothing on this Whombat carries out (essentials-agents.md EA-03, `OPTIONAL_EXECUTOR_ACTION_TYPES` without
   * an executor): asking for one is refused up front, so the action tools aren't served them (turn-overhead.md TO-04).
   */
  unavailableActions?: readonly string[];
  /**
   * The turn is an automation's own step (dispatch trigger `automation`; automation-chat.md): it is never served
   * `draft_automation` or `automation_read`, so what an issue or a report says can't change an automation, nor
   * `schedule`: the step's reply is what the automation goes on with, so a turn scheduled for later would leave it with
   * “I'll come back to this”. Absent: no.
   */
  automationStep?: boolean;
  /**
   * A T3 Code connection manages and works (council.md CNL-03): the council's tools, whose members run there, and the
   * delegation's (delegate.md), whose tasks do. Absent: no.
   */
  council?: boolean;
  /** The burrow has a Custom connection (an MCP server or API set up by hand): `connection_look`. Absent: no. */
  customConnections?: boolean;
  /**
   * The person can send reports to the Whombat Team, or has some (team-reports.md):
   * `report_to_whombat_team` and `whombat_team_reports`. Absent: no.
   */
  teamReports?: boolean;
  /**
   * The person's own turn in the thread of something Looks ahead told them (docs/decisions/looks-ahead.md):
   * `ahead_feedback`, their word on it. No other turn lists it. Absent: no.
   */
  aheadThread?: boolean;
  /** The burrow has an active Paperless-ngx or Notion connection for read-only Looks ahead doc searches. Absent: no. */
  aheadDocs?: boolean;
  /**
   * A turn the person began themselves, in their own words (docs/decisions/looks-ahead.md): `ahead_watch`, to keep an
   * eye on something in their mail. Never a Looks ahead check, an automation's step or an outsiders' turn. Absent: no.
   */
  aheadWatch?: boolean;
}

/** Reports to the Whombat Team (team-reports.md): the person's own turns, where they can send reports or have some. */
export const TEAM_REPORT_TOOL_NAMES = [
  'report_to_whombat_team',
  'whombat_team_reports',
] as const satisfies readonly McpToolName[];

/**
 * The action types an approval can carry out only when something is set up for them (turn-overhead.md TO-04): a deploy
 * workflow, a payment system, a way to send outside the burrow. `mcpToolList` hides those without an executor.
 */
export const OPTIONAL_EXECUTOR_ACTION_TYPES = [
  'deploy',
  'refund',
  'message_external',
] as const satisfies readonly ApprovalActionType[];

/**
 * The names of Whombat's own tools a turn is served, in `tools/list` order: the contract's tools that fit the turn
 * (`toolFitsTurn`) and the agent, then the browser's and the connection tools. The Vault's come after them
 * (`servedVaultTools`).
 */
export function servedToolNames(sel: ServedSelection): McpToolName[] {
  return [...MCP_TOOL_NAMES.filter((name) => listedOwnTool(name, sel)), ...trailingTools(sel)];
}

/**
 * The browser's tools, served in a turn with the agent's Chromium: its build as a website, a page as a message shows it
 * (docs/decisions/visual-replies.md), a folder of pages for the person (docs/decisions/page-sets.md).
 */
const BROWSER_TOOLS: McpToolName[] = [BROWSER_PREVIEW_TOOL, PAGE_PREVIEW_TOOL, SHOW_PAGES_TOOL];

/** Whether one of the contract's tools is listed in the turn's first part (`servedToolNames`). */
function listedOwnTool(name: McpToolName, sel: ServedSelection): boolean {
  if (!toolFitsTurn(name, sel.turn)) return false;
  // Tools nobody but an assessment calls (FB-21): the assessor’s own.
  if (FEEDBACK_ONLY_TOOL_NAMES.includes(name)) return false;
  // `vault_save` and `vault_add_server` with the Vault's tools, for a person's own assistant in their turns
  // (vault-self-serve.md VS-12, `vaultContextFor`).
  if ((VAULT_SELF_SERVE_TOOL_NAMES as readonly string[]).includes(name)) return false;
  // `browser_preview`, `page_preview` and `show_pages` are listed with the browser (browser.md BT-02, BT-48, `trailingTools`).
  if (BROWSER_TOOLS.includes(name)) return false;
  // The connection tools only when the agent can use a connection in this turn (connections-catalog.md CX-30,
  // `trailingTools`).
  if ((CONNECTION_TOOL_NAMES as readonly string[]).includes(name)) return false;
  // An automation's structured assessment: only in the turn of a step that asks for one (AR-24).
  if (name === 'report_assessment' && !sel.assesses) return false;
  // Proposed connection actions: only in the turn of a step with `proposeActions: true`.
  if (name === 'propose_connection_actions' && !sel.proposes) return false;
  // What the assistant found out about a look: only in a look's turns (look-research.md LR-05).
  if (name === 'look_report' && !sel.looks) return false;
  // The person's word on what Looks ahead told them: only in their turn in its thread (looks-ahead.md).
  if (name === 'ahead_feedback' && !sel.aheadThread) return false;
  // Read-only Paperless/Notion search in a Looks ahead check: only when one is connected.
  if (name === 'ahead_read_docs' && !sel.aheadDocs) return false;
  // Only the person's own words make a watch: never a turn something else began.
  if (name === 'ahead_watch' && (!sel.aheadWatch || sel.automationStep)) return false;
  // Automations change only when the person asks in Chat, never from inside an automation's own step, and a step
  // finishes its work in its own turn.
  if ((AUTOMATION_CHAT_TOOLS as readonly string[]).includes(name) && sel.automationStep) return false;
  if (name === 'schedule' && sel.automationStep) return false;
  // What Whombat watches is the person's to change: never from an automation's own step (on-purpose.md).
  if ((name === 'watch_checks' || name === 'quiet_until' || name === 'thing_watch') && sel.automationStep)
    return false;
  // A council runs on T3 Code, when the person asks: never from an automation's step (council.md CNL-05).
  // Tasks handed to T3 Code from a checklist card are the person's too (delegate.md).
  if (
    ([...COUNCIL_TOOL_NAMES, ...DELEGATE_TOOL_NAMES] as readonly string[]).includes(name) &&
    (!sel.council || sel.automationStep)
  )
    return false;
  // A Custom connection's logo and page, when there is one: never from an automation's step.
  if (name === 'connection_look' && (!sel.customConnections || sel.automationStep)) return false;
  // A link is made when the person asks for one in Chat: never from an automation's step (share-links.md).
  if (name === 'share_link' && sel.automationStep) return false;
  // A report to the Whombat Team is the person's, drafted when they say so in Chat, and the team's words stay out of
  // automations: never from an automation's step, and only where the person can send reports or has some.
  if (
    (TEAM_REPORT_TOOL_NAMES as readonly string[]).includes(name) &&
    (!sel.teamReports || sel.automationStep)
  )
    return false;
  // Settings are the person's to change, when they ask: never from an automation's own step (assistant-settings.md).
  if ((SETTINGS_TOOL_NAMES as readonly string[]).includes(name) && sel.automationStep) return false;
  // A tracker run's own tools (TA-09, TA-10): the report in its turns, the organization only in a granted one.
  if (name === 'tracker_item' && !sel.tracker?.report) return false;
  if (name === 'tracker_read' && !sel.tracker?.read) return false;
  // The assistant's own tools (start_guide and the like; CT-82) are for personal agents only.
  if (mcpToolPersonalOnly(name) && !sel.turn.personal) return false;
  const connector = mcpToolConnector(name);
  return connector === null || sel.usable.includes(connector);
}

/**
 * What the list ends with: the browser's tool, then the connection tools. No browser in an outsiders' turn, whatever the
 * selection says. Its connections are already narrowed: one on a tracker report sees T3 Code alone, every other one
 * none (`visibleConnections`, outsiders-turns.md OT-11).
 */
function trailingTools(sel: ServedSelection): McpToolName[] {
  // A Looks ahead check has neither (looks-ahead.md, `AHEAD_TOOLS`).
  if (sel.turn.ahead) return [];
  return [
    ...(sel.browser === 'none' || sel.turn.outside === true ? [] : BROWSER_TOOLS),
    ...(sel.connections ? CONNECTION_TOOL_NAMES : []),
  ];
}

/**
 * Whether the turn is served one of Whombat's own tools: whether `servedToolNames` lists it, by the same rules, without
 * listing the rest. The browser's and the connection tools are only ever listed at the end.
 */
export function servesTool(name: McpToolName, sel: ServedSelection): boolean {
  if (BROWSER_TOOLS.includes(name) || (CONNECTION_TOOL_NAMES as readonly string[]).includes(name))
    return trailingTools(sel).includes(name);
  return listedOwnTool(name, sel);
}

/** One loader per part of a turn's selection, each read from the database when it is first asked for. */
export type SelectionLoaders = { [K in keyof ServedSelection]-?: () => Promise<ServedSelection[K]> };

/** The whole selection, its parts loaded at once (`tools/list`). */
export async function loadSelection(load: SelectionLoaders): Promise<ServedSelection> {
  const keys = Object.keys(load) as (keyof ServedSelection)[];
  const values = await Promise.all(keys.map((key) => load[key]()));
  return Object.fromEntries(keys.map((key, i) => [key, values[i]])) as unknown as ServedSelection;
}

/** A part of the selection the rules reached before it was loaded. */
class NotLoaded {
  constructor(readonly key: keyof ServedSelection) {}
}

/**
 * Whether the turn is served `name` (`servesTool`), loading only the parts of its selection the rules read for that name:
 * a tool call checks one tool, and most parts cost a database read. The rules run on what is loaded so far; when they
 * reach a part that isn't, it is loaded and they run again from the start. The same rules on the same parts, so the same
 * answer as the whole list gives.
 */
export async function servesToolLazily(name: McpToolName, load: SelectionLoaders): Promise<boolean> {
  const known: Partial<Record<keyof ServedSelection, unknown>> = {};
  const view = new Proxy(known, {
    get(target, key) {
      if (Object.hasOwn(target, key)) return target[key as keyof ServedSelection];
      if (Object.hasOwn(load, key)) throw new NotLoaded(key as keyof ServedSelection);
      return undefined;
    },
  }) as unknown as ServedSelection;
  // Each pass either answers or loads a part it hadn't, so this ends after at most one pass per part.
  for (;;) {
    try {
      return servesTool(name, view);
    } catch (err) {
      if (!(err instanceof NotLoaded)) throw err;
      known[err.key] = await load[err.key]();
    }
  }
}

/** Whombat's own tools a turn is served (`servedToolNames`), each as served (`toolEntry`, the hidden actions narrowed). */
export function servedTools(sel: ServedSelection): Tool[] {
  const hidden = [...hiddenVariants(sel.turn, sel.usable), ...(sel.unavailableActions ?? [])];
  return servedToolNames(sel).map((name) => toolEntry(name, hidden, sel.turn.code === false));
}

/**
 * The Vault's tools of a turn's Vault context: `vault_save` and `vault_add_server` for a person's own assistant in their
 * turns (vault-self-serve.md VS-12). The relays and bridged tools are gone (hermes-engine.md HE-43).
 */
export function servedVaultTools(tools: readonly string[]): Tool[] {
  return VAULT_SELF_SERVE_TOOL_NAMES.filter((name) => tools.includes(name)).map((name) => {
    const def = MCP_TOOLS[name as McpToolName];
    return {
      name,
      title: def.title,
      description: def.description,
      inputSchema: servedInputSchema(name as McpToolName) as Tool['inputSchema'],
      annotations: { title: def.title, readOnlyHint: def.readOnly, openWorldHint: true },
    };
  });
}
