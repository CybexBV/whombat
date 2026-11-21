/**
 * The backup this Whombat has open for reading (backup-look.md): one at a time, because the backup service opens one
 * peek at a time. Opening one asks the service and waits for it to be ready; then its database is read through a
 * read-only pool of its own and its folders without following a symlink. It closes when the person is done, after two
 * hours unused, when the box stops, and at the next start when a stop left one open (its id is kept in a small file).
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { type BackupLookTally, backupLookDoneLine, newId } from '@whombat/core';
import {
  BACKUP_LOOK_IDLE_MS,
  type BackupLook,
  type BackupLookBringResult,
  type BackupLookCategory,
  type BackupLookCategoryCount,
  type BackupLookContentsOutput,
  type BackupLookProblem,
} from '@whombat/protocol/session';
import type { BurrowRow } from '../../commit/types';
import { createDb } from '../../db/client';
import { withDatabase } from '../../db/url';
import { ApiError } from '../../lib/errors';
import { iso } from '../../lib/time';
import type { BackupPort } from '../../managed/backup-port';
import { loadAgentRow, type PrincipalRow, shortName } from '../../read/principals';
import type { Services } from '../../services';
import { backupCodeOf } from '../errors';
import { stagedPath, stagingDir } from '../paths';
import { bringBack } from './bring';
import { allLookItems, findPicked, type LookScope, lookCategories, lookItems } from './items';
import { closePeek, LOOK_TEXT, openPeek, PEEK_DATABASE, readPeek } from './peek';
import { itemIdOf, makePick, type PickedItem, parseItemId } from './pick';

/**
 * How long a bring-back's answer waits for it before saying it is still going (the screens follow it): well within a
 * device's 30-second wait for an answer.
 */
export const BRING_WAIT_MS = 20_000;
/** How often an open look is checked for being unused. */
const IDLE_CHECK_MS = 60_000;

/** The words of a bring-back that couldn't finish. */
export const BRING_TEXT = {
  running: 'Something is being brought back already. Try again when it’s done.',
  failed:
    'Bringing them back stopped part-way. Try again: what came back stays, and nothing comes back twice.',
  notOpen: 'This backup isn’t open any more. Open it again to bring things back.',
  nothing: 'None of those are in this backup.',
} as const;

interface Look {
  id: string;
  checkpointId: string;
  madeAt: Date | null;
  ownerId: string;
  port: BackupPort;
  peekId: string | null;
  state: BackupLook['state'];
  problem: BackupLookProblem | null;
  expiresAt: string | null;
  root: string | null;
  pool: ReturnType<typeof createDb> | null;
  usedAt: number;
  categories: BackupLookCategoryCount[] | null;
  bring: BackupLookBringResult | null;
  bringing: Promise<void> | null;
}

/** Who looks: the person, their account's email (their own things in the backup) and the Whombat. */
export interface Looker {
  burrow: BurrowRow;
  person: PrincipalRow;
  email: string;
}

const view = (l: Look): BackupLook => ({
  lookId: l.id,
  checkpointId: l.checkpointId,
  madeAt: l.madeAt ? iso(l.madeAt) : null,
  state: l.state,
  expiresAt: l.state === 'ready' || l.state === 'opening' ? l.expiresAt : null,
  problem: l.problem,
  bring: l.bring,
});

/** What a bring-back says for the assistant to pass on. */
export function bringSay(bring: BackupLookBringResult | null): string {
  if (!bring) return BRING_TEXT.notOpen;
  if (bring.state === 'bringing') return 'Bringing them back now; it takes a moment.';
  if (bring.state === 'failed') return bring.error ?? BRING_TEXT.failed;
  const tally: BackupLookTally = {
    back: bring.back,
    already: bring.already,
    notBack: bring.notBack,
    titles: bring.titles,
    signIn: bring.signIn,
  };
  return backupLookDoneLine(tally);
}

export class BackupLooks {
  #look: Look | null = null;
  #stopIdle: (() => void) | null = null;

  constructor(private readonly services: Services) {}

  /** Where the open peek's id is kept, so a start after a stop closes it (beside, not in, the backup files' folder). */
  private get marker(): string {
    return join(dirname(stagingDir(this.services.config)), 'backup-look.json');
  }

