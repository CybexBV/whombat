/**
 * The restore test job (docs/decisions/backup-trust.md), every minute on the home jobs' tick:
 *
 * 1. moves every test that isn't finished one step on (`restore_tests.step`): choose the newest backup, a storage with
 *    room and a free number for the copy; restore it as a new machine; pull its network cables, rename and tag it;
 *    start it; wait until it runs (and, when the real machine has a guest agent, until that answers inside the copy);
 *    then stop and delete the copy. Each step is written down before Proxmox is asked, so a restart carries on and the
 *    copy is always found again. The real machine is only read, never changed.
 * 2. starts the weekly test of each server whose tests are on, in the quiet hours, a week after the last one: the
 *    machine whose turn it is.
 * 3. deletes copies an interrupted test left behind (a machine in the copies' range named or tagged as one).
 * 4. keeps a problem for each machine whose last test failed, for the hosts service's hints, while tests are on.
 *
 * Everything goes through the hosts service's manage routes as Whombat.
 */
import {
  type HostHint,
  isRestoreTestCopy,
  isRestoreTestId,
  RESTORE_TEST_FAILED_HINT,
  RESTORE_TEST_FAILURES,
  type RestoreTestReason,
  restoreTestName,
  restoreTestProblem,
} from '@whombat/core';
import { and, desc, eq, gte, isNotNull, isNull } from 'drizzle-orm';
import { changeWindowOf } from '../care/window';
import { burrows, restoreTestServers, restoreTests } from '../db/schema/index';
import { HostsError, HostsUnavailable } from '../hosts/client';
import {
  arr,
  obj,
  toHostBackupVolumes,
  toHostChoices,
  toHostGuestConfig,
  toHostManageResult,
  toHostTask,
} from '../hosts/map';
import { hostsFor, WHOMBAT_ACTOR } from '../hosts/service';
import { G, S } from '../hosts/tools-shared';
import { loadAgentRow } from '../read/principals';
import type { Services } from '../services';
import { beginRestoreTest, stepRestoreTest } from './commands';
import {
  bootVerdict,
  chosenGuests,
  copyOwnsDisks,
  copySettings,
  eligibleGuests,
  freeCopyId,
  guestNumbers,
  networkDown,
  nextGuest,
  roomNeeded,
  storageFor,
  storagesOf,
  TEST_MAX_MS,
  testDue,
  usesHostParts,
} from './plan';

type TestRow = typeof restoreTests.$inferSelect;
type Step = Parameters<typeof stepRestoreTest.apply>[2];

const MIN = 60_000;
/** A restore whose task was lost (a restart while the hub answered) waits this long for its copy to show. */
const LOST_RESTORE_MS = 15 * MIN;
/** Clean-up keeps trying this many minutes; a copy still there is left to the stray sweep. */
const CLEANUP_TRIES = 30;
/** How often a server is looked over for copies an interrupted test left. */
const SWEEP_MS = 10 * MIN;
/** Servers that had a test in this long are looked over too, after their tests were turned off. */
const SWEEP_AFTER_MS = 30 * 24 * 60 * MIN;
/** A call the hosts service couldn't make now is tried again on the next pass, this many times. */
const TRANSIENT_TRIES = 3;

const ADMIN = { ...WHOMBAT_ACTOR, role: 'admin' as const };

/** The hosts service didn't answer, or its server didn't: worth another try. */
function transient(err: unknown): boolean {
  if (err instanceof HostsUnavailable) return true;
  return (
    err instanceof HostsError &&
    (err.status >= 500 || err.status === 408 || err.status === 429 || err.code === 'agent_offline')
  );
}

const codeOf = (err: unknown) => (err instanceof HostsError ? err.code : null);

interface GuestFacts {
  id: string;
  name: string;
  state: string;
  agent: boolean;
  lock: string | null;
  self: boolean;
  tags: string[];
}

function guestFacts(raw: unknown): GuestFacts {
  const g = obj(raw);
  return {
    id: String(g.id ?? ''),
    name: String(g.name ?? ''),
    state: String(g.state ?? ''),
    agent: g.guest_agent === 'running',
    lock: typeof g.lock === 'string' && g.lock ? g.lock : null,
    self: g.self === true,
    tags: Array.isArray(g.tags) ? g.tags.filter((t): t is string => typeof t === 'string') : [],
  };
}

