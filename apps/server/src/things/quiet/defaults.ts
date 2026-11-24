/**
 * Which checks Whombat watches from the start (docs/decisions/watch-defaults.md). Every check of every kind, the generic
 * lines, devices, mail accounts and servers says so itself (`KindCheck.startsOn`, `HostWatchCheck.startsOn`): only what
 * is very important and what Whombat can act on or tell something useful about starts on. A check that starts off isn't
 * watched until someone turns it on in What Whombat watches (a `watch_ons` row): its lines show nowhere, as those of a
 * check switched off, while the page's figures stay. Check ids are unique across kinds, so one table answers for all.
 *
 * Each list of checks registers itself as its module loads (the kinds, the generic lines, devices, mail), as Home's
 * sources do: the kinds read their lines through the modules that ask this table, so it imports none of them. Servers'
 * checks come from the contract.
 */
import { hostCheckStartsOn } from '@whombat/core';
import type { ThingQuiet } from './store';
import { holdOf } from './windows';

const table = new Map<string, boolean>();

/** Adds a list of checks and whether each starts on. */
export function registerChecks(checks: readonly { check: string; startsOn: boolean }[]): void {
  for (const c of checks) table.set(c.check, c.startsOn);
}

/** Whether a list registered this check (servers' checks are the contract's, not this table's). */
export function isRegisteredCheck(check: string): boolean {
  return table.has(check);
}

let onUnregistered: ((check: string) => void) | null = null;
const reported = new Set<string>();

/** Where a check no list registered is reported, once per check id (the server's log). */
export function reportUnregisteredChecks(report: ((check: string) => void) | null): void {
  onUnregistered = report;
}

/**
 * Whether Whombat watches a check from the start. When in doubt, off: a check no list names (a line during a kind's
 * move, a row of a check since gone) starts off and is reported once, so it gets its own decision. A server's check
 * follows the contract (a hint this version doesn't know starts off).
 */
export function checkStartsOn(check: string): boolean {
  if (check.startsWith('host.')) return hostCheckStartsOn(check);
  const known = table.get(check);
  if (known !== undefined) return known;
  if (!reported.has(check)) {
    reported.add(check);
    onUnregistered?.(check);
  }
  return false;
}

/** The checks of a thing that start off and that nobody turned on: `applyQuiet`'s `unwatched`. */
export function unwatchedIn(quiet: Pick<ThingQuiet, 'ons'>): (check: string) => boolean {
  return (check) => !checkStartsOn(check) && !quiet.ons.some((o) => o.checkId === check);
}

/**
 * What `applyQuiet` leaves out of a thing — the checks and items switched off, and the checks that start off — and what
 * may hold the whole thing quiet (its windows and its cause, monitoring.md MON-04, MON-07).
 */
export function notWatched(quiet: Pick<ThingQuiet, 'offs' | 'ons' | 'windows' | 'cause'>) {
  return {
    offs: quiet.offs,
    unwatched: unwatchedIn(quiet),
    windows: quiet.windows ?? [],
    cause: quiet.cause ?? null,
  };
}

/** Whether a check is currently watched for this thing (starts on unless switched off, or starts off and turned on). */
export function checkWatched(quiet: Pick<ThingQuiet, 'offs' | 'ons'>, check: string): boolean {
  if (unwatchedIn(quiet)(check)) return false;
  return !quiet.offs.some((o) => o.checkId === check && o.subject === '');
}

/**
 * Whether a line is quiet now by its rows alone (no line to compare: a message about it, QN-S19): its check starts off
 * and nobody turned it on, the thing is held quiet, an off of the check or of the item, or an Ignore or snooze of the
 * item still in its time.
 * Worse and newer can't be told here.
 */
export function quietNow(quiet: ThingQuiet, check: string, subject: string, now: Date): boolean {
  if (unwatchedIn(quiet)(check)) return true;
  // Kept quiet, or down because of something else: every line of it (monitoring.md MON-04, MON-07).
  if (holdOf(quiet, now)) return true;
  if (quiet.offs.some((o) => o.checkId === check && (o.subject === '' || o.subject === subject))) return true;
  return quiet.quiets.some(
    (q) =>
      q.checkId === check && q.subject === subject && (q.until === null || q.until.getTime() > now.getTime()),
  );
}
