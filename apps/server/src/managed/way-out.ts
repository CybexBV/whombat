/**
 * Whombat checks its own way out (docs/decisions/monitoring.md MON-08). Every minute the server process checks, without
 * root:
 *
 * - **the router**: the default gateway from the process's own route table (`/proc/self/net/route`: the server's
 *   sandbox shows only its own process under `/proc`, so `/proc/net` isn't there), reached with a TCP connect on a few
 *   common ports (a refused connection still proves it answers);
 * - **the internet**: TCP connects to two independent addresses, Whombat's own service (the hosted app's host) and a
 *   well-known anycast address, by their addresses so name lookups don't decide it, at the same time as the router;
 * - **name lookups**: the system resolver finding those names, and always one fixed name, so a box whose targets are
 *   bare addresses still checks its lookups.
 *
 * A step that fails for two minutes in a row is an outage (`way_out_outages`). The internet is down when nothing outside
 * answers; it is the router's fault only when a gateway is known and doesn't answer either (a router that drops these
 * ports while the internet works, an IPv6-only or point-to-point route, says nothing about the router). Without a
 * gateway the router isn't judged. When the internet answers, name lookups that all fail are the step said: “The router
 * doesn't answer”, “The internet is down since 14:02”, “Name lookups don't work”. It is one Inbox
 * item that starts on (Whombat can't reach things any more), and while it lasts the connections on internet addresses
 * that fail are down because of it (the causes job, `things/causes.ts`) and listed under that item instead of each
 * having their own. It ends at the first pass that finds every step working; the outage stays for history (“The
 * internet was down 14:02–14:31”).
 *
 * The probes are injected: a development box and tests never probe the internet unless `WHOMBAT_WAY_OUT` is `on`.
 */
