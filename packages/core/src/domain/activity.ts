/**
 * Observed agent activity (work-supervision WS-11…WS-17). The runner turns a provider's own tool events into
 * reports; the server keeps one row per action and updates it through its lifecycle. Copy is action + object +
 * outcome from facts the provider gave (“Edited invoice.ts”, “Command failed · exit 1”, “Waiting for approval”);
 * nothing is inferred from output text.
 */
import { z } from 'zod';
import {
  ActivityId,
  ApprovalId,
  BurrowId,
  ConversationId,
  DispatchId,
  MessageId,
  PrincipalId,
  RunId,
} from '../ids.js';
import { parseUrlAuthority } from '../vault/network.js';
import { isVaultActivityTool } from '../vault/tools.js';
import { Timestamp } from './common.js';
import { LinkRef } from './links.js';

export const ActivityKind = z.enum([
  /** Read a file, grep, glob, list, view an image. */
  'read',
  /** Wrote, edited or deleted files. */
  'edit',
  /** A shell command. */
  'command',
  /** Searched code or files. */
  'search',
  /** Fetched or searched the web. */
  'web',
  /** One of Whombat's own MCP tools (posting, runs, approvals, plans, canvases…). */
  'whombat',
  /** Another tool: a connector tool, an MCP server of the runtime. */
  'tool',
  /** Handed part of the turn to a subagent. */
  'delegate',
  /** A permission the provider asked for and Whombat's policy answered. */
  'permission',
]);
export type ActivityKind = z.infer<typeof ActivityKind>;

export const ActivityStatus = z.enum(['running', 'waiting', 'done', 'failed', 'interrupted']);
export type ActivityStatus = z.infer<typeof ActivityStatus>;

/** Why a finished action failed, as the provider or Whombat reported it. */
export const ActivityFailure = z.enum(['error', 'denied', 'blocked', 'cancelled']);
export type ActivityFailure = z.infer<typeof ActivityFailure>;

/** Redacted technical evidence behind a row (WS-14). Never thinking, reasoning, credentials or file contents. */
export const ActivityEvidence = z.object({
  /** The tool's input as the runner kept it: a command, a path, a query (≤ 1 KB, redacted). */
  input: z.string().max(1000).nullable(),
  /** The tail of the output (≤ 4 KB, redacted), when the provider gave one. */
  output: z.string().max(4000).nullable(),
  /** True when either was shortened. */
  truncated: z.boolean().default(false),
});
export type ActivityEvidence = z.infer<typeof ActivityEvidence>;

/** Most reports in one progress beat. */
export const ACTIVITY_REPORTS_MAX = 100;

/**
 * One observation of one action, sent by the runner with its progress beat (`ProgressBody.activity`). The server
 * upserts by `(dispatch, key)` and ignores a report whose `seq` isn't newer than the row's (WS-12).
 */
export const ActivityReport = z.object({
  /** `<attempt>:<provider tool id>` (or the runner's sequence number when the provider gives no id). */
  key: z.string().min(1).max(160),
  /** Per dispatch, increasing with every report the runner sends. */
  seq: z.number().int().nonnegative(),
  kind: ActivityKind,
  /** The provider's tool name, normalized: `Edit`, `shell`, `whombat.post_message` (`pack.tool` in old activity). */
  tool: z.string().min(1).max(120),
  status: ActivityStatus,
  /** What it acted on, shortened and redacted: a workdir-relative path, a command line, a query. */
  object: z.string().max(300).nullable().default(null),
  exitCode: z.number().int().nullable().default(null),
  failure: ActivityFailure.nullable().default(null),
  /** For `blocked`: the key the action needed. */
  keyNeeded: z.string().max(80).nullable().default(null),
  /** A Whombat tool that answered `pending_approval`: the approval it created. */
  approvalId: ApprovalId.nullable().default(null),
  evidence: ActivityEvidence.nullable().default(null),
  at: Timestamp,
});
export type ActivityReport = z.infer<typeof ActivityReport>;

