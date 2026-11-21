/**
 * Claude Code's usage, read through the unmodified CLI (docs/decisions/ui-improvements.md UI-R02, UI-R03; SUB-03):
 *
 * - The probe: one `claude -p` stream-JSON process with the person's `CLAUDE_CONFIG_DIR`, the host protocol's
 *   `control_request` `{subtype: 'get_usage', skip_behaviors: true}` (experimental in 2.1.283: “Requests the structured
 *   /usage data … Experimental — the response shape may change”), then stdin closes and the CLI exits. No user message
 *   is ever sent, so no model turn runs. The CLI calls claude.ai's usage endpoint with its own login; Whombat reads
 *   only the answer.
 * - Every turn: `rate_limit_event.rate_limit_info` (`status`, `resetsAt`, `rateLimitType`, `utilization` 0–1,
 *   `unifiedWindows.five_hour|seven_day` `{utilization 0–1, resetsAt unix}`), claude.ai subscriptions only.
 *
 * Parsing is pure and forgiving: an unknown or missing field reads as absent, never as an error.
 */

import { ClaudeCliProcess, launchCommand } from '../claude/cli';
import type { ProcessSpawner } from '../contract';
import { errorMessage, trimMessage } from '../support/errors';
import {
  isoOf,
  MAX_USAGE_WINDOWS,
  namedWindow,
  percent,
  statusOf,
  type UsageObservation,
  type UsageStatus,
  type UsageWindow,
  WINDOW_MINUTES,
} from './types';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null;

/** The `get_usage` request Whombat sends (the local transcript scan is skipped: only the plan's windows matter). */
export const CLAUDE_GET_USAGE = { subtype: 'get_usage', skip_behaviors: true } as const;

/** `rate_limits.<kind>` of the `get_usage` answer Whombat reads, in order. */
const GET_USAGE_KINDS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'] as const;

/**
 * The `get_usage` control response (`response.response`): `subscription_type` (`pro`, `max`, `team`, `enterprise`,
 * null for API keys and cloud providers), `rate_limits_available` (false: plan limits don't apply — an API key,
 * Bedrock, Vertex, or a login without the profile scope) and `rate_limits.{five_hour, seven_day, seven_day_opus,
 * seven_day_sonnet}` `{utilization 0–100 | null, resets_at ISO | null}` (null or absent when not on the plan), plus
 * `model_scoped[]` `{display_name, utilization, resets_at}` — a model's own weekly window (kind `other`).
 */
export function parseClaudeGetUsage(response: unknown, observedAt: string): UsageObservation {
  const r = obj(response) ?? {};
  const plan = typeof r.subscription_type === 'string' && r.subscription_type ? r.subscription_type : null;
  const limits = obj(r.rate_limits);
  if (r.rate_limits_available === false || (!limits && !plan))
    return { provider: 'claude', kind: 'api_key', plan: null, windows: [], observedAt, error: null };
  const windows: UsageWindow[] = [];
  for (const kind of GET_USAGE_KINDS) {
    const w = obj(limits?.[kind]);
    if (!w) continue;
    windows.push(namedWindow(kind, percent(w.utilization), isoOf(w.resets_at)));
  }
  const scoped = Array.isArray(limits?.model_scoped) ? limits.model_scoped : [];
  for (const raw of scoped) {
    const w = obj(raw);
    const name = typeof w?.display_name === 'string' ? w.display_name.trim().slice(0, 40) : '';
    if (!w || !name) continue;
    const usedPct = percent(w.utilization);
    windows.push({
      kind: 'other',
      label: `${name} 7-day`,
      usedPct,
      resetsAt: isoOf(w.resets_at),
      status: statusOf(usedPct),
      windowMinutes: WINDOW_MINUTES.seven_day,
    });
  }
  return {
    provider: 'claude',
    kind: 'subscription',
    plan,
    windows: windows.slice(0, MAX_USAGE_WINDOWS),
    observedAt,
    error: limits ? null : 'Claude Code didn’t report the plan’s limits.',
  };
}

