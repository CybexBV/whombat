/**
 * Whombat's own tools as activity rows, from the calls the server ran (hermes-engine.md, stream E; work-supervision.md
 * WS-11…WS-15). The server runs every call of its MCP tools for a dispatch, so it records the row itself — the tool and
 * its outcome from the tool's own structured answer — instead of the runner reading it back from the provider: Hermes
 * passes a Whombat tool's answer over ACP only as rendered text. The runner reports every other tool
 * (`apps/runner/src/activity.ts`, which skips Whombat's).
 *
 * - One row per call, keyed `<attempt>:mcp-<id>`: `id` is drawn by the server for the call (JSON-RPC ids repeat across
 *   MCP connections and reconnects of one turn), `attempt` is the dispatch's claim. Written `running` (seq 1) before the
 *   tool runs and finished (seq 2) after, each through `recordActivity` in its own `transactAccount`: the same rules,
 *   copy, scrubbing, approval check, run and `activity.updated` frames as the runner's reports.
 * - Only for a live dispatch (claimed or running), checked under a share lock on the dispatch so a requeue or an end
 *   can't slip in between; a finish never revives a row the end interrupted meanwhile (WS-15).
 * - The fields are the ones the runner reported for these tools: Vault tools one neutral row (VT-53), the browser's
 *   `web` rows with the opened page (BT-03), connector tools `tool` rows without content, Whombat's own `whombat` rows.
 *   Outcome: `pending_approval` (or `request_approval`'s `ok`) waits with its approval, `blocked` fails with the key, a
 *   refusal, a browser refusal or an MCP error fails — a Whombat tool's with the reason the agent got (RA-DS49),
 *   redacted and bounded — else done. A Feedback assessment's rows are bare (`recordActivity`, WS-14).
 * - Recording never fails the call: an error is logged and the tool's answer goes back as it was.
 */
import { randomBytes } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
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
  redactActivitySecrets as redactSecrets,
} from '@whombat/core';
import { eq } from 'drizzle-orm';

/** A browser tool's bare name, whatever prefixed it (`isBrowserActivityTool`), or null for any other tool. */
const browserToolOf = (name: string): string | null =>
  isBrowserActivityTool(name) ? (name.split(/__|\./).at(-1) ?? name) : null;

import type { AgentAuth } from '../auth/agent-tokens';
import { dispatches } from '../db/schema/index';
import type { Services } from '../services';
import { recordActivity, VAULT_ACTIVITY_TOOL } from './activity';

export { redactSecrets };

const OBJECT_MAX = 300;
const TOOL_MAX = 120;
const KEY_NEEDED_MAX = 80;
/** Most characters of a failed Whombat call's reason a row keeps (its first 160 are the row's detail). */
export const REASON_MAX = 500;
const LIVE = new Set(['claimed', 'running']);

function head(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One line, redacted, then bounded (so no secret is left half there); null when empty. */
function clean(text: string | null, max: number): string | null {
  const one = text ? redactSecrets(text).replace(/\s+/g, ' ').trim() : '';
  return one ? head(one, max) : null;
}

/* The call ------------------------------------------------------------------------------------- */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});

const WHOMBAT_TOOLS: ReadonlySet<string> = new Set(MCP_TOOL_NAMES);

export interface McpActivityCall {
  kind: ActivityKind;
  /** Normalized as the runner did: `whombat.post_message`, `mail.search`, `whombat.browser_open`. */
  tool: string;
  object: string | null;
}

