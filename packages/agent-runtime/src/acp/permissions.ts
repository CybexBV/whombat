/**
 * `session/request_permission` (bp-acp.md BP-E07). The runtime asks before a tool runs; Whombat answers for
 * the agent, never a person:
 *
 * - Whombat MCP tools are allowed — Whombat's own and the Vault's bridged ones, served through Whombat's `/mcp`: the
 *   server's keys engine decides behind every one of them.
 * - Everything else only where the sandbox walls it in: reading, searching, editing, moving, deleting and running
 *   commands; fetching only with the “Browse the web” key; never switching the runtime's own mode (that would widen
 *   its permissions) and never a tool Whombat doesn't know.
 *
 * Options are chosen by `kind`, never by id (ids are the runtime's own words); `allow_always` is never
 * chosen, so every call is asked again. With no fitting option the answer is `cancelled`.
 */
import type {
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolKind,
} from '@agentclientprotocol/sdk';
import { MCP_SERVER_NAME } from '@whombat/core/contracts';

export interface KnownToolCall {
  /** Whombat's name for it: the bare tool name for Whombat MCP tools (`post_message`), else the runtime's. */
  name: string;
  kind: ToolKind | null;
  /** A tool of Whombat's own MCP server. */
  whombat: boolean;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

const TOOL = '[A-Za-z0-9_.-]{1,80}';
const TOOL_NAME = new RegExp(`^${TOOL}$`);
/**
 * `mcp__whombat__post_message` (Claude Code), `mcp.whombat.post_message` (Codex), `whombat.post_message`, and Hermes's
 * name for a server its ACP client gave it, `mcp__editor_whombat_<hash>__post_message`.
 */
const WHOMBAT_TOOL = new RegExp(
  `^(?:mcp(?:__|\\.))?(?:${MCP_SERVER_NAME}|editor_${MCP_SERVER_NAME}_[0-9a-f]{4,16})(?:__|\\.|/|:)(${TOOL})$`,
);

/** The bare Whombat tool name in `text`, if it names one. */
export function whombatToolName(text: string | null | undefined): string | null {
  if (!text) return null;
  return WHOMBAT_TOOL.exec(text.trim())?.[1] ?? null;
}

/**
 * What a `tool_call` (or a permission request's `toolCall`) is. A Whombat MCP tool is recognised only from
 * what a runtime marks as a tool name — Claude Code's `_meta.claudeCode.toolName`, Codex's `is_mcp_tool_call`
 * with its `mcp.<server>.<tool>` title or `{server, tool}` input, or the tool call's `name` — or from a title
 * when the kind is `other` (a shell command's title is the command itself, which could spell anything): the whole
 * title, or its tool name before `: ` (Hermes titles a call `<tool>: <preview>`).
 */
export function describeToolCall(update: {
  title?: string | null;
  name?: string | null;
  kind?: ToolKind | null;
  rawInput?: unknown;
  _meta?: { [key: string]: unknown } | null;
}): KnownToolCall {
  const meta = obj(update._meta);
  const claudeName = str(obj(meta.claudeCode).toolName);
  const input = obj(update.rawInput);
  const kind = update.kind ?? null;
  const candidates: (string | null)[] = [str(update.name), claudeName];
  if (meta.is_mcp_tool_call === true) {
    candidates.push(str(update.title));
    const server = str(input.server);
    const tool = str(input.tool);
    if (server && tool) candidates.push(`${server}.${tool}`);
  }
  if (kind === 'other' || kind === null) {
    const title = str(update.title);
    candidates.push(title, title ? titleToolName(title) : null);
  }
  for (const c of candidates) {
    const tool = whombatToolName(c);
    if (tool) return { name: tool, kind, whombat: true };
  }
  const title = str(update.title);
  const titled = (kind === 'other' || kind === null) && title ? titleToolName(title) : null;
  const name = claudeName ?? str(update.name) ?? titled ?? title ?? kind ?? 'tool';
  return { name: name.slice(0, 120), kind, whombat: false };
}

/** The tool name of a `<tool>: <preview>` title (Hermes's `build_tool_title`), or null. */
function titleToolName(title: string): string | null {
  const at = title.indexOf(': ');
  const name = at > 0 ? title.slice(0, at) : null;
  return name && TOOL_NAME.test(name) ? name : null;
}

/** Kinds an agent may use: its file and shell tools, walled by the task sandbox and the commands' own (HE-S22). */
const WALLED_KINDS: ReadonlySet<ToolKind> = new Set([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
]);

export interface PermissionPolicy {
  /** The agent holds “Browse the web”. */
  network: boolean;
}

export interface PermissionDecision {
  allow: boolean;
  /** Why, in Whombat's words (logged as a tool event). */
  reason: string;
}

/** Whether a tool call may run, and why. Pure; tested per rule. */
export function decidePermission(tool: KnownToolCall, policy: PermissionPolicy): PermissionDecision {
  if (tool.whombat) return { allow: true, reason: 'a Whombat tool: the keys engine decides' };
  if (tool.kind === 'fetch')
    return policy.network
      ? { allow: true, reason: 'the key to browse the web' }
      : { allow: false, reason: 'no key to browse the web' };
  if (tool.kind === 'switch_mode')
    return { allow: false, reason: 'the runtime’s mode is not the agent’s to change' };
  if (tool.kind && WALLED_KINDS.has(tool.kind)) return { allow: true, reason: 'walled by the sandbox' };
  return { allow: false, reason: `${tool.name} is not a tool Whombat agents use` };
}

const pick = (options: readonly PermissionOption[], kinds: readonly PermissionOptionKind[]) => {
  for (const kind of kinds) {
    const option = options.find((o) => o.kind === kind);
    if (option) return option;
  }
  return null;
};

/**
 * The answer to one request: `allow_once` to allow; `reject_once` (else `reject_always`) to reject; `cancelled`
 * when the request offers no such option, or the turn is being cancelled.
 */
export function permissionResponse(
  request: Pick<RequestPermissionRequest, 'options'>,
  decision: PermissionDecision | 'cancelled',
): RequestPermissionResponse {
  if (decision === 'cancelled') return { outcome: { outcome: 'cancelled' } };
  const option = decision.allow
    ? pick(request.options, ['allow_once'])
    : pick(request.options, ['reject_once', 'reject_always']);
  return option
    ? { outcome: { outcome: 'selected', optionId: option.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}