const LIMIT_KINDS = new Set(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']);

/**
 * What one `rate_limit_event.rate_limit_info` says about the windows (a turn's reading, `source: 'turn'`): the
 * `unifiedWindows` (both tracked on every observation), and the window `rateLimitType` names with `status` —
 * `rejected` is the limit hit (the turn refused, SUB-16), `allowed_warning` a warning. Null when it names no window
 * (an API-key session never sends one; an older CLI without `unifiedWindows` and without a type).
 */
export function claudeRateLimitObservation(info: unknown, observedAt: string): UsageObservation | null {
  const i = obj(info);
  if (!i) return null;
  const byKind = new Map<string, UsageWindow>();
  const unified = obj(i.unifiedWindows);
  for (const kind of ['five_hour', 'seven_day'] as const) {
    const w = obj(unified?.[kind]);
    if (!w) continue;
    byKind.set(kind, namedWindow(kind, percent(w.utilization, 'fraction'), isoOf(w.resetsAt)));
  }
  const type = typeof i.rateLimitType === 'string' ? i.rateLimitType : null;
  if (type && LIMIT_KINDS.has(type)) {
    const kind = type as 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet';
    const said: UsageStatus | null =
      i.status === 'rejected' ? 'limited' : i.status === 'allowed_warning' ? 'warning' : null;
    const known = byKind.get(kind);
    const usedPct = percent(i.utilization, 'fraction') ?? known?.usedPct ?? (said === 'limited' ? 100 : null);
    byKind.set(kind, namedWindow(kind, usedPct, isoOf(i.resetsAt) ?? known?.resetsAt ?? null, said));
  }
  if (byKind.size === 0) return null;
  return {
    provider: 'claude',
    kind: 'subscription',
    plan: null,
    windows: [...byKind.values()],
    observedAt,
    error: null,
  };
}

/** The flags of a probe: print mode, stream-JSON both ways, nothing from settings files, no tools, no MCP servers. */
export function claudeProbeArgs(settings: Obj): string[] {
  return [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--input-format',
    'stream-json',
    '--setting-sources=',
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify({ mcpServers: {} }),
    '--tools',
    '',
    '--disable-slash-commands',
    '--settings',
    JSON.stringify(settings),
  ];
}

export interface ClaudeUsageProbeOptions {
  command: string;
  /** The complete environment (the person's `CLAUDE_CONFIG_DIR`, nothing of the host's logins). */
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Flag settings: hooks off, updates off (and an API key's helper, never used: API keys aren't probed). */
  settings: Obj;
  /** Managed: inside the task sandbox (like a turn). */
  spawn?: ProcessSpawner;
  timeoutMs?: number;
  now?: () => Date;
}

/**
 * Asks the unmodified CLI for its plan's usage (`get_usage`) and ends it without a model turn. An error answer (an
 * older CLI that doesn't know the subtype, a failed request) is a reading with `error` and no windows: the turns'
 * readings still come in (UI-R03).
 */
export async function claudeUsageProbe(o: ClaudeUsageProbeOptions): Promise<UsageObservation> {
  const now = o.now ?? (() => new Date());
  const launch = launchCommand(o.command, claudeProbeArgs(o.settings));
  const cli = new ClaudeCliProcess({
    command: launch.command,
    args: launch.args,
    cwd: o.cwd,
    env: o.env,
    ...(o.spawn ? { spawn: o.spawn } : {}),
    killGraceMs: 1000,
  });
  try {
    const response = await cli.request({ ...CLAUDE_GET_USAGE }, o.timeoutMs ?? 30_000);
    return parseClaudeGetUsage(response, now().toISOString());
  } catch (error) {
    const tail = cli.stderr.slice(-2).join(' ');
    return {
      provider: 'claude',
      kind: 'subscription',
      plan: null,
      windows: [],
      observedAt: now().toISOString(),
      error: trimMessage(`${errorMessage(error)}${tail ? ` (${tail})` : ''}`, 300),
    };
  } finally {
    // Done: stdin closes and the CLI exits on its own (it keeps its config consistent); killed only if it lingers.
    cli.endInput();
    await exited(cli, 3000);
    await cli.close();
  }
}

/** Resolves when the process has exited, or after `ms`. */
function exited(cli: ClaudeCliProcess, ms: number): Promise<void> {
  if (cli.exit || cli.child.exitCode !== null || cli.child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    cli.child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
