/**
 * The watcher (docs/decisions/look-research.md LR-01…LR-03): about every minute it reads the looks as the desk does
 * (`deskLooks` over Home's things and the servers' cards, the line behind each) for each burrow's person, and
 *
 * - ends the research of a look that went, got worse or whose line changed (a new problem, LR-02);
 * - gives a look that came back as it was what the assistant found about it last time, at once and without a turn, when
 *   that is less than `REMEMBER_MS` old (LR-02): a check that comes and goes isn't a new problem each time;
 * - settles a research whose turn ended without a report (`failed`, or the step offered again), and looks into a failed
 *   one once more in its thread a while later;
 * - starts research on the first look, in the desk's order, that was there on this pass and the one before with the
 *   same line and no research for it: one at a time, at most `RESEARCH_PER_DAY` a day and `RESEARCH_PER_THING` of one
 *   thing (LR-03), only while a turn of the person's could run now. A look the person quieted (Ignore, Not now, not
 *   watched) is no look here: nothing colours the thing, so `deskLooks` never has it. A heads-up never is.
 *
 * What it saw on the pass before is kept in memory: after a restart a look waits one more pass.
 */

import { careThingKey, parseThingId } from '@whombat/core';
import { and, eq, inArray, or } from 'drizzle-orm';
import { careOfferFor } from '../care/facts';
import { burrows, dispatches, type LookResearchRow } from '../db/schema/index';
import { deskFleet, deskLooks, lookLinesOf, screenText } from '../desk/glance';
import type { DeskLook } from '../desk/shapes';
import { thePerson } from '../domain/the-person';
import { type HomeViewer, things } from '../home/overview';
import { startOfLocalDay } from '../home/time';
import { agentRuntimeOf, loadAgentRow, type PrincipalRow } from '../read/principals';
import { providerReadiness } from '../runtime/readiness';
import type { Services } from '../services';
import { hasCareLines, type LookLine, lineKey, linesCovered, onlyCareLines } from './lines';
import {
  endedRows,
  LOOK_RANK,
  type LookRank,
  liveRows,
  type ResearchLook,
  researchesSince,
  retryResearch,
  settleResearch,
  startResearch,
} from './research';

/** At most this many researches a day per Whombat (LR-03). */
export const RESEARCH_PER_DAY = 12;
/** At most this many researches a day of one thing, so one noisy check can't use up the day's (LR-03). */
export const RESEARCH_PER_THING = 2;
/** What the assistant found about a look is given back when the look comes back within this long (LR-02). */
export const REMEMBER_MS = 7 * 24 * 60 * 60_000;
/** How often the watcher looks (LR-01: two passes in a row). */
export const WATCH_MS = 60_000;
/** A research still `looking` this long after it began failed: its turn never ran (no runner took it). */
export const LOOKING_MAX_MS = 2 * 60 * 60_000;
/**
 * A look still there this long after the assistant said it fixed it isn't fixed: three of the health pass's five minutes
 * have gone by. Its green words go, and it is a problem to look into again.
 */
export const FIXED_HOLD_MS = 15 * 60_000;
/**
 * A research that failed is looked into once more, in its own thread, this long after (a turn can end without a report:
 * the model stopped early, a provider hiccup). At most `LOOK_TRIES` turns per research.
 */
export const RETRY_AFTER_MS = 10 * 60_000;
export const LOOK_TRIES = 2;
/** The looks read per pass, as the desk's every look. */
const LOOKS_MAX = 50;

/** A look as the watcher weighs it: the desk's, its rank, its line and every line of the thing. */
export interface WatchedLook extends ResearchLook {
  /** A problem or only-you line, or none known; never a heads-up. */
  nature: 'problem' | 'you' | null;
}

/** A live research as the watcher weighs it. */
export interface WatchedRow {
  id: string;
  key: string;
  kind: 'server' | 'connection' | 'device';
  rank: number;
  check: string | null;
  subject: string;
  /** Every line it covers (none known: a row from before, its own line only). */
  lines: readonly LookLine[];
  state: string;
  startedAt: Date;
  /** When its state last changed. */
  stateAt: Date;
  /** Its turn ended (done, failed or cancelled). */
  turnEnded: boolean;
  /** How many turns looked into it so far. */
  tries: number;
  /** A new server's care plan (care-plan.md): not a look, so no look's going ends it. */
  care?: boolean;
}

