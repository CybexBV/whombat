/**
 * Found on your network on the screen (docs/decisions/desk-found.md DF-03, DF-06, DF-07; DF-S03…DF-S05, DF-S09):
 * `glance.found` from what the burrow's scans hold now, as the paired person sees it. What is new for them is read with
 * the glance (`foundInputsOf`, at most every 10 s); `deskFound` (pure) reads the scan's progress and finds from memory
 * at every state, so the cards and “Looked at 412 of 1 022 addresses” move while the console asks.
 */
import { DESK_FOUND_ITEMS } from '@whombat/control-contracts/local';
import { type BurrowFound, burrowFound, type Found, newFoundTest } from '../connections/discover';
import { foundStateOf } from '../connections/found-scans';
import { foundAddress, foundName, foundTagline, orderFound } from '../connections/found-view';
import type { Services } from '../services';
import { type DeskPlace, screenText } from './glance';
import type { DeskFound } from './shapes';

/** The glance names at most this many; the rest are counted (DF-03). */
export const FOUND_ITEMS_MAX = DESK_FOUND_ITEMS;

/** What the glance's read knows for the found part: the paired person's view of the burrow's finds. */
export interface FoundInputs {
  /** Not connected for the person (CS-52), not hidden (CS-53). */
  isNew: (f: Found) => boolean;
  /** When the burrow's first automatic scan finished; null until then (DF-07). */
  firstScanAt: Date | null;
  /** The screen's Not now put it away (DF-04). */
  putAway: boolean;
}

/**
 * `glance.found` (DF-06): null when nothing shows — put away, or nothing new and the first automatic scan not looking.
 * While the burrow's first automatic scan runs it shows that scan's progress and what it found so far (DF-07); after
 * that the last finished result until the next one is in, or, when this runtime has none yet (a restart), what the
 * running scan found so far, without progress (DF-S09).
 */
export function deskFound(scans: BurrowFound, inputs: FoundInputs): DeskFound | null {
  if (inputs.putAway) return null;
  const running = scans.running;
  const looking = running?.automatic === true && inputs.firstScanAt === null;
  const source = looking ? running.found : (scans.last?.found ?? running?.found ?? []);
  const fresh = orderFound(source.filter(inputs.isNew));
  if (!looking && fresh.length === 0) return null;
  const items = fresh.slice(0, FOUND_ITEMS_MAX).flatMap((f) => {
    const name = screenText(foundName(f), 60);
    const tagline = screenText(foundTagline(f), 40);
    const address = screenText(foundAddress(f, fresh), 120);
    return name && tagline && address ? [{ catalogId: f.catalogId, name, tagline, address }] : [];
  });
  const finished = looking ? null : scans.last;
  return {
    scanning: running !== null,
    progress: looking ? { done: running.done, total: running.total } : null,
    items,
    count: Math.max(fresh.length, items.length),
    finishedAt: finished ? finished.finishedAt.toISOString() : null,
  };
}

/**
 * What the glance's read knows for the found part (DF-03): what is new for the paired person, the burrow's first scan
 * and Not now.
 */
export async function foundInputsOf(services: Services, place: DeskPlace): Promise<FoundInputs> {
  const [isNew, state] = await Promise.all([
    newFoundTest(services, {
      accountId: place.accountId,
      burrowId: place.burrow.id,
      principal: place.person,
    }),
    foundStateOf(services.db, place.burrow.id),
  ]);
  return { isNew, firstScanAt: state.firstScanAt, putAway: state.putAwayAt !== null };
}

/** `glance.found` for the paired person now (DF-06): from the inputs the glance read and the scans in memory. */
export function deskFoundNow(
  services: Services,
  burrowId: string,
  inputs: FoundInputs | null,
): DeskFound | null {
  return inputs ? deskFound(burrowFound(services, burrowId), inputs) : null;
}
