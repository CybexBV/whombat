import type {
  HostCheck,
  HostFleet,
  HostOsFamily,
  HostServerDetail,
  HostServerPlatform,
  RealtimeEvent,
  ThingWatch,
} from '@whombat/core';
import { HOST_MONITORING_MINOR, WINDOWS_MINOR } from '@whombat/protocol/session';
import { obj } from './map';

function readsHostMonitoring(minor: number | undefined): boolean {
  return minor === undefined || minor >= HOST_MONITORING_MINOR;
}

export function needsHostMonitoring(op: string, body: unknown, minor: number | undefined): boolean {
  return (
    !readsHostMonitoring(minor) &&
    (op === 'hosts.getCheck' ||
      op === 'things.setWatchLimit' ||
      (op === 'hosts.createCheck' && Object.hasOwn(obj(body), 'owner')))
  );
}

function olderCheck({ owner: _owner, stale: _stale, ...check }: HostCheck) {
  return check;
}

export function hostAnswerFor(op: string, body: unknown, minor: number | undefined): unknown {
  if (readsHostMonitoring(minor) || !body || typeof body !== 'object') return body;
  if (op === 'things.watch' || op === 'things.setWatch') {
    const watch = body as ThingWatch;
    return { ...watch, checks: watch.checks.map(({ limit: _limit, ...check }) => check) };
  }
  if (op === 'hosts.listChecks') {
    const result = body as { checks: HostCheck[] };
    return { ...result, checks: result.checks.map(olderCheck) };
  }
  if (op === 'hosts.createCheck' || op === 'hosts.updateCheck') {
    return olderCheck(body as HostCheck);
  }
  return body;
}

/**
 * Whether a session at `minor` reads Windows PCs; outside a session (`undefined`), it does. An app below it parses a
 * server's platform and os family strictly and would refuse a whole answer with `windows` in it, so it is shown a
 * Windows PC as a standard server without an os family or its Windows facts (docs/decisions/windows-servers.md).
 */
export const readsWindows = (minor: number | undefined) => minor === undefined || minor >= WINDOWS_MINOR;

/** A server's platform and os family as an app before Windows PCs reads them. */
export function beforeWindows<
  T extends { platform: HostServerPlatform; osFamily?: HostOsFamily | undefined },
>(server: T): T {
  if (server.platform !== 'windows' && server.osFamily !== 'windows') return server;
  const { osFamily, ...rest } = server;
  return {
    ...rest,
    platform: server.platform === 'windows' ? 'standard' : server.platform,
    ...(osFamily && osFamily !== 'windows' ? { osFamily } : {}),
  } as T;
}

/** `hosts.fleet` as an app at `minor` reads it. */
export function fleetFor(fleet: HostFleet, minor: number | undefined): HostFleet {
  return readsWindows(minor) ? fleet : { ...fleet, servers: fleet.servers.map(beforeWindows) };
}

/** `hosts.getServer` as an app at `minor` reads it. */
export function serverDetailFor<T extends HostServerDetail>(detail: T, minor: number | undefined): T {
  if (readsWindows(minor)) return detail;
  const { windows: _, ...rest } = detail;
  return { ...rest, server: beforeWindows(detail.server) } as T;
}

/** A live server row as an app at `minor` reads it. */
export function hostsEventFor(event: RealtimeEvent, minor: number | undefined): RealtimeEvent {
  if (readsWindows(minor) || event.type !== 'hosts.server' || !event.server) return event;
  return { ...event, server: beforeWindows(event.server) };
}