export interface PassInput {
  looks: readonly WatchedLook[];
  live: readonly WatchedRow[];
  /** The latest research of each look that went (`endedRows`), by the look's key. */
  ended: ReadonlyMap<string, WatchedRow>;
  /** What the pass before saw (`seenOf`); null on the first pass. */
  before: ReadonlySet<string> | null;
  /** How many researches of each look began today. */
  startedToday: ReadonlyMap<string, number>;
  /** The servers' cards were read: a server look missing means it went (else it is unknown). */
  serversRead: boolean;
  /** A turn of the person's could run now. */
  ready: boolean;
  now: Date;
  /** The servers' keys (`server:pve-01`) when they were read: a care plan of a server that went ends. */
  servers?: ReadonlySet<string> | null;
}

export interface PassPlan {
  /** Rows whose look went or became a new problem. */
  gone: string[];
  /** Rows whose turn ended without a report, or never ran. */
  unreported: string[];
  /** Findings of looks that came back as they were: live again, nothing posted, no turn. */
  revive: string[];
  /** A failed research to look into once more, in its thread; then nothing starts this pass. */
  retry: string | null;
  /** The look to start on, if any. */
  start: WatchedLook | null;
  /** What this pass saw, for the next. */
  seen: Set<string>;
}

/** A look as seen on a pass: its key, how bad, its line and every line of the thing. */
export function seenOf(
  look: Pick<WatchedLook, 'key' | 'rank' | 'check' | 'subject'> & { lines?: readonly LookLine[] },
): string {
  const lines = (look.lines ?? []).map(lineKey).sort();
  return [look.key, look.rank, look.check ?? '', look.subject, ...lines].join('\n');
}

/**
 * Whether a look is a new problem for the research it has (LR-02): worse than the worst it was, or a line it didn't look
 * into (handle-it.md: a research covers every line of the thing; one that went is no new problem). A row or a read
 * that doesn't know the thing's lines compares the line behind the look, when both lines are known (a read that doesn't
 * know the line says nothing about it).
 */
export function newProblem(
  row: Pick<WatchedRow, 'rank' | 'check' | 'subject'> & { lines?: readonly LookLine[] },
  look: Pick<WatchedLook, 'rank' | 'check' | 'subject'> & { lines?: readonly LookLine[] },
): boolean {
  if (look.rank < row.rank) return true;
  if (row.lines?.length && look.lines?.length) return !linesCovered(row.lines, look.lines);
  return (
    row.check !== null && look.check !== null && (row.check !== look.check || row.subject !== look.subject)
  );
}

/** One pass's decisions (LR-01…LR-03), pure. */
export function planPass(input: PassInput): PassPlan {
  const byKey = new Map(input.looks.map((l) => [l.key, l]));
  const gone: string[] = [];
  const unreported: string[] = [];
  const kept: WatchedRow[] = [];
  // The servers whose care plan waits or is being carried out: their care lines are its, not a look's (care-plan.md).
  const caring = new Set<string>();
  for (const row of input.live) {
    if (row.care) {
      const thing = careThingKey(row.key);
      const removed = !!thing && !!input.servers && input.serversRead && !input.servers.has(thing);
      const done = row.state === 'fixed' && input.now.getTime() - row.stateAt.getTime() >= FIXED_HOLD_MS;
      const gaveUp =
        row.state === 'failed' &&
        row.tries >= LOOK_TRIES &&
        input.now.getTime() - row.stateAt.getTime() >= RETRY_AFTER_MS;
      // It ends once done (its card stays done), when it gave up, or when its server went.
      if (removed || done || gaveUp) {
        gone.push(row.id);
        continue;
      }
      kept.push(row);
      if (thing && row.state !== 'fixed' && row.state !== 'failed') caring.add(thing);
      const stale =
        row.state === 'looking' && input.now.getTime() - row.startedAt.getTime() >= LOOKING_MAX_MS;
      if ((row.state === 'looking' || row.state === 'fixing') && (row.turnEnded || stale))
        unreported.push(row.id);
      continue;
    }
    const look = byKey.get(row.key);
    // Unknown when the servers weren't read: kept until a read says. Fixed but still there long after: not fixed.
    const notFixed = row.state === 'fixed' && input.now.getTime() - row.stateAt.getTime() >= FIXED_HOLD_MS;
    if (!look ? row.kind !== 'server' || input.serversRead : notFixed || newProblem(row, look)) {
      gone.push(row.id);
      continue;
    }
    kept.push(row);
    const stale = row.state === 'looking' && input.now.getTime() - row.startedAt.getTime() >= LOOKING_MAX_MS;
    if ((row.state === 'looking' || row.state === 'fixing') && (row.turnEnded || stale))
      unreported.push(row.id);
  }
  const seen = new Set(input.looks.map(seenOf));
  const busy = kept.some((r) => r.state === 'looking' && !unreported.includes(r.id));
  const retry =
    busy || !input.ready
      ? null
      : (kept.find(
          (r) =>
            r.state === 'failed' &&
            r.tries < LOOK_TRIES &&
            input.now.getTime() - r.stateAt.getTime() >= RETRY_AFTER_MS,
        )?.id ?? null);
  const researched = new Set(kept.map((r) => r.key));
  // Came back as it was when the assistant last looked into it, not long ago: that finding again (LR-02).
  const revive: string[] = [];
  for (const look of input.looks) {
    const last = researched.has(look.key) ? undefined : input.ended.get(look.key);
    if (
      last?.state === 'found' &&
      input.now.getTime() - last.stateAt.getTime() < REMEMBER_MS &&
      !newProblem(last, look)
    ) {
      revive.push(last.id);
      researched.add(look.key);
    }
  }
  const today = [...input.startedToday.values()].reduce((a, b) => a + b, 0);
  const start =
    busy || retry || !input.ready || today >= RESEARCH_PER_DAY || !input.before
      ? null
      : (input.looks.find(
          (l) =>
            !researched.has(l.key) &&
            !(caring.has(l.key) && onlyCareLines(l)) &&
            (input.startedToday.get(l.key) ?? 0) < RESEARCH_PER_THING &&
            (input.before as ReadonlySet<string>).has(seenOf(l)),
        ) ?? null);
  return { gone, unreported, revive, retry, start, seen };
}

