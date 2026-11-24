import type { HostCheck, ThingWatch } from '@whombat/core';
import { HOST_MONITORING_MINOR } from '@whombat/protocol/session';
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