  /** At start: a peek a stop left open is closed; then the check for an unused look. */
  async start(port: BackupPort): Promise<void> {
    const left = await readFile(this.marker, 'utf8')
      .then((t) => (JSON.parse(t) as { peekId?: unknown }).peekId)
      .catch(() => null);
    if (typeof left === 'string' && !this.#look) {
      await closePeek(port, left, 5_000).catch(() => {});
      await rm(this.marker, { force: true }).catch(() => {});
    }
    this.#stopIdle ??= this.services.housekeeping.add('backup look', IDLE_CHECK_MS, () => this.closeIdle());
  }

  /** The box stops: the open look closes (quickly; the service closes it at its own start anyway). */
  async stop(): Promise<void> {
    this.#stopIdle?.();
    this.#stopIdle = null;
    const look = this.#look;
    if (look) await this.shut(look, 'closed', 3_000).catch(() => {});
  }

  /** Closes the look once it has been unused for two hours (never while it brings things back). */
  async closeIdle(now = Date.now()): Promise<boolean> {
    const look = this.#look;
    if (!look || look.bringing || look.state === 'closed') return false;
    if (now - look.usedAt < BACKUP_LOOK_IDLE_MS) return false;
    await this.shut(look, 'closed');
    look.problem = { code: 'closed', message: LOOK_TEXT.closed };
    return true;
  }

  /** The look `id` of this person, used now; refused when it isn't the open one. */
  private mine(lookId: string, person: PrincipalRow): Look {
    const look = this.#look;
    if (!look || look.id !== lookId || look.ownerId !== person.id)
      throw new ApiError('not_found', BRING_TEXT.notOpen, { details: { code: 'backup_look_closed' } });
    look.usedAt = Date.now();
    return look;
  }

  /** Ends the pool, then asks the service to close the peek (once more after a moment when a session lingered). */
  private async shut(look: Look, state: 'closed' | 'failed', deadlineMs = 15_000): Promise<void> {
    const pool = look.pool;
    look.pool = null;
    look.root = null;
    look.state = state;
    look.categories = null;
    if (pool) await pool.sql.end({ timeout: 2 }).catch(() => {});
    const peekId = look.peekId;
    look.peekId = null;
    if (peekId) {
      let answer = await closePeek(look.port, peekId, deadlineMs).catch(() => 'closed' as const);
      if (answer === 'busy') {
        await new Promise((r) => setTimeout(r, 1000));
        answer = await closePeek(look.port, peekId, deadlineMs).catch(() => 'closed' as const);
      }
    }
    await rm(this.marker, { force: true }).catch(() => {});
  }

  /** Opens a backup for reading (the same one again answers the same look; another closes the one open first). */
  async open(
    port: BackupPort,
    who: Looker,
    checkpointId: string,
    madeAt: () => Promise<Date | null>,
  ): Promise<BackupLook> {
    const open = this.#look;
    if (open && open.checkpointId === checkpointId && open.ownerId === who.person.id) {
      if (open.state === 'opening' || open.state === 'ready') {
        open.usedAt = Date.now();
        open.port = port;
        await this.refresh(open);
        if (open.state === 'opening' || open.state === 'ready') return view(open);
      }
    }
    if (open?.bringing)
      return view({
        ...newLook(port, who, checkpointId, null),
        state: 'failed',
        problem: { code: 'busy', message: LOOK_TEXT.busy },
      });
    if (open) await this.shut(open, 'closed');
    const look = newLook(port, who, checkpointId, await madeAt().catch(() => null));
    this.#look = look;
    const answer = await openPeek(port, checkpointId);
    if ('problem' in answer) {
      look.state = 'failed';
      look.problem = answer.problem;
      return view(look);
    }
    look.peekId = answer.id;
    await mkdir(dirname(this.marker), { recursive: true }).catch(() => {});
    await writeFile(this.marker, JSON.stringify({ peekId: answer.id }), { mode: 0o600 }).catch(() => {});
    await this.refresh(look);
    return view(look);
  }