import { promises as dns } from 'node:dns';
import { readFile } from 'node:fs/promises';
import { connect, isIP } from 'node:net';
import { localParts, type NeedsYouItem, randomIdBody } from '@whombat/core';
import { and, desc, eq, gte, isNull, or } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { burrows, wayOutOutages } from '../db/schema/index';
import type { WayOutOutageRow } from '../db/schema/quiet-windows';
import { homeAudience, publishHomeChanged } from '../home/notify';
import { registerNeedsYouSource, type SourceCtx } from '../home/registry';
import { loadPrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { checkStartsOn, registerChecks } from '../things/quiet/defaults';

export type WayOutStep = 'router' | 'names' | 'internet';

/** How often the way out is checked. */
export const WAY_OUT_CHECK_MS = 60_000;
/** How long a step must fail before it is an outage: two minutes, so one lost answer is nothing. */
export const WAY_OUT_CONFIRM_MS = 2 * 60_000;
/** How long one probe waits for an answer. */
export const PROBE_TIMEOUT_MS = 3_000;
/** The router's ports tried: name service, web, secure web. Any answer, even a refusal, is the router answering. */
const ROUTER_PORTS = [53, 80, 443];
/** Two anycast addresses of different operators, when the box has no Whombat service to reach. */
const ANYCAST = ['1.1.1.1:443', '9.9.9.9:443'];
/** A name every resolver finds, looked up on every pass whatever the targets are. */
export const WAY_OUT_NAME = 'one.one.one.one';
/** The route tables read for the default gateway: the process's own first (the server's sandbox hides `/proc/net`). */
const ROUTE_TABLES = ['/proc/self/net/route', '/proc/net/route'];

/** The check behind the item: Whombat can't reach things any more, so it starts on (watch-defaults.md). */
export const WAY_OUT_CHECKS = [{ check: 'box.way_out', startsOn: true }] as const;
registerChecks(WAY_OUT_CHECKS);

/* Probes ---------------------------------------------------------------------------------------------------------- */

/** What the check asks of the network; tests and a development box stand in for it. */
export interface WayOutProbes {
  /** The default gateway's address, or null without one. */
  gateway(): Promise<string | null>;
  /** Whether something answers at `host:port` (a refused connection answers). */
  answers(host: string, port: number): Promise<boolean>;
  /** The addresses a name resolves to with the system resolver; empty when it doesn't. */
  lookup(name: string): Promise<string[]>;
}

/** The default gateway from `/proc/net/route`'s text: the row for 0.0.0.0/0 with the gateway flag (pure). */
export function defaultGateway(routes: string): string | null {
  for (const line of routes.split('\n').slice(1)) {
    const [, dest, gateway, flags, , , , mask] = line.trim().split(/\s+/);
    if (dest !== '00000000' || !gateway || !flags) continue;
    if (mask && mask !== '00000000') continue;
    // RTF_UP (1) and RTF_GATEWAY (2); the address is little-endian hex.
    if ((Number.parseInt(flags, 16) & 3) !== 3) continue;
    const n = Number.parseInt(gateway, 16);
    if (!Number.isFinite(n) || n === 0) continue;
    return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join('.');
  }
  return null;
}

/**
 * The default gateway from the first route table that can be read: the process's own, which the server's sandbox
 * (`ProcSubset=pid`) keeps, else the system's.
 */
export async function readGateway(read: (file: string) => Promise<string>): Promise<string | null> {
  for (const file of ROUTE_TABLES) {
    const text = await read(file).catch(() => null);
    if (text !== null) return defaultGateway(text);
  }
  return null;
}

/** The probes of the real network. */
export function systemProbes(timeoutMs = PROBE_TIMEOUT_MS): WayOutProbes {
  return {
    gateway: () => readGateway((file) => readFile(file, 'utf8')),
    answers(host, port) {
      return new Promise((resolve) => {
        const socket = connect({ host, port });
        const done = (ok: boolean) => {
          socket.destroy();
          resolve(ok);
        };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', (err: NodeJS.ErrnoException) => done(err.code === 'ECONNREFUSED'));
      });
    },
    async lookup(name) {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<string[]>((resolve) => {
        timer = setTimeout(() => resolve([]), timeoutMs);
        timer.unref?.();
      });
      const found = dns
        .lookup(name, { all: true })
        .then((all) => all.map((a) => a.address))
        .catch(() => [] as string[]);
      return Promise.race([found, late]).finally(() => clearTimeout(timer));
    },
  };
}

/** A `host:port` target. */
export interface WayOutTarget {
  host: string;
  port: number;
}

/** The targets from `WHOMBAT_WAY_OUT_TARGETS`, else Whombat's own service and an anycast address (pure). */
export function wayOutTargets(config: { targets?: string; appUrl?: string | undefined }): WayOutTarget[] {
  const parse = (t: string): WayOutTarget | null => {
    const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(t.trim());
    const port = m ? Number(m[2]) : 0;
    return m?.[1] && port > 0 && port < 65_536 ? { host: m[1], port } : null;
  };
  const given = (config.targets ?? '')
    .split(',')
    .map(parse)
    .filter((t): t is WayOutTarget => t !== null);
  if (given.length >= 2) return given.slice(0, 2);
  let own: WayOutTarget | null = null;
  try {
    const host = config.appUrl ? new URL(config.appUrl).hostname : '';
    if (host && host !== 'localhost' && !host.endsWith('.localhost')) own = { host, port: 443 };
  } catch {
    own = null;
  }
  const anycast = ANYCAST.map(parse).filter((t): t is WayOutTarget => t !== null);
  return own ? [own, anycast[0] as WayOutTarget] : anycast;
}

/**
 * Which step of the way out fails now; null when all work. The router and the internet are tried at the same time: the
 * internet is down when no target answers, and that is the router's fault only when a gateway is known and doesn't
 * answer either (no gateway: the router isn't judged). With the internet answering, name lookups fail when none of the
 * names resolves (the targets' and `WAY_OUT_NAME`). A name target's address is the one it resolved to now, else the
 * last one it did (`known`), so a failing lookup doesn't make the internet look down.
 */
export async function probeWayOut(
  probes: WayOutProbes,
  targets: readonly WayOutTarget[],
  known: Map<string, string>,
): Promise<WayOutStep | null> {
  const names = [...new Set([...targets.filter((t) => !isIP(t.host)).map((t) => t.host), WAY_OUT_NAME])];
  const [gateway, resolved] = await Promise.all([
    probes.gateway().catch(() => null),
    Promise.all(names.map(async (name) => [name, await probes.lookup(name).catch(() => [])] as const)),
  ]);
  for (const [name, addresses] of resolved) if (addresses[0]) known.set(name, addresses[0]);
  const addresses = targets
    .map((t) => ({ host: isIP(t.host) ? t.host : known.get(t.host), port: t.port }))
    .filter((t): t is WayOutTarget => !!t.host);
  const [routerOk, reached] = await Promise.all([
    gateway
      ? Promise.all(ROUTER_PORTS.map((p) => probes.answers(gateway, p).catch(() => false))).then((r) =>
          r.some(Boolean),
        )
      : Promise.resolve(null),
    Promise.all(addresses.map((t) => probes.answers(t.host, t.port).catch(() => false))).then((r) =>
      r.some(Boolean),
    ),
  ]);
  if (!reached) return routerOk === false ? 'router' : 'internet';
  if (!resolved.some(([, a]) => a.length > 0)) return 'names';
  return null;
}

/* What a pass does (pure) ------------------------------------------------------------------------------------------ */

/** What the watch remembers between passes: the step failing now and since when. */
export interface WayOutMemory {
  failing: { step: WayOutStep; since: Date } | null;
}

/** What a pass changes: an outage that opens (since when it failed) and whether the open one ends now. */
export interface WayOutChange {
  memory: WayOutMemory;
  open: { step: WayOutStep; startedAt: Date } | null;
  close: boolean;
}

export function nextWayOut(
  memory: WayOutMemory,
  seen: WayOutStep | null,
  now: Date,
  current: { step: WayOutStep } | null,
): WayOutChange {
  if (!seen) return { memory: { failing: null }, open: null, close: current !== null };
  const since = memory.failing?.step === seen ? memory.failing.since : now;
  const next = { failing: { step: seen, since } };
  if (current?.step === seen || now.getTime() - since.getTime() < WAY_OUT_CONFIRM_MS)
    return { memory: next, open: null, close: false };
  return { memory: next, open: { step: seen, startedAt: since }, close: current !== null };
}

/* The store ------------------------------------------------------------------------------------------------------- */

/** The outage open now, if any. */
export async function openWayOut(db: Db | Tx): Promise<WayOutOutageRow | null> {
  const [row] = await db
    .select()
    .from(wayOutOutages)
    .where(isNull(wayOutOutages.endedAt))
    .orderBy(desc(wayOutOutages.startedAt))
    .limit(1);
  return row ?? null;
}

/** Outages that started, or were still going, since `since`, newest first (for history). */
export async function wayOutHistory(db: Db | Tx, since: Date): Promise<WayOutOutageRow[]> {
  return db
    .select()
    .from(wayOutOutages)
    .where(
      or(
        gte(wayOutOutages.startedAt, since),
        isNull(wayOutOutages.endedAt),
        gte(wayOutOutages.endedAt, since),
      ),
    )
    .orderBy(desc(wayOutOutages.startedAt))
    .limit(200);
}

/* Words ----------------------------------------------------------------------------------------------------------- */

const hm = (at: Date, timeZone: string) => {
  const p = localParts(at.getTime(), timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

/** What the cause is called, and the words after “Not answering ” for what it takes with it. */
export const WAY_OUT_CAUSE: Record<WayOutStep, { name: string; words: string }> = {
  router: { name: 'the router', words: 'while the router doesn’t answer' },
  internet: { name: 'the internet', words: 'while the internet is down' },
  names: { name: 'name lookups', words: 'while name lookups don’t work' },
};

/** The Inbox item's title: “The internet is down since 14:02”. */
export function wayOutTitle(step: WayOutStep, since: Date, timeZone: string): string {
  const at = hm(since, timeZone);
  if (step === 'router') return `The router doesn’t answer since ${at}`;
  if (step === 'names') return `Name lookups don’t work since ${at}`;
  return `The internet is down since ${at}`;
}

/** “GitHub, Google and 3 more”: the first two names and how many more. */
export function namesAndMore(names: readonly string[]): string {
  const [a, b] = names;
  if (!a) return '';
  if (!b) return a;
  if (names.length === 2) return `${a} and ${b}`;
  return `${a}, ${b} and ${names.length - 2} more`;
}

/** The item's words below the title: what it means, and what it takes with it. */
export function wayOutBody(step: WayOutStep, takes: readonly string[]): string {
  const what =
    step === 'router'
      ? 'Whombat can’t reach the router, so nothing outside the house either. Check that it is on and its cables are in.'
      : step === 'names'
        ? 'Whombat reaches the internet but can’t find addresses by name. The router or the internet provider may be at fault.'
        : 'Whombat can reach the router but nothing on the internet. The internet provider may be at fault.';
  const list = namesAndMore(takes);
  return list ? `${what} ${list} can’t be reached until it’s back.` : what;
}

/** History's words: “The internet was down 14:02–14:31”. */
export function wayOutHistoryWords(
  row: Pick<WayOutOutageRow, 'step' | 'startedAt' | 'endedAt'>,
  timeZone: string,
) {
  const from = hm(row.startedAt, timeZone);
  const to = row.endedAt ? hm(row.endedAt, timeZone) : 'now';
  if (row.step === 'router') return `The router didn’t answer ${from}–${to}`;
  if (row.step === 'names') return `Name lookups didn’t work ${from}–${to}`;
  return `The internet was down ${from}–${to}`;
}

/* The watch ------------------------------------------------------------------------------------------------------- */

/** The minute's check of the way out, its memory between passes, and the outage it keeps. */
export class WayOutWatch {
  #memory: WayOutMemory = { failing: null };
  readonly #known = new Map<string, string>();
  readonly #probes: WayOutProbes | null;
  readonly #targets: WayOutTarget[];

  constructor(
    private readonly services: Services,
    options: { probes?: WayOutProbes | null; targets?: WayOutTarget[] } = {},
  ) {
    const on = services.config.WHOMBAT_WAY_OUT === 'on';
    this.#probes = options.probes !== undefined ? options.probes : on ? systemProbes() : null;
    this.#targets =
      options.targets ??
      wayOutTargets({
        ...(services.config.WHOMBAT_WAY_OUT_TARGETS
          ? { targets: services.config.WHOMBAT_WAY_OUT_TARGETS }
          : {}),
        appUrl: services.config.WHOMBAT_APP_URL,
      });
  }

  /** One pass: probe, and open or end the outage. Returns the step failing now (null: the way out works). */
  async pass(now = this.services.clock()): Promise<WayOutStep | null> {
    if (!this.#probes) return null;
    const seen = await probeWayOut(this.#probes, this.#targets, this.#known);
    const current = await openWayOut(this.services.db);
    const change = nextWayOut(this.#memory, seen, now, current);
    this.#memory = change.memory;
    if (!change.open && !change.close) return seen;
    const burrowIds = (await this.services.db.select({ id: burrows.id }).from(burrows)).map((b) => b.id);
    const [first] = burrowIds;
    const write = async (tx: Db | Tx) => {
      if (change.close && current)
        await tx.update(wayOutOutages).set({ endedAt: now }).where(eq(wayOutOutages.id, current.id));
      if (change.open)
        await tx.insert(wayOutOutages).values({
          id: `wo_${randomIdBody(12)}`,
          step: change.open.step,
          startedAt: change.open.startedAt,
          endedAt: null,
        });
    };
    if (!first) await write(this.services.db);
    else
      await this.services.pipeline.transact(first, async (session) => {
        await write(session.tx);
        for (const id of burrowIds)
          publishHomeChanged(session, await homeAudience(session, id), ['needsYou', 'things', 'watch']);
      });
    return seen;
  }
}

/* The Inbox ------------------------------------------------------------------------------------------------------- */

/** The item of an outage (pure): `takes` the names of what is down with it. */
export function wayOutItem(
  row: Pick<WayOutOutageRow, 'id' | 'step' | 'startedAt'>,
  input: { timeZone: string; takes: readonly string[] },
): NeedsYouItem {
  return {
    id: `box.way_out:${row.id}`,
    ref: { kind: 'way_out', id: row.id },
    kind: 'alert',
    severity: 'bad',
    nature: 'you',
    title: wayOutTitle(row.step, row.startedAt, input.timeZone).slice(0, 200),
    body: wayOutBody(row.step, input.takes).slice(0, 600),
    at: row.startedAt.toISOString(),
    actions: [],
  };
}

/** What the outage takes with it in a burrow: the names of the things down because of it (the causes job's rows). */
export type TakenBy = (db: Db | Tx, burrowId: string, cause: string) => Promise<string[]>;

let takenBy: TakenBy = async () => [];

/** The causes' part says what an outage takes with it (it imports this file; not the other way round). */
export function setWayOutTakenBy(fn: TakenBy): void {
  takenBy = fn;
}

/** The thing the outage is, as a cause: `box:network`. */
export const WAY_OUT_THING = 'box:network';

/** The Needs you source: the box's way out, for the person. */
export async function wayOutNeedsYou(ctx: SourceCtx): Promise<NeedsYouItem[]> {
  if (!checkStartsOn('box.way_out')) return [];
  const person = ctx.reads?.person ?? (await loadPrincipalRow(ctx.db, ctx.personId));
  if (person?.kind !== 'person') return [];
  const row = await openWayOut(ctx.db);
  if (!row) return [];
  const [zone, takes] = await Promise.all([
    ctx.db
      .select({ timeZone: burrows.timeZone })
      .from(burrows)
      .where(and(eq(burrows.id, ctx.burrowId)))
      .then((r) => r[0]?.timeZone ?? 'UTC'),
    takenBy(ctx.db, ctx.burrowId, WAY_OUT_THING).catch(() => [] as string[]),
  ]);
  return [wayOutItem(row, { timeZone: zone, takes })];
}

/** Registers the source with Home (idempotent). */
export function registerWayOutSource(): void {
  registerNeedsYouSource('way-out', wayOutNeedsYou);
}