/** A row of the activity feed. */
export const Activity = z.object({
  id: ActivityId,
  burrowId: BurrowId,
  dispatchId: DispatchId,
  /** The run the turn worked on, once there is one. */
  runId: RunId.nullable(),
  agentId: PrincipalId,
  conversationId: ConversationId,
  threadRootId: MessageId.nullable(),
  key: z.string().max(160),
  attempt: z.number().int().positive(),
  seq: z.number().int().nonnegative(),
  kind: ActivityKind,
  tool: z.string().max(120),
  status: ActivityStatus,
  /** “Edited invoice.ts”, “Command failed · exit 1”, “Waiting for approval”. */
  title: z.string().max(200),
  object: z.string().max(300).nullable(),
  /** A few words of outcome beside the title: “exit 1”, “approval #12 · approved”, “needs Deploy to staging”. */
  detail: z.string().max(160).nullable(),
  /** Failures, writes, commands, permissions and decisions stay visible when routine reads collapse (WS-17). */
  important: z.boolean(),
  approvalId: ApprovalId.nullable(),
  link: LinkRef.nullable(),
  evidence: ActivityEvidence.nullable(),
  startedAt: Timestamp,
  updatedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
});
export type Activity = z.infer<typeof Activity>;

/* ---------------------------------------------------------------------------------------------- */
/* Copy                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

/** Whombat tools: [while running, when done]. Unknown tools read “Used {tool}”. */
const WHOMBAT_VERBS: Record<string, readonly [string, string]> = {
  post_message: ['Posting a message', 'Posted a message'],
  reply_in_thread: ['Replying in the thread', 'Replied in the thread'],
  post_card: ['Posting a card', 'Posted a card'],
  read_conversation: ['Reading the conversation', 'Read the conversation'],
  search: ['Searching', 'Searched'],
  start_run: ['Starting a run', 'Started a run'],
  run_step: ['Updating the run', 'Updated the run'],
  run_log: ['Writing to the run log', 'Wrote to the run log'],
  run_tests: ['Reporting tests', 'Reported tests'],
  run_files: ['Reporting files', 'Reported files'],
  finish_run: ['Finishing the run', 'Finished the run'],
  request_approval: ['Asking for approval', 'Asked for approval'],
  perform_action: ['Acting', 'Acted'],
  open_pull_request: ['Opening a pull request', 'Opened a pull request'],
  review_pull_request: ['Reviewing the pull request', 'Reviewed the pull request'],
  merge_pull_request: ['Merging', 'Merged'],
  canvas_read: ['Reading a canvas', 'Read a canvas'],
  canvas_edit: ['Editing a canvas', 'Edited a canvas'],
  canvas_create: ['Creating a canvas', 'Created a canvas'],
  plan_create: ['Making a plan', 'Made a plan'],
  plan_read: ['Reading a plan', 'Read a plan'],
  plan_update: ['Updating the plan', 'Updated the plan'],
  post_answer: ['Answering', 'Answered'],
  set_status: ['Updating status', 'Updated status'],
  draft_automation: ['Drafting an automation', 'Drafted an automation'],
  automation_continue_run: ['Continuing the automation run', 'Continued the automation run'],
  read_attachment: ['Reading a file', 'Read a file'],
  upload_file: ['Uploading a file', 'Uploaded a file'],
  list_files: ['Listing files', 'Listed files'],
  record_deploy: ['Recording a deploy', 'Recorded a deploy'],
  connection_tools: ['Looking at a connection', 'Looked at a connection'],
  connection_call: ['Using a connection', 'Used a connection'],
  report_change: ['Noting a change', 'Noted a change'],
  report_done: ['Noting what I did', 'Noted what I did'],
  look_report: ['Noting what I found', 'Noted what I found'],
  watch_checks: ['Checking what Whombat watches', 'Checked what Whombat watches'],
  watch_status: ['Checking how everything is', 'Checked how everything is'],
  watch_history: ['Looking back at what went wrong', 'Looked back at what went wrong'],
  internet_exposure: ['Checking what the internet can reach', 'Checked what the internet can reach'],
  quiet_until: ['Keeping it quiet', 'Kept it quiet'],
};

