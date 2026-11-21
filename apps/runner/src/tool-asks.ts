/**
 * A key at Ask holds a Hermes tool back (docs/decisions/hermes-engine.md HE-44, HE-S149, HE-S150): the turn's person is
 * asked the way a consequential command asks (AC-41, AC-42) — `runner.authorizeCommand` with the key's category (`web`,
 * `browser`), the tool's name as the command, the address's host as the target and what it looks at as the reason — and
 * `runner.authorizeWait` until they answer, the wait is over or the turn stops. A standing yes (“Allow for this task”,
 * “Always allow”) answers at once; Off answers no at once.
 */

import type { ToolAsk, ToolAskAnswer } from '@whombat/agent-runtime';
import { type CommandCategory, commandTimedOutText } from '@whombat/core';
import type { AuthorizeWaitReply, RunnerCommandsApi } from './commands/api';

const CATEGORY: Record<ToolAsk['keyId'], CommandCategory> = { 'web.browse': 'web', 'browser.use': 'browser' };

/** The host of the first address in what a call looks at (`https://example.com/a b` → `example.com`), or null. */
export function askTarget(detail: string): string | null {
  const first = detail.trim().split(/\s+/)[0] ?? '';
  try {
    const url = new URL(first);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname.slice(0, 253) || null : null;
  } catch {
    return null;
  }
}

export interface ToolAskerDeps {
  api: Pick<RunnerCommandsApi, 'authorizeCommand' | 'authorizeWait'>;
  dispatchId: string;
  lease: { runnerId: string; attempt: number };
  /** How long a person is waited for (`WHOMBAT_COMMANDS_APPROVAL_WAIT_MINUTES`, default 15). */
  approvalWaitMs?: number;
  log: (level: 'info' | 'warn', message: string, meta?: Record<string, unknown>) => void;
  now?: () => number;
}

/** `TurnInput.askPerson` for one turn. */
export function toolAsker(
  deps: ToolAskerDeps,
): (ask: ToolAsk, signal: AbortSignal) => Promise<ToolAskAnswer> {
  const now = deps.now ?? Date.now;
  const waitMs = deps.approvalWaitMs ?? 15 * 60_000;
  return async (ask, signal) => {
    const category = CATEGORY[ask.keyId];
    let reply: Awaited<ReturnType<RunnerCommandsApi['authorizeCommand']>>;
    try {
      reply = await deps.api.authorizeCommand({
        dispatchId: deps.dispatchId,
        ...deps.lease,
        command: ask.tool.slice(0, 200),
        category,
        target: askTarget(ask.detail),
        reason: ask.detail ? ask.detail.slice(0, 500) : null,
      });
    } catch (err) {
      return {
        allow: false,
        reason: `couldn’t ask whether it may run: ${err instanceof Error ? err.message : err}`,
      };
    }
    // Never what it looks at (it may be private): the tool and the outcome.
    deps.log('info', `tool ${ask.tool} · ${category}: ${reply.outcome}`, { dispatchId: deps.dispatchId });
    if (reply.outcome === 'run') return { allow: true, reason: 'the key allows it' };
    // What the agent reads when it didn't happen is Whombat's (HE-S149): the key's Off, the person's no, the wait over.
    if (reply.outcome === 'blocked' || !reply.approvalId)
      return { allow: false, reason: 'Off', ...(reply.message ? { message: reply.message } : {}) };
    const deadline = now() + waitMs;
    let last: AuthorizeWaitReply | null = null;
    while (!signal.aborted) {
      const left = deadline - now();
      if (left <= 0) break;
      try {
        last = await deps.api.authorizeWait(
          reply.approvalId,
          { dispatchId: deps.dispatchId, ...deps.lease, waitMs: Math.max(0, Math.min(25_000, left)) },
          signal,
        );
      } catch (err) {
        if (signal.aborted) break;
        deps.log('warn', `waiting for an approval failed: ${String(err)}`, { dispatchId: deps.dispatchId });
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (last.outcome === 'run') return { allow: true, reason: last.message || 'a person allowed it' };
      if (last.outcome === 'declined')
        return {
          allow: false,
          reason: 'a person said no',
          ...(last.message ? { message: last.message } : {}),
        };
    }
    if (signal.aborted) return { allow: false, reason: 'the turn stopped' };
    return {
      allow: false,
      reason: 'nobody answered in time',
      message: commandTimedOutText(Math.max(1, Math.round(waitMs / 60_000))),
    };
  };
}
