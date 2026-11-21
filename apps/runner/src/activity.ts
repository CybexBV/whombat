/**
 * Observed activity (docs/decisions/work-supervision.md WS-11…WS-15): the runner turns the provider's own tool
 * events into activity reports, one row per action updated through its lifecycle, and sends them with its progress
 * beat (`ProgressBody.activity`). Pure apart from the clock: classification, redaction, path shortening, evidence
 * bounds, keying and the unsent-report queue are unit-tested here; `turn.ts` does the sending.
 *
 * - Not Whombat's own MCP tools (`isWhombatMcpCall`: Whombat's, the Vault's, the browser's, connector tools): the
 *   server runs those calls and records their rows itself, with the outcome it gave (`apps/server/src/runtime/
 *   activity-mcp.ts`) — Hermes passes a Whombat tool's answer over ACP only as text. Every other tool (shell, edits,
 *   reads, web, the provider's own) is reported here, named by the provider's category when it gave one, else its name.
 * - Key = `<attempt>:<provider tool id>`, or `<attempt>:s<n>` (the runner's sequence number) for a provider without
 *   ids; `seq` increases with every report of the dispatch, so the server can ignore stale ones.
 * - Titles come from facts the provider gave (kind, object, status, exit code); nothing is read out of output text.
 * - Evidence is redacted (tokens, keys, bearer headers, `*_TOKEN=` assignments, private keys, URL credentials),
 *   paths shortened (workdir-relative, `~`) and bounded (input ≤ 1 KB, the tail of output ≤ 4 KB). Never thinking or
 *   assistant text, never file contents of reads or searches, never other MCP tools' arguments or results (their
 *   audience may be another room), and for a Feedback assessment nothing beyond kind and state.
 * - A command the commands' service didn't run because it kept failing the same way (health-command-loops.md
 *   HC-05) is a failed, `blocked` command row: the exec service says so (`notRun`) before the provider can report it,
 *   and the provider's row is the shell call whose output carries `REPEAT_REFUSED_LINE` — the one place output is read,
 *   and only to tell which row Whombat's own refusal was.
 * - Hermes's skill tools (`skill_view`, `skill_manage`) are `tool` rows whose object is the skill's name
 *   (hermes-engine.md HE-41), no evidence. A tool named like one of the browser's (browser.md BT-03) keeps its rules: its object is core's `browserActivityObject` (an opened
 *   URL without query and fragment, else nothing); typed text and selected values never reach evidence.
 */
import { type TurnEvent, whombatToolName } from '@whombat/agent-runtime';
import {
  ACTIVITY_REPORTS_MAX,
  type ActivityEvidence,
  type ActivityKind,
  type ActivityReport,
  type ActivityStatus,
  browserActivityObject,
  isBrowserActivityTool,
  isVaultActivityTool,
  MCP_TOOL_NAMES,
  type McpToolName,
  mcpToolConnector,
  redactActivitySecrets as redact,
} from '@whombat/core';
import { REPEAT_REFUSED_LINE } from './commands/repeats';

export { redact };

export const EVIDENCE_INPUT_MAX = 1000;
export const EVIDENCE_OUTPUT_MAX = 4000;
const OBJECT_MAX = 300;
const TOOL_MAX = 120;
const KEY_MAX = 160;
/** How long new reports wait for more before the runner sends them (WS-12). */
export const ACTIVITY_FLUSH_MS = 300;

/* Paths ---------------------------------------------------------------------------------------- */

