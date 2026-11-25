import {
  ConnectionId,
  UPTIME_HUB_NAME,
  UPTIME_HUB_RUNNER,
  UPTIME_ID,
  UptimeFields,
  UptimeHubCheck,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { externalEffect } from '../commit/scope';
import { catalogConnections } from '../db/schema/index';
import { HOSTS_API, type HostsActor, HostsError, seg } from '../hosts/client';
import { arr, obj, toHostCheck } from '../hosts/map';
import { serverLabel } from '../hosts/self';
import { type HostsService, hostsFor, WHOMBAT_ACTOR } from '../hosts/service';
import type { Services } from '../services';
import { HEALTH_POINT_MS } from '../things/points';
import { connectionError } from './errors';
import { connectionRow } from './store';
import type { CatalogConnectionRow } from './types';

const CHECKS = `${HOSTS_API}/checks`;
const ADMIN = { ...WHOMBAT_ACTOR, role: 'admin' } as const;
const UNAVAILABLE = 'Whombat couldn’t reach its checks. Try again in a moment.';
const OWNER_PREFIX = 'whombat:connection:';
const ownerOf = (id: string) => `${OWNER_PREFIX}${id}`;
const REMOVAL_TIMEOUT_MS = 1_500;
const SWEEP_MS = 60 * 60_000;

const swept = new WeakMap<Services, number>();

type UptimeRow = Pick<CatalogConnectionRow, 'id' | 'label' | 'fields' | 'hubCheckId' | 'hubCheckChangedAt'>;

/** Edits, removal and repair of the same check share one queue in the server. */
const work = new WeakMap<Services, Map<string, Promise<unknown>>>();
export function withUptimeCheck<T>(services: Services, id: string, run: () => Promise<T>): Promise<T> {
  let checks = work.get(services);
  if (!checks) {
    checks = new Map();
    work.set(services, checks);
  }
  const queue = checks;
  const next = (queue.get(id) ?? Promise.resolve()).catch(() => undefined).then(run);
  queue.set(id, next);
  return next.finally(() => {
    if (queue.get(id) === next) queue.delete(id);
  });
}

export async function uptimeRunners(services: Services, burrowId: string) {
  const hosts = hostsFor(services);
  if (!(await hosts.serves(burrowId))) throw connectionError('check_failed', {}, UNAVAILABLE);
  const fleet = await hosts.fleetRaw().catch(() => null);
  if (!fleet) throw connectionError('check_failed', {}, UNAVAILABLE);
  return [
    { id: UPTIME_HUB_RUNNER, name: UPTIME_HUB_NAME },
    ...arr(fleet.servers).flatMap((server) => {
      const id = obj(server).id;
      return typeof id === 'string' && id !== UPTIME_HUB_RUNNER ? [{ id, name: serverLabel(id) }] : [];
    }),
  ];
}

function hubCheckName(label: string): string {
  const printable = label.replace(/[^\p{L}\p{M}\p{N}\p{P}\p{S} ]/gu, '').trim();
  let remaining = 80;
  let name = '';
  for (const char of printable) {
    remaining -= Buffer.byteLength(char);
    if (remaining < 0) break;
    name += char;
  }
  return name.trimEnd() || 'Website or address';
}

export function uptimeSpec(row: Pick<UptimeRow, 'label' | 'fields'>) {
  const fields = UptimeFields.parse(row.fields);
  const heartbeat = fields.kind === 'heartbeat';
  const options =
    fields.kind === 'dns'
      ? { dns_type: 'any' }
      : fields.kind === 'http' && fields.keyword
        ? { keyword: fields.keyword }
        : {};
  return {
    name: hubCheckName(row.label),
    kind: fields.kind,
    target: heartbeat ? '' : (fields.address ?? ''),
    runner: heartbeat ? UPTIME_HUB_RUNNER : fields.runner,
    interval_s: Number(fields.every) * 60,
    grace_s: heartbeat ? Number(fields.late) * 60 : 0,
    options,
  };
}

function hubCheck(raw: unknown): UptimeHubCheck {
  const { stale, owner, period_status } = obj(raw);
  return UptimeHubCheck.parse({
    ...toHostCheck(raw),
    stale,
    owner: owner || undefined,
    periodStatus: period_status,
  });
}

const missing = (err: unknown) => err instanceof HostsError && err.status === 404;

async function checksList(hosts: HostsService, actor: HostsActor, timeoutMs?: number) {
  return arr(await hosts.call<unknown>({ path: CHECKS, actor, ...(timeoutMs ? { timeoutMs } : {}) })).map(
    hubCheck,
  );
}

type Period = { since: string; until: string };

async function findCheck(
  hosts: HostsService,
  row: UptimeRow,
  actor: HostsActor,
  period?: Period,
  timeoutMs?: number,
) {
  if (row.hubCheckId) {
    try {
      const check = hubCheck(
        await hosts.call<unknown>({
          path: `${CHECKS}/${seg(row.hubCheckId)}`,
          actor,
          ...(period ? { query: period } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
        }),
      );
      if (!check.owner || check.owner === ownerOf(row.id)) return check;
    } catch (err) {
      // Older hubs only offer the list; it also finds a repaired check if its id changed.
      if (!missing(err) && !(err instanceof HostsError && err.status === 405)) throw err;
    }
  }
  const checks = await checksList(hosts, actor, timeoutMs);
  return (
    checks.find((c) => c.owner === ownerOf(row.id)) ??
    checks.find((c) => c.id === row.hubCheckId && !c.owner) ??
    null
  );
}

function effectOptions(err: unknown) {
  return err instanceof HostsError && err.status >= 400 && err.status < 500;
}

async function createUptimeCheck(
  services: Services,
  row: Pick<UptimeRow, 'id' | 'label' | 'fields'>,
  actor: HostsActor,
): Promise<UptimeHubCheck> {
  return externalEffect(
    'uptime.createCheck',
    async () =>
      hubCheck(
        await hostsFor(services).call<unknown>({
          method: 'POST',
          path: CHECKS,
          body: { ...uptimeSpec(row), owner: ownerOf(row.id) },
          actor,
        }),
      ),
    { refused: effectOptions },
  );
}

async function deleteUptimeCheck(services: Services, id: string, actor: HostsActor): Promise<void> {
  try {
    await externalEffect(
      'uptime.deleteCheck',
      () =>
        hostsFor(services).call({
          method: 'DELETE',
          path: `${CHECKS}/${seg(id)}`,
          actor,
          timeoutMs: REMOVAL_TIMEOUT_MS,
        }),
      { idempotent: true, refused: effectOptions },
    );
  } catch (err) {
    if (!missing(err)) throw err;
  }
}

export async function removeUptimeCheck(services: Services, row: UptimeRow, actor: HostsActor) {
  try {
    const check = await findCheck(hostsFor(services), row, actor, undefined, REMOVAL_TIMEOUT_MS);
    if (check) await deleteUptimeCheck(services, check.id, actor);
  } catch {
    // The connection is gone. Retry its hub cleanup on the next health pass.
    swept.delete(services);
  }
}

export async function sweepUptimeChecks(services: Services, now: Date): Promise<void> {
  const hosts = hostsFor(services);
  const last = swept.get(services);
  if (!hosts.present || (last !== undefined && now.getTime() - last < SWEEP_MS)) return;
  const checks = await checksList(hosts, WHOMBAT_ACTOR, REMOVAL_TIMEOUT_MS).catch(() => null);
  if (!checks) return;
  swept.set(services, now.getTime());
  for (const check of checks) {
    if (!check.owner?.startsWith(OWNER_PREFIX)) continue;
    const id = ConnectionId.safeParse(check.owner.slice(OWNER_PREFIX.length));
    if (!id.success) continue;
    await withUptimeCheck(services, id.data, async () => {
      if (await connectionRow(services.db, id.data)) return;
      await deleteUptimeCheck(services, check.id, ADMIN).catch(() => swept.delete(services));
    });
  }
}

const sampledSpecChanged = (check: UptimeHubCheck, spec: ReturnType<typeof uptimeSpec>) =>
  check.kind !== spec.kind ||
  check.target !== spec.target ||
  check.runner !== spec.runner ||
  (check.options.keyword ?? '') !== (spec.options.keyword ?? '') ||
  (spec.kind === 'dns' && check.options.dnsType?.toLowerCase() !== spec.options.dns_type);

/** The hub may still have a reading for the pre-edit settings. */
export function currentUptimeReading(check: UptimeHubCheck, configuredAt: Date | null): UptimeHubCheck {
  if (!configuredAt || !check.last) return check;
  if (Date.parse(check.last.at) >= configuredAt.getTime()) {
    return check.since && Date.parse(check.since) < configuredAt.getTime()
      ? { ...check, since: configuredAt.toISOString() }
      : check;
  }
  return {
    ...check,
    status: check.enabled ? 'pending' : 'disabled',
    since: null,
    last: null,
    lastPing: null,
  };
}

/** Match the hub to the saved connection, repairing a missing check. Call while holding the check's queue. */
export async function syncUptimeCheck(
  services: Services,
  row: UptimeRow,
  actor = ADMIN as HostsActor,
  period?: Period,
) {
  const hosts = hostsFor(services);
  let check = await findCheck(hosts, row, actor, period);
  const spec = uptimeSpec(row);
  // When the target last changed stays when the hub's check is made again: the watcher dates a new outage from
  // no earlier than that, so research on the old target can't backdate it.
  let configuredAt = row.hubCheckChangedAt;
  let storedAt = configuredAt;
  if (!check) {
    check = await createUptimeCheck(services, row, actor);
  } else {
    const changed = sampledSpecChanged(check, spec);
    if (
      changed ||
      check.name !== spec.name ||
      check.intervalS !== spec.interval_s ||
      check.graceS !== spec.grace_s
    ) {
      const periodStatus = changed ? undefined : check.periodStatus;
      if (changed) {
        const started = services.clock();
        // Keep the boundary even if the PATCH took effect but its answer never arrived.
        configuredAt = new Date(Math.floor(started.getTime() / 1000) * 1000 + 1000);
        await services.pipeline.transactAccount((tx) =>
          tx
            .update(catalogConnections)
            .set({ hubCheckChangedAt: configuredAt })
            .where(eq(catalogConnections.id, row.id)),
        );
        storedAt = configuredAt;
      }
      const path = `${CHECKS}/${seg(check.id)}`;
      try {
        check = await externalEffect(
          'uptime.updateCheck',
          async () =>
            hubCheck(
              await hosts.call<unknown>({
                method: 'PATCH',
                path,
                body: spec,
                actor,
              }),
            ),
          { idempotent: true, refused: effectOptions },
        );
        check = { ...check, ...(periodStatus ? { periodStatus } : {}) };
      } catch (err) {
        if (!missing(err)) throw err;
        check = await createUptimeCheck(services, row, actor);
      }
    }
  }
  if (check.id !== row.hubCheckId || configuredAt !== storedAt)
    await services.pipeline.transactAccount((tx) =>
      tx
        .update(catalogConnections)
        .set({ hubCheckId: check.id, hubCheckChangedAt: configuredAt })
        .where(eq(catalogConnections.id, row.id)),
    );
  return currentUptimeReading(check, configuredAt);
}

/** Match the saved check before reading it. The health pass also asks what the hub saw between passes. */
export async function pollUptimeCheck(
  services: Services,
  id: string,
  at?: Date,
): Promise<UptimeHubCheck | null> {
  return withUptimeCheck(services, id, async () => {
    const row = await connectionRow(services.db, id);
    if (row?.catalogId !== UPTIME_ID) return null;
    // A restarted or freshly edited probe cannot say how the former probe answered.
    const since =
      at &&
      Math.max(
        row.glanceAt?.getTime() ?? at.getTime() - HEALTH_POINT_MS,
        row.hubCheckChangedAt ? row.hubCheckChangedAt.getTime() - 1000 : -Infinity,
      );
    const period =
      at && since !== undefined && since < at.getTime()
        ? { since: new Date(since).toISOString(), until: at.toISOString() }
        : undefined;
    return syncUptimeCheck(services, row, ADMIN, period);
  }).catch(() => null);
}

/** Pages and the assistant read the hub as it is. Only the person's page requests the check-in credential. */
export async function readUptimeCheck(services: Services, row: UptimeRow, withPingUrl = false) {
  const check = await findCheck(hostsFor(services), row, withPingUrl ? ADMIN : WHOMBAT_ACTOR).catch(
    () => null,
  );
  return check && !sampledSpecChanged(check, uptimeSpec(row))
    ? currentUptimeReading(check, row.hubCheckChangedAt)
    : null;
}

export function uptimeUnseen(check: UptimeHubCheck | null): boolean {
  return !check || check.stale === true || check.status === 'pending' || check.status === 'disabled';
}

/** Whether a failed website check got an HTTP response. */
export function uptimeHttpError(check: UptimeHubCheck | null): boolean {
  return check?.kind === 'http' && check.status === 'down' && !!check.last?.statusCode;
}

/** For history, include a failure the hub saw even if the probe has since recovered. */
export function uptimePoint(check: UptimeHubCheck | null): 0 | 1 | undefined {
  if (!check || check.status === 'disabled') return undefined;
  if (check.periodStatus === 'down') return 0;
  if (check.periodStatus === 'up') return 1;
  return uptimeUnseen(check) ? undefined : check.status === 'up' ? 1 : 0;
}

export function uptimeState(check: UptimeHubCheck | null, heartbeat: boolean): string {
  if (!check || check.stale) return 'Not checked';
  if (check.status === 'disabled') return 'Paused';
  if (check.status === 'up') return heartbeat ? 'Checking in' : 'Answering';
  if (check.status === 'down')
    return heartbeat
      ? 'Check-in late'
      : uptimeHttpError(check)
        ? 'It answered with an error'
        : 'Not answering';
  if (check.last) return 'Waiting for another check';
  return heartbeat ? 'Waiting for its first check-in' : 'Waiting for its first check';
}

/** The listener uses its own CA. curl verifies the listener key instead of looking for a public CA. */
export function checkInCommand(pingUrl: string | null | undefined, pin: unknown): string | null {
  if (!pingUrl || typeof pin !== 'string' || !/^sha256\/\/[A-Za-z0-9+/]{43}=$/.test(pin)) return null;
  try {
    const url = new URL(pingUrl);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/ping\/[A-Za-z0-9_-]+$/.test(url.pathname)
    )
      return null;
    return `curl --fail --silent --show-error --insecure --pinnedpubkey '${pin}' '${url.href}'`;
  } catch {
    return null;
  }
}
