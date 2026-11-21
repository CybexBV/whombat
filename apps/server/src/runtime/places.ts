/**
 * Where an agent's turn works in a conversation (docs/decisions/hermes-native.md HN-T01…HN-T03): its thread
 * (`dispatches.thread_root_id`), or the conversation's top level (null). The claim runs one turn of an agent per thread
 * at a time, and a turn at the top level alone in its conversation (`runtime/service.ts` `claimInTx`).
 */
import { type SQL, sql } from 'drizzle-orm';
import { dispatches, runs } from '../db/schema/index';

/**
 * Whether the `dispatches` row aliased `alias` holds its place: claimed or running, or stopped by a person while its
 * runner still holds it (review-features.md RF-01) — it counts until the runner reports it ended (`finalizeIn` clears
 * the lease) or the lease runs out.
 */
export function holdsItsPlace(alias: string, now: Date): SQL {
  const d = sql.raw(alias);
  return sql`(${d}.state in ('claimed', 'running')
    or (${d}.state = 'cancelled' and ${d}.stopped_by_id is not null
      and ${d}.lease_expires_at > ${now.toISOString()}::timestamptz))`;
}

/** The claim pass's key for a queued turn's place: oldest first within it (`claimInTx`). */
export function placeKey(d: {
  agentId: string;
  conversationId: string;
  threadRootId: string | null;
}): string {
  return `${d.agentId}|${d.conversationId}|${d.threadRootId ?? ''}`;
}

/**
 * The outsiders' turns (`person.ts` `outsidersTurn`) that hold their place now (`holdsItsPlace`), as a subquery for the
 * turn queued with `runId` (a column or a value). Every outsiders' turn runs in Hermes's one outsiders' profile, which
 * one Hermes holds at a time, so the claim takes the next one only once none of these is left
 * (docs/decisions/outsiders-turns.md). As with a turn's own place, a run's turn isn't held back by the turn that
 * started the run.
 */
export function outsidersTurnsInFlight(runId: SQL, now: Date): SQL {
  return sql`select outsider.id, outsider.trigger from ${dispatches} as outsider
    where outsider.on_behalf_of_account_id is null
      and ${holdsItsPlace('outsider', now)}
      and not exists (select 1 from ${runs} as started
        where started.id = ${runId} and started.dispatch_id = outsider.id)`;
}
