/**
 * Whombat's tool policy for a Hermes turn (docs/decisions/hermes-engine.md HE-17, HE-44, HE-S147…): the plugin's
 * `$HERMES_HOME/whombat-policy.json` (`whombat_hermes/policy.py`), written by the provider before every turn from the
 * agent's keys. Hermes's `pre_tool_call` hook reads it for every tool call — Hermes's own tools by their names, Claude
 * Code's by Claude's — and the first rule that matches decides:
 *
 * - Whombat's own tools run: the server's keys engine decides behind each of them (servers and connections keep
 *   “Asks you first” there).
 * - File tools never reach into the profile (memory, sessions, sign-ins, this very file) or the CLI's sign-in home:
 *   Claude Code's may read a skill's files; Hermes's own (`HERMES_FILE_TOOLS`, which run beside the profile) may read
 *   and change the skills in it (one-person.md OP-07, OP-08), never Whombat's bookkeeping there.
 * - The tools behind a key (`KEYED_TOOLS`): Allowed runs, Ask asks a person (`approve` with the key: Hermes's approval
 *   gate → ACP `session/request_permission` → the runner → a card for the person), Off blocks.
 * - Commands and files run (each command in its own sandbox, whose guard asks about consequential ones, OP-S107); the
 *   person's own memory, sessions, skills and task list run; sub-agents (under this same policy), Hermes's questions
 *   (whose cards are declined: the agent asks in the conversation) and looking at an image run.
 * - A Feedback assessment that may look at the reported website gets the browser's looking tools only (FB-28).
 * - Anything else is blocked: a Hermes tool no key covers (cron, kanban, messaging, connectors, the desktop)
 *   is Whombat's to do, or nobody's.
 *
 * Pure; the file is JSON (`hermesPolicyJson`).
 */
import type { DispatchContext } from '@whombat/core/contracts';
import { AHEAD_TOOL_NAMES } from '@whombat/core/domain';
import { KEY_CATALOG, type KeyId } from '@whombat/core/keys';
import type { ToolAsk } from '../contract';
import { toolKeyAccess } from '../persona/access';
import { ASSESSOR_BROWSER_BLOCKED } from './assessment';
import { SKILLS_STATE_DIR } from './skills';

export const HERMES_POLICY_FILE = 'whombat-policy.json';

export type HermesPolicyAction = 'allow' | 'approve' | 'block';

export interface HermesPolicyRule {
  /** Tool name patterns (`fnmatch`). */
  tools: string[];
  action: HermesPolicyAction;
  /** What the agent reads when a `block` stops the call. */
  message?: string;
  /** The key an `approve` stands for: the runner asks a person for it. */
  key?: KeyId;
  /** Only calls whose path arguments lie inside these directories (`$HERMES_HOME`, `$NAME`, or absolute). */
  paths?: string[];
}

export interface HermesPolicy {
  rules: HermesPolicyRule[];
  default: HermesPolicyAction;
  /**
   * Hermes's post-answer memory and skill review runs after the turn; false for a Looks ahead check (Whombat
   * looks-ahead.md), which read strangers' text: the plugin gives it a review that does nothing. Absent: true.
   */
  review?: boolean;
}

/**
 * Whombat's web search is search only (web-search.md): `web_extract` has no backend, and Hermes's own error would ask the
 * agent to configure one.
 */
export const WEB_EXTRACT_REFUSED =
  'Pages aren’t read with web_extract here: open them with the browser tools, or fetch them with curl in your commands.';

/** The tools each key turns, by Hermes's names (v0.22.5) and Claude Code's. */
export const KEYED_TOOLS = {
  'web.browse': ['web_search', 'web_extract', 'x_search', 'WebFetch', 'WebSearch'],
  // Hermes's browser on the agent's Chromium (HE-42, OP-S113): every `browser_*` tool, its credential vault included.
  'browser.use': ['browser_*'],
} as const satisfies Partial<Record<KeyId, readonly string[]>>;

export type ToolKeyId = keyof typeof KEYED_TOOLS;

