/**
 * Pruning Hermes sessions no thread names (docs/decisions/hermes-native.md HN-K10, HN-K11; contracts 2.1
 * `sessions.list`, CT-1453): a turn that never reported its session, a home restored from another Whombat (HE-S124),
 * leave conversations in a Hermes home that nothing here will resume or forget. Every few hours, and soon after a
 * restore, the server lists each home's sessions through the runner and forgets — through the durable drop
 * path (`hermes_session_drops`, HN-K02), which hands them to `sessions.delete` — exactly those that are
 *
 * - Whombat's (`source` `acp`: anything begun on Hermes's CLI, cron or another surface stays),
 * - not named by any turn (`dispatches.provider_session_id`, whatever the turn's state: a queued turn resumes only a
 *   session an earlier turn names, and a running one runs in a session it named or just began), and
 * - idle for `PRUNE_IDLE_MS` (a turn begins its session before it reports it; Hermes's own activity says when).
 *
 * The names are checked again in the commit that records the drops, and the hand-over still waits for a turn that
 * names one (none can). A session forgotten already isn't recorded again while the runner may still be deleting it
 * (not handed yet, or handed within `PRUNE_EVERY_MS`); one still listed after that is.
 */
import { HERMES_HOMES, type HermesHome, type HermesHomeResult } from '@whombat/core';
import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { dispatches, hermesSessionDrops } from '../db/schema/index';
import { HERMES_SESSION, type HermesSession } from '../runtime/sessions';
import type { Services } from '../services';
import { HermesHomeCallError, type HermesHomeExecutor } from './service';

/** How often each home is listed. */
export const PRUNE_EVERY_MS = 6 * 60 * 60_000;
/** After a listing that didn't happen (no runner, a busy store), the next try. */
export const PRUNE_RETRY_MS = 30 * 60_000;
/** How long a session nobody names must have been idle before it goes. */
export const PRUNE_IDLE_MS = 7 * 24 * 60 * 60_000;
/** Where Whombat's turns begin their sessions, as Hermes names it. */
export const PRUNE_SOURCE = 'acp';
/** A listing reads the whole store once: Hermes's start and one query (the runner gives it 2 minutes). */
const LIST_TIMEOUT_MS = 150_000;
/** Ids per `IN (…)` list. */
const CHUNK = 1_000;

/** Which of these Hermes ids a turn names (`hermes:<id>`), in any state. */
async function namedOf(db: Db | Tx, ids: readonly string[]): Promise<Set<string>> {
  const named = new Set<string>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await db
      .selectDistinct({ session: dispatches.providerSessionId })
      .from(dispatches)
      .where(
        inArray(
          dispatches.providerSessionId,
          ids.slice(i, i + CHUNK).map((id) => `${HERMES_SESSION}${id}`),
        ),
      );
    for (const r of rows) if (r.session) named.add(r.session.slice(HERMES_SESSION.length));
  }
  return named;
}

/** Which of these are forgotten already and may still be on their way out: not handed yet, or handed since `since`. */
async function waitingOf(
  db: Db | Tx,
  home: HermesHome,
  ids: readonly string[],
  since: Date,
): Promise<Set<string>> {
  const waiting = new Set<string>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await db
      .select({ session: hermesSessionDrops.sessionId })
      .from(hermesSessionDrops)
      .where(
        and(
          eq(hermesSessionDrops.home, home),
          inArray(hermesSessionDrops.sessionId, ids.slice(i, i + CHUNK)),
          or(isNull(hermesSessionDrops.handedAt), gt(hermesSessionDrops.handedAt, since)),
        ),
      );
    for (const r of rows) waiting.add(r.session);
  }
  return waiting;
}

/** The prune's own state: when each home is listed next (in memory; after a restart every home is due). */
export class SessionPrune {
  readonly #nextAt = new Map<string, number>();

  constructor(
    private readonly services: Services,
    private readonly record: (tx: Tx, sessions: readonly HermesSession[], at: Date) => Promise<void>,
  ) {}

  /** A home came back from a backup (HN-K03): listed at the next round. */
  soon(home: HermesHome): void {
    this.#nextAt.set(home, 0);
  }

  /** Lists the homes that are due and forgets what may go; how many sessions it forgot. */
  async run(exec: HermesHomeExecutor): Promise<number> {
    let forgot = 0;
    for (const home of HERMES_HOMES) {
      const now = this.services.clock().getTime();
      if ((this.#nextAt.get(home) ?? 0) > now) continue;
      let listed: HermesHomeResult<'sessions.list'>;
      try {
        listed = await exec.call('sessions.list', { home }, { timeoutMs: LIST_TIMEOUT_MS });
      } catch (err) {
        // `unavailable` too: no real Hermes (the scripted one), or the runner didn't take it.
        this.#nextAt.set(home, now + PRUNE_RETRY_MS);
        if (!(err instanceof HermesHomeCallError && (err.code === 'unavailable' || err.code === 'busy')))
          this.services.log.warn({ err: String(err) }, 'hermes sessions not listed');
        continue;
      }
      const cutoff = now - PRUNE_IDLE_MS;
      const idle = listed.sessions
        .filter((s) => s.source === PRUNE_SOURCE && Date.parse(s.lastActiveAt) < cutoff)
        .map((s) => s.id);
      const pruned = await this.#forget(home, idle);
      forgot += pruned;
      // A long list goes on at the next round while it still finds some (`more`: the most recent were left out).
      this.#nextAt.set(home, listed.more && pruned > 0 ? 0 : now + PRUNE_EVERY_MS);
      if (pruned > 0)
        this.services.log.info(
          { home, sessions: pruned, listed: listed.sessions.length },
          'hermes sessions no thread names forgotten',
        );
    }
    return forgot;
  }

  /** Records the idle sessions no turn names as forgotten (the hand-over deletes them); how many. */
  async #forget(home: HermesHome, idle: readonly string[]): Promise<number> {
    if (idle.length === 0) return 0;
    const db = this.services.db;
    const named = await namedOf(db, idle);
    const waiting = await waitingOf(
      db,
      home,
      idle,
      new Date(this.services.clock().getTime() - PRUNE_EVERY_MS),
    );
    const candidates = idle.filter((id) => !named.has(id) && !waiting.has(id));
    if (candidates.length === 0) return 0;
    return this.services.pipeline.transactAccount(async (tx) => {
      // Named meanwhile (a turn reported it after the listing): it stays.
      const late = await namedOf(tx, candidates);
      const go = candidates.filter((id) => !late.has(id));
      await this.record(
        tx,
        go.map((session) => ({ home, session })),
        this.services.clock(),
      );
      return go.length;
    });
  }
}