/** The desk's look with its line and the thing's lines, as the watcher weighs it; none for a heads-up. */
export function watchedLook(
  look: DeskLook,
  since: Date | null,
  lines: readonly LookLine[] = [],
): WatchedLook | null {
  if (look.nature === 'fyi') return null;
  return {
    key: look.key,
    kind: look.kind,
    name: look.name,
    rank: LOOK_RANK[look.state] as LookRank,
    reason: look.reason ?? null,
    question: look.question ?? null,
    check: look.notice?.check ?? null,
    subject: look.notice?.subject ?? '',
    since,
    lines: [...lines],
    nature: look.nature ?? null,
  };
}

/**
 * A thing's look as the watcher would weigh it now, with every line of it (*Ask {assistant} to handle these*,
 * handle-it.md): null when nothing needs a look there (it is fine, quieted, or only heads-ups).
 */
export async function thingLook(
  services: Services,
  viewer: HomeViewer,
  key: string,
): Promise<ResearchLook | null> {
  const now = services.clock();
  const thingList = await things(services, viewer, now);
  const fleet = key.startsWith('server:')
    ? await deskFleet(services, viewer.burrow.id).catch(() => null)
    : null;
  const look = deskLooks(fleet?.cards ?? [], thingList, LOOKS_MAX).find((l) => l.key === key);
  if (!look) return null;
  const seen = look.server && look.state === 'down' ? fleet?.rows.get(look.server)?.lastSeen : null;
  const watched = watchedLook(look, seen ? new Date(seen) : null, lookLinesOf(look));
  if (!watched) return null;
  const { nature: _n, ...out } = watched;
  return out;
}

/** Options for tests: whether a turn could run (the runtime's readiness otherwise). */
export interface WatchOptions {
  ready?: (agent: PrincipalRow, person: PrincipalRow) => Promise<boolean>;
}

