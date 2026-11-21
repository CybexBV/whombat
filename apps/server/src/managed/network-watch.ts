/**
 * What owners hear about the box's network (docs/decisions/network-move.md NM-09, NM-10; network-move-server.md
 * NM-S06…NM-S11). Once a minute the runtime reads the network from the manager (and the hosts service's agents'
 * address) and keeps in `box_network`:
 *
 * - **The cable stopped** while Wi-Fi only is off and Wi-Fi carries the box: one Inbox item until a cable is in use
 *   again or Wi-Fi only is chosen.
 * - **The cable is back as the backup** (the manager's committed cable change `by: backup`, NM-03): one item, until Wi-Fi
 *   only is chosen again, it is settled, or three days went by.
 * - **The box's address changed** (any cause: a move, DHCP, a restore; the manager's addresses, else the hosts service's
 *   agents' address): the connections that worked in their last check before it are checked again a minute later, and
 *   each that is refused or doesn't answer now is one item, “… stopped letting Whombat in after its address changed”,
 *   until it works again.
 *
 * The Inbox source reads only what is kept (no manager call per Home read). Every check here starts on
 * (watch-defaults.md): see `BOX_NETWORK_CHECKS`.
 */
import { NETWORK_MOVE_WORDS, type NeedsYouItem, thingHref } from '@whombat/core';
import { type HostNetwork, networkChangeDone } from '@whombat/protocol/session';
import { asc, eq, inArray } from 'drizzle-orm';
import type { CatalogConnectionRow } from '../connections/types';
import { burrows, catalogConnections } from '../db/schema/index';
import { loadWhombatName } from '../desk/store';
import { checkConnectionHealth } from '../home/health';
import { homeAudience, publishHomeChanged } from '../home/notify';
import { registerNeedsYouSource, type SourceCtx } from '../home/registry';
import type { ConnectionGlance } from '../home/types';
import { toHubInfo } from '../hosts/hub';
import { hostsFor } from '../hosts/service';
import { loadPrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { checkStartsOn, registerChecks } from '../things/quiet/defaults';
import type { HostNetworkService } from './host-network';
import {
  type AddressChange,
  addressChangeOf,
  BACKUP_KEEP_MS,
  backupChangeOf,
  boxAddress,
  type CableMemory,
  type ConnectionHealth,
  cableAfter,
  connectionHealth,
  currentMove,
  stoppedAfterChange,
} from './network-move';
import {
  type BoxNetworkState,
  loadBoxNetwork,
  type RefusedConnection,
  updateBoxNetwork,
} from './network-move-store';

/** How often the network is read (NM-09: “at most once a minute”). */
export const BOX_NETWORK_CHECK_MS = 60_000;
/** How long after an address change the connections are checked again: the box's routes and leases settle first. */
export const RECHECK_AFTER_MS = 45_000;
/** A hosts service's agents' address change older than this when first seen is history, not news. */
const HUB_CHANGE_FRESH_MS = 60 * 60_000;
/** The most connections checked again after one change. */
const RECHECK_MAX = 50;
/** Where Use Wi-Fi only and the cable are (Settings → This Whombat → Overview → Network). */
export const NETWORK_HREF = '/settings?tab=appliance&section=overview';

/**
 * The checks behind the items (watch-defaults.md WD-01, WD-04). All three start on: each says a part is broken now and
 * only the person can fix it.
 */
export const BOX_NETWORK_CHECKS = [
  // The box's cable stopped while Wi-Fi carries it: a part of the box broken now; the person plugs it back, or settles
  // the item when it was unplugged on purpose.
  { check: 'box.cable_stopped', startsOn: true },
  // Wi-Fi only lost Whombat and the box went back to its cable: its Wi-Fi is broken now, and only the person can say
  // whether to try Wi-Fi only again.
  { check: 'box.cable_backup', startsOn: true },
  // A connection refuses Whombat since the box's address changed: Whombat can no longer reach it, and Whombat can say
  // what to change (the address it may still allow).
  { check: 'conn.address_refused', startsOn: true },
] as const;
registerChecks(BOX_NETWORK_CHECKS);

/** A connection as the before and after compare it. */
interface SeenConnection {
  health: ConnectionHealth;
  checkedAt: number | null;
}

export class BoxNetworkWatch {
  #ticker: (() => void) | null = null;
  #closed = false;
  /** Each connection as the last tick saw it: the before of a change found after its first check after it. */
  #seen = new Map<string, SeenConnection>();

  readonly #checkConnection: (row: CatalogConnectionRow, now: Date) => Promise<unknown>;

  constructor(
    private readonly services: Services,
    private readonly network: Pick<HostNetworkService, 'state'>,
    /** How a connection is checked again (the health pass's own check; tests stand in for the service it calls). */
    options: { checkConnection?: (row: CatalogConnectionRow, now: Date) => Promise<unknown> } = {},
  ) {
    this.#checkConnection =
      options.checkConnection ?? ((row, now) => checkConnectionHealth(this.services, row, now));
  }

  /** Checks on the housekeeping tick: soon after the start, then every minute. */
  start(): void {
    if (this.#ticker || this.#closed) return;
    this.#ticker = this.services.housekeeping.add('box network', BOX_NETWORK_CHECK_MS, () => this.check(), {
      first: 'tick',
    });
  }

  close(): void {
    this.#closed = true;
    this.#ticker?.();
    this.#ticker = null;
  }

  /** One pass: what the network says now, and the connections checked again after a change. */
  async check(now = this.services.clock()): Promise<void> {
    if (this.#closed || this.services.maintenance.paused) return;
    const [network, hubChange] = await Promise.all([this.network.state(), this.#hubChange(now)]);
    const connections = await this.#connections();
    const before = await loadBoxNetwork(this.services.db);
    // The first check after a change seen on an earlier pass (NM-10), once no cable change runs (one still being checked
    // may go back, and would make every connection look refused while its Wi-Fi had no internet) and unless the box is
    // back at the address it had (this pass undoes the change).
    const settled = !network?.cableChange || networkChangeDone(network.cableChange.phase);
    const back = !!network && !!before.change && boxAddress(network) === before.change.from;
    const recheck =
      settled &&
      !back &&
      before.change &&
      !before.change.checked &&
      now.getTime() - Date.parse(before.change.at) >= RECHECK_AFTER_MS
        ? await this.#recheck(before.change, connections, now)
        : null;
    const after = await updateBoxNetwork(this.services, (s) =>
      nextState(s, { network, hubChange, connections, seen: this.#seen, recheck, now }),
    );
    this.#seen = new Map(connections.map((c) => [c.row.id, seenOf(c.row)]));
    if (shownKey(before) !== shownKey(after)) await this.#tell();
  }

  /** The hosts service's latest agents' address change (from and to as hosts), or null. */
  async #hubChange(now: Date): Promise<{ from: string; to: string; at: string } | null> {
    const hosts = hostsFor(this.services);
    if (!hosts.present) return null;
    const raw = await hosts.hubLive().catch(() => null);
    if (!raw) return null;
    const hub = toHubInfo(raw);
    const move = currentMove(null, hub, now);
    return move?.from ? { from: move.from, to: move.to, at: move.since } : null;
  }

  /** The connections the health pass looks at, with their last check. */
  async #connections(): Promise<{ row: CatalogConnectionRow }[]> {
    const rows = await this.services.db
      .select()
      .from(catalogConnections)
      .where(inArray(catalogConnections.status, ['active', 'needs_reauth']))
      .orderBy(asc(catalogConnections.createdAt))
      .limit(500);
    return rows.map((row) => ({ row }));
  }

  /** Checks the connections that worked before the change again now; those refused or not answering. */
  async #recheck(
    change: NonNullable<BoxNetworkState['change']>,
    connections: readonly { row: CatalogConnectionRow }[],
    now: Date,
  ): Promise<RefusedConnection[]> {
    const before = new Set(change.before.slice(0, RECHECK_MAX));
    const after = new Map<string, ConnectionHealth>();
    for (const { row } of connections) {
      if (!before.has(row.id)) continue;
      try {
        await this.#checkConnection(row, now);
        const [fresh] = await this.services.db
          .select()
          .from(catalogConnections)
          .where(eq(catalogConnections.id, row.id));
        if (fresh) after.set(row.id, connectionHealth({ status: fresh.status, glance: glanceOf(fresh) }));
      } catch (err) {
        this.services.log.warn(
          { err: err instanceof Error ? err.name : 'error' },
          'network: a connection wasn’t checked again',
        );
      }
    }
    const names = new Map(connections.map(({ row }) => [row.id, row] as const));
    return stoppedAfterChange(before, after).flatMap((id) => {
      const row = names.get(id);
      return row
        ? [
            {
              connectionId: id,
              burrowId: row.burrowId,
              name: row.label.slice(0, 200) || 'A connection',
              from: change.from,
              to: change.to,
              at: now.toISOString(),
            },
          ]
        : [];
    });
  }

  /** Home reads its Inbox again: every burrow's person. */
  async #tell(): Promise<void> {
    const rows = await this.services.db.select({ id: burrows.id }).from(burrows);
    await this.services.pipeline.transactAccount(async (tx, session) => {
      for (const { id } of rows) publishHomeChanged(session, await homeAudience({ tx }, id), ['needsYou']);
    });
  }
}

const glanceOf = (row: Pick<CatalogConnectionRow, 'glance'>) =>
  (row.glance as ConnectionGlance | null) ?? null;

function seenOf(row: CatalogConnectionRow): SeenConnection {
  return {
    health: connectionHealth({ status: row.status, glance: glanceOf(row) }),
    checkedAt: row.checkedAt ? row.checkedAt.getTime() : null,
  };
}

/** What changes what the Inbox shows (items in, items out). */
function shownKey(s: BoxNetworkState): string {
  return JSON.stringify([
    s.cableLost?.at ?? null,
    s.backup?.changeId ?? null,
    s.refused.map((r) => `${r.connectionId}:${r.at}`),
  ]);
}

/** What one pass read. */
export interface PassInput {
  network: HostNetwork | null;
  /** The hosts service's agents' address change in the last hour, from and to as hosts. */
  hubChange: AddressChange | null;
  connections: readonly { row: CatalogConnectionRow }[];
  /** Each connection as the pass before saw it. */
  seen: ReadonlyMap<string, SeenConnection>;
  /** The connections that stopped after the change being checked (this pass checked them again), else null. */
  recheck: RefusedConnection[] | null;
  now: Date;
}

/**
 * The kept state after one pass (pure): the cable (NM-09), the backup (NM-03, NM-09), the box's address and a change
 * of it with the connections that worked before (NM-10), and the connections refused after it that don't work yet.
 */
export function nextState(s: BoxNetworkState, input: PassInput): BoxNetworkState {
  const { network: n, now } = input;
  const out: BoxNetworkState = { ...s, refused: [...s.refused] };
  if (n) {
    const cable = cableAfter({ cable: s.cable, lost: s.cableLost } as CableMemory, n, now);
    out.cable = cable.cable;
    out.cableLost = cable.lost;
    const backup = backupChangeOf(n);
    if (backup && backup !== s.backup?.changeId) out.backup = { changeId: backup, at: now.toISOString() };
  }
  // Wi-Fi only chosen again, or three days on: the backup's item has said what it had to.
  if (out.backup && (n?.wifiOnly || now.getTime() - Date.parse(out.backup.at) >= BACKUP_KEEP_MS))
    out.backup = undefined;
  // The connections checked again after the change.
  if (out.change && input.recheck) {
    out.change = { ...out.change, checked: true };
    for (const r of input.recheck)
      if (!out.refused.some((x) => x.connectionId === r.connectionId)) out.refused.push(r);
  }
  // A change of the box's address: the manager's, else the hosts service's agents' address.
  const address = n ? boxAddress(n) : null;
  let change = addressChangeOf(s.address, address, now);
  const hub = input.hubChange;
  if (
    !change &&
    hub &&
    hub.at !== s.hubChangedAt &&
    (!s.hubChangedAt || Date.parse(hub.at) > Date.parse(s.hubChangedAt)) &&
    now.getTime() - Date.parse(hub.at) < HUB_CHANGE_FRESH_MS &&
    !(s.change && s.change.to === hub.to)
  )
    change = hub;
  if (hub) out.hubChangedAt = hub.at;
  if (address) out.address = address;
  if (change) {
    // A change on top of one not checked yet (a switch undone, a second lease) compares with the first's before.
    const pending = s.change && !s.change.checked ? s.change : null;
    const from = pending ? pending.from : change.from;
    out.change =
      from === change.to
        ? undefined
        : {
            from,
            to: change.to,
            at: pending?.at ?? change.at,
            before: pending?.before ?? workingBefore(input, Date.parse(change.at)),
            checked: false,
          };
  }
  // A refused connection that works again goes (its item with it), as does one that's gone.
  out.refused = out.refused.filter((r) => {
    const c = input.connections.find((x) => x.row.id === r.connectionId)?.row;
    if (!c) return false;
    const health = connectionHealth({ status: c.status, glance: glanceOf(c) });
    const checkedAt = c.checkedAt?.getTime() ?? 0;
    return !(health === 'working' && checkedAt > Date.parse(r.at));
  });
  return out;
}

/**
 * The connections that worked in their last check before `at`: as checked now when that was before it, else as the
 * pass before saw them when that was.
 */
function workingBefore(input: PassInput, at: number): string[] {
  const out: string[] = [];
  for (const { row } of input.connections) {
    const now = seenOf(row);
    const then = input.seen.get(row.id);
    const last =
      now.checkedAt !== null && now.checkedAt < at
        ? now
        : then && then.checkedAt !== null && then.checkedAt < at
          ? then
          : null;
    if (last?.health === 'working') out.push(row.id);
  }
  return out.slice(0, 500);
}

/* The Inbox ------------------------------------------------------------------------------------------------------- */

/** The items of the box's network for one person (pure): `state` kept, `name` the Whombat's. */
export function boxNetworkItems(
  s: BoxNetworkState,
  input: { name: string | null; burrowId: string; now: Date },
): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  const open = {
    id: 'open',
    label: NETWORK_MOVE_WORDS.openNetwork,
    style: 'primary' as const,
    kind: 'open' as const,
    href: NETWORK_HREF,
  };
  if (s.cableLost && checkStartsOn('box.cable_stopped'))
    items.push({
      id: `box.cable_stopped:${s.cableLost.at}`,
      ref: { kind: 'box_network', id: `cable_stopped:${s.cableLost.at}` },
      kind: 'alert',
      severity: 'warn',
      nature: 'you',
      title: NETWORK_MOVE_WORDS.cableStopped(input.name).slice(0, 200),
      body: NETWORK_MOVE_WORDS.cableStoppedBody,
      at: s.cableLost.at,
      actions: [open],
      href: NETWORK_HREF,
    });
  if (s.backup && checkStartsOn('box.cable_backup'))
    items.push({
      id: `box.cable_backup:${s.backup.changeId}`,
      ref: { kind: 'box_network', id: `cable_backup:${s.backup.changeId}` },
      kind: 'alert',
      severity: 'warn',
      nature: 'you',
      title: NETWORK_MOVE_WORDS.cableBackup(input.name).slice(0, 200),
      body: NETWORK_MOVE_WORDS.cableBackupBody,
      at: s.backup.at,
      actions: [open],
      href: NETWORK_HREF,
    });
  if (checkStartsOn('conn.address_refused'))
    for (const r of s.refused) {
      if (r.burrowId !== input.burrowId) continue;
      const href = thingHref('connection', r.connectionId);
      items.push({
        id: `address_refused:${r.connectionId}:${r.at}`.slice(0, 200),
        ref: { kind: 'address_refused', id: `${r.connectionId}:${r.at}`.slice(0, 200) },
        kind: 'connection',
        severity: 'warn',
        nature: 'you',
        title: NETWORK_MOVE_WORDS.addressRefused(r.name, r.from).slice(0, 200),
        body: NETWORK_MOVE_WORDS.addressRefusedBody(r.to),
        at: r.at,
        actions: [
          { id: 'open', label: NETWORK_MOVE_WORDS.openConnection, style: 'primary', kind: 'open', href },
        ],
        subject: { kind: 'connection', id: r.connectionId, name: r.name.slice(0, 120) },
        href,
      });
    }
  return items;
}

/** The Needs you source: the box's network, for the person. */
export async function boxNetworkNeedsYou(ctx: SourceCtx): Promise<NeedsYouItem[]> {
  const person = ctx.reads?.person ?? (await loadPrincipalRow(ctx.db, ctx.personId));
  if (person?.kind !== 'person') return [];
  const [state, name] = await Promise.all([
    loadBoxNetwork(ctx.db),
    loadWhombatName(ctx.db).catch(() => null),
  ]);
  if (!state.cableLost && !state.backup && state.refused.length === 0) return [];
  return boxNetworkItems(state, { name, burrowId: ctx.burrowId, now: ctx.now });
}

/** Registers the source with Home (idempotent): the managed runtime does at its start. */
export function registerBoxNetworkSource(): void {
  registerNeedsYouSource('box-network', boxNetworkNeedsYou);
}