/**
 * Whombat's MCP tools, as Claude Code (`mcp__whombat__…`) and Hermes (`mcp__editor_whombat_<tag>__…`) name them, and the
 * person's Vault MCP servers' (`mcp__vault_<entry key>__…`: the tools the person left on, HE-S154). In a pod a Vault
 * server is the session's own (`mcp__editor_vault_<entry key>_<tag>__…`, hermes-native.md HN-W07): allowed tool by tool
 * for the keys on in this turn (`HermesPolicyOptions.pod`), never as a whole.
 */
export const WHOMBAT_TOOL_PATTERNS = ['mcp__whombat__*', 'mcp__editor_whombat_*', 'mcp__vault_*'];

/**
 * A tool of a session's own MCP server as Hermes names it (`gateway/session_local_mcp.py`): `mcp__editor_<server>_<8 hex
 * tag>__<tool>`, the names with every character outside `[A-Za-z0-9_]` as `_`. Exactly that server's, not one whose name
 * starts with it.
 */
export function editorToolPattern(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
  return `mcp__editor_${clean(server)}_${'[0-9a-f]'.repeat(8)}__${clean(tool)}`;
}

/** What the agent reads when a session's Vault server is no key of this turn's (switched off since it began, HN-W07). */
export const VAULT_KEY_OFF = 'That key isn’t on for you in this conversation now, so this didn’t run.';
/** What the agent reads when its browser tools are called in a turn without a browser (a pod's session has them). */
export const NO_BROWSER = 'There’s no browser in this turn, so this didn’t run.';

/**
 * Hermes's `browser_exec` runs the model's Python in Hermes's own process, beside the profile's sign-ins (HE-S300): never
 * here. Its toolset is off in the config too; this holds whatever toolset a Hermes puts it in.
 */
export const BROWSER_EXEC_REFUSED =
  'browser_exec isn’t available here: use browser_navigate, browser_snapshot, browser_click and the other browser tools.';

/** Commands and files: Hermes's run in the commands' sandboxes; Claude Code's shell does, its file tools in its folder. */
const WORK_TOOLS = [
  'terminal',
  'process_manage',
  'read_file',
  'write_file',
  'patch',
  'search_files',
  'execute_code',
  'Bash',
  'BashOutput',
  'KillShell',
  'KillBash',
  'Read',
  'Edit',
  'MultiEdit',
  'Write',
  'Glob',
  'Grep',
  'LS',
  'NotebookEdit',
];

/** The person's own things (their profile) and the turn's own ways of working. */
const OWN_TOOLS = [
  'memory',
  'session_search',
  'skills_list',
  'skill_view',
  'skill_manage',
  'todo_list',
  'TodoWrite',
  'delegate_task',
  'Agent',
  'Task',
  'clarify',
  'vision_analyze',
];

/** Claude Code's tools that read or write files. */
const FILE_TOOLS = ['Read', 'Edit', 'MultiEdit', 'Write', 'Glob', 'Grep', 'LS', 'NotebookEdit'];
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS'];
/** Hermes's own file tools (v0.22.5 `tools/file_tools.py`): they run in Hermes's process, beside the profile. */
export const HERMES_FILE_TOOLS = ['read_file', 'write_file', 'patch', 'search_files'];

export const PROFILE_REFUSED =
  'That folder is Whombat’s own (your memory, sessions and sign-ins): use your memory and session tools instead.';
export const TOOL_REFUSED = 'Whombat doesn’t use this tool; do it through Whombat’s tools or your commands.';
/**
 * A look's turn finishes the look itself (Whombat look-research.md): a helper Hermes starts in the background runs
 * after the turn ended, without Whombat's tools, so nothing it found would ever be reported.
 */
export const LOOK_HELPERS_REFUSED =
  'Look into it yourself in this turn and end with look_report: a helper would run after the turn ends, without Whombat’s tools.';
/** Hermes's and Claude Code's ways of handing work to a helper. */
const HELPER_TOOLS = ['delegate_task', 'Agent', 'Task'];
export const ASSESSOR_BROWSER_REFUSED =
  'While assessing a report the browser only looks: open, read, click, scroll and go back.';

/** What the agent reads when a key is off for a tool. */
export function keyOffText(keyId: ToolKeyId): string {
  return `“${KEY_CATALOG[keyId].label}” is off for you, so this didn’t run.`;
}