/**
 * Whombat tools that are bookkeeping, not decisions: keeping a run's steps, log and files up to date, the RIGHT NOW
 * line, and reading what the agent can already see. They fold like reads (WS-17); failures still stand out.
 */
export const ROUTINE_WHOMBAT_TOOLS: ReadonlySet<string> = new Set([
  'run_step',
  'run_log',
  'run_files',
  'set_status',
  'read_conversation',
  'canvas_read',
  'plan_read',
  'read_attachment',
  'list_files',
  // What the agent finished, for the desk's Done today (done-today.md DN-01): bookkeeping, like the others.
  'report_done',
  // What the assistant found out about a look (look-research.md LR-05): bookkeeping too.
  'look_report',
]);

/** The connector tools in plain words, never what was searched or sent: [running, done, failed]. */
const CONNECTOR_VERBS: Record<string, readonly [string, string, string]> = {
  mail_search: ['Searching mail', 'Searched mail', 'Mail search failed'],
  mail_read: ['Reading an email', 'Read an email', 'Couldn’t read the email'],
  mail_attachment_open: ['Opening an attachment', 'Opened an attachment', 'Couldn’t open the attachment'],
  mail_draft: ['Drafting an email', 'Drafted an email', 'Couldn’t draft the email'],
  mail_send: ['Sending an email', 'Sent an email', 'Couldn’t send the email'],
  mail_organize: ['Organizing mail', 'Organized mail', 'Couldn’t organize mail'],
  mail_trash: ['Moving mail to the trash', 'Moved mail to the trash', 'Couldn’t trash the mail'],
  calendar_events: ['Checking the calendar', 'Checked the calendar', 'Couldn’t check the calendar'],
  calendar_create_event: ['Adding an event', 'Added an event', 'Couldn’t add the event'],
  calendar_update_event: ['Changing an event', 'Changed an event', 'Couldn’t change the event'],
  calendar_delete_event: ['Removing an event', 'Removed an event', 'Couldn’t remove the event'],
  files_search: ['Searching files', 'Searched files', 'File search failed'],
  files_read: ['Reading a file', 'Read a file', 'Couldn’t read the file'],
  files_create: ['Creating a file', 'Created a file', 'Couldn’t create the file'],
  files_share: ['Sharing a file', 'Shared a file', 'Couldn’t share the file'],
  files_trash: ['Moving a file to the trash', 'Moved a file to the trash', 'Couldn’t trash the file'],
  docs_edit: ['Editing a document', 'Edited a document', 'Couldn’t edit the document'],
  sheets_read: ['Reading a sheet', 'Read a sheet', 'Couldn’t read the sheet'],
  sheets_write: ['Writing to a sheet', 'Wrote to a sheet', 'Couldn’t write to the sheet'],
  contacts_search: ['Searching contacts', 'Searched contacts', 'Contact search failed'],
};

/**
 * The Vault's tools (`vault_save`, `vault_add_server`, Hermes's `browser_vault`) in the room's words (docs/decisions/
 * vault.md VT-53): never the tool, the entry or what was sent. The server keeps no object or evidence on such rows
 * (`isVaultActivityTool`).
 */
export const VAULT_ACTIVITY_VERBS = [
  'Using a private Vault entry',
  'Used a private Vault entry',
  'Couldn’t use a private Vault entry',
] as const;

/* The browser (Whombat hermes-engine.md HE-42; CT-1235) ---------------------------------------------------------- */

/**
 * Whether an activity row's tool is a browser tool, whatever the runner prefixed it with: Hermes's own (`browser_navigate`,
 * `browser_click`, …) and Whombat's `browser_preview`. Hermes's `browser_vault` (filling a login) is a Vault row
 * (`isVaultActivityTool`), checked first.
 */
