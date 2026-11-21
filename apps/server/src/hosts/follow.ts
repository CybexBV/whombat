/**
 * Long work reports back (proxmox.md PX-05; task-feedback.md TF-10…TF-13): a Servers call that starts a task on a
 * server (a move, a backup, a clone, an Install of updates …) is followed to its end. From its start a live `task` card
 * in the thread it was asked in says what is happening; when the hosts service's event stream says the task ended
 * (`task.finished`) the card settles into how it went, Done recently gets the change, and the agent that started it is
 * woken there to tell the person in its own words (`task_finished`), or, when it can't be, the outcome is posted as one
 * line — “The backup of web on pve-02 is done.”, “Cloning web on pve-02 didn’t work: the storage is full.” — never the
 * task's id or log (they are on the server's Tasks tab).
 *
 * Kept in the database (`followed_tasks`, TF-11), so a restart of Whombat or the hub, or a gap in the event stream, loses
 * nothing: Whombat asks the hub about every running one at start and after the stream's `resync`, and every 5 minutes
 * about those running for more than 2 minutes. One the hub can't tell about 24 hours after it started is `lost`. Ended
 * rows are deleted after 30 days. A task that ends before the call got to keep it (the answer and the event race) is
 * remembered for two minutes, so it is still told.
 *
 * The follow-up is the logic here (`TaskFollow`, unit-tested on a `TaskStore` in memory); the rows, the card, Done
 * recently and the wake are `followed.ts`'s commands (`dbTaskStore`).
 */
import { TASK_RESULT_MAX, type TaskEndState, taskLostText } from '@whombat/core';
import type { Services } from '../services';
import { HOSTS_API, seg } from './client';
import type { HostsChangeInput } from './commands';
import { dbTaskStore } from './followed';
import { camel, obj, toHostServerDetail, toHostTask } from './map';
import { type HostsChange, hostsFor, WHOMBAT_ACTOR } from './service';
import { taskPlatform } from './task-platform';
import {
  checkedText,
  installedText,
  type PackagesResult,
  reportAfterTask,
  type UpdatesReport,
} from './updates';
import { type TaskWords, taskAfterText, taskOutcomeText } from './words';

/** A task Whombat follows, as the follow-up works with it (its `followed_tasks` row). */
export interface FollowedTask {
  /** Whombat's own id for it (`ftk_…`): the card's `followedTaskId`. */
  id: string;
  taskId: string;
  serverId: string;
  /** The server's name in its words and on the card (“BlackBox”). */
  serverName: string;
  burrowId: string;
  conversationId: string;
  /**
   * The thread of that conversation it was asked in (TF-04): the turn's, or after a yes the approval card's. Null: a
   * flat conversation, where it is told at the top.
   */
  threadRootId: string | null;
  agentId: string;
  personId: string | null;
  words: TaskWords;
  /** When it was followed (ms). */
  at: number;
}

/** What a call that started a task gives to follow it. */
export interface NewFollowedTask extends Omit<FollowedTask, 'id' | 'at'> {
  /** The approval whose yes ran the call (its own words then make way for the card, TF-10). */
  approvalId?: string | null;
  /** The change Done recently gets when it ends well (TF-13), with who it is for and what it undoes. */
  change?: HostsChangeInput | null;
}

type Result = 'ok' | 'warning' | 'error';

/** How a followed task ended, as its card, the wake and Done recently say it. */
export interface TaskEnd {
  state: TaskEndState;
  /** The outcome words (at most `TASK_RESULT_MAX`). */
  words: string;
  /** The server's report after it asks for a restart. */
  rebootRequired: boolean;
  /** What an Install installed (Done recently's title), when known. */
  installed: number | null;
  endedAt: number;
}

/** Where followed tasks are kept: the database in Whombat (`dbTaskStore`), a map in tests. */
export interface TaskStore {
  /** Keeps a task and posts its card; null when it can't be kept (it is then told nowhere). */
  start(task: NewFollowedTask, at: number): Promise<FollowedTask | null>;
  /** The running task of a server with this id, or null. */
  running(serverId: string, taskId: string): Promise<FollowedTask | null>;
  /**
   * The running tasks to ask the hosts service about: every one (`null`), or those followed before `startedBefore`
   * and not asked about since `checkedBefore`. Each is marked asked at `at`.
   */
  toAsk(filter: { startedBefore: number; checkedBefore: number } | null, at: number): Promise<FollowedTask[]>;
  /** Ends a running task (its card, Done recently, the wake or the line), once: false when it had ended already. */
  end(task: FollowedTask, end: TaskEnd): Promise<boolean>;
  /** Deletes the tasks that ended before then. */
  sweep(before: number): Promise<void>;
}

