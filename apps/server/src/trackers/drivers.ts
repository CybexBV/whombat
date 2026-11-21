/**
 * The drivers of this Whombat's report trackers (docs/decisions/report-trackers.md): loaded from the plugins folder at
 * start (`plugins.ts`), and each connection's driver bound to its address and token (`BoundDriver`). Every call has a
 * time limit, what it answers is checked, and a failure becomes one of `errors.ts`'s, so the workflow treats a
 * misbehaving driver like a tracker that doesn't answer.
 */
import type { TrackerRecipeWords, TrackerWords } from '@whombat/core';
import { z } from 'zod';
import { openConnectionSecret } from '../connections/crypto';
import type { CatalogConnectionRow } from '../connections/types';
import type { Services } from '../services';
import {
  TRACKER_DRIVER_API,
  type TrackerCheck,
  TrackerCheck as TrackerCheckSchema,
  type TrackerConnection,
  type TrackerDriver,
  type TrackerDriverInfo,
  TrackerFailure,
  type TrackerGrant,
  TrackerGrant as TrackerGrantSchema,
  type TrackerHealth,
  TrackerHealth as TrackerHealthSchema,
  TrackerItem,
  type TrackerItemFull,
  TrackerItemFull as TrackerItemFullSchema,
  type TrackerPoll,
  type TrackerSend,
  type TrackerSendResult,
  TrackerSendResult as TrackerSendResultSchema,
  type TrackerWriteResult,
  TrackerWriteResult as TrackerWriteResultSchema,
} from './driver';
import { AccessRefused, SourceProblem, TrackerConflict, TrackerNotFound, TrackerRefusal } from './errors';
import { loadPlugins } from './plugins';

/** How long a call may take: a poll reads pages, the rest is one or two requests. */
export const DRIVER_TIMEOUTS = {
  poll: 5 * 60_000,
  call: 60_000,
  quick: 30_000,
} as const;

/** The field of a tracker connection that names its driver. */
export const DRIVER_FIELD = 'driver';

/** A connection's driver, bound to its address and token: the calls the workflow makes. */
export interface BoundDriver {
  /** The driver's id (the plugin's). */
  id: string;
  info: TrackerDriverInfo;
  words: TrackerWords;
  check(): Promise<TrackerCheck>;
  health(): Promise<TrackerHealth>;
  /** Items the tracker lists; entries whose shape didn't check out are counted as unreadable. */
  poll(input: { after: number | null; watch: readonly number[]; pages?: number }): Promise<TrackerPoll>;
  item(id: string): Promise<TrackerItemFull>;
  diagnostics(id: string, pkg: string, maxBytes: number): Promise<{ text: string; cut: boolean }>;
  write(
    id: string,
    input: { assessment: string | null; priority: string | null; requestId: string; resend: boolean },
  ): Promise<TrackerWriteResult>;
  send(id: string, input: TrackerSend): Promise<TrackerSendResult>;
  /** Null: this tracker grants no organization access. */
  grant: ((id: string) => Promise<TrackerGrant>) | null;
  read:
    | ((
        grant: { token: string },
        path: string,
        maxBytes: number,
      ) => Promise<{ status: number; body: string; cut: boolean }>)
    | null;
  revoke: ((id: string) => Promise<boolean>) | null;
  /** The tracker's own line for a fix's pull request, or null. */
  prLine(number: number): string | null;
}

/** What a failed call is, in the workflow's terms. */
function failureOf(err: unknown, product: string): Error {
  if (
    err instanceof SourceProblem ||
    err instanceof TrackerConflict ||
    err instanceof TrackerRefusal ||
    err instanceof TrackerNotFound ||
    err instanceof AccessRefused
  )
    return err;
  const f = TrackerFailure.of(err, product);
  switch (f.code) {
    case 'refused':
    case 'unreachable':
    case 'invalid_answer':
      return new SourceProblem(f.code, f.message);
    case 'conflict':
      return new TrackerConflict(f.message);
    case 'not_found':
      return new TrackerNotFound(f.message);
    case 'rejected':
      return new TrackerRefusal(f.message);
    case 'access_refused':
      return new AccessRefused(f.message);
  }
}

/**
 * `work` within `ms`, its failure mapped (`failureOf`). At the limit only the waiting ends: an interface 1 call can't be
 * cancelled, so its requests finish (or time out) by themselves.
 */