export interface HermesPolicyOptions {
  /** A missing answer is recovered from the work already done, without running any more tools. */
  replyOnly?: boolean;
  /** Directories besides the profile that file tools stay out of: the CLI's sign-in home. */
  privateDirs?: readonly string[];
  /**
   * A Feedback assessment with a look at the reported website (FB-28, HE-S140): its browser tools but the ones that do
   * more than look (`ASSESSOR_BROWSER_BLOCKED`), and typing only to fill a login of that website it has (FB-33).
   */
  assessorBrowser?: { logins: boolean } | null;
  /**
   * The turn runs in its person's pod (hermes-native.md HN-W07, HN-W09): a session's tools were fixed when it began, so
   * the policy is the gate — the browser's tools only when the turn has a browser, the Vault servers' tools only for the
   * keys on now (`vault`: each server's name, `vault_<entry key>`, and the tools the person left on).
   */
  pod?: { browser: boolean; vault: readonly { name: string; tools: readonly string[] }[] } | null;
}

/**
 * A Looks ahead check (Whombat looks-ahead.md) reads strangers' text — mail, web pages — while it holds the person's:
 * Whombat's own tools only (the server serves it just the calendar, the mail, its web tools and its report), nothing of
 * Hermes's: no memory, skills or sessions (the post-answer review inherits this, so nothing it read is remembered), no
 * commands, files, browser, web of its own, Vault or helpers; and no post-answer review at all (`review: false`).
 */
export const AHEAD_REFUSED =
  'While checking ahead you use only Whombat’s tools: search_web, read_web_page, the mail and ahead_report.';

/**
 * A Looks ahead check's own tools as Claude Code and Hermes name them (`mcp__whombat__<tool>`,
 * `mcp__editor_whombat_<tag>__<tool>`): exactly `AHEAD_TOOL_NAMES`, so this policy holds on its own as well as the server.
 */
const AHEAD_TOOL_PATTERNS = AHEAD_TOOL_NAMES.flatMap((tool) => [
  `mcp__whombat__${tool}`,
  `mcp__editor_whombat_*__${tool}`,
]);

/** The turn's policy from its context: see the file comment. */
export function hermesPolicy(ctx: DispatchContext, options: HermesPolicyOptions = {}): HermesPolicy {
  if (ctx.dispatch.trigger === 'ahead' && !options.replyOnly)
    return {
      default: 'block',
      review: false,
      rules: [
        { tools: AHEAD_TOOL_PATTERNS, action: 'allow' },
        { tools: ['*'], action: 'block', message: AHEAD_REFUSED },
      ],
    };
  if (options.replyOnly)
    return {
      default: 'block',
      ...(ctx.dispatch.trigger === 'ahead' ? { review: false } : {}),
      rules: [
        {
          tools: ['*'],
          action: 'block',
          message:
            'Give the person your answer from the findings already in this session. Do not run more tools.',
        },
      ],
    };
  const keyed: HermesPolicyRule[] = (Object.keys(KEYED_TOOLS) as ToolKeyId[]).map((key) => {
    const tools = [...KEYED_TOOLS[key]];
    const access = toolKeyAccess(ctx, key);
    if (access === 'allow') return { tools, action: 'allow' };
    if (access === 'ask') return { tools, action: 'approve', key };
    return { tools, action: 'block', message: keyOffText(key) };
  });
  const look = options.assessorBrowser;
  const assessor: HermesPolicyRule[] = look
    ? [
        {
          tools: [...ASSESSOR_BROWSER_BLOCKED, ...(look.logins ? [] : ['browser_type'])],
          action: 'block',
          message: ASSESSOR_BROWSER_REFUSED,
        },
        { tools: [...KEYED_TOOLS['browser.use']], action: 'allow' },
      ]
    : [];
  const pod = options.pod;
  const podRules: HermesPolicyRule[] = pod
    ? [
        ...pod.vault.flatMap((server) =>
          server.tools.length
            ? [
                {
                  tools: server.tools.map((t) => editorToolPattern(server.name, t)),
                  action: 'allow' as const,
                },
              ]
            : [],
        ),
        { tools: ['mcp__editor_vault_*'], action: 'block', message: VAULT_KEY_OFF },
        ...(pod.browser ? [] : [{ tools: ['browser_*'], action: 'block' as const, message: NO_BROWSER }]),
      ]
    : [];
  return {
    rules: [
      { tools: ['browser_exec'], action: 'block', message: BROWSER_EXEC_REFUSED },
      ...podRules,
      { tools: [...WHOMBAT_TOOL_PATTERNS], action: 'allow' },
      // The skills are the agent's to read and change (Hermes's tools; Claude Code's read), but not Whombat's
      // bookkeeping among them; the rest of the profile is Whombat's. An `allow` with paths holds only when every path
      // of the call is inside.
      {
        tools: [...FILE_TOOLS, ...HERMES_FILE_TOOLS],
        paths: [`$HERMES_HOME/skills/${SKILLS_STATE_DIR}`],
        action: 'block',
        message: PROFILE_REFUSED,
      },
      { tools: [...HERMES_FILE_TOOLS, ...READ_TOOLS], paths: ['$HERMES_HOME/skills'], action: 'allow' },
      {
        tools: [...FILE_TOOLS, ...HERMES_FILE_TOOLS],
        paths: ['$HERMES_HOME', ...(options.privateDirs ?? [])],
        action: 'block',
        message: PROFILE_REFUSED,
      },
      ...assessor,
      // While “Browse the web” is off its own rule below says so; otherwise web_extract is refused with the way that works.
      ...(toolKeyAccess(ctx, 'web.browse') === 'deny'
        ? []
        : [{ tools: ['web_extract'], action: 'block' as const, message: WEB_EXTRACT_REFUSED }]),
      ...keyed,
      ...(ctx.dispatch.trigger === 'look' || ctx.dispatch.trigger === 'look_fix'
        ? [{ tools: HELPER_TOOLS, action: 'block' as const, message: LOOK_HELPERS_REFUSED }]
        : []),
      { tools: [...WORK_TOOLS, ...OWN_TOOLS], action: 'allow' },
      { tools: ['*'], action: 'block', message: TOOL_REFUSED },
    ],
    default: 'block',
  };
}