  /** Follows an opening peek to ready (its pool connected), and notices one that closed. */
  private async refresh(look: Look): Promise<void> {
    if (!look.peekId || (look.state !== 'opening' && look.state !== 'ready')) return;
    if (look.state === 'ready' && look.expiresAt && Date.parse(look.expiresAt) > Date.now()) return;
    let peek: Awaited<ReturnType<typeof readPeek>>;
    try {
      peek = await readPeek(look.port, look.peekId);
    } catch {
      // The service didn't answer this time: the look stays as it is.
      return;
    }
    look.expiresAt = peek?.expiresAt ?? null;
    if (!peek || peek.state === 'closed') {
      await this.shut(look, 'closed');
      look.problem = { code: 'closed', message: LOOK_TEXT.closed };
      return;
    }
    if (peek.state === 'failed') {
      await this.shut(look, 'failed');
      look.problem = { code: 'failed', message: LOOK_TEXT.failed };
      return;
    }
    if (peek.state !== 'ready' || look.state === 'ready') return;
    const database = peek.database ?? '';
    const root = peek.root ?? '';
    if (!PEEK_DATABASE.test(database) || !isAbsolute(root)) {
      await this.shut(look, 'failed');
      look.problem = { code: 'failed', message: LOOK_TEXT.failed };
      return;
    }
    // Its own small pool, read-only from the start: nothing is ever written to the backup.
    const pool = createDb(withDatabase(this.services.config.DATABASE_URL, database), {
      max: 2,
      readOnly: true,
    });
    try {
      await pool.sql`select 1`;
    } catch (err) {
      this.services.log.warn({ err: String(err) }, 'backup look: the backup’s database didn’t open');
      await pool.sql.end({ timeout: 2 }).catch(() => {});
      await this.shut(look, 'failed');
      look.problem = { code: 'failed', message: LOOK_TEXT.failed };
      return;
    }
    look.pool = pool;
    look.root = root;
    look.state = 'ready';
  }

  private async scope(look: Look, who: Looker): Promise<LookScope> {
    const agent = await loadAgentRow(this.services.db, who.burrow.id);
    return {
      peek: look.pool?.db as LookScope['peek'],
      root: look.root as string,
      live: this.services.db,
      burrowId: who.burrow.id,
      personId: who.person.id,
      accountId: who.person.accountId ?? null,
      agent: agent ? shortName(agent) : 'Your assistant',
    };
  }

  async contents(
    who: Looker,
    input: { lookId: string; category?: BackupLookCategory; query?: string; cursor?: string },
  ): Promise<BackupLookContentsOutput> {
    const look = this.mine(input.lookId, who.person);
    await this.refresh(look);
    const empty = { look: view(look), categories: [], category: null, items: [], nextCursor: null };
    if (look.state !== 'ready' || !look.pool || !look.root) return empty;
    const s = await this.scope(look, who);
    try {
      look.categories ??= await lookCategories(s);
      const page = input.category ? await lookItems(s, input.category, input.query, input.cursor) : null;
      return {
        look: view(look),
        categories: look.categories,
        category: input.category ?? null,
        items: page?.items ?? [],
        nextCursor: page?.nextCursor ?? null,
      };
    } catch (err) {
      // The backup's database may have gone away under us (the service closed it): ask, and close the look if so.
      this.services.log.warn({ err: String(err) }, 'backup look: reading the backup failed');
      look.expiresAt = null;
      await this.refresh(look).catch(() => {});
      throw err;
    }
  }