export class RestoreTests {
  #hints: HostHint[] = [];
  #swept = new Map<string, number>();
  #stopHints: (() => void) | null = null;
  #chain: Promise<void> = Promise.resolve();
  #queued: Promise<void> | null = null;

  constructor(private readonly services: Services) {}

  /** Starts giving the hosts service its problems; returns nothing (`close` stops). */
  start(): void {
    if (this.#stopHints) return;
    this.#stopHints = hostsFor(this.services).addHintSource((serverId) =>
      serverId === null ? this.#hints : this.#hints.filter((h) => h.serverId === serverId),
    );
  }

  close(): void {
    this.#stopHints?.();
    this.#stopHints = null;
  }

  /** A pass now (after *Test one now*), or right after the one running. */
  kick(): void {
    void this.pass();
  }

  /** The home job's pass. */
  tick(): Promise<void> {
    return this.pass();
  }

  /**
   * One pass at a time, never two at once (two would ask Proxmox for the same step twice): a call while one runs waits
   * for it and runs once more after it; calls while that one waits share it.
   */
  pass(): Promise<void> {
    if (this.#queued) return this.#queued;
    const next = this.#chain
      .then(() => {
        this.#queued = null;
        return this.#passOnce();
      })
      .catch((err) => this.services.log.warn({ err: String(err) }, 'restore tests: the pass failed'));
    this.#queued = next;
    this.#chain = next;
    return next;
  }

  async #passOnce(): Promise<void> {
    const hosts = hostsFor(this.services);
    if (!hosts.present) return;
    const home = await hosts.homeBurrow().catch(() => null);
    if (!home) return;
    const burrowId = home.id;
    const agent = await loadAgentRow(this.services.db, burrowId);
    if (!agent) return;
    const as = { burrowId, actorId: agent.id };
    const db = this.services.db;
    const settings = await db
      .select()
      .from(restoreTestServers)
      .where(eq(restoreTestServers.burrowId, burrowId));
    const active = await db
      .select()
      .from(restoreTests)
      .where(and(eq(restoreTests.burrowId, burrowId), isNull(restoreTests.finishedAt)));
    for (const t of active)
      await this.#advance(t, as).catch((err) =>
        this.services.log.warn({ err: String(err), test: t.id }, 'restore tests: a step failed'),
      );

    const [burrow] = await db.select().from(burrows).where(eq(burrows.id, burrowId));
    if (burrow) {
      const window = changeWindowOf(burrow);
      const now = this.services.clock();
      const busy = new Set(
        (
          await db
            .select({ serverId: restoreTests.serverId })
            .from(restoreTests)
            .where(and(eq(restoreTests.burrowId, burrowId), isNull(restoreTests.finishedAt)))
        ).map((r) => r.serverId),
      );
      for (const s of settings.filter((x) => x.on && !busy.has(x.serverId))) {
        const [last] = await db
          .select({ startedAt: restoreTests.startedAt })
          .from(restoreTests)
          .where(
            and(
              eq(restoreTests.burrowId, burrowId),
              eq(restoreTests.serverId, s.serverId),
              eq(restoreTests.manual, false),
            ),
          )
          .orderBy(desc(restoreTests.startedAt))
          .limit(1);
        if (!testDue(now, window, burrow.timeZone, last?.startedAt ?? null)) continue;
        await this.startTest(burrowId, s.serverId, null, false, as).catch((err) =>
          this.services.log.warn({ err: String(err), server: s.serverId }, 'restore tests: no test started'),
        );
      }
    }