/** What a call of the MCP server's tool `name` is as a row. Pure. */
export function mcpActivityCall(name: string, args: unknown): McpActivityCall {
  // Every Vault tool (a bridged `vt_…` one, `browser_sign_in` among them) is one neutral row (VT-53, VT-D33).
  if (isVaultActivityTool(name)) return { kind: 'whombat', tool: VAULT_ACTIVITY_TOOL, object: null };
  const browser = browserToolOf(name);
  // The browser's: the opened page without its query, never what was typed (BT-03).
  if (browser)
    return {
      kind: 'web',
      tool: `whombat.${browser}`,
      object: clean(browserActivityObject(browser, args), OBJECT_MAX),
    };
  if (WHOMBAT_TOOLS.has(name)) {
    // Connector tools (mail, calendar, files …) are the person's services: a `tool` row, never their content.
    const service = mcpToolConnector(name as McpToolName);
    if (service) {
      const rest = name.startsWith(`${service}_`) ? name.slice(service.length + 1) : name;
      return { kind: 'tool', tool: `${service}.${rest}`.slice(0, TOOL_MAX), object: null };
    }
    return { kind: 'whombat', tool: `whombat.${name}`.slice(0, TOOL_MAX), object: null };
  }
  // A name the server doesn't know (the call fails): the row names it, as the runner's did.
  return { kind: 'tool', tool: clean(name, TOOL_MAX) ?? 'tool', object: null };
}

/**
 * A Whombat tool's answers that mean the call did nothing (RA-DS49): a refusal, problems to fix, the memory tool's
 * misses, or nothing to do it on. Like an MCP error, they are failed rows. The browser's own are handled with its rows.
 */
const WHOMBAT_REFUSALS: ReadonlySet<string> = new Set([
  'refused',
  'invalid',
  'unavailable',
  'memory_full',
  'no_match',
  'ambiguous_match',
  'too_long',
  'scan_refused',
]);

/** Whombat tools whose failed row carries no reason (RA-DS49): the memory tool's answers quote what agents keep. */
const REASONLESS_TOOLS: ReadonlySet<string> = new Set(['whombat.memory']);

const APPROVAL_ID = /^apr_[A-Za-z0-9_-]{1,64}$/;

/**
 * Why a Whombat call failed, in the words the agent got (RA-DS49): an error's message and the arguments it names (never
 * its `details`), a refusal's reason, a message, or the problems to fix; else the answer's text without its code.
 * Redacted, one line, at most `REASON_MAX`. Pure.
 */
export function whombatReason(structured: Obj | undefined, text: string | null): string | null {
  const error = obj(structured?.error);
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  let reason: string | null = null;
  if (typeof error.message === 'string')
    reason = [
      error.message,
      ...Object.entries(obj(error.fields)).map(
        ([field, issues]) => `${field}: ${strings(issues).join('; ')}`,
      ),
    ].join(' ');
  else if (typeof structured?.reason === 'string') reason = structured.reason;
  else if (typeof structured?.message === 'string') reason = structured.message;
  else if (strings(structured?.problems).length) reason = strings(structured?.problems).join('; ');
  else if (text) reason = text.replace(/^\s*(?:Error:\s*)?[a-z_]+:\s+/, '').replace(/\n\s*-\s*/g, ' ');
  return clean(reason, REASON_MAX);
}

export interface McpActivityOutcome {
  status: ActivityStatus;
  failure: ActivityReport['failure'];
  keyNeeded: string | null;
  approvalId: string | null;
  evidence: ActivityEvidence | null;
}

/** The text an MCP answer carries (its text parts). */
function resultText(result: Pick<CallToolResult, 'content'>): string | null {
  const parts = (result.content ?? []).flatMap((c) => (c.type === 'text' ? [c.text] : []));
  return parts.length ? parts.join('\n') : null;
}

