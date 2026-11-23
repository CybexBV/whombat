/**
 * What an older app can read of the own address (docs/decisions/own-address.md). Apps before session minor 6
 * (`OWN_ADDRESS_NAMES_MINOR`) parse an own-address host strictly as three drawn words under `box.` or `dev.`; a name the
 * person chose, or a host under `whombat.app`, would fail their whole answer. To such a session the box leaves the
 * address out (`ownAddress` null, a box of the person's list dropped), which they already handle as “no address yet”.
 * Pure.
 */
import { OWN_ADDRESS_NAMES_MINOR, type OwnAddressSummary } from '@whombat/protocol/session';

/** The host shape apps before session minor 6 read. */
const OLDER_HOST_RE = /^[a-z]{3,10}-[a-z]{3,10}-[a-z]{3,10}[.](box|dev)[.]whombat[.]app$/;

/** Whether a session at `minor` reads only the older hosts (undefined: the box's own callers, which read everything). */
export function readsOlderHostsOnly(minor: number | undefined): boolean {
  return minor !== undefined && minor < OWN_ADDRESS_NAMES_MINOR;
}

/** Whether an app before session minor 6 can parse `host`. */
export function olderAppReads(host: string): boolean {
  return host.length <= 64 && OLDER_HOST_RE.test(host);
}

/** The summary as a session at `minor` reads it: null for an older one when its host doesn't have the older shape. */
export function ownAddressFor(
  summary: OwnAddressSummary | null,
  minor: number | undefined,
): OwnAddressSummary | null {
  if (!summary || !readsOlderHostsOnly(minor)) return summary;
  if (!olderAppReads(summary.host)) return null;
  // An older app doesn't know the leaving address: it reads the current one only.
  const { leaving: _leaving, ...older } = summary;
  return older;
}

/** The person's Whombats as a session at `minor` reads them: an older one doesn't get boxes whose host it can't read. */
export function whombatsFor<T extends { host: string | null }>(
  list: readonly T[],
  minor: number | undefined,
): T[] {
  if (!readsOlderHostsOnly(minor)) return [...list];
  return list.filter((w) => w.host === null || olderAppReads(w.host));
}