    await this.#sweep(
      burrowId,
      settings.map((s) => s.serverId),
    ).catch((err) => this.services.log.warn({ err: String(err) }, 'restore tests: the sweep failed'));
    await this.#refreshHints(
      burrowId,
      settings.filter((s) => s.on).map((s) => s.serverId),
    );
  }

  /**
   * Starts a test on a server: of `guestId`, else the machine whose turn it is. Null when there is nothing to test.
   * The test row is written as `as` (the person's *Test one now*, or Whombat).
   */
  async startTest(
    burrowId: string,
    serverId: string,
    guestId: string | null,
    manual: boolean,
    as: { burrowId: string; actorId: string },
  ): Promise<string | null> {
    const hosts = hostsFor(this.services);
    const raw = await this.#guests(serverId);
    const eligible = eligibleGuests(raw);
    let pick = guestId ? (eligible.find((g) => g.id === guestId) ?? null) : null;
    if (!guestId) {
      const [setting] = await this.services.db
        .select()
        .from(restoreTestServers)
        .where(and(eq(restoreTestServers.burrowId, burrowId), eq(restoreTestServers.serverId, serverId)));
      const tested = await this.services.db
        .select({ guestId: restoreTests.guestId, startedAt: restoreTests.startedAt })
        .from(restoreTests)
        .where(and(eq(restoreTests.burrowId, burrowId), eq(restoreTests.serverId, serverId)))
        .orderBy(desc(restoreTests.startedAt))
        .limit(500);
      const last = new Map<string, Date>();
      for (const t of tested) if (!last.has(t.guestId)) last.set(t.guestId, t.startedAt);
      pick = nextGuest(chosenGuests(eligible, setting?.guests ?? []), last);
    }
    if (!pick) return null;
    const res = await this.services.pipeline.commit(
      beginRestoreTest,
      { serverId, guestId: pick.id, guestName: pick.name, kind: pick.kind, manual },
      as,
    );
    if (res.status !== 'ok') return null;
    hosts.forget(`guests:${serverId}`);
    this.kick();
    return res.result?.id ?? null;
  }

  /* One step --------------------------------------------------------------------------------------------------- */

  async #step(as: { burrowId: string; actorId: string }, t: TestRow, patch: Omit<Step, 'id'>): Promise<void> {
    const res = await this.services.pipeline.commit(stepRestoreTest, { id: t.id, ...patch }, as);
    if (res.status !== 'ok') throw new Error(`restore test ${t.id}: the step wasn't written`);
    // The row as written, for the rest of this pass.
    const { finished, backupAt, runningAt, step, tries, ...rest } = patch;
    Object.assign(t, rest);
    if (backupAt !== undefined) t.backupAt = backupAt ? new Date(backupAt) : null;
    if (runningAt !== undefined) t.runningAt = runningAt ? new Date(runningAt) : null;
    if (step !== undefined && step !== t.step) {
      t.step = step;
      t.stepAt = this.services.clock();
      t.tries = tries ?? 0;
    } else if (tries !== undefined) t.tries = tries;
    if (finished) {
      t.step = 'done';
      t.finishedAt = this.services.clock();
    }
  }

  /** Ends with an outcome: the copy (if any) is removed next. */
  async #end(
    as: { burrowId: string; actorId: string },
    t: TestRow,
    outcome: 'worked' | 'failed' | 'skipped',
    reason: RestoreTestReason | null,
    extra: Omit<Step, 'id'> = {},
  ): Promise<void> {
    const now = this.services.clock();
    await this.#step(as, t, {
      ...extra,
      outcome,
      ...(reason ? { reason } : {}),
      durationS: Math.max(0, Math.round((now.getTime() - t.startedAt.getTime()) / 1000)),
      step: 'cleaning',
      tries: 0,
    });
    if (outcome !== 'worked')
      this.services.log.info(
        { test: t.id, guest: t.guestId, outcome, reason },
        'restore tests: a test ended',
      );
  }

  /** A call that went wrong in a step: tried again later, or the end with `reason`. */
  async #trouble(
    as: { burrowId: string; actorId: string },
    t: TestRow,
    err: unknown,
    outcome: 'failed' | 'skipped',
    reason: RestoreTestReason,
  ): Promise<void> {
    if (transient(err) && t.tries + 1 < TRANSIENT_TRIES) {
      await this.#step(as, t, { tries: t.tries + 1 });
      return;
    }
    this.services.log.warn({ err: String(err), test: t.id }, 'restore tests: a call was refused');
    await this.#end(as, t, transient(err) ? 'skipped' : outcome, transient(err) ? 'unreachable' : reason);
  }

  async #advance(t: TestRow, as: { burrowId: string; actorId: string }): Promise<void> {
    const now = this.services.clock();
    const age = now.getTime() - t.startedAt.getTime();
    if (t.step !== 'cleaning' && t.step !== 'done' && age > TEST_MAX_MS) {
      if (t.step === 'pick') await this.#end(as, t, 'skipped', 'unreachable');
      else await this.#end(as, t, 'failed', 'too_long');
      return;
    }
    switch (t.step) {
      case 'pick':
        return this.#pick(t, as);
      case 'restoring':
        return this.#restoring(t, as);
      case 'configuring':
        return this.#configuring(t, as);
      case 'starting':
        return this.#starting(t, as);
      case 'booting':
        return this.#booting(t, as);
      case 'cleaning':
        return this.#cleaning(t, as);
      case 'done':
        await this.#step(as, t, { finished: true });
        return;
    }
  }

  /** Fresh guests of a server (the hosts service's list, not a cached one: a copy appears and goes within minutes). */
  async #guests(serverId: string): Promise<unknown[]> {
    const page = await hostsFor(this.services).call<unknown>({
      path: `${S(serverId)}/guests`,
      query: { limit: 500 },
      actor: WHOMBAT_ACTOR,
    });
    return arr(obj(page).guests);
  }

  async #copy(t: TestRow): Promise<GuestFacts | null> {
    if (t.copyId === null) return null;
    const raw = (await this.#guests(t.serverId)).find((g) => obj(g).id === `pve:${t.copyId}`);
    return raw ? guestFacts(raw) : null;
  }

  async #pick(t: TestRow, as: { burrowId: string; actorId: string }): Promise<void> {
    const hosts = hostsFor(this.services);
    let fleet: Awaited<ReturnType<typeof hosts.fleet>>;
    try {
      fleet = await hosts.fleet();
    } catch (err) {
      return this.#trouble(as, t, err, 'skipped', 'unreachable');
    }
    const server = fleet.servers.find((s) => s.id === t.serverId);
    if (!server || server.status === 'offline' || server.status === 'pending')
      return this.#end(as, t, 'skipped', 'unreachable');
    if (server.remoteControl.manage === false) return this.#end(as, t, 'skipped', 'manage_off');
    try {
      const guests = await this.#guests(t.serverId);
      const original = guests.map(guestFacts).find((g) => g.id === t.guestId);
      // The machine is gone, or it is this Whombat: nothing to say about its backups.
      if (!original || original.self) {
        await this.#step(as, t, { finished: true });
        return;
      }
      let config: ReturnType<typeof toHostGuestConfig>;
      try {
        config = toHostGuestConfig(
          await hosts.call<unknown>({ path: `${G(t.serverId, t.guestId)}/config`, actor: ADMIN }),
        );
      } catch (err) {
        if (codeOf(err) === 'unsupported') return this.#end(as, t, 'skipped', 'other_node');
        throw err;
      }
      if (usesHostParts(config)) return this.#end(as, t, 'skipped', 'host_parts');
      const backups = toHostBackupVolumes(
        await hosts.call<unknown>({ path: `${G(t.serverId, t.guestId)}/backups`, actor: ADMIN }),
      ).filter((b) => b.volume);
      const newest = [...backups].sort(
        (a, b) => Date.parse(b.created ?? '') - Date.parse(a.created ?? ''),
      )[0];
      if (!newest) return this.#end(as, t, 'skipped', 'no_backup');
      // Enough free memory for the copy, as the newest report says.
      const memoryMb = Number(config.values.memory ?? '');
      const { totalGb, usedPct } = server.memory;
      if (Number.isFinite(memoryMb) && memoryMb > 0 && totalGb !== null && usedPct !== null) {
        const freeMb = totalGb * 1024 * (1 - usedPct / 100);
        if (memoryMb > freeMb) return this.#end(as, t, 'skipped', 'no_memory');
      }
      const choices = toHostChoices(
        await hosts.call<unknown>({
          path: `${S(t.serverId)}/manage/choices`,
          query: { platform: 'pve' },
          actor: ADMIN,
        }),
      );
      const diskBytes = (config.disks ?? [])
        .filter((d) => d.media !== 'cdrom' && !d.unused)
        .reduce((sum, d) => sum + (d.sizeBytes ?? 0), 0);
      const storage = storageFor(
        t.kind,
        choices.storages,
        storagesOf(config.values),
        roomNeeded(diskBytes, newest.sizeBytes ?? null),
      );
      if (!storage) return this.#end(as, t, 'skipped', 'no_space');
      const copyId = freeCopyId(guestNumbers(guests));
      if (copyId === null) return this.#end(as, t, 'skipped', 'no_id');
      await this.#step(as, t, {
        step: 'restoring',
        volume: newest.volume,
        backupAt: newest.created && Number.isFinite(Date.parse(newest.created)) ? newest.created : null,
        storage,
        copyId,
        copyName: restoreTestName(t.guestName),
        agentExpected: t.kind === 'vm' && original.agent,
        task: null,
        tries: 0,
      });
      await this.#restore(t, as);
    } catch (err) {
      return this.#trouble(as, t, err, 'skipped', 'refused');
    }
  }

  /** Asks Proxmox to restore the backup as the copy; a number taken meanwhile moves on to the next free one. */
  async #restore(t: TestRow, as: { burrowId: string; actorId: string }): Promise<void> {
    const hosts = hostsFor(this.services);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = toHostManageResult(
          await hosts.call<unknown>({
            method: 'POST',
            path: `${S(t.serverId)}/backups/restore`,
            body: { platform: 'pve', volume: t.volume, new_id: t.copyId, storage: t.storage, unique: true },
            actor: ADMIN,
            timeoutMs: 60_000,
          }),
        );
        hosts.forget('fleet', `guests:${t.serverId}`);
        await this.#step(as, t, { task: r.task?.id ?? null });
        return;
      } catch (err) {
        if (codeOf(err) === 'exists' && t.copyId !== null) {
          const next = freeCopyId(guestNumbers(await this.#guests(t.serverId)), t.copyId);
          if (next === null) return this.#end(as, t, 'skipped', 'no_id');
          await this.#step(as, t, { copyId: next });
          continue;
        }
        // Not answered: it may have started. The restoring step looks for the copy before giving up.
        if (transient(err)) return;
        this.services.log.warn({ err: String(err), test: t.id }, 'restore tests: the restore was refused');
        return this.#end(as, t, 'skipped', 'refused');
      }
    }
    return this.#end(as, t, 'skipped', 'no_id');
  }

  async #restoring(t: TestRow, as: { burrowId: string; actorId: string }): Promise<void> {
    const hosts = hostsFor(this.services);
    const now = this.services.clock();
    if (t.task) {
      try {
        const task = toHostTask(
          await hosts.call<unknown>({
            path: `${S(t.serverId)}/tasks/${encodeURIComponent(t.task)}`,
            query: { platform: 'pve' },
            actor: ADMIN,
          }),
        );
        if (task.status === 'running') return;
        if (task.status === 'error') return this.#end(as, t, 'failed', 'restore_failed');
        await this.#step(as, t, { step: 'configuring', tries: 0 });
        return this.#configuring(t, as);
      } catch (err) {
        if (transient(err)) return;
        // The task is no longer known: the copy tells.
      }
    }
    const copy = await this.#copy(t).catch(() => null);
    if (copy && !copy.lock) {
      await this.#step(as, t, { step: 'configuring', tries: 0 });
      return this.#configuring(t, as);
    }
    // Asked but never answered, and no copy came: it couldn't run (asking again could make a second copy).
    if (!copy && now.getTime() - t.stepAt.getTime() > LOST_RESTORE_MS)
      return this.#end(as, t, 'skipped', 'unreachable');
  }

  async #configuring(t: TestRow, as: { burrowId: string; actorId: string }): Promise<void> {
    const hosts = hostsFor(this.services);
    const copy = await this.#copy(t);
    // The report hasn't caught up with the restore yet, or Proxmox still holds the copy.
    if (!copy || copy.lock || t.copyId === null) return;
    const path = `${G(t.serverId, copy.id)}/config`;
    try {
      const config = toHostGuestConfig(await hosts.call<unknown>({ path, actor: ADMIN }));
      if (!copyOwnsDisks(config.values, t.copyId)) return this.#end(as, t, 'skipped', 'host_parts');
      const set = copySettings(t.kind, config.values, t.copyName ?? restoreTestName(t.guestName));
      if (Object.keys(set).length)
        await hosts.call<unknown>({
          method: 'PUT',
          path,
          body: { digest: config.digest, set, confirm: true },
          actor: ADMIN,
        });
      const after = toHostGuestConfig(await hosts.call<unknown>({ path, actor: ADMIN }));
      const values = { ...after.values, ...(after.pending ?? {}) };
      if (!networkDown(after.values) || !networkDown(values) || !copyOwnsDisks(after.values, t.copyId))
        return this.#end(as, t, 'skipped', 'network_kept');
    } catch (err) {
      if (transient(err) && t.tries + 1 < TRANSIENT_TRIES) {
        await this.#step(as, t, { tries: t.tries + 1 });
        return;
      }
      this.services.log.warn(
        { err: String(err), test: t.id },
        'restore tests: the copy’s settings were refused',
      );
      return this.#end(as, t, 'skipped', transient(err) ? 'unreachable' : 'network_kept');
    }
    await this.#step(as, t, { step: 'starting', tries: 0 });
    return this.#starting(t, as);
  }

  async #starting(t: TestRow, as: { burrowId: string; actorId: string }): Promise<void> {
    const hosts = hostsFor(this.services);
    const copy = await this.#copy(t);
    if (!copy) return this.#end(as, t, 'failed', 'start_failed');
    if (copy.state === 'running') {
      await this.#step(as, t, { step: 'booting', tries: 0 });
      return;
    }
    try {
      await hosts.call<unknown>({
        method: 'POST',
        path: `${G(t.serverId, copy.id)}/actions`,
        body: { action: 'start' },
        actor: ADMIN,
        timeoutMs: 60_000,
      });
      hosts.forget('fleet', `guests:${t.serverId}`);
      await this.#step(as, t, { step: 'booting', tries: 0 });
    } catch (err) {
      return this.#trouble(as, t, err, 'failed', 'start_failed');
    }
  }

  async #booting(t: TestRow, as: { burrowId: string; actorId: string }): Promise<void> {
    const copy = await this.#copy(t);
    const v = bootVerdict({
      kind: t.kind,
      agentExpected: t.agentExpected,
      state: copy?.state ?? null,
      guestAgent: copy?.agent ?? false,
      runningAt: t.runningAt,
      askedAt: t.stepAt,
      now: this.services.clock(),
    });
    if (v.verdict === 'wait') {
      if (v.runningAt && !t.runningAt) await this.#step(as, t, { runningAt: v.runningAt.toISOString() });
      return;
    }
    if (v.verdict === 'worked') return this.#end(as, t, 'worked', null, { booted: v.booted });
    return this.#end(as, t, 'failed', v.reason);
  }

  async #cleaning(t: TestRow, as: { burrowId: string; actorId: string }): Promise<void> {
    if (t.copyId === null) return this.#step(as, t, { finished: true });
    let copy: GuestFacts | null;
    try {
      copy = await this.#copy(t);
    } catch {
      if (t.tries + 1 >= CLEANUP_TRIES) return this.#step(as, t, { finished: true });
      await this.#step(as, t, { tries: t.tries + 1 });
      return;
    }
    if (!copy) return this.#step(as, t, { finished: true });
    // Only ever the copy: the number was free when the test chose it, it is in the copies' range, and the restore was
    // asked to make it there (before it is renamed it carries the real machine's name).
    if (copy.self || !isRestoreTestId(copy.id)) {
      this.services.log.warn(
        { test: t.id, guest: copy.id },
        'restore tests: the copy’s number holds another machine',
      );
      return this.#step(as, t, { finished: true });
    }
    if (t.tries >= CLEANUP_TRIES) {
      this.services.log.warn({ test: t.id, guest: copy.id }, 'restore tests: the copy is still there');
      return this.#step(as, t, { finished: true });
    }
    await this.#step(as, t, { tries: t.tries + 1 });
    await this.#remove(t.serverId, copy).catch((err) =>
      this.services.log.warn({ err: String(err), test: t.id }, 'restore tests: removing the copy failed'),
    );
  }

  /** Stops a copy, or deletes it once stopped (its disks with it). */
  async #remove(serverId: string, copy: GuestFacts): Promise<void> {
    const hosts = hostsFor(this.services);
    if (copy.lock) return;
    if (copy.state !== 'stopped') {
      await hosts.call<unknown>({
        method: 'POST',
        path: `${G(serverId, copy.id)}/actions`,
        body: { action: 'stop', confirm: true },
        actor: ADMIN,
        timeoutMs: 60_000,
      });
    } else {
      await hosts.call<unknown>({
        method: 'DELETE',
        path: G(serverId, copy.id),
        query: { confirm_name: copy.name || copy.id, purge: '1' },
        actor: ADMIN,
        timeoutMs: 60_000,
      });
    }
    hosts.forget('fleet', `guests:${serverId}`);
  }

  /* Copies left behind ------------------------------------------------------------------------------------------------ */

  async #sweep(burrowId: string, serverIds: readonly string[]): Promise<void> {
    const db = this.services.db;
    const now = this.services.clock().getTime();
    const recent = await db
      .selectDistinct({ serverId: restoreTests.serverId })
      .from(restoreTests)
      .where(
        and(eq(restoreTests.burrowId, burrowId), gte(restoreTests.startedAt, new Date(now - SWEEP_AFTER_MS))),
      );
    const active = await db
      .select({ serverId: restoreTests.serverId })
      .from(restoreTests)
      .where(and(eq(restoreTests.burrowId, burrowId), isNull(restoreTests.finishedAt)));
    const busy = new Set(active.map((a) => a.serverId));
    for (const serverId of new Set([...serverIds, ...recent.map((r) => r.serverId)])) {
      if (busy.has(serverId) || now - (this.#swept.get(serverId) ?? 0) < SWEEP_MS) continue;
      this.#swept.set(serverId, now);
      const guests = (await this.#guests(serverId).catch(() => [])).map(guestFacts);
      for (const copy of guests.filter((g) => !g.self && isRestoreTestCopy(g)))
        await this.#remove(serverId, copy).catch((err) =>
          this.services.log.warn(
            { err: String(err), guest: copy.id },
            'restore tests: a left copy wasn’t removed',
          ),
        );
    }
  }

  /* Problems ---------------------------------------------------------------------------------------------------------- */

  async #refreshHints(burrowId: string, onServers: readonly string[]): Promise<void> {
    if (!onServers.length) {
      this.#hints = [];
      return;
    }
    const locale = await hostsFor(this.services)
      .locale()
      .catch(() => 'en');
    const rows = await this.services.db
      .select()
      .from(restoreTests)
      .where(and(eq(restoreTests.burrowId, burrowId), isNotNull(restoreTests.outcome)))
      .orderBy(desc(restoreTests.startedAt))
      .limit(1000);
    this.#hints = failingTests(rows, onServers).map((r) => {
      const words = restoreTestProblem(r.guestName, r.reason as RestoreTestReason, locale);
      return {
        serverId: r.serverId,
        kind: RESTORE_TEST_FAILED_HINT,
        severity: 'warning' as const,
        entity: r.guestId,
        title: words.title,
        detail: words.detail,
        section: 'guests',
        id: `${RESTORE_TEST_FAILED_HINT}:${r.guestId}`,
      };
    });
  }
}

/**
 * The machines whose newest test (that came to a verdict) failed, on servers whose tests are on: one each. A skipped
 * test says nothing about the backup, so it neither raises nor clears a problem.
 */
export function failingTests<
  R extends Pick<TestRow, 'serverId' | 'guestId' | 'outcome' | 'reason' | 'startedAt'>,
>(rows: readonly R[], onServers: readonly string[]): R[] {
  const newest = new Map<string, R>();
  for (const r of [...rows].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())) {
    if (!onServers.includes(r.serverId) || r.outcome === 'skipped' || !r.outcome) continue;
    const key = `${r.serverId}\n${r.guestId}`;
    if (!newest.has(key)) newest.set(key, r);
  }
  return [...newest.values()].filter(
    (r) => r.outcome === 'failed' && RESTORE_TEST_FAILURES.has(r.reason as RestoreTestReason),
  );
}

const all = new WeakMap<Services, RestoreTests>();

/** This runtime's restore test job. */
export function restoreTestsFor(services: Services): RestoreTests {
  let r = all.get(services);
  if (!r) {
    r = new RestoreTests(services);
    all.set(services, r);
  }
  return r;
}