/** How the call ended, from the answer the server gave the agent. Pure. */
export function mcpActivityOutcome(
  call: McpActivityCall,
  result: Pick<CallToolResult, 'content' | 'structuredContent' | 'isError'>,
): McpActivityOutcome {
  const browser = browserToolOf(call.tool) !== null;
  // Whombat's own tools answer a commit outcome — the browser's too, on their web rows (BT-03).
  const answer = result.structuredContent;
  const structured =
    (call.kind === 'whombat' || browser) && typeof answer === 'object' && answer !== null
      ? (answer as Obj)
      : undefined;
  const status = typeof structured?.status === 'string' ? structured.status : null;
  // A Whombat tool's own row (not the Vault's neutral one, nor the browser's): did it refuse? (RA-DS49)
  const own = call.kind === 'whombat' && call.tool !== VAULT_ACTIVITY_TOOL;
  const out: McpActivityOutcome = {
    status: 'done',
    failure: null,
    keyNeeded: null,
    approvalId: null,
    evidence: null,
  };
  // `request_approval` answers `ok` with the request it made: the agent now waits for a person too (WS-13).
  if (status === 'pending_approval' || (call.tool === 'whombat.request_approval' && status === 'ok')) {
    const approvalId = typeof structured?.approvalId === 'string' ? structured.approvalId : null;
    out.status = 'waiting';
    out.approvalId = approvalId && APPROVAL_ID.test(approvalId) ? approvalId : null;
  } else if (status === 'blocked') {
    const label = obj(structured?.keyNeeded).label;
    out.status = 'failed';
    out.failure = 'blocked';
    out.keyNeeded = typeof label === 'string' ? head(label, KEY_NEEDED_MAX) : null;
  } else if (
    (browser && (status === 'refused' || status === 'failed')) ||
    (own && status !== null && WHOMBAT_REFUSALS.has(status)) ||
    result.isError === true
  ) {
    out.status = 'failed';
    out.failure = 'error';
  }
  if (own && out.status === 'failed' && out.failure === 'error' && !REASONLESS_TOOLS.has(call.tool)) {
    const reason = whombatReason(structured, resultText(result));
    if (reason) out.evidence = { input: null, output: reason, truncated: false };
  }
  return out;
}

/* Recording ------------------------------------------------------------------------------------ */

/** Writes one report of the call's row; null when the dispatch isn't live (`live`) or is gone. */
async function write(
  services: Services,
  dispatchId: string,
  row: { key: string | null; seq: number; call: McpActivityCall; outcome: McpActivityOutcome | null },
): Promise<string | null> {
  return services.pipeline.transactAccount(async (tx, session) => {
    // A share lock: a requeue or an end (which interrupts running rows) waits for this row, or this sees it ended.
    const [dispatch] = await tx.select().from(dispatches).where(eq(dispatches.id, dispatchId)).for('share');
    if (!dispatch || (row.key === null && !LIVE.has(dispatch.state))) return null;
    const key = row.key ?? `${Math.max(1, dispatch.attempts)}:mcp-${randomBytes(9).toString('base64url')}`;
    const now = services.clock();
    const report: ActivityReport = {
      key,
      seq: row.seq,
      kind: row.call.kind,
      tool: row.call.tool,
      object: row.call.object,
      exitCode: null,
      status: row.outcome?.status ?? 'running',
      failure: row.outcome?.failure ?? null,
      keyNeeded: row.outcome?.keyNeeded ?? null,
      approvalId: row.outcome?.approvalId ?? null,
      evidence: row.outcome?.evidence ?? null,
      at: now.toISOString(),
    };
    await recordActivity(tx, session, dispatch, [report], now);
    return key;
  });
}

/**
 * Runs one MCP tool call of a dispatch's agent (`run`) with its activity row: running before, finished after. Returns
 * the call's answer unchanged.
 */
export async function withToolActivity(
  services: Services,
  auth: Pick<AgentAuth, 'dispatchId'>,
  name: string,
  args: unknown,
  run: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const call = mcpActivityCall(name, args);
  const failed = (err: unknown) => {
    // The row's tool only: a Vault call's is neutral, and nothing the call carried reaches the log.
    services.log.warn(
      { err: err instanceof Error ? err.name : 'error', tool: call.tool, dispatchId: auth.dispatchId },
      'could not record a tool call’s activity',
    );
    return null;
  };
  const key = await write(services, auth.dispatchId, { key: null, seq: 1, call, outcome: null }).catch(
    failed,
  );
  const result = await run();
  if (key)
    await write(services, auth.dispatchId, {
      key,
      seq: 2,
      call,
      outcome: mcpActivityOutcome(call, result),
    }).catch(failed);
  return result;
}