async function timed<T>(product: string, ms: number, work: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SourceProblem('unreachable', `${product} didn’t answer in time.`)),
          ms,
        );
      }),
    ]);
  } catch (err) {
    throw failureOf(err, product);
  } finally {
    clearTimeout(timer);
  }
}

/** A driver's answer checked against its schema; one that doesn't fit is an answer Whombat doesn't understand. */
function checked<T>(schema: z.ZodType<T>, value: unknown, product: string, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new SourceProblem('invalid_answer', `${product}’s ${what} wasn’t what this Whombat understands.`);
  return parsed.data;
}

const PollAnswer = z.object({
  items: z.array(z.unknown()).max(10_000),
  unreadable: z
    .array(z.object({ id: z.string().max(100).nullable(), number: z.number().int().nullable() }))
    .max(10_000)
    .default([]),
  backlog: z.boolean().default(false),
});

/** `driver` bound to the connection `conn` (its address and token). */
export function bindDriver(driver: TrackerDriver, conn: TrackerConnection): BoundDriver {
  const product = driver.info.words.product;
  const call = <T>(ms: number, work: () => Promise<T>) => timed(product, ms, work);
  return {
    id: driver.info.id,
    info: driver.info,
    words: { product: driver.info.words.product, team: driver.info.words.team },
    check: () =>
      call(DRIVER_TIMEOUTS.quick, async () =>
        checked(TrackerCheckSchema, await driver.check(conn), product, 'check'),
      ),
    health: () =>
      call(DRIVER_TIMEOUTS.quick, async () =>
        checked(TrackerHealthSchema, await driver.health(conn), product, 'health'),
      ),
    poll: (input) =>
      call(DRIVER_TIMEOUTS.poll, async () => {
        const raw = checked(PollAnswer, await driver.poll(conn, input), product, 'list of reports');
        const items: TrackerPoll['items'] = [];
        const unreadable = [...raw.unreadable];
        for (const entry of raw.items) {
          const item = TrackerItem.safeParse(entry);
          if (item.success) items.push(item.data);
          else {
            const e = entry as { id?: unknown; number?: unknown } | null;
            unreadable.push({
              id: typeof e?.id === 'string' ? e.id.slice(0, 100) : null,
              number: typeof e?.number === 'number' && Number.isInteger(e.number) ? e.number : null,
            });
          }
        }
        return { items, unreadable, backlog: input.after === null ? false : raw.backlog };
      }),
    item: (id) =>
      call(DRIVER_TIMEOUTS.call, async () =>
        checked(TrackerItemFullSchema, await driver.item(conn, id), product, 'answer for the report'),
      ),
    diagnostics: (id, pkg, maxBytes) =>
      call(DRIVER_TIMEOUTS.call, async () => {
        const out = checked(
          z.object({ text: z.string(), cut: z.boolean() }),
          await driver.diagnostics(conn, id, pkg, maxBytes),
          product,
          'diagnostics',
        );
        return out.text.length > maxBytes ? { text: out.text.slice(0, maxBytes), cut: true } : out;
      }),
    write: (id, input) =>
      call(DRIVER_TIMEOUTS.call, async () =>
        checked(
          TrackerWriteResultSchema,
          await driver.write(conn, id, input),
          product,
          'answer to the write',
        ),
      ),
    send: (id, input) =>
      call(DRIVER_TIMEOUTS.call, async () =>
        checked(TrackerSendResultSchema, await driver.send(conn, id, input), product, 'answer to the reply'),
      ),
    grant: driver.grant
      ? (id) =>
          call(DRIVER_TIMEOUTS.quick, async () =>
            checked(
              TrackerGrantSchema,
              await driver.grant?.(conn, id),
              product,
              'answer to the access request',
            ),
          )
      : null,
    read: driver.read
      ? (grant, path, maxBytes) =>
          call(DRIVER_TIMEOUTS.quick, async () =>
            checked(
              z.object({ status: z.number().int(), body: z.string(), cut: z.boolean() }),
              await driver.read?.(conn, grant, path, maxBytes),
              product,
              'answer',
            ),
          )
      : null,
    revoke: driver.revoke
      ? (id) =>
          timed(product, DRIVER_TIMEOUTS.quick, async () => (await driver.revoke?.(conn, id)) === true).catch(
            () => false,
          )
      : null,
    prLine: (number) => {
      try {
        const line = driver.prLine?.(conn, number) ?? null;
        return typeof line === 'string' && line.trim() && !line.includes('\n')
          ? line.trim().slice(0, 200)
          : null;
      } catch {
        return null;
      }
    },
  };
}