  /**
   * Brings back the picked things (or whole categories) and waits a while for it; the answer says how it went, or that
   * it is still going (the look's `bring` then follows it).
   */
  async bring(
    who: Looker,
    input: { lookId: string; items?: string[]; categories?: BackupLookCategory[] },
    waitMs = BRING_WAIT_MS,
  ): Promise<{ look: BackupLook; say: string }> {
    const look = this.mine(input.lookId, who.person);
    await this.refresh(look);
    if (look.state !== 'ready' || !look.pool || !look.root)
      throw new ApiError('conflict', BRING_TEXT.notOpen, { details: { code: 'backup_look_closed' } });
    if (look.bringing) return { look: view(look), say: bringSay(look.bring) };
    const picked: PickedItem[] = [];
    for (const id of input.items ?? []) {
      const item = parseItemId(id);
      if (!item)
        throw new ApiError('validation_failed', BRING_TEXT.nothing, { fields: { items: ['unknown item'] } });
      picked.push(item);
    }
    const s = await this.scope(look, who);
    const whole = input.categories ?? [];
    for (const category of whole)
      for (const i of await allLookItems(s, category)) {
        const item = parseItemId(i.id);
        if (item) picked.push(item);
      }
    const found = await findPicked(s, dedupe(picked));
    if (found.length === 0) {
      look.bring = result('done', { picked: picked.length, back: 0, already: 0, notBack: picked.length });
      return { look: view(look), say: BRING_TEXT.nothing };
    }
    const pick = makePick(found, whole);
    look.bring = result('bringing', { picked: found.length });
    const job = bringBack({
      services: this.services,
      lookId: look.id,
      burrow: who.burrow,
      person: who.person,
      personEmail: who.email,
      peek: look.pool.db,
      root: look.root,
      madeAt: look.madeAt ?? this.services.clock(),
      pick,
      found,
      scratch: stagedPath(this.services.config, `${look.id}-${newId('backupRestore').slice(4, 10)}.work`),
    })
      .then((done) => {
        look.bring = result('done', {
          picked: found.length,
          back: done.back,
          already: done.already,
          notBack: done.notBack,
          titles: done.titles,
          signIn: done.signIn,
        });
      })
      .catch((err: unknown) => {
        const running = backupCodeOf(err) === 'restore_running';
        if (!running)
          this.services.log.warn({ err: String(err) }, 'backup look: bringing things back failed');
        look.bring = result('failed', {
          picked: found.length,
          error: running ? BRING_TEXT.running : BRING_TEXT.failed,
        });
      })
      .finally(() => {
        look.bringing = null;
        look.usedAt = Date.now();
      });
    look.bringing = job;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([job, new Promise((r) => (timer = setTimeout(r, waitMs)))]);
    clearTimeout(timer);
    return { look: view(look), say: bringSay(look.bring) };
  }

  /** The look this person has open (the assistant's last find), or null. */
  current(person: PrincipalRow): BackupLook | null {
    const look = this.#look;
    return look && look.ownerId === person.id ? view(look) : null;
  }

  /** Picked items as the backup has them (their titles and where they were), for the card that asks first. */
  async named(
    who: Looker,
    lookId: string,
    items: readonly string[],
  ): Promise<{ id: string; title: string }[]> {
    const look = this.mine(lookId, who.person);
    await this.refresh(look);
    if (look.state !== 'ready' || !look.pool || !look.root) return [];
    const picked = dedupe(items.flatMap((id) => parseItemId(id) ?? []));
    const found = await findPicked(await this.scope(look, who), picked);
    return found.map((f) => ({ id: itemIdOf(f.item), title: f.title }));
  }

  /** Waits for a bring-back that is still going (tests, shutdown). */
  async settle(): Promise<void> {
    await this.#look?.bringing;
  }

  async close(lookId: string, person: PrincipalRow): Promise<BackupLook> {
    const look = this.mine(lookId, person);
    if (look.bringing)
      throw new ApiError('conflict', 'It’s still bringing things back. Close it when that’s done.', {
        details: { code: 'backup_look_busy' },
      });
    await this.shut(look, 'closed');
    look.problem = null;
    return view(look);
  }
}

function newLook(port: BackupPort, who: Looker, checkpointId: string, madeAt: Date | null): Look {
  return {
    id: newId('backupLook'),
    checkpointId,
    madeAt,
    ownerId: who.person.id,
    port,
    peekId: null,
    state: 'opening',
    problem: null,
    expiresAt: null,
    root: null,
    pool: null,
    usedAt: Date.now(),
    categories: null,
    bring: null,
    bringing: null,
  };
}

function result(
  state: BackupLookBringResult['state'],
  r: Partial<Omit<BackupLookBringResult, 'state'>>,
): BackupLookBringResult {
  return {
    state,
    picked: r.picked ?? 0,
    back: r.back ?? 0,
    already: r.already ?? 0,
    notBack: r.notBack ?? 0,
    titles: (r.titles ?? []).slice(0, 10),
    signIn: (r.signIn ?? []).slice(0, 10),
    error: r.error ?? null,
    finishedAt: state === 'bringing' ? null : new Date().toISOString(),
  };
}

function dedupe(items: PickedItem[]): PickedItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const key = JSON.stringify(i);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function looksFor(services: Services): BackupLooks {
  const s = services as Services & { backupLooks?: BackupLooks };
  s.backupLooks ??= new BackupLooks(services);
  return s.backupLooks;
}
