/**
 * Deleting Hermes sessions (hermes-engine.md HE-40, HE-S113): a deleted thread's and Clear chats' sessions go the Hermes
 * way, `hermes sessions delete <id> --yes` with the home's profile as `HERMES_HOME` (the person's, or the outsiders':
 * one-person.md OP-17), under the profile's lock (no Hermes runs on it meanwhile). The runner takes them at once into
 * `pending/<home>.json` and works through them in the background: while a turn holds the profile they are tried again
 * after it (the sweep, every minute), a restart carries on from the file. The lock is taken for one session at a time and never while a turn of the person waits for it, so a long list
 * delays a turn by one delete at most (hermes-native.md HN-K05). A session Hermes doesn't know is gone; one that keeps
 * failing is given up after `MAX_ATTEMPTS`. Listing a profile's sessions (`sessions.list`, HN-K09) is `sessions-list.ts`.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HermesHomeArgs, HermesHomeResult } from '@whombat/core';
import { HERMES_HOMES, type HermesHome } from '@whombat/core';
import { type HermesHomeContext, HermesHomeError } from './context';
import type { AreaHandlers } from './handlers';
import { listSessions } from './sessions-list';

/** Tries of one session's delete before it is given up (a broken store must not be retried forever). */
export const MAX_ATTEMPTS = 20;
/** One `hermes sessions delete` at most. */
const DELETE_TIMEOUT_MS = 60_000;

interface Pending {
  id: string;
  attempts: number;
}

/** Hermes's answer for a session it doesn't have (`hermes_cli/sessions_cmd.py` `_not_found`). */
const NOT_FOUND = /^No session '/m;

/** The homes, as their pending lists are named in `pending/`. */
const HOMES: readonly HermesHome[] = HERMES_HOMES;

export class SessionDeleter {
  /** The pass working through a home's list now, if one is. */
  private readonly draining = new Map<HermesHome, Promise<void>>();
  /** Serializes a pending file's read-modify-write. */
  private readonly fileQueue = new Map<HermesHome, Promise<unknown>>();

  constructor(private readonly ctx: HermesHomeContext) {}

  private file(home: HermesHome): string {
    return join(this.ctx.dir('pending'), `${home}.json`);
  }

  private async read(home: HermesHome): Promise<Pending[]> {
    try {
      const list = JSON.parse(await readFile(this.file(home), 'utf8')) as unknown;
      return Array.isArray(list)
        ? list.filter((p): p is Pending => typeof p?.id === 'string' && typeof p?.attempts === 'number')
        : [];
    } catch {
      return [];
    }
  }

  private async write(home: HermesHome, list: Pending[]): Promise<void> {
    const path = this.file(home);
    if (list.length === 0) {
      await rm(path, { force: true });
      return;
    }
    await mkdir(this.ctx.dir('pending'), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(list), { mode: 0o600 });
    await rename(tmp, path);
  }