export interface PathContext {
  /** The turn's working directory: paths inside it become relative. */
  cwd: string;
  /** The host user's home: paths inside it become `~/…`. */
  home?: string | null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Workdir-relative paths and `~` for the home directory, wherever they appear in `text`. */
export function shortenPaths(text: string, ctx: PathContext): string {
  let out = text;
  const cwd = ctx.cwd.replace(/\/+$/, '');
  if (cwd && cwd !== '/') {
    out = out.replace(new RegExp(`${escapeRegExp(cwd)}/`, 'g'), '');
    out = out.replace(new RegExp(`${escapeRegExp(cwd)}(?![\\w.-])`, 'g'), '.');
  }
  const home = ctx.home?.replace(/\/+$/, '');
  if (home && home !== '/') out = out.replace(new RegExp(`${escapeRegExp(home)}(?=/|(?![\\w.-]))`, 'g'), '~');
  return out;
}

/* Bounds --------------------------------------------------------------------------------------- */

function head(text: string, max: number): { text: string; cut: boolean } {
  return text.length > max ? { text: `${text.slice(0, max - 1)}…`, cut: true } : { text, cut: false };
}

function tail(text: string, max: number): { text: string; cut: boolean } {
  return text.length > max
    ? { text: `…${text.slice(text.length - max + 1)}`, cut: true }
    : { text, cut: false };
}

/** Redacted, shortened and bounded evidence; null when there is nothing to show. */
export function boundEvidence(
  input: string | null,
  output: string | null,
  ctx: PathContext,
): ActivityEvidence | null {
  const clean = (t: string | null) => (t ? redact(shortenPaths(t, ctx)).trim() : '');
  const i = clean(input);
  const o = clean(output);
  if (!i && !o) return null;
  const inBound = i ? head(i, EVIDENCE_INPUT_MAX) : null;
  const outBound = o ? tail(o, EVIDENCE_OUTPUT_MAX) : null;
  return {
    input: inBound?.text ?? null,
    output: outBound?.text ?? null,
    truncated: Boolean(inBound?.cut || outBound?.cut),
  };
}

/* Classification ------------------------------------------------------------------------------- */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

const WHOMBAT_TOOLS = new Set<string>(MCP_TOOL_NAMES);
/** How a Vault tool's row names its tool: one neutral name (the server stores the same, VT-53). */
export const VAULT_ACTIVITY_TOOL = 'whombat.vault_request';

/** Tools that are the provider's own bookkeeping (its to-do list, plan mode): no row. */
const SILENT_TOOLS = new Set([
  'TodoWrite',
  'ExitPlanMode',
  'EnterPlanMode',
  'update_plan',
  // Claude Code 2.1's task list (resourceful-agents.md RA-15): the agent's own notes on its steps.
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
]);

/** Hermes's tools that read or change a skill (`{name}`; `skill_manage` also `{operations: [{name}]}`). */
export const SKILL_TOOLS: ReadonlySet<string> = new Set(['skill_view', 'skill_manage']);

/** The providers' shell tools: what the commands' service runs (Claude Code's Bash, Codex's commands). */
const SHELL_TOOLS = new Set(['Bash', 'shell']);

/** Whether a shell call's output is the exec service's refusal of a command that kept failing (HC-05). */
function refusedOutput(output: string | undefined): boolean {
  return Boolean(output?.split('\n').some((line) => line.trim() === REPEAT_REFUSED_LINE));
}

/**
 * A browser tool's bare name (`browser_navigate`), whatever the provider prefixed it with, or null for any other tool
 * (contracts 0.125 `isBrowserActivityTool`: Hermes's browser tools and Whombat's `browser_preview`).
 */
function browserToolOf(name: string): string | null {
  return isBrowserActivityTool(name) ? (name.split(/__|\./).at(-1) ?? name) : null;
}

/** Browser tools whose input is what the agent typed or chose: never evidence (BT-03). */
const BROWSER_PRIVATE_INPUT: ReadonlySet<string> = new Set<string>([
  'browser_type',
  'browser_select',
  'browser_press',
  'browser_sign_in',
]);

const NAME_KINDS: Record<string, ActivityKind> = {
  // Claude Code
  Read: 'read',
  LS: 'read',
  NotebookRead: 'read',
  Glob: 'search',
  Grep: 'search',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'command',
  BashOutput: 'command',
  KillShell: 'command',
  WebFetch: 'web',
  WebSearch: 'web',
  Task: 'delegate',
  Agent: 'delegate',
  // Codex (codex/events.ts names)
  shell: 'command',
  edit: 'edit',
  web_search: 'web',
  view_image: 'read',
  subagent: 'delegate',
};

export interface Classified {
  kind: ActivityKind;
  /** Normalized: `Edit`, `shell`, `whombat.post_message`, `mail.search`, `server.tool`. */
  tool: string;
  /** Whether the call's input and output may be shown as evidence (not for Whombat or connector tools). */
  evidence: boolean;
}

/**
 * Whether a provider tool call is one of Whombat's own MCP server (Whombat's tools, the Vault's, the browser's,
 * connector tools): a name `whombatToolName` recognises (`mcp__whombat__…`, Hermes's `mcp__editor_whombat_<hash>__…`),
 * or the bare name the providers give them when they mark the call an MCP call (or give no category). The server
 * records those rows from the calls it ran; a provider's own tool of the same name (Hermes's `memory`) is not one.
 */
export function isWhombatMcpCall(call: { name: string; category?: string | undefined }): boolean {
  const name = call.name.trim();
  if (whombatToolName(name)) return true;
  if (call.category !== undefined && call.category !== 'mcp') return false;
  return WHOMBAT_TOOLS.has(name) || isVaultActivityTool(name) || browserToolOf(name) !== null;
}

/** A provider tool call → activity kind and normalized tool name, or null for tools that get no row. */
export function classifyTool(call: { name: string; category?: string | undefined }): Classified | null {
  const name = call.name.trim() || 'tool';
  if (SILENT_TOOLS.has(name)) return null;
  // Every Vault tool (`vault_request`, a bridged `vt_…` tool, whatever the provider prefixed it with) is one neutral
  // row: “Used a private Vault entry”, no tool name, object or evidence (Whombat vault.md VT-53).
  if (isVaultActivityTool(name)) return { kind: 'whombat', tool: VAULT_ACTIVITY_TOOL, evidence: false };
  // A name of Whombat's is Whombat's tool only as an MCP call: Hermes's own `memory` or `browser_click` is Hermes's.
  const whombatNamed = call.category === undefined || call.category === 'mcp';
  // The browser's tools: web rows, whatever the provider called them (BT-03).
  const browser = whombatNamed ? browserToolOf(name) : null;
  if (browser)
    return { kind: 'web', tool: `whombat.${browser}`, evidence: !BROWSER_PRIVATE_INPUT.has(browser) };
  // A skill the agent read or changed (HE-41): which one is its object.
  if (SKILL_TOOLS.has(name)) return { kind: 'tool', tool: name, evidence: false };
  if (whombatNamed && WHOMBAT_TOOLS.has(name)) {
    const service = mcpToolConnector(name as McpToolName);
    // Connector tools (mail, calendar, files …) are the person's services: a `tool` row, never their content.
    if (service) {
      const rest = name.startsWith(`${service}_`) ? name.slice(service.length + 1) : name;
      return { kind: 'tool', tool: `${service}.${rest}`.slice(0, TOOL_MAX), evidence: false };
    }
    return { kind: 'whombat', tool: `whombat.${name}`.slice(0, TOOL_MAX), evidence: false };
  }
  const mcpName = name.startsWith('mcp__') ? name.slice(5).replace(/__/g, '.') : name;
  switch (call.category) {
    case 'read':
    case 'edit':
    case 'command':
    case 'search':
    case 'web':
    case 'delegate':
      return { kind: call.category, tool: name.slice(0, TOOL_MAX), evidence: call.category !== 'delegate' };
    case 'mcp':
    case 'other':
      return { kind: 'tool', tool: mcpName.slice(0, TOOL_MAX), evidence: false };
  }
  const kind = NAME_KINDS[name];
  if (kind) return { kind, tool: name, evidence: kind !== 'delegate' };
  return { kind: 'tool', tool: mcpName.slice(0, TOOL_MAX), evidence: false };
}

/** The command line of a shell call (`command` as a string or argv, `cmd`). */
function commandOf(input: Obj): string | null {
  const c = input.command ?? input.cmd;
  if (Array.isArray(c)) return c.filter((x) => typeof x === 'string').join(' ') || null;
  return str(c);
}

/** The skill a skill tool reads or changes: its `name`, else the names its operations name. */
export function skillObject(input: unknown): string | null {
  const o = obj(input);
  const ops = Array.isArray(o.operations) ? o.operations : [];
  const names = [str(o.name), ...ops.map((op) => str(obj(op).name))].filter((n): n is string => !!n?.trim());
  return [...new Set(names.map((n) => n.trim()))].join(', ') || null;
}

/**
 * What a classified call acts on: a skill's name, a browser tool's page (never typed text), else `rawObject`. For
 * browser rows it is also their only evidence.
 */
export function callObject(
  classified: Classified,
  input: unknown,
  paths: readonly string[] | undefined,
): string | null {
  if (SKILL_TOOLS.has(classified.tool)) return skillObject(input);
  if (browserToolOf(classified.tool)) return browserActivityObject(classified.tool, input);
  return rawObject(classified.kind, input, paths);
}

/** What a call acts on, before shortening and redaction: a path, a command line, a pattern, a URL or query. */
export function rawObject(
  kind: ActivityKind,
  input: unknown,
  paths: readonly string[] | undefined,
): string | null {
  const i = obj(input);
  const firstPath =
    paths?.[0] ??
    str(i.file_path) ??
    str(i.notebook_path) ??
    str(i.path) ??
    (Array.isArray(i.paths) ? str(i.paths[0]) : null);
  switch (kind) {
    case 'read':
      return firstPath ?? commandOf(i);
    case 'edit':
      return firstPath;
    case 'search':
      return str(i.pattern) ?? str(i.query) ?? str(i.glob) ?? commandOf(i) ?? firstPath;
    case 'command':
      return commandOf(i);
    case 'web':
      return str(i.url) ?? str(i.query) ?? str(i.q);
    default:
      return null;
  }
}

/** The evidence input of a call: the command, the pattern and where, the paths, the URL. */
function rawInput(kind: ActivityKind, input: unknown, paths: readonly string[] | undefined): string | null {
  const i = obj(input);
  switch (kind) {
    case 'command':
      return commandOf(i);
    case 'search': {
      const what = str(i.pattern) ?? str(i.query) ?? str(i.glob) ?? commandOf(i);
      const where = str(i.path) ?? paths?.[0] ?? null;
      return [what, where ? `in ${where}` : null].filter(Boolean).join(' ') || null;
    }
    case 'read':
    case 'edit': {
      const all = paths?.length
        ? paths
        : Array.isArray(i.paths)
          ? i.paths.filter((p) => typeof p === 'string')
          : [];
      return all.length ? all.join('\n') : rawObject(kind, input, paths);
    }
    case 'web':
      return rawObject(kind, input, paths);
    default:
      return null;
  }
}

/* The recorder --------------------------------------------------------------------------------- */

export interface ActivityOptions extends PathContext {
  /** The claim this turn runs as (the lease's attempt). */
  attempt: number;
  /** A Whombat Feedback assessment: kind and state only (WS-14). */
  bare?: boolean;
  now?: () => Date;
}

interface Row {
  key: string;
  /** The seq of its latest change. */
  seq: number;
  /** A change not acknowledged by the server yet. */
  dirty: boolean;
  kind: ActivityKind;
  tool: string;
  status: ActivityStatus;
  object: string | null;
  exitCode: number | null;
  failure: ActivityReport['failure'];
  evidence: ActivityEvidence | null;
  /** Whether evidence may be shown for its kind. */
  shows: boolean;
  /** The evidence input, kept to pair with the output. */
  input: string | null;
  /** A shell call's command line (for a row the exec service didn't run, HC-05). */
  command: string | null;
  at: string;
  /** A denied permission: later events for the call don't change the row. */
  sealed: boolean;
  name: string;
  hasId: boolean;
}

function boundKey(attempt: number, id: string): string {
  const key = `${attempt}:${id}`;
  if (key.length <= KEY_MAX) return key;
  // A provider id longer than the key allows: keep it unique with a short hash of the whole id.
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return `${`${attempt}:${id}`.slice(0, KEY_MAX - 10)}#${(h >>> 0).toString(36)}`;
}

/**
 * Keeps the rows of one turn attempt and the reports the server has not acknowledged. `observe()` every TurnEvent;
 * `pending()` what to send with the next beat; `ack()` what the server took.
 */
export class ActivityRecorder {
  readonly #rows = new Map<string, Row>();
  readonly #opts: ActivityOptions;
  #seq = 0;
  #calls = 0;
  #permissions = 0;
  /** Commands the exec service didn't run (HC-05) whose rows haven't been found yet. */
  #notRun = 0;
  /** Calls of Whombat's MCP tools (the server records their rows): by id, and how many without one, by name. */
  readonly #whombatIds = new Set<string>();
  readonly #whombatOpen = new Map<string, number>();