/** Reads one burrow's looks and acts on its pass. Returns what it started (a research id) or null. */
export async function watchBurrow(
  services: Services,
  burrowId: string,
  before: ReadonlySet<string> | null,
  options: WatchOptions = {},
): Promise<{ seen: Set<string>; started: string | null } | null> {
  const now = services.clock();
  const [burrow] = await services.db.select().from(burrows).where(eq(burrows.id, burrowId));
  const person = await thePerson(services.db, burrowId);
  const agent = await loadAgentRow(services.db, burrowId);
  if (!burrow || !person?.accountId || !agent) return null;
  const viewer: HomeViewer = { burrow, principal: person };
  // A pass that can't read Home says nothing: nothing ends, nothing starts.
  const thingList = await things(services, viewer, now).catch(() => null);
  if (!thingList) return null;
  let serversRead = true;
  const fleet = await deskFleet(services, burrowId).catch(() => {
    serversRead = false;
    return null;
  });
  const cards = fleet?.cards ?? [];
  const sinceOf = (look: DeskLook): Date | null => {
    const seen = look.server ? fleet?.rows.get(look.server)?.lastSeen : null;
    return look.state === 'down' && seen ? new Date(seen) : null;
  };
  const looks = deskLooks(cards, thingList, LOOKS_MAX)
    .map((l) => watchedLook(l, sinceOf(l), lookLinesOf(l)))
    .filter((l): l is WatchedLook => l !== null);
  const rows = await liveRows(services.db, burrowId);
  const ended = await endedRows(services.db, burrowId, new Date(now.getTime() - REMEMBER_MS));
  const turns = rows.flatMap((r) => (r.dispatchId ? [r.dispatchId] : []));
  const turnsEnded = new Set(
    turns.length
      ? (
          await services.db
            .select({ id: dispatches.id })
            .from(dispatches)
            .where(
              and(inArray(dispatches.id, turns), inArray(dispatches.state, ['done', 'failed', 'cancelled'])),
            )
        ).map((d) => d.id)
      : [],
  );
  // How many turns looked into each so far, in its thread since it began (a thing's thread holds all its researches):
  // a failed one is tried once more (`RETRY_AFTER_MS`).
  // A research's thread and its look turns are in the same conversation (the person's Chat): naming it lets the
  // threads' index find the turns, instead of scanning every turn for their roots. A thread whose conversation isn't
  // kept is still found by its root alone.
  const threads = new Map<string | null, string[]>();
  for (const r of rows) {
    if (!r.threadRootId) continue;
    const roots = threads.get(r.conversationId);
    if (roots) roots.push(r.threadRootId);
    else threads.set(r.conversationId, [r.threadRootId]);
  }
  const lookTurns = threads.size
    ? await services.db
        .select({ root: dispatches.threadRootId, at: dispatches.createdAt })
        .from(dispatches)
        .where(
          and(
            eq(dispatches.trigger, 'look'),
            or(
              ...[...threads].map(([conversationId, roots]) =>
                conversationId
                  ? and(
                      eq(dispatches.conversationId, conversationId),
                      inArray(dispatches.threadRootId, roots),
                    )
                  : inArray(dispatches.threadRootId, roots),
              ),
            ),
          ),
        )
    : [];
  const triesOf = (r: LookResearchRow) =>
    lookTurns.filter((d) => d.root === r.threadRootId && d.at >= r.startedAt).length || 1;
  const ready = options.ready
    ? await options.ready(agent, person)
    : (await providerReadiness(services, agent, agentRuntimeOf(agent.runtime).provider, person)).ok;
  const watched = (r: LookResearchRow): WatchedRow => ({
    id: r.id,
    key: r.lookKey,
    kind: r.kind,
    rank: r.rank,
    check: r.checkId,
    subject: r.subject,
    lines: r.lines,
    state: r.state,
    startedAt: r.startedAt,
    stateAt: r.stateAt,
    turnEnded: !!r.dispatchId && turnsEnded.has(r.dispatchId),
    tries: triesOf(r),
    ...(r.care?.new ? { care: true } : {}),
  });
  const plan = planPass({
    looks,
    live: rows.map(watched),
    ended: new Map([...ended].map(([key, r]) => [key, watched(r)])),
    before,
    startedToday: await researchesSince(services.db, burrowId, startOfLocalDay(now, burrow.timeZone)),
    serversRead,
    ready,
    now,
    servers: fleet ? new Set([...fleet.rows.keys()].map((id) => screenText(`server:${id}`, 120))) : null,
  });
  const as = { burrowId, actorId: agent.id };
  if (plan.gone.length || plan.unreported.length || plan.revive.length)
    await services.pipeline.commit(
      settleResearch,
      {
        gone: plan.gone.slice(0, 100),
        unreported: plan.unreported.slice(0, 100),
        revive: plan.revive.slice(0, 100),
      },
      as,
    );
  let started: string | null = null;
  if (plan.retry) await services.pipeline.commit(retryResearch, { researchId: plan.retry }, as);
  if (plan.start) {
    const { nature: _n, ...found } = plan.start;
    // A server's missing backups, snapshots or updates are answered by its care plan (care-plan.md): the turn gets it.
    const server = found.kind === 'server' && hasCareLines(found) ? parseThingId(found.key)?.id : null;
    const care = server ? await careOfferFor(services, burrowId, server).catch(() => null) : null;
    const look = { ...found, care };
    const res = await services.pipeline.commit(startResearch, { look, personId: person.id }, as);
    if (res.status === 'ok') started = res.result?.researchId ?? null;
  }
  return { seen: plan.seen, started };
}

/** The watcher's memory: what each burrow's pass before saw. */
export class LookWatcher {
  readonly #before = new Map<string, Set<string>>();

  constructor(
    private readonly services: Services,
    private readonly options: WatchOptions = {},
  ) {}

  /** One pass over every burrow with a person. */
  async pass(): Promise<void> {
    const rows = await this.services.db.select({ id: burrows.id }).from(burrows);
    for (const { id } of rows) {
      const out = await watchBurrow(this.services, id, this.#before.get(id) ?? null, this.options).catch(
        (err) => {
          this.services.log.warn({ err: String(err), burrowId: id }, 'looks: the pass failed');
          return null;
        },
      );
      // A pass that read nothing forgets: a look must be seen on two passes that read it.
      if (out) this.#before.set(id, out.seen);
      else this.#before.delete(id);
    }
  }
}