/** What the hosts service says about a task now: still running, how it ended, or null when it can't tell. */
export type TaskAnswer =
  | { status: 'running' }
  | { status: Result; message: string | null; code: string | null }
  | null;

/** What a clean end adds from the server's report: the words, a restart it asks for, what an Install installed. */
export interface TaskAfter {
  text: string;
  rebootRequired?: boolean;
  installed?: number | null;
}

/**
 * What a clean end adds from the server's report (IU-07: parity errors, updates), or null; `at` when followed,
 * `endedAt` when the end was heard. For a Check or Install of the server's updates it is the whole message (SWU-08).
 */
export type TaskEnrich = (
  task: FollowedTask,
  message: string | null,
  endedAt: number,
) => Promise<TaskAfter | null>;

export interface TaskFollowDeps {
  store: TaskStore;
  now?: () => number;
  enrich?: TaskEnrich | null;
  /** Asks the hosts service about a task (TF-11); absent: never asked. */
  ask?: ((task: FollowedTask) => Promise<TaskAnswer>) | null;
  /** Something went wrong that nobody sees (logged). */
  warn?: (what: string, err: unknown) => void;
}

const MINUTE = 60_000;
/** How long an end that came before its task was kept is remembered. */
const EARLY_TTL_MS = 2 * MINUTE;
const EARLY_CAP = 200;
/** Asked about again when running longer than this (TF-11)… */
export const ASK_AFTER_MS = 2 * MINUTE;
/** …at most this often; also the follow-up's tick. */
export const ASK_EVERY_MS = 5 * MINUTE;
/** A task the hosts service can't tell about this long after it started is lost (TF-11). */
export const LOST_AFTER_MS = 24 * 60 * MINUTE;
/** Ended tasks are kept this long. */
export const ENDED_KEEP_MS = 30 * 24 * 60 * MINUTE;

const keyOf = (serverId: string, taskId: string) => `${serverId}\n${taskId}`;

