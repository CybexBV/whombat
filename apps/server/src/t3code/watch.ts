/**
 * The watcher of T3 Code threads the agent handed work to (docs/decisions/t3code.md). Every
 * `T3_WATCH_EVERY_MS` it reads each watched thread through the connection's own sign-in: every item since its last read
 * (`readThread`, a few pages at most) for the job's track and steps; a thread that asks gets its questions read, one
 * that ended its final answer, after a short wait that says whether work it delegated is still running (then it isn't
 * over yet). Anything the agent hasn't told or seen (`threads.ts`'s keys) is committed as `t3code.thread_moved`, which
 * wakes it. While a turn of the agent is at work where a thread is told, the watcher still reads it and keeps what the
 * person sees, but tells and settles nothing: the agent may be reading it itself. An ended job whose pull request is
 * still open has GitHub's side read on (`#followPullRequests`).
 *
 * A run whose thread still waits for work it delegated or a command it waits for (`t3_thread_wait`'s
 * `untilDelegatedWorkSettled` doesn't settle) hasn't truly ended: its end is held back, nobody told, and the end of the
 * run that follows is the one told. When the agent is told of a hand-over's end, Whombat posts T3 Code's report in the
 * person's thread itself as the job's result (`result.ts`).
 *
 * A thread Whombat started is settled in T3 Code once its job is finished, so the person's list there keeps what still
 * needs them; a failed or stopped one stays. A job handed over for the person is finished when the agent says so: it
 * settles the thread itself (`settle.ts` `settleRefusal` keeps it from settling one still at work). A step's, a
 * council's or a checklist's thread is settled by the watcher once that is over. Settling ends the thread's session
 * there, which stops every command it left running, and T3 Code counts a command the thread didn't wait for
 * (`t3_background_wait`) as nothing still going on. So the watcher settles a thread only once it has been quiet for
 * `T3_SETTLE_QUIET_MS` (`#settleQuiet`), and looks that long at a told hand-over for a run after it. When such a
 * command ends meanwhile, T3 Code runs the thread again: a hand-over's watch is on again then, so that run's end is told
 * too. A thread that ended
 * its run waiting for a pull request T3 Code watches for it (its checks, its reviews) isn't over: T3 Code runs it again
 * when the pull request moves, and refuses to on a settled thread. Each run's end is told, and the watch goes on, without
 * settling, until T3 Code no longer watches one (merged, closed, or the thread stopped watching it). A watch that wakes
 * nobody (an automation's step, or another turn that waits for its thread itself, handed the work over and waited for it itself) only settles its
 * thread, once that turn is over, whether or not the turn finished well: Whombat reports the turn's own end.
 *
 * Between passes the running server holds a wait open at T3 Code for the threads at work that wake the agent
 * (`#holdEnds`), so such a thread's end is read the moment it comes. The passes stay: they read what a held wait doesn't
 * tell (a step, a question), and every thread when a wait can't be held.
 *
 * Watches go quiet a week after the agent last handed the thread work, and are deleted 30 days after. A thread T3 Code
 * no longer has goes quiet; one that can't be read now (T3 Code unreachable, signed out) is read again next time.
 */
