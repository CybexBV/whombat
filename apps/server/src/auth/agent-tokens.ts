/**
 * Per-dispatch agent tokens (ARCHITECTURE A-07): the runner hands the agent a short-lived bearer token
 * (`wat_…`) for the Whombat MCP server; it authenticates as that agent, in that burrow, while the dispatch
 * is live. The runner phase issues these on claim. Only the MCP server and the AI gateway relay accept them (the relay:
 * the CLI's own key for a turn that goes through the gateway, docs/decisions/ai-gateway.md AIG-09); REST and `/ws` do
 * not, so the MCP rules (switched-off repos, rate limits) cannot be bypassed (security-fixes.md).
 *
 * A token lasts {@link AGENT_TOKEN_TTL_MS} and slides while its turn is alive (docs/decisions/essentials-agents.md
 * EA-04): every runner beat that renews the lease (progress, heartbeat) and every authenticated MCP call moves its
 * expiry to now + the TTL, never past the claim + the turn's wall time + {@link AGENT_TOKEN_WALL_MARGIN_MS}. An
 * expired token is never revived, and a finished or cancelled dispatch's token stops working at once.
 */
import { and, eq, inArray, lt, type SQL, sql } from 'drizzle-orm';
import { dispatches, principals } from '../db/schema/index';
import { newSecret, sha256 } from '../lib/secrets';
import type { Services } from '../services';

export const AGENT_TOKEN_TTL_MS = 30 * 60_000;
/** After the turn's wall time: room for the runner's final post, its push and `complete`. */
export const AGENT_TOKEN_WALL_MARGIN_MS = 15 * 60_000;
/** An MCP call slides the token only when that gains at least this much (one write a minute, not one per call). */
const SLIDE_STEP_MS = 60_000;
const LIVE = ['queued', 'claimed', 'running'] as const;
const LIVE_STATES = new Set<string>(LIVE);

export async function issueDispatchToken(
  services: Services,
  dispatchId: string,
  ttlMs = AGENT_TOKEN_TTL_MS,
): Promise<{ token: string; expiresAt: Date }> {
  const token = newSecret('wat', 32);
  const expiresAt = new Date(services.clock().getTime() + ttlMs);
  const updated = await services.pipeline.transactAccount(async (tx) =>
    tx
      .update(dispatches)
      .set({ tokenHash: sha256(token), tokenExpiresAt: expiresAt })
      .where(eq(dispatches.id, dispatchId))
      .returning({ id: dispatches.id }),
  );
  if (updated.length === 0) throw new Error(`Unknown dispatch ${dispatchId}`);
  return { token, expiresAt };
}

/** How long after its claim a turn's token may live at most: the wall time plus the margin. */
export function agentTokenCapMs(services: Pick<Services, 'config'>): number {
  return services.config.WHOMBAT_SANDBOX_WALL_MINUTES * 60_000 + AGENT_TOKEN_WALL_MARGIN_MS;
}

/**
 * The token expiry a live beat or call leaves on a dispatch row (a `set` value): now + the TTL, never earlier than it
 * already was, never past the claim + {@link agentTokenCapMs}; an expired (or never issued) token stays as it is.
 */
export function slidTokenExpiry(services: Pick<Services, 'config'>, now: Date): SQL {
  const at = now.toISOString();
  const next = new Date(now.getTime() + AGENT_TOKEN_TTL_MS).toISOString();
  const cap = agentTokenCapMs(services);
  return sql`case when ${dispatches.tokenExpiresAt} > ${at}::timestamptz
    then greatest(${dispatches.tokenExpiresAt}, least(${next}::timestamptz,
      coalesce(${dispatches.claimedAt}, ${at}::timestamptz) + ${cap}::double precision * interval '1 millisecond'))
    else ${dispatches.tokenExpiresAt} end`;
}

/**
 * An authenticated MCP call keeps its turn's token alive (EA-04). Writes only when the expiry moves by a minute or
 * more; operational bookkeeping, like issuing the token.
 */
export async function slideAgentToken(services: Services, dispatchId: string): Promise<void> {
  const now = services.clock();
  const soon = new Date(now.getTime() + AGENT_TOKEN_TTL_MS - SLIDE_STEP_MS).toISOString();
  await services.pipeline.transactAccount((tx) =>
    tx
      .update(dispatches)
      .set({ tokenExpiresAt: slidTokenExpiry(services, now) })
      .where(
        and(
          eq(dispatches.id, dispatchId),
          inArray(dispatches.state, [...LIVE]),
          lt(dispatches.tokenExpiresAt, sql`${soon}::timestamptz`),
        ),
      ),
  );
}

export interface AgentAuth {
  dispatchId: string;
  agentId: string;
  burrowId: string;
}

/**
 * The dispatch behind an unexpired agent token, whatever its state (the AI gateway relay answers a bad token 401 and a
 * turn that ended 409, AIG-09). Null: no such token, not an agent's, or expired.
 */
export async function agentTokenDispatch(
  services: Services,
  token: string,
): Promise<typeof dispatches.$inferSelect | null> {
  if (!token.startsWith('wat_')) return null;
  const [row] = await services.db
    .select({ dispatch: dispatches, agentKind: principals.kind })
    .from(dispatches)
    .innerJoin(principals, and(eq(principals.id, dispatches.agentId)))
    .where(eq(dispatches.tokenHash, sha256(token)));
  if (row?.agentKind !== 'agent') return null;
  const d = row.dispatch;
  if (!d.tokenExpiresAt || d.tokenExpiresAt <= services.clock()) return null;
  return d;
}

/** The agent behind a token, while its dispatch is live and the token unexpired. */
export async function verifyAgentToken(services: Services, token: string): Promise<AgentAuth | null> {
  if (!token.startsWith('wat_')) return null;
  const [row] = await services.db
    .select({ dispatch: dispatches, agentKind: principals.kind })
    .from(dispatches)
    .innerJoin(principals, and(eq(principals.id, dispatches.agentId)))
    .where(eq(dispatches.tokenHash, sha256(token)));
  if (row?.agentKind !== 'agent') return null;
  const d = row.dispatch;
  if (!LIVE_STATES.has(d.state)) return null;
  if (!d.tokenExpiresAt || d.tokenExpiresAt <= services.clock()) return null;
  return { dispatchId: d.id, agentId: d.agentId, burrowId: d.burrowId };
}