/** At most `TASK_RESULT_MAX` characters, never half a character, with “…” when cut. */
export function resultWords(text: string): string {
  const t = text.trim();
  if (t.length <= TASK_RESULT_MAX) return t;
  let out = '';
  for (const ch of t) {
    if (out.length + ch.length > TASK_RESULT_MAX - 1) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

export class TaskFollow {
  readonly #store: TaskStore;
  readonly #now: () => number;
  readonly #enrich: TaskEnrich | null;
  readonly #ask: ((task: FollowedTask) => Promise<TaskAnswer>) | null;
  readonly #warn: (what: string, err: unknown) => void;
  #early = new Map<string, { result: Result; message: string | null; code: string | null; at: number }>();
  /** Tasks this process is ending now (an end is worked out once, however many times it is heard). */
  #ending = new Set<string>();
  #ticking: Promise<void> | null = null;

  constructor(deps: TaskFollowDeps) {
    this.#store = deps.store;
    this.#now = deps.now ?? Date.now;
    this.#enrich = deps.enrich ?? null;
    this.#ask = deps.ask ?? null;
    this.#warn = deps.warn ?? (() => {});
  }

  /** Follows a task a call started (its card is posted); one that already ended is told at once. Null: not kept. */
  async remember(task: NewFollowedTask): Promise<FollowedTask | null> {
    this.#prune();
    const row = await this.#store.start(task, this.#now()).catch((err: unknown) => {
      this.#warn('a task couldn’t be followed', err);
      return null;
    });
    if (!row) return null;
    const key = keyOf(row.serverId, row.taskId);
    const early = this.#early.get(key);
    if (early) {
      this.#early.delete(key);
      await this.#end(row, early.result, early.message, early.code, early.at);
    }
    return row;
  }

  /** A task ended on a server: its message, when Whombat started it (`code`: a package task's `busy` or `timeout`). */
  async finished(
    serverId: string,
    taskId: string,
    result: Result,
    message: string | null,
    code: string | null = null,
  ): Promise<void> {
    this.#prune();
    const key = keyOf(serverId, taskId);
    const at = this.#now();
    // Remembered first: a call keeping this task meanwhile finds it after its commit (the answer and the event race).
    this.#early.set(key, { result, message, code, at });
    while (this.#early.size > EARLY_CAP) {
      const oldest = this.#early.keys().next().value;
      if (oldest === undefined) break;
      this.#early.delete(oldest);
    }
    const row = await this.#store.running(serverId, taskId).catch(() => null);
    if (!row) return;
    this.#early.delete(key);
    await this.#end(row, result, message, code, at);
  }

  /** The hosts service's change notices (`startHosts` listens with this): an end, or a gap in the stream. */
  onChange(change: HostsChange): void {
    if (change.kind === 'resync') {
      void this.check(true);
      return;
    }
    if (change.kind !== 'task' || change.data.event !== 'task.finished') return;
    const d = change.data;
    if (typeof d.task !== 'string' || !d.task) return;
    const result: Result = d.result === 'ok' || d.result === 'warning' ? d.result : 'error';
    void this.finished(
      change.serverId,
      d.task,
      result,
      typeof d.message === 'string' ? d.message : null,
      typeof d.code === 'string' && d.code ? d.code : null,
    );
  }

  /**
   * Asks the hosts service how the running tasks are (TF-11): every one (`all`: at start and after a `resync`), else
   * those running longer than 2 minutes and not asked about for 5. An ended one is told; one it can't tell about 24
   * hours after it started is lost. Also deletes the tasks that ended more than 30 days ago.
   */
  check(all = false): Promise<void> {
    const run = async () => {
      const now = this.#now();
      const rows = await this.#store
        .toAsk(all ? null : { startedBefore: now - ASK_AFTER_MS, checkedBefore: now - ASK_EVERY_MS }, now)
        .catch((err: unknown) => {
          this.#warn('the followed tasks couldn’t be read', err);
          return [] as FollowedTask[];
        });
      for (const row of rows) {
        const answer = this.#ask ? await this.#ask(row).catch(() => null) : null;
        if (answer && answer.status !== 'running')
          await this.#end(row, answer.status, answer.message, answer.code, now);
        else if (!answer && now - row.at > LOST_AFTER_MS) await this.#lose(row, now);
      }
      await this.#store.sweep(now - ENDED_KEEP_MS).catch((err: unknown) => {
        this.#warn('ended tasks weren’t deleted', err);
      });
    };
    // One check at a time; one asked for meanwhile runs after it.
    const next = (this.#ticking ?? Promise.resolve()).then(run);
    const settled = next.catch((err: unknown) => this.#warn('a check of the followed tasks failed', err));
    this.#ticking = settled;
    void settled.then(() => {
      if (this.#ticking === settled) this.#ticking = null;
    });
    return settled;
  }

  /**
   * Starts asking (TF-11): at once about every running task, then every `everyMs` (default 5 minutes). Returns what
   * stops it.
   */
  start(everyMs = ASK_EVERY_MS): () => void {
    void this.check(true);
    const timer = setInterval(() => void this.check(false), everyMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async #end(
    task: FollowedTask,
    result: Result,
    message: string | null,
    code: string | null,
    endedAt: number,
  ): Promise<void> {
    if (this.#ending.has(task.id)) return;
    this.#ending.add(task.id);
    try {
      const said = await this.#outcome(task, result, message, code, endedAt);
      await this.#store.end(task, { state: result, ...said, endedAt });
    } catch (err) {
      // The task stays running: the next check asks the hosts service again.
      this.#warn('a task’s end wasn’t told', err);
    } finally {
      this.#ending.delete(task.id);
    }
  }

  async #lose(task: FollowedTask, now: number): Promise<void> {
    if (this.#ending.has(task.id)) return;
    this.#ending.add(task.id);
    try {
      await this.#store.end(task, {
        state: 'lost',
        words: resultWords(taskLostText(task.serverName)),
        rebootRequired: false,
        installed: null,
        endedAt: now,
      });
    } catch (err) {
      this.#warn('a lost task wasn’t told', err);
    } finally {
      this.#ending.delete(task.id);
    }
  }

  async #outcome(
    task: FollowedTask,
    result: Result,
    message: string | null,
    code: string | null,
    endedAt: number,
  ): Promise<Omit<TaskEnd, 'state' | 'endedAt'>> {
    let text = taskOutcomeText(task.words, result, message, code);
    let rebootRequired = false;
    let installed: number | null = null;
    // A Check's or Install's message is written from its result and the report after it (SWU-08), warnings too.
    const updates = isUpdatesAfter(task.words.after);
    if (!code && (result === 'ok' || (updates && result === 'warning')) && task.words.after && this.#enrich) {
      const more = await this.#enrich(task, message, endedAt).catch(() => null);
      if (more) {
        text = updates ? more.text : `${text} ${more.text}`;
        rebootRequired = more.rebootRequired === true;
        installed = more.installed ?? null;
      }
    }
    return { words: resultWords(text), rebootRequired, installed };
  }

  #prune(): void {
    const now = this.#now();
    for (const [k, e] of this.#early) if (now - e.at > EARLY_TTL_MS) this.#early.delete(k);
  }
}

const instances = new WeakMap<object, TaskFollow>();

/** How long to wait for the next report when the server's detail doesn't show a finished check yet. */
export const AFTER_RETRY_MS = 35_000;

const isUpdatesAfter = (after: TaskWords['after']): after is 'updates.check' | 'updates.install' =>
  after === 'updates.check' || after === 'updates.install';