import {
  COUNCIL_ANSWER_MAX,
  DELEGATION_ANSWER_MAX,
  JOB_REPORT_MAX,
  T3_ANSWER_MAX,
  type T3ThreadQuestion,
  type T3ThreadUpdate,
} from '@whombat/core';
import { and, asc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { CatalogConnectionRow } from '../connections/types';
import { builderStep, memberEnded } from '../council/commands';
import { sweepCouncils, syncCouncilNow } from '../council/run';
import {
  catalogConnections,
  councils,
  delegations,
  delegationTasks,
  type T3WatchRow,
  t3Watches,
} from '../db/schema/index';
import { saysChecks } from '../delegate/briefs';
import {
  awaitFinalVerification,
  CHECKS_STUCK_MINUTES,
  CHECKS_STUCK_NOTE,
  checksStuck,
  refreshDelegation,
  taskChecks,
  taskEnded,
} from '../delegate/commands';
import { mergeReady, START_GRACE_MS, startReady, sweepDelegations, taskOfWatch } from '../delegate/run';
import { isFinal } from '../delegate/state';
import { verificationOf } from '../delegate/verification';
import { verifyFinal } from '../delegate/verify-final';
import { githubScope } from '../managed/providers/github-adapter';
import type { Services } from '../services';
import { rarelyRead, webUrl } from '../things/kinds/business/common';
import {
  AT_WORK,
  callT3,
  environmentOf,
  FINISHED,
  requestIdsOf,
  requestOf,
  T3Failure,
} from '../things/kinds/business/t3code';
import { list, rec, str } from '../things/words';
import { readLastAnswer } from './answer';
import { type T3Moved, t3ThreadMoved, waitsForTurn } from './follow';
import {
  HANDOFF_RECEIPT_SHOWN_MS,
  handoffOf,
  mergeSteps,
  programOf,
  runEndedOf,
  shownSteps,
} from './handoff';
import { publishHandoffs } from './handoffs';
import { mergePromptJobs } from './merge';
import {
  checksOf,
  closeStages,
  githubDue,
  githubProgress,
  isPlanItem,
  JOB_ANSWER_READ_MAX,
  jobAnswerOf,
  planOf,
  progressOf,
  questionOf,
  readProgress,
  readSaid,
  receiptOf,
  retryVerification,
  type T3Progress,
} from './progress';
import { sameProgress } from './pull-requests';
import { type JobReport, reportOf } from './result';
import { settleLater, T3_SETTLE_QUIET_MS } from './settle';
import { outcomeOf } from './status';
import {
  approvalKey,
  asksKey,
  baseBranchOf,
  endedKey,
  mergedOf,
  needsOf,
  pullRequestUrlsOf,
  readThread,
  settlesWhenTold,
  stateArgs,
  type T3ThreadState,
  type ThreadRead,
  threadStateOf,
  waitOf,
  watchedPullRequestsOf,
} from './threads';

/** How often the watched threads are read: the housekeeping tick. */
export const T3_WATCH_EVERY_MS = 15_000;

/** A delegation task's row when T3 Code no longer has its thread, or its thread never began. */
const THREAD_GONE_NOTE = 'Its T3 Code thread is gone, so this stopped.';
const THREAD_UNSTARTED_NOTE = 'Its T3 Code thread never started.';
const DAY = 86_400_000;
/** A watch the agent handed no work for a week goes quiet. */
export const T3_WATCH_DAYS = 7;
/** Quiet watches are deleted after 30 days. */
const KEEP_DAYS = 30;
/** At most this many threads are read in one pass, the ones read longest ago first. */
export const T3_WATCH_PER_PASS = 40;
const AT_ONCE = 4;
/** At most this many ended jobs' pull requests are read on GitHub in one pass. */
const PRS_PER_PASS = 10;
/** A thread waiting to be settled is looked at this often, for a run that started since. */
const SETTLE_LOOK_EVERY_MS = 60_000;
/** At most this many threads waiting to be settled are looked at in one pass. */
const SETTLES_PER_PASS = 10;
/** A report is read this long, so the start a result message keeps is the report's own (`fitAnswer` keeps both ends). */
const JOB_REPORT_READ_MAX = JOB_REPORT_MAX * 2;
/** How long the watcher waits for a thread's delegated work to settle: only to ask whether it has. */
const SETTLE_PROBE_MS = 1000;
/**
 * Threads at work whose end is waited for with a call held open at T3 Code, so their end is read the moment it comes
 * and not at the next pass: at most this many at once, each call this long (a call to a connection ends after 30 s),
 * asked again this often before the pass takes over.
 */
const HELD_WAITS = 6;
/** How long a council's lead thread's end waits for its reviewers to be read one last time. */
const FINAL_READ_WAIT_MS = 10 * 60_000;
/** How long a council's lead thread may wait for its pull request's checks before its run's end counts as its end. */
const PR_WAIT_MS = 2 * 3_600_000;
const HELD_WAIT_MS = 25_000;
const HELD_WAIT_ROUNDS = 40;
/** A delegation thread's messages are read this many at a time, at most this many pages a pass. */
const SAID_PAGE = 20;
const SAID_PAGES = 3;

type Watched = { watch: T3WatchRow; connection: CatalogConnectionRow };

const base = (address: string) => address.replace(/\/+$/, '');

/** What a delegation thread said, as its card shows it: when it changes the card is sent again. */
const saidKey = (watch: T3WatchRow) => {
  const p = progressOf(watch.progress);
  return JSON.stringify([p.said, p.reported]);
};

export class T3Watcher {
  #pass: Promise<void> | null = null;
  /** A pass's reads of threads' last answers (a run's end and its receipt read the same one), by thread and length. */
  #answers = new Map<string, Promise<string | null>>();
  /** What each council builder's watch last said (its step, worktree and branch), so a pass commits only changes. */
  readonly #builders = new Map<string, string>();
  /** The reads of single threads at work now, by thread: a pass and a held wait never read one thread at once. */
  readonly #checks = new Map<string, Promise<void>>();
  /** The threads whose end a held wait waits for now. */
  readonly #held = new Set<string>();
  /** Whether passes hold waits open (the running server does; a test's bare pass doesn't), and how long each is. */
  #holds = false;
  readonly #holdMs: number;
  /** How long a finished thread stays quiet before it is settled, and how often one is looked at meanwhile. */
  readonly #quietMs: number;
  readonly #lookMs: number;

  constructor(
    private readonly services: Services,
    options: { holdMs?: number; quietMs?: number } = {},
  ) {
    this.#holdMs = options.holdMs ?? HELD_WAIT_MS;
    this.#quietMs = options.quietMs ?? T3_SETTLE_QUIET_MS;
    this.#lookMs = Math.min(SETTLE_LOOK_EVERY_MS, this.#quietMs);
  }

  /** From now on a pass also holds a wait open for threads at work (`#holdEnds`). */
  holdWaits(): this {
    this.#holds = true;
    return this;
  }

  /** No more waits are held; the ones open end when T3 Code answers them. Resolves once none is open. */
  async releaseWaits(): Promise<void> {
    this.#holds = false;
    while (this.#held.size) await new Promise((r) => setTimeout(r, 10));
  }

  /** Starts reading every `T3_WATCH_EVERY_MS`; a pass never holds up the other housekeeping. Returns its stop. */
  start(): () => void {
    this.holdWaits();
    const stop = this.services.housekeeping.add(
      't3 code threads',
      T3_WATCH_EVERY_MS,
      async () => {
        void this.pass();
      },
      { first: 'tick' },
    );
    return () => {
      this.#holds = false;
      stop();
    };
  }

  /** One pass (one already running is the one). */
  pass(): Promise<void> {
    this.#pass ??= this.#run()
      .catch((err: unknown) =>
        this.services.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          't3 watch pass failed',
        ),
      )
      .finally(() => {
        this.#pass = null;
      });
    return this.#pass;
  }

  async #run(): Promise<void> {
    const { db } = this.services;
    this.#answers = new Map();
    // Councils first: each one's reviewers are read from its lead thread, and a lead out of time is stopped (council.md).
    await sweepCouncils(this.services).catch((err: unknown) =>
      this.services.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'council sweep failed',
      ),
    );
    // Delegations' tasks: stops tried again, threads that never started failed, the next ones started (delegate.md).
    await sweepDelegations(this.services).catch((err: unknown) =>
      this.services.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'delegation sweep failed',
      ),
    );
    const now = this.services.clock().getTime();
    // A task still at work keeps its watch however long it runs: its list can't end without hearing from it.
    await db
      .update(t3Watches)
      .set({ state: 'idle' })
      .where(
        and(
          eq(t3Watches.state, 'watching'),
          lt(t3Watches.armedAt, new Date(now - T3_WATCH_DAYS * DAY)),
          sql`not exists (select 1 from ${delegationTasks} where ${delegationTasks.id} = ${t3Watches.delegationTaskId} and ${delegationTasks.state} = 'working')`,
        ),
      );
    await db
      .delete(t3Watches)
      .where(and(eq(t3Watches.state, 'idle'), lt(t3Watches.armedAt, new Date(now - KEEP_DAYS * DAY))));
    const rows = await db
      .select({ watch: t3Watches, connection: catalogConnections })
      .from(t3Watches)
      .innerJoin(catalogConnections, eq(catalogConnections.id, t3Watches.connectionId))
      .where(and(eq(t3Watches.state, 'watching'), eq(catalogConnections.status, 'active')))
      // The ones read longest ago first (new and re-armed ones have not been read), so every thread gets its turn
      // however many are watched.
      .orderBy(sql`${t3Watches.checkedAt} asc nulls first`, asc(t3Watches.armedAt))
      .limit(T3_WATCH_PER_PASS);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(AT_ONCE, rows.length) }, async () => {
        while (next < rows.length) {
          const row = rows[next++] as Watched;
          await this.check(row).catch((err: unknown) =>
            this.services.log.warn(
              { err: err instanceof Error ? err.name : 'error', connectionId: row.connection.id },
              't3 watch: a thread could not be read',
            ),
          );
        }
      }),
    );
    await this.#followPullRequests().catch((err: unknown) =>
      this.services.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        't3 watch: ended jobs’ pull requests could not be followed',
      ),
    );
    // A prompt's “Merge into main when it’s done”: once its job is done, its pull request merges when the checks pass.
    await mergePromptJobs(this.services).catch((err: unknown) =>
      this.services.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        't3 watch: prompts’ pull requests could not be merged',
      ),
    );
    await this.#settleQuiet().catch((err: unknown) =>
      this.services.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        't3 watch: finished threads could not be settled',
      ),
    );
    if (this.#holds) await this.#holdEnds();
  }

  /**
   * Holds a wait open at T3 Code for the threads at work that wake the agent, the ones handed over last first: when one
   * ends (work it delegated included) it is read at once, so the agent hears within a moment instead of at the next
   * pass. A wait that can't be held (an older T3 Code, a call that fails) leaves the thread to the passes, as before.
   */
  async #holdEnds(): Promise<void> {
    const { db } = this.services;
    if (this.#held.size >= HELD_WAITS) return;
    const rows = await db
      .select({ watch: t3Watches, connection: catalogConnections })
      .from(t3Watches)
      .innerJoin(catalogConnections, eq(catalogConnections.id, t3Watches.connectionId))
      .where(
        and(
          eq(t3Watches.state, 'watching'),
          eq(t3Watches.wakes, true),
          eq(catalogConnections.status, 'active'),
          sql`${t3Watches.status} in ('preparing', 'queued', 'starting', 'running')`,
        ),
      )
      .orderBy(sql`${t3Watches.armedAt} desc`)
      .limit(HELD_WAITS * 2);
    for (const row of rows as Watched[]) {
      if (this.#held.size >= HELD_WAITS) return;
      const key = `${row.watch.connectionId}\u0000${row.watch.threadId}`;
      if (this.#held.has(key)) continue;
      this.#held.add(key);
      void this.#holdEnd(row)
        .catch(this.#warnFailed(row.watch, 'waiting for a thread’s end'))
        .finally(() => this.#held.delete(key));
    }
  }

  /** One thread's held wait: asked again while it times out and the thread is still watched; its end is read at once. */
  async #holdEnd({ watch, connection }: Watched): Promise<void> {
    const { services } = this;
    const pk = and(eq(t3Watches.connectionId, watch.connectionId), eq(t3Watches.threadId, watch.threadId));
    for (let round = 0; round < HELD_WAIT_ROUNDS; round++) {
      const asked = performance.now();
      const waited = await callT3(services, connection, 't3_thread_wait', {
        threadId: watch.threadId,
        timeoutMs: this.#holdMs,
        untilDelegatedWorkSettled: true,
      }).then(waitOf, () => null);
      if (!waited || !this.#holds) return;
      const [now] = await services.db
        .select({ watch: t3Watches, connection: catalogConnections })
        .from(t3Watches)
        .innerJoin(catalogConnections, eq(catalogConnections.id, t3Watches.connectionId))
        .where(and(pk, eq(t3Watches.state, 'watching')));
      if (!now) return;
      if (!waited.timedOut) {
        await this.check(now as Watched);
        return;
      }
      // It came back at once without an end: this T3 Code doesn't hold the call. The passes read it.
      if (performance.now() - asked < this.#holdMs / 2) return;
    }
  }

  /**
   * Jobs whose T3 Code part ended while their pull request is still open (one an automation's step opened from the
   * job's branch, or one T3 Code doesn't watch): GitHub's side is read once a minute as for a job at work, at most
   * `PRS_PER_PASS` a pass, while the job is listed (a week after its end) and until the pull request merges or closes,
   * so the job shows its checks and its merge. T3 Code isn't asked: its part is over.
   */
  async #followPullRequests(): Promise<void> {
    const { services } = this;
    const { db } = services;
    if (!services.github.adapter) return;
    const now = services.clock();
    const rows = await db
      .select()
      .from(t3Watches)
      .where(
        and(
          eq(t3Watches.state, 'idle'),
          isNull(t3Watches.councilId),
          isNull(t3Watches.delegationTaskId),
          gt(t3Watches.runEndedAt, new Date(now.getTime() - HANDOFF_RECEIPT_SHOWN_MS)),
          sql`${t3Watches.progress}->'pullRequest'->>'state' in ('open', 'draft')`,
        ),
      )
      // Read longest ago first (ISO times sort as text).
      .orderBy(sql`${t3Watches.progress}->'github'->>'at' asc nulls first`)
      .limit(PRS_PER_PASS);
    for (const watch of rows) {
      const p = progressOf(watch.progress);
      if (!githubDue(p, now)) continue;
      const before = JSON.stringify(handoffOf(watch, now));
      const progress = await this.#github(watch, p);
      const [after] = await db
        .update(t3Watches)
        .set({ progress })
        .where(
          and(
            eq(t3Watches.connectionId, watch.connectionId),
            eq(t3Watches.threadId, watch.threadId),
            sameProgress(watch.progress),
          ),
        )
        .returning();
      if (after && JSON.stringify(handoffOf(after, services.clock())) !== before)
        await publishHandoffs(services, after.burrowId, after.conversationId);
    }
  }

  /**
   * Reads one watched thread and wakes the agent when it moved on in a way it hasn't heard of. When what the person sees
   * of it changed (a step, a question, its end), the conversation's hand-overs are sent to whoever has it open.
   */
  check(watched: Watched): Promise<void> {
    const key = `${watched.watch.connectionId}\u0000${watched.watch.threadId}`;
    const reading = this.#checks.get(key);
    if (reading) return reading;
    const read = this.#checkOnce(watched).finally(() => this.#checks.delete(key));
    this.#checks.set(key, read);
    return read;
  }

  async #checkOnce(watched: Watched): Promise<void> {
    const { watch } = watched;
    const started = this.services.clock();
    const before = JSON.stringify(handoffOf(watch, started));
    const saidBefore = saidKey(watch);
    const pk = and(eq(t3Watches.connectionId, watch.connectionId), eq(t3Watches.threadId, watch.threadId));
    try {
      await this.#check(watched);
    } finally {
      let [after] = await this.services.db.select().from(t3Watches).where(pk);
      // Read or not, it goes to the back of the line: a thread that can't be read keeps no other waiting.
      if (after && (!after.checkedAt || after.checkedAt < started))
        [after] = await this.services.db.update(t3Watches).set({ checkedAt: started }).where(pk).returning();
      const moved = after && JSON.stringify(handoffOf(after, this.services.clock())) !== before;
      if (after && moved) await publishHandoffs(this.services, after.burrowId, after.conversationId);
      // A delegation's task: its row on the card says what it does now and what its thread said (delegate.md).
      if (after?.delegationTaskId && (moved || saidKey(after) !== saidBefore))
        await this.#refreshDelegation(after);
    }
  }

  async #check({ watch, connection }: Watched): Promise<void> {
    const { services } = this;
    const { db } = services;
    // A turn of the agent at work where the watch is told (an automation's step waiting for its thread, for one) may
    // read the thread itself: the thread is still read and the job keeps moving for the person, but nothing is told,
    // settled or handed on until that turn is over. What it would have told then has its key, so it is told once.
    const busy = await waitsForTurn(db, watch);
    const call = (tool: string, args: Record<string, unknown>) => callT3(services, connection, tool, args);
    const pk = and(eq(t3Watches.connectionId, watch.connectionId), eq(t3Watches.threadId, watch.threadId));
    let state: T3ThreadState | null;
    let read: ThreadRead;
    try {
      read = await readThread(
        (args) => call('t3_thread_read', args),
        watch.threadId,
        progressOf(watch.progress).readTo,
        watch.items,
      );
      state = threadStateOf(read.latest);
    } catch (err) {
      // T3 Code no longer has it: nothing more to watch, and a task it did is over. Any other refusal may pass; it is
      // read again next time, as it is while a turn is at work there.
      if (err instanceof T3Failure && err.code === 'thread_not_found' && !busy) {
        await db.update(t3Watches).set({ state: 'idle' }).where(pk);
        if (watch.delegationTaskId)
          await this.#delegationGone(watch, THREAD_GONE_NOTE).catch(
            this.#warnFailed(watch, 'ending a task whose thread is gone'),
          );
      }
      throw err;
    }
    const { body } = read;
    if (!state) return;
    const needs = needsOf(state);
    // Cleanup of an ended delegation owns only its old completed run. Work someone resumed stays theirs.
    if (watch.delegationTaskId && !watch.wakes) {
      const found = await taskOfWatch(services, watch.delegationTaskId);
      if (
        found?.d.endedAt &&
        found.task.state !== 'working' &&
        (needs.kind !== 'ended' || (state.activity.startedAt && state.activity.startedAt > found.d.endedAt))
      ) {
        await db.update(t3Watches).set({ state: 'idle', checkedAt: services.clock() }).where(pk);
        return;
      }
    }
    const pending = needs.kind === 'pending' ? (state.activity.asks ? 'question' : 'approval') : null;
    // The job's progress (t3code.md T3-30…T3-41): the track and plan from what was read, GitHub's side once a minute.
    const progress = {
      ...(await this.#progress(connection, watch, body, state, pending)),
      readTo: read.readTo,
    };
    // A run at work again, or a question: an end held back is over (its next end is decided anew).
    if (needs.kind !== 'ended') progress.held = null;
    // Bookkeeping, nobody's change: when it was read, how long its timeline was, and what the person sees of it.
    const kept = await db
      .update(t3Watches)
      .set({
        checkedAt: services.clock(),
        items: state.items,
        ...(state.title ? { title: state.title } : {}),
        status: state.status,
        pending,
        // A question's words come with its questions (below); a permission's subject is in its item.
        asks: pending === 'approval' ? state.activity.approval : pending === 'question' ? watch.asks : null,
        steps: mergeSteps(watch.steps, body),
        program: programOf(body) ?? watch.program,
        runStartedAt: state.activity.startedAt,
        runEndedAt: runEndedOf(body),
        progress,
        ...(watch.url ? {} : { url: await this.#urlOf(connection, watch.threadId) }),
      })
      // The job changed meanwhile (new work handed over, a pull request linked): it is read again next pass.
      .where(and(pk, sameProgress(watch.progress)))
      .returning({ threadId: t3Watches.threadId });
    if (!kept.length) return;
    // More of its timeline is still unread: its end (and what follows it) waits until the track is whole.
    if (read.backlog) return;
    if (watch.councilId) await this.#councilBuilder(watch, body);
    if (busy) {
      // The question the job waits on still shows, for the person to answer (T3-38); the turn is told nothing.
      if (needs.kind === 'pending' && watch.wakes)
        await this.#pending(connection, watch, state, progress, true);
      return;
    }
    // A task that waited for its checks runs again (a check ended): it holds a place again (DLG-21). Asked of the task
    // itself, not of the run's end kept on the watch: a read while a turn was at work may have kept the new run already.
    if (needs.kind === 'nothing' && watch.delegationTaskId) await this.#busyAgain(watch);
    if (needs.kind === 'nothing') return;
    if (needs.kind === 'no_work') {
      // A task's thread gets its first run at launch: one still without it after a while never started.
      if (watch.delegationTaskId) {
        const found = await taskOfWatch(services, watch.delegationTaskId);
        const started = found?.task.startedAt?.getTime() ?? 0;
        if (found?.task.state === 'working' && services.clock().getTime() - started < START_GRACE_MS) return;
        await db.update(t3Watches).set({ state: 'idle' }).where(pk);
        await this.#delegationGone(watch, THREAD_UNSTARTED_NOTE);
        return;
      }
      await db.update(t3Watches).set({ state: 'idle' }).where(pk);
      return;
    }
    // Nobody is woken for it: what it asks waits in T3 Code for whoever looks there.
    if (needs.kind === 'pending' && !watch.wakes) return;
    if (needs.kind === 'pending') return this.#pending(connection, watch, state, progress, false);

    // Its run ended. Work it delegated or a command it waits for may still be running (its result comes in a run of its
    // own): not over yet. The job shows as finishing meanwhile.
    const settled = await call('t3_thread_wait', {
      threadId: watch.threadId,
      timeoutMs: SETTLE_PROBE_MS,
      untilDelegatedWorkSettled: true,
    }).then(waitOf, (err: unknown) => {
      // A T3 Code that doesn't know the wait for delegated work: the run's end is the end.
      if (err instanceof T3Failure) return null;
      throw err;
    });
    if (settled?.timedOut) {
      const key = endedKey(state.latestRunId ?? needs.runId);
      const ordinary = !watch.councilId && !watch.delegationTaskId;
      if (ordinary && key !== watch.seenKey && progress.held?.key !== key) {
        const since = runEndedOf(body) ?? services.clock();
        await db
          .update(t3Watches)
          .set({ progress: { ...progress, held: { key, since: since.toISOString() } } })
          .where(and(pk, sameProgress(progress)));
      }
      return;
    }
    if (settled?.runId && settled.runId !== state.latestRunId) {
      const refreshed = threadStateOf(await call('t3_thread_read', stateArgs(watch.threadId, state.items)));
      if (!refreshed || needsOf(refreshed).kind !== 'ended') return;
      state = refreshed;
    }
    const key = endedKey(settled?.runId ?? state.latestRunId ?? needs.runId);
    // A council's lead thread: its end goes to the council (its answer, the agent woken).
    if (watch.councilId && (await this.#councilEnded(connection, watch, state))) return;
    // A delegation's task: its end goes to the delegation (its answer and pull request, the next task, the agent woken).
    if (watch.delegationTaskId && (await this.#delegationEnded(connection, watch, state, key, progress)))
      return;
    // Pull requests T3 Code still watches for it: it runs again when they move, so this end isn't the last.
    const watching = await this.#watchedPullRequests(connection, watch.threadId);
    await db.update(t3Watches).set({ prs: watching }).where(pk);
    // The agent saw the end itself in its turn, or the turn that handed it over is over: nothing to tell.
    if (key === watch.seenKey || !watch.wakes) {
      if (watching.length) return;
      await db.update(t3Watches).set({ state: 'idle' }).where(pk);
      return this.#settleLater(watch, state.status);
    }
    const ordinary = !watch.councilId && !watch.delegationTaskId;
    const answer = await this.#lastAnswer(connection, watch.threadId, state.items);
    const update = await this.#told(connection, watch, state, {
      event: 'finished',
      answer: answer?.slice(0, T3_ANSWER_MAX) ?? null,
      watching,
      personSaid: progress.personSaid,
    });
    const report = ordinary ? await this.#report(connection, watch, state, body, progress, update.url) : null;
    const moved = await this.#tell(watch, key, !watching.length, update, report);
    // Told: a message sent to the thread from now on asks for the next run, and the person's words were passed on.
    if (moved && !moved.later && (progress.held || progress.asked || progress.personSaid.length))
      await db
        .update(t3Watches)
        .set({ progress: { ...progress, held: null, asked: false, personSaid: [] } })
        .where(and(pk, sameProgress(progress)));
    if (!moved?.dispatchId || watching.length) return;
    await this.#settleLater(watch, state.status);
  }

  /**
   * The job's result for the person's thread (`result.ts`): T3 Code's last answer, its start kept when it is longer than
   * a result message keeps, and the facts the job's progress knows.
   */
  async #report(
    connection: CatalogConnectionRow,
    watch: T3WatchRow,
    state: T3ThreadState,
    body: unknown,
    progress: T3Progress,
    url: string | null,
  ): Promise<JobReport> {
    const { text, cut } = reportOf(
      await this.#lastAnswer(connection, watch.threadId, state.items, JOB_REPORT_READ_MAX),
    );
    const changes = progress.github?.changes;
    const pr = progress.pullRequest;
    return {
      text,
      jobResult: {
        handoffId: watch.threadId,
        outcome: outcomeOf(state.status),
        endedAt: (runEndedOf(body) ?? this.services.clock()).toISOString(),
        tests: progress.receipt?.tests ?? progress.tests,
        changes: changes
          ? { files: changes.fileCount, additions: changes.additions, deletions: changes.deletions }
          : null,
        pullRequest: pr ? { number: pr.number, url: pr.url, state: pr.state } : null,
        durationMs: progress.receipt?.durationMs ?? null,
        program: (programOf(body) ?? watch.program)?.slice(0, 80) ?? null,
        url,
        cut,
      },
    };
  }

  /** What a wake tells of the thread: its title, state and page, and `over`. */
  async #told(
    connection: CatalogConnectionRow,
    watch: T3WatchRow,
    state: T3ThreadState,
    over: Pick<T3ThreadUpdate, 'event'> & Partial<T3ThreadUpdate>,
  ): Promise<T3ThreadUpdate> {
    return {
      connection: connection.handle,
      threadId: watch.threadId,
      title: state.title ?? watch.title,
      status: state.status,
      answer: null,
      requestId: null,
      questions: [],
      approval: null,
      url: await this.#urlOf(connection, watch.threadId),
      watching: [],
      reported: false,
      personSaid: [],
      at: this.services.clock().toISOString(),
      ...over,
    };
  }

  /**
   * A thread that waits on a question or a permission: the job shows the question, read once per question (T3-38), and
   * the agent is woken once for each, unless it saw it already or its turn is at work there (`busy`): it is told once
   * that turn is over, the question read again to tell it.
   */
  async #pending(
    connection: CatalogConnectionRow,
    watch: T3WatchRow,
    state: T3ThreadState,
    progress: T3Progress,
    busy: boolean,
  ): Promise<void> {
    const { db } = this.services;
    const call = (tool: string, args: Record<string, unknown>) =>
      callT3(this.services, connection, tool, args);
    const pk = and(eq(t3Watches.connectionId, watch.connectionId), eq(t3Watches.threadId, watch.threadId));
    const ids = requestIdsOf(await call('t3_pending_request', { action: 'list', threadId: watch.threadId }));
    if (ids.length) {
      const key = asksKey(ids);
      const requestId = ids[0] as string;
      const quiet = key === watch.seenKey || busy;
      if (quiet && progress.question?.requestId === requestId) return;
      const request = requestOf(
        await call('t3_pending_request', { action: 'read', threadId: watch.threadId, requestId }),
        watch.threadId,
      );
      // Only over the progress this pass read: a pull request linked meanwhile (T3-47) isn't overwritten.
      await db
        .update(t3Watches)
        .set({
          asks: request?.questions[0]?.question.slice(0, 300) ?? null,
          progress: { ...progress, question: questionOf(request) },
        })
        .where(and(pk, sameProgress(progress)));
      if (quiet) return;
      const questions: T3ThreadQuestion[] = (request?.questions ?? []).slice(0, 4).map((q) => ({
        id: q.id.slice(0, 200),
        question: q.question.slice(0, 300),
        options: q.options
          .slice(0, 10)
          .map((o) => ({ label: o.label.slice(0, 200), description: o.description })),
        multiSelect: q.multiSelect,
      }));
      await this.#tell(
        watch,
        key,
        false,
        await this.#told(connection, watch, state, {
          event: 'asks',
          requestId,
          questions,
          personSaid: progress.personSaid,
        }),
      );
      return;
    }
    const key = approvalKey(state.activeRunId, state.activity.pending);
    if (key === watch.seenKey || busy) return;
    let approval = state.activity.approval;
    // Its latest items may not have been read (the thread grew since): read them now.
    if (!approval && state.items !== watch.items)
      approval =
        threadStateOf(await call('t3_thread_read', stateArgs(watch.threadId, state.items)))?.activity
          .approval ?? null;
    await this.#tell(
      watch,
      key,
      false,
      await this.#told(connection, watch, state, {
        event: 'approval',
        approval,
        personSaid: progress.personSaid,
      }),
    );
  }

  /**
   * The job's progress after a read (`progress.ts`): its track and tests from the items read, its plan read in full when
   * its plan item changed, GitHub's side of its pull request at most once a minute, and its receipt and its answer once
   * per run end.
   * Council and delegation threads show on their own cards, so only their track is kept. A read that fails leaves the
   * part as it was: the part is hidden, never guessed.
   */
  async #progress(
    connection: CatalogConnectionRow,
    watch: T3WatchRow,
    body: unknown,
    state: T3ThreadState,
    pending: 'question' | 'approval' | null,
  ): Promise<T3Progress> {
    const { services } = this;
    const now = services.clock();
    let p = readProgress(progressOf(watch.progress), body, now, watch.armedAt);
    if (pending !== 'question') p = { ...p, question: null };
    // A delegation's thread: what it says while it works goes on its card.
    if (watch.delegationTaskId && (state.items !== watch.items || p.saidAt === null))
      p = await this.#said(connection, watch.threadId, p);
    if (watch.councilId || watch.delegationTaskId) return p;
    const plan = list(rec(body).items).map(rec).filter(isPlanItem).at(-1);
    const planKey = plan ? `${str(plan.itemId) ?? str(plan.position)}@${str(plan.updatedAt) ?? ''}` : null;
    if (plan && planKey !== p.planKey) {
      const full =
        plan.textTruncated === true && str(plan.itemId)
          ? await callT3(services, connection, 't3_thread_read', {
              threadId: watch.threadId,
              view: 'activity',
              itemId: str(plan.itemId),
              limit: 1,
              maxCharsPerItem: 8000,
            })
              .then(
                (b) =>
                  list(rec(b).items)
                    .map(rec)
                    .find((i) => str(i.itemId) === str(plan.itemId)) ?? null,
              )
              .catch(() => null)
          : plan;
      const steps = full ? planOf(full) : [];
      p = { ...p, planKey, ...(steps.length ? { plan: steps } : {}) };
    }
    const ended = FINISHED.includes(state.status) || (state.status === 'idle' && state.runs > 0);
    const endedAt = runEndedOf(body);
    if (ended) p = closeStages(p, (endedAt ?? now).toISOString());
    if (githubDue(p, now)) p = await this.#github(watch, p);
    if (ended && state.latestRunId && p.receiptRun !== state.latestRunId) {
      // Read longer than the thread keeps, so what it keeps is the answer's own start.
      const answer = await this.#lastAnswer(
        connection,
        watch.threadId,
        state.items,
        JOB_ANSWER_READ_MAX,
      ).catch(() => null);
      p = {
        ...p,
        receipt: receiptOf(p, answer, state.activity.startedAt ?? watch.armedAt, endedAt),
        receiptRun: state.latestRunId,
        answer: jobAnswerOf(answer),
      };
    }
    return p;
  }

  /**
   * The thread's last answer, cut to `max` with its start and its end (`fitAnswer`). T3 Code cuts a long message off at
   * the read's length, so the rest of a cut-off answer is read after it (a few reads at most): the lines Whombat reads
   * close it. A failed read throws, and the next pass reads it again.
   */
  #lastAnswer(
    connection: CatalogConnectionRow,
    threadId: string,
    items: number,
    max: number = T3_ANSWER_MAX,
  ): Promise<string | null> {
    const key = `${connection.id}\u0000${threadId}\u0000${items}\u0000${max}`;
    const known = this.#answers.get(key);
    if (known) return known;
    const read = this.#readLastAnswer(connection, threadId, items, max);
    this.#answers.set(key, read);
    // A failed read isn't kept: the next caller reads again.
    read.catch(() => this.#answers.delete(key));
    return read;
  }

  #readLastAnswer(
    connection: CatalogConnectionRow,
    threadId: string,
    items: number,
    max: number,
  ): Promise<string | null> {
    return readLastAnswer(this.services, connection, threadId, items, max);
  }

  /**
   * A delegation thread's messages since the last read (`readSaid`): a few pages at most, so a long thread is read to
   * its end over a few passes. A read that fails keeps what was there.
   */
  async #said(connection: CatalogConnectionRow, threadId: string, p: T3Progress): Promise<T3Progress> {
    let next = p;
    for (let page = 0; page < SAID_PAGES; page++) {
      const body = await callT3(this.services, connection, 't3_thread_read', {
        threadId,
        view: 'messages',
        limit: SAID_PAGE,
        maxCharsPerItem: 1500,
        ...(next.saidAt !== null ? { afterPosition: next.saidAt } : {}),
      }).catch(() => null);
      if (!body) return next;
      const read = readSaid(next, body);
      // Nothing new, or the position didn't move (nothing more to page through).
      if (read.saidAt === next.saidAt) return read;
      next = read;
      if (rec(body).hasMore !== true) return next;
    }
    return next;
  }

  /** GitHub's side of the job's pull request: its changes (read again when its head moved) and its checks. */
  async #github(watch: T3WatchRow, p: T3Progress): Promise<T3Progress> {
    const { services } = this;
    const now = services.clock();
    const adapter = services.github.adapter;
    const pr = p.pullRequest;
    // Not read again for a minute, whatever happens: a GitHub that refuses isn't asked every pass.
    const tried: T3Progress = {
      ...p,
      github: {
        at: now.toISOString(),
        head: p.github?.head ?? null,
        changes: p.github?.changes ?? null,
        checks: p.github?.checks ?? null,
      },
    };
    if (!adapter || !pr?.repo) return tried;
    try {
      return await githubScope.run({ burrowId: watch.burrowId }, async () => {
        const read = await adapter.getPullRequest(pr.repo, pr.number);
        const [files, runs, statuses] = await Promise.all([
          read.headSha && read.headSha === p.github?.head && p.github?.changes
            ? null
            : adapter.listPullRequestFiles(pr.repo, pr.number),
          read.headSha ? adapter.checkRuns(pr.repo, read.headSha, null) : null,
          read.headSha ? adapter.commitStatuses(pr.repo, read.headSha) : [],
        ]);
        const checks = checksOf(runs?.modified ? runs.data : [], statuses);
        return githubProgress(p, { pr: read, files, checks }, now);
      });
    } catch (err) {
      services.log.debug(
        { err: err instanceof Error ? err.message : String(err) },
        't3 watch: the pull request could not be read on GitHub',
      );
      return tried;
    }
  }

  /**
   * A council's lead thread ended its work (council.md CNL-S02): its last answer, read longer than a hand-over's, goes
   * to the council. False when no member of the council waits for this thread any more (the agent sent it
   * work itself): the ordinary watch tells it then.
   */
  async #councilEnded(
    connection: CatalogConnectionRow,
    watch: T3WatchRow,
    state: T3ThreadState,
  ): Promise<boolean> {
    const { services } = this;
    const failed = state.status === 'failed' || state.status === 'rolled_back';
    const stopped = state.status === 'interrupted' || state.status === 'cancelled';
    const answer = failed
      ? null
      : await this.#lastAnswer(connection, watch.threadId, state.items, COUNCIL_ANSWER_MAX);
    // The lead thread is done: its reviewers' last answers are read first, so the council's turn has every score.
    const [council] = await services.db
      .select()
      .from(councils)
      .where(eq(councils.id, watch.councilId as string));
    const lead = council?.builderThreadId === watch.threadId;
    const ended = watch.runEndedAt?.getTime() ?? services.clock().getTime();
    // A lead that ended its run to wait for its pull request's checks isn't done: T3 Code runs it again when they
    // move. After two hours it counts as done all the same (a pull request left open for the person).
    if (lead && !failed && !stopped && services.clock().getTime() - ended < PR_WAIT_MS) {
      const watching = await this.#watchedPullRequests(connection, watch.threadId).catch(() => []);
      if (watching.length) return true;
    }
    if (lead && council) {
      const read = await syncCouncilNow(services, council, { final: true }).then(
        () => true,
        (err: unknown) => {
          this.#warnFailed(watch, 'reading a council’s reviewers at its end')(err);
          return false;
        },
      );
      // Not read: the end waits for the next pass, so the agent isn't woken with scores missing (and finishes
      // without them). After ten minutes it goes on with what there is.
      if (!read && services.clock().getTime() - ended < FINAL_READ_WAIT_MS) return true;
    }
    const res = await services.pipeline.commit(
      memberEnded,
      {
        councilId: watch.councilId as string,
        threadId: watch.threadId,
        state: failed ? 'failed' : stopped ? 'stopped' : 'done',
        answer,
      },
      { burrowId: watch.burrowId, actorId: watch.agentId },
    );
    if (res.status !== 'ok' || !res.result.handled) return false;
    // The lead's thread stays in T3 Code's list while its council goes on (a go-ahead, more to do): the council's end
    // settles it.
    if (!lead) await this.#settleLater(watch, state.status);
    return true;
  }

  /**
   * A delegation task's end (delegate.md): its last answer and its pull request go to the delegation, which wakes the
   * agent (or, when its pull request waits to be merged, keeps the thread for that); the next tasks whose turn came
   * start, the next pull request is merged, and the thread is settled unless T3 Code still watches a pull request for
   * it. A merge isn't over while T3 Code watches its pull request: it runs the thread again when the checks move. False
   * when no task waits for this thread any more (the agent sent it work itself): the ordinary watch tells it then.
   */
  async #delegationEnded(
    connection: CatalogConnectionRow,
    watch: T3WatchRow,
    state: T3ThreadState,
    key: string,
    progress: T3Progress,
  ): Promise<boolean> {
    const { services } = this;
    const found = await taskOfWatch(services, watch.delegationTaskId as string);
    if (!found) return false;
    const failed = state.status === 'failed' || state.status === 'rolled_back';
    const stopped = state.status === 'interrupted' || state.status === 'cancelled';
    const ours = found.task.state === 'working' && found.task.threadId === watch.threadId;
    if (!ours) return false;
    const merging = ours && found.task.mergeState === 'merging';
    const retry = progress.verificationRetry;
    if (
      isFinal(found.task) &&
      !failed &&
      !stopped &&
      retry?.key === key &&
      Date.parse(retry.nextAt) > services.clock().getTime()
    )
      return true;
    // The same run that left it waiting for its checks: nothing new to read (DLG-21).
    if (
      ours &&
      !isFinal(found.task) &&
      found.task.checks === 'running' &&
      watch.seenKey === key &&
      !failed &&
      !stopped
    )
      return true;
    const prs = await callT3(services, connection, 'list_thread_pull_requests', {
      threadId: watch.threadId,
    }).catch(() => null);
    // An unreadable watch list is unknown, not permission to settle a thread whose pull request may still be watched.
    if (!prs) return true;
    const watched = prs ? watchedPullRequestsOf(prs) : [];
    // Where its pull requests go: later tasks start from it, fetched fresh (DLG-23). Bookkeeping, nobody's change.
    const base = prs ? baseBranchOf(prs) : null;
    if (base && !found.d.baseBranch)
      await services.db.update(delegations).set({ baseBranch: base }).where(eq(delegations.id, found.d.id));
    // A merge waiting for its pull request's checks: not over, and it holds no place meanwhile (DLG-12, DLG-21).
    if (merging && !isFinal(found.task) && watched.length && !failed && !stopped) {
      const res = await services.pipeline.commit(
        taskChecks,
        { delegationId: found.d.id, threadId: watch.threadId, waiting: true },
        { burrowId: watch.burrowId, actorId: watch.agentId },
      );
      await services.db
        .update(t3Watches)
        .set({ seenKey: key })
        .where(and(eq(t3Watches.connectionId, watch.connectionId), eq(t3Watches.threadId, watch.threadId)));
      if (res.status === 'ok' && res.result.changed) await startReady(services, found.d.id, found.d.burrowId);
      return true;
    }
    const answer = failed
      ? null
      : await this.#lastAnswer(connection, watch.threadId, state.items, DELEGATION_ANSWER_MAX);
    const pr = prs ? (pullRequestUrlsOf(prs).at(-1) ?? null) : null;
    const checks = merging ? null : saysChecks(answer);
    const final = isFinal(found.task);
    const proof = final ? verificationOf(merging ? found.task.answer : answer) : null;
    const verified =
      final && !failed && !stopped && proof
        ? await verifyFinal(services, found.d, found.task, proof, pr ?? found.task.pr, merging)
        : null;
    if (verified?.reason === 'unavailable') {
      await services.pipeline.commit(
        awaitFinalVerification,
        {
          delegationId: found.d.id,
          taskId: found.task.id,
          threadId: watch.threadId,
          answer: merging ? found.task.answer : answer,
          pr: pr ?? found.task.pr,
          message: verified.message ?? 'Waiting for GitHub verification.',
          blocked: true,
        },
        { burrowId: watch.burrowId, actorId: watch.agentId },
      );
      await services.db
        .update(t3Watches)
        .set({ seenKey: key, progress: retryVerification(progress, key, services.clock()) })
        .where(and(eq(t3Watches.connectionId, watch.connectionId), eq(t3Watches.threadId, watch.threadId)));
      return true;
    }
    if (retry)
      await services.db
        .update(t3Watches)
        .set({ progress: { ...progress, verificationRetry: null } })
        .where(and(eq(t3Watches.connectionId, watch.connectionId), eq(t3Watches.threadId, watch.threadId)));
    // Its pull request is open and T3 Code watches it, and its checks don't pass yet: it waits for them, holding no
    // place, and its watch goes on (DLG-20, DLG-21). A thread that pushed a fix ends its run saying they fail while the
    // fix's checks run; T3 Code runs it again when they end, so only a thread that stopped watching has given up.
    const settledChecks = final ? verified?.ok === true : checks === 'passing' || checks === 'none';
    if (
      ours &&
      !failed &&
      !stopped &&
      ((final && verified?.reason === 'waiting') || (!merging && watched.length && !settledChecks))
    ) {
      const res = await services.pipeline.commit(
        taskChecks,
        { delegationId: found.d.id, threadId: watch.threadId, waiting: true, pr },
        { burrowId: watch.burrowId, actorId: watch.agentId },
      );
      if (final && verified?.reason === 'waiting' && found.task.note !== CHECKS_STUCK_NOTE)
        await services.pipeline.commit(
          awaitFinalVerification,
          {
            delegationId: found.d.id,
            taskId: found.task.id,
            threadId: watch.threadId,
            answer: merging ? found.task.answer : answer,
            pr: pr ?? found.task.pr,
            message: verified.message ?? 'Waiting for the combined checks.',
            blocked: false,
          },
          { burrowId: watch.burrowId, actorId: watch.agentId },
        );
      await services.db
        .update(t3Watches)
        .set({ seenKey: key })
        .where(and(eq(t3Watches.connectionId, watch.connectionId), eq(t3Watches.threadId, watch.threadId)));
      if (final && verified?.reason === 'waiting')
        await this.#stuckChecks(found, watch, verified.queued ?? []);
      if (res.status === 'ok' && res.result.changed) await startReady(services, found.d.id, found.d.burrowId);
      return true;
    }
    const res = await services.pipeline.commit(
      taskEnded,
      {
        delegationId: found.d.id,
        threadId: watch.threadId,
        state: failed ? 'failed' : stopped ? 'stopped' : 'done',
        answer,
        pr,
        merged: final
          ? verified?.ok
            ? verified.merged === true
            : false
          : merging && prs
            ? mergedOf(prs, found.task.pr ?? pr)
            : null,
        checks,
        verification: proof,
        verified: verified?.ok === true,
        watching: watched.length > 0,
        note: final && verified && !verified.ok ? verified.message : null,
      },
      { burrowId: watch.burrowId, actorId: watch.agentId },
    );
    if (res.status !== 'ok' || !res.result.handled) return false;
    if (!watched.length && res.result.settle) await this.#settleLater(watch, state.status);
    await startReady(services, found.d.id, found.d.burrowId);
    await mergeReady(services, found.d.id, found.d.burrowId);
    return true;
  }

  /**
   * A task whose thread can't end by itself any more (T3 Code no longer has it, or it never began): it failed, which
   * wakes the agent, and the next tasks whose turn came start. Tasks have no time limit, so this is how such work ends.
   */
  async #delegationGone(watch: T3WatchRow, note: string): Promise<void> {
    const { services } = this;
    const found = await taskOfWatch(services, watch.delegationTaskId as string);
    if (found?.task.state !== 'working' || found.task.threadId !== watch.threadId) return;
    const res = await services.pipeline
      .commit(
        taskEnded,
        {
          delegationId: found.d.id,
          threadId: watch.threadId,
          state: 'failed',
          answer: null,
          pr: null,
          merged: null,
          note,
        },
        { burrowId: watch.burrowId, actorId: watch.agentId },
      )
      .catch(() => null);
    if (res?.status !== 'ok' || !res.result.handled) return;
    await startReady(services, found.d.id, found.d.burrowId);
    await mergeReady(services, found.d.id, found.d.burrowId);
  }

  /**
   * The combined check waits for checks that haven't started: past half an hour (since the CI queued them, or
   * since its run ended for a check nobody reported yet), the agent is told once to look at the CI; checks that started
   * after all take the row's line about it away. Checks that merely run never tell anyone.
   */
  async #stuckChecks(
    found: NonNullable<Awaited<ReturnType<typeof taskOfWatch>>>,
    watch: T3WatchRow,
    queued: readonly { name: string; since: string | null }[],
  ): Promise<void> {
    const ended = watch.runEndedAt?.getTime() ?? null;
    const times = queued
      .map((q) => (q.since ? Date.parse(q.since) : ended))
      .filter((at): at is number => at !== null && Number.isFinite(at));
    const oldest = times.length ? Math.min(...times) : null;
    const stuck =
      oldest !== null && this.services.clock().getTime() - oldest >= CHECKS_STUCK_MINUTES * 60_000;
    // Nothing new: not stuck and no line about it to take away, or this wait already told.
    if (!stuck && found.task.note !== CHECKS_STUCK_NOTE) return;
    if (stuck && oldest !== null && (found.task.checksStuckAt?.getTime() ?? -1) >= oldest) return;
    await this.services.pipeline
      .commit(
        checksStuck,
        {
          delegationId: found.d.id,
          taskId: found.task.id,
          since: new Date(oldest ?? this.services.clock().getTime()).toISOString(),
          names: queued.map((q) => q.name.slice(0, 200)).slice(0, 20),
          clear: !stuck,
        },
        { burrowId: watch.burrowId, actorId: watch.agentId },
      )
      .catch(this.#warnFailed(watch, 'marking checks that are stuck'));
  }

  /** A task that waited for its checks is at work again in T3 Code: it holds a place again (DLG-21). */
  async #busyAgain(watch: T3WatchRow): Promise<void> {
    const found = await taskOfWatch(this.services, watch.delegationTaskId as string);
    if (found?.task.state !== 'working' || found.task.checks !== 'running') return;
    if (found.task.threadId !== watch.threadId) return;
    await this.services.pipeline
      .commit(
        taskChecks,
        { delegationId: found.d.id, threadId: watch.threadId, waiting: false },
        { burrowId: watch.burrowId, actorId: watch.agentId },
      )
      .catch(this.#warnFailed(watch, 'marking a task at work again'));
  }

  async #refreshDelegation(watch: T3WatchRow): Promise<void> {
    const found = await taskOfWatch(this.services, watch.delegationTaskId as string);
    if (found?.task.state !== 'working' || found.task.threadId !== watch.threadId) return;
    await this.services.pipeline
      .commit(
        refreshDelegation,
        { delegationId: found.d.id },
        { burrowId: watch.burrowId, actorId: watch.agentId },
      )
      .catch(this.#warnFailed(watch, 'refreshing a delegation'));
  }

  /** What a council's builder does now and where it works, when that changed since the last pass. */
  async #councilBuilder(watch: T3WatchRow, body: unknown): Promise<void> {
    const steps = shownSteps(mergeSteps(watch.steps, body));
    const step = steps.filter((s) => !s.done).at(-1)?.text ?? steps.at(-1)?.text ?? null;
    const t = rec(rec(body).thread);
    const worktree = str(t.worktreePath)?.slice(0, 2000) ?? null;
    const branch = str(t.branch)?.slice(0, 300) ?? null;
    const key = `${watch.connectionId}:${watch.threadId}`;
    const seen = `${step}|${worktree}|${branch}`;
    if (this.#builders.get(key) === seen) return;
    this.#builders.set(key, seen);
    if (this.#builders.size > 200) this.#builders.delete(this.#builders.keys().next().value as string);
    await this.services.pipeline
      .commit(
        builderStep,
        { councilId: watch.councilId as string, threadId: watch.threadId, step, worktree, branch },
        { burrowId: watch.burrowId, actorId: watch.agentId },
      )
      .catch((err) => {
        // Not written: forget it, so the next pass writes it again.
        if (this.#builders.get(key) === seen) this.#builders.delete(key);
        this.#warnFailed(watch, 'saving what a council builder does')(err);
      });
  }

  /** A step for a watched thread failed: say so in the log and go on; the next pass tries it again. */
  #warnFailed(watch: T3WatchRow, what: string): (err: unknown) => void {
    return (err) =>
      this.services.log.warn(
        { err: String(err), connectionId: watch.connectionId, threadId: watch.threadId },
        `t3code watch: ${what} failed`,
      );
  }

  /**
   * The pull requests T3 Code watches for a thread. A T3 Code that can't list them (an older one) watches none Whombat
   * knows of; one that can't be reached now is asked again next pass.
   */
  async #watchedPullRequests(connection: CatalogConnectionRow, threadId: string): Promise<string[]> {
    return watchedPullRequestsOf(
      await callT3(this.services, connection, 'list_thread_pull_requests', { threadId }),
    );
  }

  /**
   * Marks a thread whose work completed to be settled once it has been quiet (`#settleQuiet`); a failed one stays. A
   * hand-over's mark only looks for a run after the told one: the agent settles its thread.
   */
  async #settleLater(watch: T3WatchRow, status: T3ThreadState['status']): Promise<void> {
    if (!settlesWhenTold(status)) return;
    await settleLater(this.services.db, watch.connectionId, watch.threadId, this.services.clock());
  }

  /**
   * The quiet watches whose thread waits to be settled (`progress.settle`), each looked at about once a minute: settled
   * in T3 Code once no run has started for `T3_SETTLE_QUIET_MS` and it waits for nothing (delegated work, a command it
   * waits for, a pull request T3 Code watches for it). A run that started since puts a hand-over's watch on again, so
   * that run's end is told; any other watch waits for it to be over. A hand-over's thread is left for the agent to
   * settle once that time is up. A thread that can't be read now, or that T3 Code refuses to settle, is looked at again
   * a minute later.
   */
  async #settleQuiet(): Promise<void> {
    const { services } = this;
    const due = new Date(services.clock().getTime() - this.#lookMs).toISOString();
    const rows = await services.db
      .select({ watch: t3Watches, connection: catalogConnections })
      .from(t3Watches)
      .innerJoin(catalogConnections, eq(catalogConnections.id, t3Watches.connectionId))
      .where(
        and(
          eq(t3Watches.state, 'idle'),
          eq(catalogConnections.status, 'active'),
          sql`${t3Watches.progress}->'settle'->>'at' <= ${due}`,
        ),
      )
      // Looked at longest ago first (ISO times sort as text).
      .orderBy(sql`${t3Watches.progress}->'settle'->>'at' asc`)
      .limit(SETTLES_PER_PASS);
    for (const row of rows as Watched[])
      await this.#settleIfQuiet(row).catch(async (err: unknown) => {
        this.#warnFailed(row.watch, 'settling a finished thread')(err);
        await services.db
          .update(t3Watches)
          .set({
            progress: sql`jsonb_set(${t3Watches.progress}, '{settle,at}', to_jsonb(${services.clock().toISOString()}::text))`,
          })
          .where(
            and(
              eq(t3Watches.connectionId, row.watch.connectionId),
              eq(t3Watches.threadId, row.watch.threadId),
              sql`${t3Watches.progress}->'settle' is not null`,
            ),
          );
      });
  }

  async #settleIfQuiet({ watch, connection }: Watched): Promise<void> {
    const { services } = this;
    const { db } = services;
    const progress = progressOf(watch.progress);
    const mark = progress.settle;
    if (!mark) return;
    const now = services.clock();
    const pk = and(eq(t3Watches.connectionId, watch.connectionId), eq(t3Watches.threadId, watch.threadId));
    const write = (settle: T3Progress['settle'], extra: Partial<T3WatchRow> = {}) =>
      db
        .update(t3Watches)
        .set({ ...extra, progress: { ...progress, settle } })
        .where(and(pk, eq(t3Watches.state, 'idle'), sameProgress(watch.progress)));
    const call = (tool: string, args: Record<string, unknown>) => callT3(services, connection, tool, args);
    let body: unknown;
    try {
      body = await call('t3_thread_read', stateArgs(watch.threadId, watch.items));
    } catch (err) {
      if (err instanceof T3Failure && err.code === 'thread_not_found') return void (await write(null));
      throw err;
    }
    const state = threadStateOf(body);
    if (!state) return void (await write({ ...mark, at: now.toISOString() }));
    const ordinary = watch.wakes && !watch.councilId && !watch.delegationTaskId;
    const ranAgain =
      state.activeRunId !== null ||
      (state.latestRunId !== null && endedKey(state.latestRunId) !== watch.seenKey);
    // A command it left running ended and T3 Code ran the thread again: that run's end is the job's news too.
    if (ordinary && ranAgain) return void (await write(null, { state: 'watching' }));
    const atWork = state.activeRunId !== null || AT_WORK.includes(state.status);
    if (!atWork && !settlesWhenTold(state.status)) return void (await write(null));
    const ended = runEndedOf(body)?.getTime() ?? 0;
    const quietSince = Math.max(Date.parse(mark.from), ended);
    const later = () => write({ from: atWork ? now.toISOString() : mark.from, at: now.toISOString() });
    if (atWork || now.getTime() - quietSince < this.#quietMs) return void (await later());
    // A job handed over for the person is settled by the agent once it is finished (it may still have more for the
    // thread); the watch only looked for a run after the told one.
    if (ordinary) return void (await write(null));
    const waits = await call('t3_thread_wait', {
      threadId: watch.threadId,
      timeoutMs: SETTLE_PROBE_MS,
      untilDelegatedWorkSettled: true,
    }).then(waitOf, (err: unknown) => {
      if (err instanceof T3Failure) return null;
      throw err;
    });
    const watched = await this.#watchedPullRequests(connection, watch.threadId);
    if (waits?.timedOut || watched.length)
      return void (await write({ from: now.toISOString(), at: now.toISOString() }));
    try {
      await callT3(
        services,
        connection,
        't3_thread_organize',
        { action: 'settle', threadId: watch.threadId },
        'things.action',
      );
    } catch (err) {
      if (!(err instanceof T3Failure)) throw err;
      // T3 Code refused it (busy for a moment, archived meanwhile): tried again in a minute, for a day at most.
      services.log.debug(
        { err: err.message, connectionId: connection.id },
        't3 watch: a finished thread could not be settled yet',
      );
      const gaveUp = now.getTime() - quietSince > this.#quietMs + DAY;
      return void (await write(gaveUp ? null : { ...mark, at: now.toISOString() }));
    }
    await write(null);
  }

  /** Wakes the agent for it: the turn that tells it, or null when nobody was woken. */
  async #tell(
    watch: T3WatchRow,
    key: string,
    ends: boolean,
    update: T3ThreadUpdate,
    result: JobReport | null = null,
  ): Promise<T3Moved | null> {
    const res = await this.services.pipeline.commit(
      t3ThreadMoved,
      { connectionId: watch.connectionId, threadId: watch.threadId, key, ends, update, result },
      { burrowId: watch.burrowId, actorId: watch.agentId },
    );
    return res.status === 'ok' ? res.result : null;
  }

  /** The thread's page in T3 Code's web app (`<address>/<environment>/<thread>`), else T3 Code's address. */
  async #urlOf(connection: CatalogConnectionRow, threadId: string): Promise<string | null> {
    const env = environmentOf(
      await rarelyRead(
        this.services,
        `t3code-env:${connection.id}`,
        connection,
        () => callT3(this.services, connection, 't3_environment_read', {}),
        { optional: true },
      ),
    ).id;
    const address = base(connection.baseUrl);
    return (
      (env ? webUrl(`${address}/${encodeURIComponent(env)}/${encodeURIComponent(threadId)}`) : null) ??
      webUrl(address)
    );
  }
}

let watcher: { services: Services; watcher: T3Watcher } | null = null;

/** This process's watcher (one per services). */
export function t3WatcherFor(services: Services): T3Watcher {
  if (watcher?.services !== services) watcher = { services, watcher: new T3Watcher(services) };
  return watcher.watcher;
}