/** The drivers loaded at start, by id, and the plugin folders that didn't load (with why). */
export class TrackerDrivers {
  readonly #drivers = new Map<string, TrackerDriver>();
  #failed: { folder: string; reason: string }[] = [];

  constructor(private readonly services: Pick<Services, 'log'>) {}

  /** Loads `<home>/plugins` (replacing what was loaded before). */
  async load(home: string): Promise<void> {
    const loaded = await loadPlugins(home);
    this.#drivers.clear();
    for (const [id, d] of loaded.drivers) this.#drivers.set(id, d);
    this.#failed = loaded.failed;
    for (const d of loaded.drivers.values())
      this.services.log.info(
        { driver: d.info.id, version: d.info.version },
        'trackers: a driver was loaded from the plugins folder',
      );
    for (const f of loaded.failed)
      this.services.log.warn({ plugin: f.folder, reason: f.reason }, 'trackers: a plugin didn’t load');
  }

  /** Tests and development: a driver added without a plugin file. */
  register(driver: TrackerDriver): void {
    if (driver.info.api !== TRACKER_DRIVER_API) throw new Error('trackers: an unknown driver interface');
    this.#drivers.set(driver.info.id, driver);
  }

  unregister(id: string): void {
    this.#drivers.delete(id);
  }

  get(id: string): TrackerDriver | null {
    return this.#drivers.get(id) ?? null;
  }

  list(): TrackerDriver[] {
    return [...this.#drivers.values()];
  }

  /** Why a plugin of this id didn't load, or null. */
  failure(id: string): string | null {
    return this.#failed.find((f) => f.folder === id)?.reason ?? null;
  }
}

/** The driver a tracker connection names (its `driver` field), or '' without one. */
export function driverIdOf(row: Pick<CatalogConnectionRow, 'fields'>): string {
  const id = (row.fields as Record<string, string> | null | undefined)?.[DRIVER_FIELD];
  return typeof id === 'string' ? id.trim() : '';
}

/** Why a connection has no usable driver, in plain words. */
export function noDriverText(
  row: Pick<CatalogConnectionRow, 'label' | 'fields'>,
  failure: string | null,
): string {
  const id = driverIdOf(row);
  if (!id) return `${row.label} names no driver, so it can’t be read.`;
  return failure
    ? `${row.label} can’t be read: its driver ${id} didn’t load (${failure.replace(/[.\s]+$/, '')}).`
    : `${row.label} can’t be read: its driver ${id} isn’t installed on this Whombat.`;
}

/** The connection's token, opened; '' when it has none or it can't be opened here. */
export function connectionToken(services: Pick<Services, 'custody'>, row: CatalogConnectionRow): string {
  if (!row.secretEnc) return '';
  try {
    return openConnectionSecret(services.custody, row.id, 'secret', row.secretEnc);
  } catch {
    return '';
  }
}

/** The connection as a driver's call takes it. */
export function trackerConnectionOf(
  services: Pick<Services, 'custody'>,
  row: CatalogConnectionRow,
): TrackerConnection {
  return {
    id: row.id,
    label: row.label,
    baseUrl: row.baseUrl.replace(/\/+$/, ''),
    token: connectionToken(services, row),
  };
}

/** The words a connection's driver gives, or the plain ones when it isn't there. */
export function wordsOfDriver(driver: TrackerDriver | null): TrackerWords {
  return driver
    ? { product: driver.info.words.product, team: driver.info.words.team }
    : { product: 'the tracker', team: 'the team' };
}

/**
 * The words a new tracker recipe keeps (`RecipeWhen.words`): the driver's words and its own lines for the prompt, the
 * organization's access only when it grants one.
 */
export function recipeWordsOf(driver: TrackerDriver): TrackerRecipeWords {
  const g = driver.info.guidance ?? {};
  return {
    product: driver.info.words.product,
    team: driver.info.words.team,
    ...(g.source ? { source: g.source } : {}),
    ...(driver.grant && g.access ? { access: g.access } : {}),
  };
}
