/**
 * Hermes housekeeping the server owes the runner's two homes (docs/decisions/hermes-native.md HN-K02, HN-K10; one-person.md
 * OP-S47: the person's, and the outsiders'), kept in the database so a runner that isn't there, a failed call or a
 * restart only delays it:
 *
 * - Sessions Whombat forgot (`hermes_session_drops`, written in the commit that forgets them): handed to the runner
 *   (`sessions.delete`, which keeps them on disk until Hermes deleted them) until it takes them, after the turn that
 *   runs in one ends. No turn names a forgotten session again (`sessionForgotten`: a late turn report doesn't), so no
 *   queued turn resumes one; the runner deletes only between the person's turns. The rows stay after that: a restored
 *   home (`hermesHomeRestored`) has them deleted again.
 * - Sessions no thread names (HN-K10): each home's are listed every few hours and soon after a restore
 *   (`sessions.list`), and Whombat's that no turn names and that sat idle long enough are forgotten like the rest
 *   (`prune.ts`).
 *
 * Every minute on the housekeeping tick, and at once after a commit that adds work (`kickHermesHousekeeping`).
 */
import type { HermesHome } from '@whombat/core';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { TxSession } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { dispatches, hermesSessionDrops } from '../db/schema/index';
import { HERMES_SESSION, type HermesSession } from '../runtime/sessions';
import type { Services } from '../services';
import { SessionPrune } from './prune';
import { type HermesHomeExecutor, hermesHome } from './service';

/** How often the work is looked at (and retried). */
export const HERMES_HOUSEKEEPING_MS = 60_000;
/** Most sessions one `sessions.delete` takes (the contract's limit). */
const DELETE_BATCH = 500;
/** Most forgotten sessions one round hands over (the rest in the next). */
const ROUND_SESSIONS = 5_000;
/** A turn that runs in a session now: its session waits for the turn's end. */
const LIVE = ['claimed', 'running'] as const;

/** The home a dispatch's sessions live in (OP-17): the person's, or the outsiders' for a turn queued for nobody. */
export const homeOf = (onBehalfOfAccountId: string | null): HermesHome =>
  onBehalfOfAccountId ? 'person' : 'outside';

/** Whether the server forgot this session (`hermes:<id>` in `home`): a turn report doesn't name it. */
export async function sessionForgotten(
  tx: Db,
  home: HermesHome,
  providerSessionId: string,
): Promise<boolean> {
  if (!providerSessionId.startsWith(HERMES_SESSION)) return false;
  const [row] = await tx
    .select({ at: hermesSessionDrops.droppedAt })
    .from(hermesSessionDrops)
    .where(
      and(
        eq(hermesSessionDrops.home, home),
        eq(hermesSessionDrops.sessionId, providerSessionId.slice(HERMES_SESSION.length)),
      ),
    )
    .limit(1);
  return !!row;
}

/** Records sessions the commit forgets; the runner deletes them after it. */
export async function recordForgottenSessions(
  tx: Tx,
  sessions: readonly HermesSession[],
  at: Date,
): Promise<void> {
  const rows = [...new Map(sessions.map((s) => [`${s.home}/${s.session}`, s])).values()].map((s) => ({
    home: s.home,
    sessionId: s.session,
    droppedAt: at,
    handedAt: null,
  }));
  for (let i = 0; i < rows.length; i += 1_000)
    await tx
      .insert(hermesSessionDrops)
      .values(rows.slice(i, i + 1_000))
      .onConflictDoUpdate({
        target: [hermesSessionDrops.home, hermesSessionDrops.sessionId],
        set: { droppedAt: at, handedAt: null },
      });
}

/**
 * A home came back from a backup (HN-K03): every session forgotten in it is deleted again, as the archive may hold ones
 * forgotten since it was made.
 */
export async function hermesHomeRestored(tx: Db, home: HermesHome): Promise<void> {
  await tx.update(hermesSessionDrops).set({ handedAt: null }).where(eq(hermesSessionDrops.home, home));
}

/**
 * Runs the housekeeping after the commit (it sees what the commit wrote). `restored`: a home that came back from a
 * backup, whose sessions are listed in that round (HN-K11).
 */
