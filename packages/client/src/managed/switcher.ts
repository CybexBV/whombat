/**
 * The burrow name's menu (whombat-switcher.md AP-3080…AP-3084): the organization's Whombats from the directory, the
 * open one first and ticked, the others by name, each with what the list says about it (online, last seen) or, when
 * this device isn't let in there yet, “Set up this device”. Retired Whombats aren't offered (the list still shows the
 * ones this device remembers, AP-695). Web and phone draw the same rows.
 */

import type { ApplianceSession } from '../session/types';
import type { ApplianceSummary } from './control';
import { agoText, COPY } from './copy';
import type { KnownAppliance } from './registry';
import { isRetired } from './retired';
import { knownBoxRows } from './whombat-link';

/** Seen by control within this long: online (the list's rule, AP-64). */
export const SWITCHER_ONLINE_S = 120;

export const SWITCHER_COPY = {
  kicker: COPY.appliances.kicker,
  here: 'This Whombat',
  setUp: COPY.setup.title,
  all: 'All Whombats',
  claim: COPY.appliances.claim,
  /** The burrow name's button: what it is and that it opens the list. */
  label: (name: string) => `${name}. Your Whombats`,
} as const;

export interface SwitcherRow {
  device: string;
  /** The directory's name, else the card id (the list's `name ?? device`). */
  name: string;
  /** The Whombat this app has open. */
  here: boolean;
  online: boolean;
  /** This device has no pin or isn't let in there: opening it sets the device up first. */
  setUp: boolean;
  /** The line under the name. */
  meta: string;
  appliance: ApplianceSummary;
}

export function switcherRows(
  list: readonly ApplianceSummary[],
  input: {
    current: string;
    known: (device: string) => KnownAppliance | undefined;
    now?: number;
    /** The list is the boxes this device knows (LNK-43): no last-seen from a directory, so each says where it opens. */
    local?: boolean;
  },
): SwitcherRow[] {
  const now = input.now ?? Date.now();
  const rows = list
    .filter((a) => !isRetired(a))
    .map((a): SwitcherRow => {
      const here = a.device === input.current;
      const online = a.lastSeenAt !== null && now / 1000 - a.lastSeenAt < SWITCHER_ONLINE_S;
      const setUp = !here && !input.known(a.device)?.enrolled;
      const local = input.local ? knownBoxRows([input.known(a.device) ?? localStandIn(a)], '')[0] : null;
      const meta = here
        ? SWITCHER_COPY.here
        : setUp
          ? SWITCHER_COPY.setUp
          : local
            ? local.meta
            : online
              ? COPY.appliances.online
              : a.lastSeenAt !== null
                ? COPY.appliances.offline(agoText(a.lastSeenAt, now))
                : COPY.appliances.neverSeen;
      return { device: a.device, name: a.name ?? a.device, here, online, setUp, meta, appliance: a };
    });
  return rows.sort((a, b) => Number(b.here) - Number(a.here) || a.name.localeCompare(b.name));
}

/** What the menu needs from the app's managed root (whombat-switcher.md AP-3080…AP-3082), on the web and the phone. */
export interface ManagedWhombats {
  /** The organization's directory (control's `devices.list`). */
  list(): Promise<ApplianceSummary[]>;
  /** What this device knows about a Whombat: its pin and whether it is let in there. */
  known(device: string): KnownAppliance | undefined;
  /** An unconnected application session, only for a pinned Whombat this device is already enrolled on. Caller closes it. */
  connect?(device: string): ApplianceSession | null;
  /** Opens another Whombat as the list's Open does (AP-64): straight in, or set this device up first. */
  open(appliance: ApplianceSummary): void;
  /** Claim a Whombat. */
  claim: () => void;
  /** `list` is the boxes this device knows (its registry, LNK-43), not an account's directory. */
  local?: boolean;
}

/** The burrow name opens the menu only when there is another Whombat to go to. */
export function showsSwitcher(rows: readonly SwitcherRow[]): boolean {
  return rows.some((r) => !r.here);
}

/** A summary's stand-in record when this device has none (it shows as not let in). */
function localStandIn(a: ApplianceSummary): KnownAppliance {
  return {
    device: a.device,
    orgId: a.orgId ?? '',
    name: a.name,
    peerId: a.contentPeerId,
    pinSource: 'legacy',
    enrolled: false,
    kitPending: false,
  };
}