export function isBrowserActivityTool(tool: string): boolean {
  return /^browser_[a-z_]+$/.test(bareToolName(tool));
}

/** The tools that open a page: their row's object is the address (`browserActivityObject`). */
const OPENING_TOOLS = ['browser_navigate', 'browser_back'];

/**
 * A URL as activity rows and events may show it: origin and path, without query and fragment. Anything that isn't an
 * absolute http(s) URL once cut at the first `?` or `#`, or holds a username or password in any form, is the empty
 * string: nothing of it is shown, since a malformed address can't be told apart from its credentials (CT-131). Callers
 * treat `''` as no URL.
 */
export function stripUrlForActivity(url: string): string {
  const parsed = parseActivityUrl(url.trim().replace(/[?#][\s\S]*$/, ''));
  return parsed ? `${parsed.origin}${parsed.path}` : '';
}

/**
 * The host a person reads for a URL or origin (“example.com”, “192.168.1.10:8123”, “[fd00::1]”): the port only when
 * it was written and isn't the default. Null when it isn't an http(s) URL.
 */
export function activityUrlHost(url: string): string | null {
  const u = parseActivityUrl(url.trim());
  if (!u) return null;
  const host = u.hostKind === 'ipv6' ? `[${u.host}]` : u.host;
  return u.explicitPort && u.port !== (u.scheme === 'https' ? 443 : 80) ? `${host}:${u.port}` : host;
}

function parseActivityUrl(text: string) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
  if (text.length === 0 || text.length > 4096 || /[\u0000-\u001f\u007f]/.test(text)) return null;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(text)?.[1]?.toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return null;
  const m = /^[A-Za-z]+:\/\/([^/?#\\]*)([^?#]*)([?#].*)?$/.exec(text);
  if (!m) return null;
  const authorityText = m[1] as string;
  const path = (m[2] as string) === '' ? '/' : (m[2] as string);
  if (path.includes('\\') || !path.startsWith('/') || /\s/.test(authorityText)) return null;
  const parsed = parseUrlAuthority(scheme, authorityText);
  return parsed.ok ? { scheme, ...parsed.authority, path } : null;
}

/**
 * The object a browser tool's activity row carries: for a tool that opens a page (`browser_navigate`) the URL without
 * credentials, query and fragment; for every other browser tool null (typed text or selected values never reach a row).
 * The server strips a stored browser row's object the same way, whatever a runner sent, and stores null for its empty
 * answer (a malformed URL or one with credentials).
 */
export function browserActivityObject(tool: string, input: unknown): string | null {
  if (!OPENING_TOOLS.includes(bareToolName(tool))) return null;
  const url = (input as { url?: unknown } | null)?.url;
  return typeof url === 'string' ? stripUrlForActivity(url) || null : null;
}

/** A tool's name without the runner's prefix (`whombat.`, `mcp__whombat__`). */
function bareToolName(tool: string): string {
  return tool.replace(/^whombat\./, '').replace(/^mcp__whombat__/, '');
}

/** A browser row's words: [running, done, failed], with and without the page's host. */
function browserVerbs(tool: string, host: string | null): readonly [string, string, string] {
  if (tool === 'browser_preview')
    return ['Previewing the build', 'Previewed the build', 'Couldn’t preview the build'];
  if (OPENING_TOOLS.includes(tool)) {
    if (host) return [`Opening ${host}`, `Opened ${host}`, `Couldn’t open ${host}`];
    return tool === 'browser_back'
      ? ['Going back a page', 'Went back a page', 'Couldn’t go back a page']
      : ['Opening a page', 'Opened a page', 'Couldn’t open the page'];
  }
  return host
    ? [`Using the browser on ${host}`, `Used the browser on ${host}`, `Couldn’t use the browser on ${host}`]
    : ['Using the browser', 'Used the browser', 'Couldn’t use the browser'];
}

/** A path's last segment: `billing/pdf/invoice.ts` → `invoice.ts`. */
export function activityObjectName(object: string | null): string | null {
  if (!object) return null;
  const trimmed = object.replace(/[/\\]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return i >= 0 && i < trimmed.length - 1 ? trimmed.slice(i + 1) : trimmed;
}

/** A command line shortened for a title. */
function commandName(object: string | null): string | null {
  if (!object) return null;
  const line = object.split('\n')[0]?.trim() ?? '';
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || null;
}

export interface ActivityCopyInput {
  kind: ActivityKind;
  tool: string;
  status: ActivityStatus;
  object: string | null;
  exitCode: number | null;
  failure: ActivityFailure | null;
  keyNeeded: string | null;
}

/**
 * Title, detail and importance of a row (WS-13). Titles say only what the provider reported: a command that ended
 * without an exit code is “Ran …”, not “passed”; an edit that failed is “Couldn’t edit …”.
 */
export function describeActivity(a: ActivityCopyInput): {
  title: string;
  detail: string | null;
  important: boolean;
} {
  const name = activityObjectName(a.object);
  const failed = a.status === 'failed';
  const running = a.status === 'running';
  const interrupted = a.status === 'interrupted';
  const detailOf = (): string | null => {
    if (a.failure === 'blocked') return a.keyNeeded ? `needs ${a.keyNeeded}` : 'blocked';
    if (a.failure === 'denied') return 'not allowed';
    if (a.failure === 'cancelled') return 'cancelled';
    if (a.exitCode !== null && a.exitCode !== 0) return `exit ${a.exitCode}`;
    if (interrupted) return 'the turn stopped';
    return null;
  };
  const detail = detailOf();
  const bare = a.tool.replace(/^whombat\./, '');
  const routine =
    a.kind === 'read' || a.kind === 'search' || (a.kind === 'whombat' && ROUTINE_WHOMBAT_TOOLS.has(bare));
  const important = routine ? failed || interrupted : true;

  if (isVaultActivityTool(a.tool)) {
    if (a.status === 'waiting') return { title: 'Waiting for approval', detail: null, important: true };
    const [doing, done, didnt] = VAULT_ACTIVITY_VERBS;
    const vaultDetail =
      a.failure === 'blocked'
        ? 'blocked'
        : a.failure === 'denied'
          ? 'not allowed'
          : a.failure === 'cancelled'
            ? 'cancelled'
            : interrupted
              ? 'the turn stopped'
              : null;
    return {
      title: running ? doing : failed ? didnt : `${done}${interrupted ? ' · interrupted' : ''}`,
      detail: vaultDetail,
      important: true,
    };
  }
  if (a.status === 'waiting') return { title: 'Waiting for approval', detail, important: true };
  if (a.failure === 'blocked') {
    return { title: a.keyNeeded ? `Blocked · needs ${a.keyNeeded}` : 'Blocked', detail, important: true };
  }
  if (a.kind === 'permission') {
    return {
      title: failed ? `Not allowed: ${a.object ?? a.tool}` : `Allowed: ${a.object ?? a.tool}`,
      detail,
      important: true,
    };
  }
  const suffix = interrupted ? ' · interrupted' : '';
  // The browser's tools (CT-1235): “Opened example.com”, “Used the browser on example.com”, whatever kind the runner
  // gave the row. The host comes from the object (a URL or an origin); nothing else of it shows.
  if (isBrowserActivityTool(a.tool)) {
    const [doing, done, didnt] = browserVerbs(
      bareToolName(a.tool),
      a.object ? activityUrlHost(a.object) : null,
    );
    return { title: running ? doing : failed ? didnt : `${done}${suffix}`, detail, important: true };
  }
  switch (a.kind) {
    case 'read':
      return {
        title: running
          ? `Reading ${name ?? 'files'}`
          : failed
            ? `Couldn’t read ${name ?? 'a file'}`
            : `Read ${name ?? 'files'}${suffix}`,
        detail,
        important,
      };
    case 'search':
      return {
        title: running
          ? 'Searching files'
          : failed
            ? 'Search failed'
            : `Searched ${name ? `for ${name}` : 'files'}${suffix}`,
        detail,
        important,
      };
    case 'edit':
      return {
        title: running
          ? `Editing ${name ?? 'files'}`
          : failed
            ? `Couldn’t edit ${name ?? 'files'}`
            : `Edited ${name ?? 'files'}${suffix}`,
        detail,
        important,
      };
    case 'command': {
      const cmd = commandName(a.object);
      if (running) return { title: cmd ? `Running ${cmd}` : 'Running a command', detail, important };
      if (failed) return { title: 'Command failed', detail: detail ?? cmd, important };
      return { title: `Ran ${cmd ?? 'a command'}${suffix}`, detail, important };
    }
    case 'web':
      return {
        title: running ? 'Looking on the web' : failed ? 'Web request failed' : `Looked on the web${suffix}`,
        detail: detail ?? a.object,
        important,
      };
    case 'delegate':
      return {
        title: running
          ? 'Working with a subagent'
          : failed
            ? 'Subagent failed'
            : `Subagent finished${suffix}`,
        detail,
        important,
      };
    case 'whombat': {
      const plain = CONNECTOR_VERBS[bare];
      if (plain) {
        const [doing, done, didnt] = plain;
        return { title: running ? doing : failed ? didnt : `${done}${suffix}`, detail, important };
      }
      const verbs = WHOMBAT_VERBS[bare];
      const [doing, done] = verbs ?? [`Using ${bare}`, `Used ${bare}`];
      return { title: running ? doing : failed ? `${doing} failed` : `${done}${suffix}`, detail, important };
    }
    case 'tool': {
      const tool = a.tool.replace(/^mcp__/, '').replace(/__/g, '.');
      return {
        title: running ? `Using ${tool}` : failed ? `${tool} failed` : `Used ${tool}${suffix}`,
        detail,
        important,
      };
    }
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Noise reduction (WS-17)                                                                        */
/* ---------------------------------------------------------------------------------------------- */

export type ActivityEntry =
  | { type: 'row'; activity: Activity }
  | {
      type: 'group';
      /** “Read 4 files”, “Ran 3 searches”, “Read 2 files and ran 1 search”. */
      title: string;
      items: Activity[];
    };

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Collapse consecutive finished routine reads, searches and bookkeeping (`ROUTINE_WHOMBAT_TOOLS`) of one turn into
 * one group; everything important stays a row of its own. Order is kept (oldest first in, oldest first out).
 */
export function collapseActivity(rows: readonly Activity[]): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  let run: Activity[] = [];
  const flush = () => {
    if (run.length >= 2) {
      const reads = run.filter((r) => r.kind === 'read').length;
      const searches = run.filter((r) => r.kind === 'search').length;
      const updates = run.length - reads - searches;
      const parts = [
        reads ? `read ${plural(reads, 'file', 'files')}` : null,
        searches ? `ran ${plural(searches, 'search', 'searches')}` : null,
        updates ? `made ${plural(updates, 'routine update', 'routine updates')}` : null,
      ].filter((p): p is string => !!p);
      const title =
        parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '');
      out.push({ type: 'group', title: title.charAt(0).toUpperCase() + title.slice(1), items: run });
    } else if (run[0]) {
      out.push({ type: 'row', activity: run[0] });
    }
    run = [];
  };
  for (const row of rows) {
    const routine =
      !row.important &&
      row.status === 'done' &&
      (row.kind === 'read' ||
        row.kind === 'search' ||
        (row.kind === 'whombat' && ROUTINE_WHOMBAT_TOOLS.has(row.tool.replace(/^whombat\./, ''))));
    const sameTurn = run.length === 0 || run[0]?.dispatchId === row.dispatchId;
    if (routine && sameTurn) {
      run.push(row);
      continue;
    }
    flush();
    if (routine) run.push(row);
    else out.push({ type: 'row', activity: row });
  }
  flush();
  return out;
}