  constructor(opts: ActivityOptions) {
    this.#opts = opts;
  }

  get hasPending(): boolean {
    for (const r of this.#rows.values()) if (r.dirty) return true;
    return false;
  }

  /** All rows as reports (latest state), oldest first; for tests and diagnostics. */
  rows(): ActivityReport[] {
    return [...this.#rows.values()].sort((a, b) => a.seq - b.seq).map((r) => this.#report(r));
  }

  /** The unacknowledged reports, oldest change first, at most one beat's worth. */
  pending(): ActivityReport[] {
    return [...this.#rows.values()]
      .filter((r) => r.dirty)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, ACTIVITY_REPORTS_MAX)
      .map((r) => this.#report(r));
  }

  /** The server took these: rows not changed since are clean. */
  ack(sent: readonly ActivityReport[]): void {
    for (const s of sent) {
      const row = this.#rows.get(s.key);
      if (row && row.seq === s.seq) row.dirty = false;
    }
  }

  /**
   * The commands' service didn't run a command because it kept failing the same way (HC-05): the provider's row
   * for it, when its result comes, is a failed, blocked command.
   */
  notRun(): void {
    this.#notRun += 1;
  }

  /** Takes one TurnEvent; true when it changed a row (something new to send). */
  observe(event: TurnEvent): boolean {
    switch (event.type) {
      case 'tool_call':
        return this.#call(event);
      case 'tool_result':
        return this.#result(event);
      case 'permission':
        return this.#permission(event);
      default:
        return false;
    }
  }

  #now(): string {
    return (this.#opts.now?.() ?? new Date()).toISOString();
  }

  #touch(row: Row): true {
    row.seq = ++this.#seq;
    row.dirty = true;
    row.at = this.#now();
    return true;
  }

  #clean(text: string | null, max: number): string | null {
    if (!text) return null;
    const one = redact(shortenPaths(text, this.#opts)).replace(/\s+/g, ' ').trim();
    return one ? head(one, max).text : null;
  }

  #call(event: Extract<TurnEvent, { type: 'tool_call' }>): boolean {
    // Whombat's own: the server's row, from the call it ran. Its result must not land on another row.
    if (isWhombatMcpCall(event)) {
      if (event.id) this.#whombatIds.add(event.id);
      else this.#whombatOpen.set(event.name, (this.#whombatOpen.get(event.name) ?? 0) + 1);
      return false;
    }
    const classified = classifyTool(event);
    if (!classified) return false;
    const key = event.id ? boundKey(this.#opts.attempt, event.id) : `${this.#opts.attempt}:s${++this.#calls}`;
    const existing = this.#rows.get(key);
    const bare = this.#opts.bare === true;
    const shows = classified.evidence && !bare;
    const browser = browserToolOf(classified.tool) !== null;
    const object = bare ? null : this.#clean(callObject(classified, event.input, event.paths), OBJECT_MAX);
    // A browser row's evidence is its page, never what the call sent (BT-03).
    const input = shows
      ? browser
        ? callObject(classified, event.input, event.paths)
        : rawInput(classified.kind, event.input, event.paths)
      : null;
    if (existing) {
      // Announced again (ACP) or after a denial: fill in what is missing, never go back to running.
      if (existing.sealed) {
        if (!existing.evidence && shows && input) {
          existing.evidence = boundEvidence(input, null, this.#opts);
          return this.#touch(existing);
        }
        return false;
      }
      return false;
    }
    const row: Row = {
      key,
      seq: 0,
      dirty: true,
      kind: classified.kind,
      tool: classified.tool,
      status: 'running',
      object,
      exitCode: null,
      failure: null,
      evidence: shows ? boundEvidence(input, null, this.#opts) : null,
      shows,
      input,
      command: SHELL_TOOLS.has(event.name) ? commandOf(obj(event.input)) : null,
      at: '',
      sealed: false,
      name: event.name,
      hasId: Boolean(event.id),
    };
    this.#rows.set(key, row);
    return this.#touch(row);
  }

  /** The row a result belongs to: by id, else the oldest running call without an id (same name first). */
  #rowFor(id: string | undefined, name: string): Row | undefined {
    if (id) return this.#rows.get(boundKey(this.#opts.attempt, id));
    const open = [...this.#rows.values()].filter((r) => !r.hasId && r.status === 'running');
    return open.find((r) => r.name === name) ?? open[0];
  }

  /** Whether a result is of a Whombat MCP call (no row here); consumes an id-less one's place. */
  #whombatResult(event: Extract<TurnEvent, { type: 'tool_result' }>): boolean {
    if (event.id) return this.#whombatIds.has(event.id);
    const open = this.#whombatOpen.get(event.name) ?? 0;
    if (open > 0) {
      this.#whombatOpen.set(event.name, open - 1);
      return true;
    }
    return whombatToolName(event.name) !== null;
  }

  #result(event: Extract<TurnEvent, { type: 'tool_result' }>): boolean {
    if (this.#whombatResult(event)) return false;
    const row = this.#rowFor(event.id, event.name);
    if (!row || row.sealed || row.status !== 'running') return false;
    const outcome = event.outcome ?? {};
    const bare = this.#opts.bare === true;
    if (this.#notRun > 0 && SHELL_TOOLS.has(row.name) && refusedOutput(outcome.output)) {
      // The exec service didn't run it: it kept failing the same way (HC-05). A command row naming it, whatever kind
      // the provider read the command as (Codex: a read or a search).
      this.#notRun -= 1;
      row.status = 'failed';
      row.failure = 'blocked';
      row.kind = 'command';
      if (row.command && !bare) {
        row.object = this.#clean(row.command, OBJECT_MAX);
        if (row.shows) row.input = row.command;
      }
    } else if (event.ok) {
      row.status = 'done';
    } else {
      row.status = 'failed';
      row.failure =
        outcome.error === 'denied' ? 'denied' : outcome.error === 'cancelled' ? 'cancelled' : 'error';
    }
    if (!bare && typeof outcome.exitCode === 'number') row.exitCode = outcome.exitCode;
    if (row.shows) {
      // Output only where it is the action's own result: a command's, or why an edit failed. Never file contents.
      const output =
        row.kind === 'command' || (row.kind === 'edit' && row.status === 'failed')
          ? (outcome.output ?? null)
          : null;
      row.evidence = boundEvidence(row.input, output, this.#opts);
    }
    return this.#touch(row);
  }

  #permission(event: Extract<TurnEvent, { type: 'permission' }>): boolean {
    // Allowed calls show as their own rows; a denial is the action's row (WS-13: “Not allowed: {tool}”).
    if (event.allowed) return false;
    const key = event.id
      ? boundKey(this.#opts.attempt, event.id)
      : `${this.#opts.attempt}:p${++this.#permissions}`;
    const existing = this.#rows.get(key);
    const bare = this.#opts.bare === true;
    const target = bare ? null : this.#clean(event.target ?? null, OBJECT_MAX);
    const detail = [existing?.input ?? null, event.reason ?? null].filter(Boolean).join('\n') || null;
    const row: Row = existing ?? {
      key,
      seq: 0,
      dirty: true,
      kind: 'permission',
      tool: event.tool.slice(0, TOOL_MAX) || 'tool',
      status: 'failed',
      object: null,
      exitCode: null,
      failure: 'denied',
      evidence: null,
      shows: false,
      input: null,
      command: null,
      at: '',
      sealed: true,
      name: event.tool,
      hasId: Boolean(event.id),
    };
    if (row.sealed && existing) return false;
    row.kind = 'permission';
    row.status = 'failed';
    row.failure = 'denied';
    row.sealed = true;
    row.object = target;
    row.evidence = bare ? null : boundEvidence(detail, null, this.#opts);
    this.#rows.set(key, row);
    return this.#touch(row);
  }

  #report(r: Row): ActivityReport {
    return {
      key: r.key,
      seq: r.seq,
      kind: r.kind,
      tool: r.tool,
      status: r.status,
      object: r.object,
      exitCode: r.exitCode,
      failure: r.failure,
      keyNeeded: null,
      approvalId: null,
      evidence: r.evidence,
      at: r.at,
    };
  }
}