export function kickHermesHousekeeping(
  session: Pick<TxSession, 'services' | 'background'>,
  restored?: { home: HermesHome },
): void {
  const services = session.services;
  session.background(
    'hermes housekeeping',
    () => {
      const h = hermesHousekeeping(services);
      if (restored) h.pruneSoon(restored.home);
      return h.run();
    },
    'hermes-housekeeping',
  );
}

const instances = new WeakMap<Services, HermesHousekeeping>();

/** The server's housekeeping (one per services). */
export function hermesHousekeeping(services: Services): HermesHousekeeping {
  let h = instances.get(services);
  if (!h) {
    h = new HermesHousekeeping(services);
    instances.set(services, h);
  }
  return h;
}

export class HermesHousekeeping {
  #off: (() => void) | null = null;
  #round: Promise<void> | null = null;
  #again = false;
  readonly #prune: SessionPrune;

  constructor(private readonly services: Services) {
    this.#prune = new SessionPrune(services, recordForgottenSessions);
  }

  /** A home's sessions are listed at the next round (a restored home, HN-K11). */
  pruneSoon(home: HermesHome): void {
    this.#prune.soon(home);
  }

  /** On the housekeeping tick, every minute (a read-only start runs none of it). */
  start(): void {
    if (this.#off) return;
    this.#off = this.services.housekeeping.add(
      'hermes housekeeping',
      HERMES_HOUSEKEEPING_MS,
      () => this.run(),
      {
        first: 'tick',
      },
    );
  }

  close(): void {
    this.#off?.();
    this.#off = null;
  }

  /** One round now; asked again while one runs, another follows it (it sees what came meanwhile). */
  run(): Promise<void> {
    if (this.#round) {
      this.#again = true;
      return this.#round;
    }
    this.#round = (async () => {
      do {
        this.#again = false;
        await this.#once();
      } while (this.#again);
    })().finally(() => {
      this.#round = null;
    });
    return this.#round;
  }

  async #once(): Promise<void> {
    const exec = hermesHome(this.services);
    // Nobody to hand it to: the next round, once the runner polls.
    if (!exec.runnerSeen) return;
    try {
      await this.#prune.run(exec);
      await this.#handOver(exec);
    } catch (err) {
      this.services.log.warn({ err: String(err) }, 'hermes housekeeping failed');
    }
  }

  /** Forgotten sessions not handed over yet go to the runner, by home; one a turn runs in waits for its end. */
  async #handOver(exec: HermesHomeExecutor): Promise<void> {
    const db = this.services.db;
    const rows = await db
      .select({ home: hermesSessionDrops.home, sessionId: hermesSessionDrops.sessionId })
      .from(hermesSessionDrops)
      .where(isNull(hermesSessionDrops.handedAt))
      .orderBy(asc(hermesSessionDrops.droppedAt))
      .limit(ROUND_SESSIONS);
    const byHome = new Map<HermesHome, string[]>();
    for (const r of rows) byHome.set(r.home, [...(byHome.get(r.home) ?? []), r.sessionId]);
    for (const [home, ids] of byHome) {
      for (let i = 0; i < ids.length; i += DELETE_BATCH) {
        const batch = ids.slice(i, i + DELETE_BATCH);
        const named = batch.map((id) => `${HERMES_SESSION}${id}`);
        const live = new Set(
          (
            await db
              .selectDistinct({ session: dispatches.providerSessionId })
              .from(dispatches)
              .where(and(inArray(dispatches.state, [...LIVE]), inArray(dispatches.providerSessionId, named)))
          ).map((r) => r.session),
        );
        const ready = batch.filter((id) => !live.has(`${HERMES_SESSION}${id}`));
        if (ready.length === 0) continue;
        try {
          await exec.call('sessions.delete', { home, sessions: ready });
        } catch (err) {
          // Not taken (the runner went, a busy or broken step): this home's next round.
          this.services.log.warn(
            { err: String(err), sessions: ready.length },
            'hermes sessions not handed over yet',
          );
          break;
        }
        const at = this.services.clock();
        await this.services.pipeline.transactAccount((tx) =>
          tx
            .update(hermesSessionDrops)
            .set({ handedAt: at })
            .where(
              and(
                eq(hermesSessionDrops.home, home),
                inArray(hermesSessionDrops.sessionId, ready),
                isNull(hermesSessionDrops.handedAt),
              ),
            ),
        );
      }
    }
  }
}