  /** Changes a home's pending list, one change at a time. */
  private update<T>(
    home: HermesHome,
    change: (list: Pending[]) => { list: Pending[]; value: T },
  ): Promise<T> {
    const next = (this.fileQueue.get(home) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const { list, value } = change(await this.read(home));
        await this.write(home, list);
        return value;
      });
    this.fileQueue.set(home, next);
    return next;
  }

  /** Takes sessions for deletion; how many are new. The work starts at once. */
  async queue(home: HermesHome, ids: readonly string[]): Promise<number> {
    const added = await this.update(home, (list) => {
      const known = new Set(list.map((p) => p.id));
      const fresh = [...new Set(ids)].filter((id) => !known.has(id));
      return { list: [...list, ...fresh.map((id) => ({ id, attempts: 0 }))], value: fresh.length };
    });
    void this.drain(home);
    return added;
  }

  async pending(home: HermesHome): Promise<string[]> {
    return (await this.read(home)).map((p) => p.id);
  }

  /** Works through a home's list (the pass running now, if one is). */
  drain(home: HermesHome): Promise<void> {
    const running = this.draining.get(home);
    if (running) return running;
    const pass = this.pass(home).finally(() => this.draining.delete(home));
    this.draining.set(home, pass);
    return pass;
  }

  private async pass(home: HermesHome): Promise<void> {
    for (;;) {
      const [next] = await this.read(home);
      if (!next) return;
      let outcome: 'done' | 'retry';
      try {
        // One session per hold of the lock, never waiting for a turn nor taking it while one waits: the sweep comes
        // back after the turn.
        outcome = await this.ctx.withProfile((dir) => this.deleteOne(dir, next.id), {
          waitMs: 0,
          polite: true,
          holder: 'hermes-home:sessions',
          home,
        });
      } catch (err) {
        if (!(err instanceof HermesHomeError && err.code === 'busy'))
          this.ctx.log('warn', `hermes-home · deleting ${home} sessions: ${(err as Error).message}`);
        return;
      }
      await this.update(home, (list) => ({
        list:
          outcome === 'done' || next.attempts + 1 >= MAX_ATTEMPTS
            ? list.filter((p) => p.id !== next.id)
            : [...list.filter((p) => p.id !== next.id), { ...next, attempts: next.attempts + 1 }],
        value: null,
      }));
      if (outcome !== 'done' && next.attempts + 1 >= MAX_ATTEMPTS)
        this.ctx.log('warn', `hermes-home · gave up deleting a session (${next.id})`);
      if (outcome === 'retry') return;
    }
  }

  /** `done` (deleted or not there), or `retry` (Hermes couldn't now: a lost turn, a broken store, a timeout). */
  private deleteOne(home: string, id: string): Promise<'done' | 'retry'> {
    return new Promise((resolve) => {
      execFile(
        this.ctx.bin,
        ['sessions', 'delete', id, '--yes'],
        { env: this.ctx.hermesEnv(home), cwd: home, timeout: DELETE_TIMEOUT_MS, maxBuffer: 256 * 1024 },
        (error, stdout) => {
          if (!error || NOT_FOUND.test(String(stdout))) resolve('done');
          else {
            this.ctx.log(
              'warn',
              `hermes-home · hermes sessions delete: ${String(stdout).trim().slice(0, 300)}`,
            );
            resolve('retry');
          }
        },
      );
    });
  }

  /** The sessions still to delete, tried once more (the worker's minute sweep). */
  async sweep(): Promise<void> {
    for (const home of HOMES) await this.drain(home);
  }

  /** Waits for the passes running now (tests, shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.draining.values()]);
  }
}

const deleters = new WeakMap<HermesHomeContext, SessionDeleter>();

/** The context's deleter (one per service). */
export function sessionDeleter(ctx: HermesHomeContext): SessionDeleter {
  let d = deleters.get(ctx);
  if (!d) {
    d = new SessionDeleter(ctx);
    deleters.set(ctx, d);
  }
  return d;
}

async function del(
  ctx: HermesHomeContext,
  p: HermesHomeArgs<'sessions.delete'>,
): Promise<HermesHomeResult<'sessions.delete'>> {
  return { queued: await sessionDeleter(ctx).queue(p.home, p.sessions) };
}

async function pending(
  ctx: HermesHomeContext,
  p: HermesHomeArgs<'sessions.pending'>,
): Promise<HermesHomeResult<'sessions.pending'>> {
  return { sessions: await sessionDeleter(ctx).pending(p.home) };
}

async function list(
  ctx: HermesHomeContext,
  p: HermesHomeArgs<'sessions.list'>,
): Promise<HermesHomeResult<'sessions.list'>> {
  return listSessions(ctx, p.home);
}

export const sessionHandlers: AreaHandlers<'sessions.delete' | 'sessions.pending' | 'sessions.list'> = {
  'sessions.delete': del,
  'sessions.pending': pending,
  'sessions.list': list,
};
