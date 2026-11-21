/**
 * The runtime a turn runs on (docs/decisions/chat-runtime.md CR-02; chat-runtime-server.md CR-S03): its agent's, with
 * provider, model, effort and fast taken from the dispatch's resolved runtime (`dispatches.runtime`, its Chat thread's
 * choice) when it has one. Every reader of a turn's provider — the claim, the unrunnable sweep, the gateway route, the
 * session, the context, usage, the Work view — reads it through here.
 */
import type { AgentRuntime, ChatRuntime } from '@whombat/core';
import { sql } from 'drizzle-orm';
import { turnProviderOf, turnRuntimeOf } from '../chats/runtime-rules';
import { dispatches, principals } from '../db/schema/index';
import { agentRuntimeOf } from '../read/principals';

/** The provider a dispatch runs on, in SQL over `dispatches` joined with its agent's `principals` row. */
export const turnProviderSql = sql<string>`coalesce(${dispatches.runtime}->>'provider', ${principals.runtime}->>'provider', 'claude')`;

/** The runtime a dispatch's turn runs on, from its agent's stored runtime and its own resolved one. */
export function turnRuntime(
  agentRuntime: Parameters<typeof agentRuntimeOf>[0],
  dispatch: { runtime: ChatRuntime | null } | null | undefined,
): AgentRuntime {
  return turnRuntimeOf(agentRuntimeOf(agentRuntime), dispatch?.runtime ?? null);
}

/** The provider a dispatch's turn runs on, from its agent's stored runtime and its own resolved one. */
export function turnProvider(
  agentRuntime: unknown,
  dispatch: { runtime: ChatRuntime | null } | null | undefined,
) {
  return turnProviderOf(agentRuntime, dispatch?.runtime ?? null);
}