/** The file's text. */
export function hermesPolicyJson(policy: HermesPolicy): string {
  return `${JSON.stringify(policy, null, 2)}\n`;
}

/** Hermes's display target of a plugin's approval (`tools.approval.request_tool_approval`): `<tool> (plugin approval rule)`. */
const PLUGIN_APPROVAL = /^<([^<>\s]{1,120})> \(plugin approval rule\)$/;
/** The plugin's kind of a keyed ask (`whombat_hermes/policy.py` `ASK_KIND`). */
export const ASK_KIND = 'whombat_ask';

/**
 * A permission request Hermes's approval gate sent for a plugin's `approve` (its `rawInput`: the display target as
 * `command`, the plugin's message as `description`): null when it isn't one; `ask` null when it isn't Whombat's keyed
 * ask (nobody is asked about anything else).
 */
export function pluginApproval(rawInput: unknown): { tool: string; ask: ToolAsk | null } | null {
  const raw = typeof rawInput === 'object' && rawInput !== null ? (rawInput as Record<string, unknown>) : {};
  const command = typeof raw.command === 'string' ? raw.command : '';
  const tool = PLUGIN_APPROVAL.exec(command)?.[1];
  if (!tool) return null;
  let said: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(typeof raw.description === 'string' ? raw.description : '');
    if (typeof parsed === 'object' && parsed !== null) said = parsed as Record<string, unknown>;
  } catch {
    return { tool, ask: null };
  }
  const keyId = said.key;
  if (said.kind !== ASK_KIND || said.tool !== tool || (keyId !== 'web.browse' && keyId !== 'browser.use'))
    return { tool, ask: null };
  const detail = typeof said.detail === 'string' ? said.detail.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  const id = typeof said.ask === 'string' && ASK_ID.test(said.ask) ? said.ask : undefined;
  return { tool, ask: { keyId, tool, detail, ...(id ? { id } : {}) } };
}

/** An ask's id as the plugin makes it (32 hex). */
const ASK_ID = /^[0-9a-f]{32}$/;
/** Where the agent's words for an ask that didn't run go, in the profile (`whombat_hermes/policy.py` reads them). */
export const ASK_ANSWERS_DIR = 'whombat-asks';