/**
 * SWU-08's message after a Check or Install: the task's result (what it installed and held back, a warning) and the
 * server's report after it (what waits, a restart), read again once when the report is older than the task's end.
 */
async function updatesAfter(
  services: Services,
  task: FollowedTask,
  endedAt: number,
  retryMs: number,
): Promise<TaskAfter | null> {
  const hosts = hostsFor(services);
  const name = task.words.server ?? task.serverName;
  const read = async () =>
    obj(
      camel(
        obj(
          await hosts.call<unknown>({
            path: `${HOSTS_API}/servers/${seg(task.serverId)}`,
            actor: WHOMBAT_ACTOR,
          }),
        ).system,
      ),
    ) as UpdatesReport;
  let report = await read().catch(() => null);
  if (!reportAfterTask(report, task.at, endedAt)) {
    await new Promise((resolve) => setTimeout(resolve, retryMs));
    report = await read().catch(() => null);
  }
  const after = reportAfterTask(report, task.at, endedAt) ? report : null;
  const rebootRequired = after?.rebootRequired === true;
  if (task.words.after === 'updates.check') {
    const text = checkedText(name, after);
    return text ? { text, rebootRequired } : null;
  }
  const done = await hosts
    .call<unknown>({
      path: `${HOSTS_API}/servers/${seg(task.serverId)}/tasks/${seg(task.taskId)}`,
      query: { platform: 'host' },
      actor: { ...WHOMBAT_ACTOR, role: 'operator' },
    })
    .then((raw) => toHostTask(raw) as { packages?: PackagesResult })
    .catch(() => null);
  return {
    text: installedText(name, done?.packages ?? null, after, task.words.packages ?? []),
    rebootRequired,
    installed: done?.packages?.installed ?? null,
  };
}

/** IU-07's “No errors.”: the server's detail after the task, read again once when its report is older. */
function enrichFor(services: Services, retryMs = AFTER_RETRY_MS): TaskEnrich {
  return async (task, message, endedAt) => {
    const after = task.words.after;
    if (!after) return null;
    if (isUpdatesAfter(after)) return updatesAfter(services, task, endedAt, retryMs);
    const read = async () =>
      toHostServerDetail(
        await hostsFor(services).call<unknown>({
          path: `${HOSTS_API}/servers/${seg(task.serverId)}`,
          actor: WHOMBAT_ACTOR,
        }),
        [],
        null,
        services.clock(),
      );
    let text = taskAfterText(after, await read(), task.at, message);
    if (text === null && after === 'parity') {
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      text = taskAfterText(after, await read(), task.at, message);
    }
    return text === null ? null : { text };
  };
}

/**
 * How a task is now, as the hosts service answers it (TF-11): asked as an operator with the task's own platform (a
 * package task is the host's, a Proxmox task the default). Null when it can't tell (gone from its list, not answering).
 */
export function askHub(services: Services): (task: FollowedTask) => Promise<TaskAnswer> {
  return async (task) => {
    const platform = taskPlatform(task.taskId);
    try {
      const t = toHostTask(
        await hostsFor(services).call<unknown>({
          path: `${HOSTS_API}/servers/${seg(task.serverId)}/tasks/${seg(task.taskId)}`,
          ...(platform !== 'pve' ? { query: { platform } } : {}),
          actor: { ...WHOMBAT_ACTOR, role: 'operator' },
        }),
      );
      if (t.status === 'running') return { status: 'running' };
      return { status: t.status, message: t.message ?? null, code: t.code ?? null };
    } catch {
      return null;
    }
  };
}

/**
 * A follow-up of tasks on these services' database and hosts service. `retryMs`: how long it waits before reading a
 * server's report again when it is older than the task's end (default `AFTER_RETRY_MS`; tests shorten it, test-speed.md).
 * `now`: its clock (tests move it). The process has one (`taskFollowFor`); a new one is what a restart makes.
 */
export function newTaskFollow(
  services: Services,
  options: { retryMs?: number; now?: () => number } = {},
): TaskFollow {
  return new TaskFollow({
    store: dbTaskStore(services),
    now: options.now ?? (() => services.clock().getTime()),
    enrich: enrichFor(services, options.retryMs ?? AFTER_RETRY_MS),
    ask: askHub(services),
    warn: (what, err) =>
      services.log.warn({ err: err instanceof Error ? err.message : String(err) }, `hosts: ${what}`),
  });
}

/**
 * The process's task follow-up (one per `Services`): posts as the Whombat that started the task. Only the call that
 * makes the instance sets its options.
 */
export function taskFollowFor(services: Services, options: { retryMs?: number } = {}): TaskFollow {
  let f = instances.get(services);
  if (!f) {
    f = newTaskFollow(services, options);
    instances.set(services, f);
  }
  return f;
}
