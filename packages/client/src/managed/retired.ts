/**
 * A Whombat this device knows but can't open any more (AP-693…AP-696): control retired it (stolen, repaired,
 * destroyed, replaced by a new appliance), or it isn't this organization's any more.
 *
 * Control refuses its admission tickets (`tickets.client` → 404 `device_not_found`), but gives the same answer for a
 * Whombat whose claim the appliance hasn't reported yet (it reports `claim.claimed` right after the ceremony and again
 * every 5 minutes until control takes it): a 404 alone proves nothing, so the directory tells them apart. Listed
 * `retired`: for good. Not listed: retried, with its own words, and given up after `UNLISTED_GIVE_UP_MS`.
 *
 * Nothing here pins or unpins (AP-63): a Whombat left behind keeps its record (the list shows a retired one until the
 * person forgets it); only the last-used Whombat is cleared, so it isn't reopened by itself.
 */
import { ApplianceRefusedError, TicketDeniedError, type TicketSource } from '../session/connector';
import type { ConnectionState } from '../session/types';
import { type ApplianceSummary, type ControlApi, ControlError } from './control';
import { COPY } from './copy';

/**
 * How long control may refuse a Whombat the directory doesn't list before the session gives up on it: twice the
 * appliance's 5-minute retry of an unreported claim.
 */
export const UNLISTED_GIVE_UP_MS = 10 * 60_000;

/**
 * Control's admission tickets for one Whombat, as `createManagedConnector` asks for them (web and Android alike).
 * Signed out, a role that may not connect, or not a member any more (`org_not_found`): `TicketDeniedError`. No such
 * Whombat for this organization (any other 404): the directory says how it stands — `ApplianceRefusedError` with
 * `appliance_retired` (listed retired), `appliance_unlisted` (anything else, also when the directory can't be read) or,
 * unlisted since `giveUpMs`, `appliance_gone`. Control unreachable or busy: rethrown, so the session retries as offline.
 * One per session: the time it has been unlisted is this session's.
 */
export function controlTickets(
  control: Pick<ControlApi, 'ticket' | 'appliances'>,
  target: { orgId: string; device: string },
  options: { now?: () => number; giveUpMs?: number } = {},
): TicketSource {
  const now = options.now ?? Date.now;
  const giveUpMs = options.giveUpMs ?? UNLISTED_GIVE_UP_MS;
  let unlistedSince: number | null = null;
  return async (request) => {
    try {
      const ticket = await control.ticket(
        {
          orgId: target.orgId,
          device: target.device,
          channel: request.channel,
          class: request.class,
        },
        { signal: request.signal },
      );
      unlistedSince = null;
      return ticket;
    } catch (error) {
      if (!(error instanceof ControlError)) throw error;
      if (error.code === 'signed_out' || error.code === 'forbidden' || error.reason === 'org_not_found')
        throw new TicketDeniedError(error.message);
      if (error.code !== 'not_found') throw error;
      if (request.signal?.aborted) throw error;
      const list = await control.appliances(target.orgId, { signal: request.signal }).catch(() => null);
      if (request.signal?.aborted) throw error;
      if (list?.some((a) => a.device === target.device && a.state === 'retired'))
        throw new ApplianceRefusedError('appliance_retired', 'This Whombat was retired.');
      unlistedSince ??= now();
      if (now() - unlistedSince >= giveUpMs)
        throw new ApplianceRefusedError(
          'appliance_gone',
          'This Whombat isn’t in this organization any more.',
        );
      throw new ApplianceRefusedError('appliance_unlisted', 'This Whombat isn’t in this organization.');
    }
  };
}

/** Why a Whombat can't be opened any more: retired, or not this organization's (any more). */
export type GoneReason = 'retired' | 'missing';

/** A session that ended for good because its Whombat can't be opened any more (AP-694), and why; else null. */
export function goneOf(state: ConnectionState): GoneReason | null {
  if (state.status !== 'closed') return null;
  if (state.reason === 'appliance_retired') return 'retired';
  return state.reason === 'appliance_gone' ? 'missing' : null;
}

/** The list's notice after leaving a Whombat that can't be opened (AP-694): “Burrow HQ was retired. …”. */
export function goneNotice(reason: GoneReason, name: string | null | undefined): string {
  return COPY.appliances.gone[reason](name?.trim() || COPY.appliances.yourWhombat);
}

export const isRetired = (a: Pick<ApplianceSummary, 'state'>): boolean => a.state === 'retired';

/**
 * The list's rows (AP-695): the organization's Whombats in use, then the retired ones this device still remembers
 * (they say Retired and can be forgotten). A retired Whombat this device never knew isn't listed: there is nothing to
 * open and nothing to forget.
 */
export function listedAppliances(
  list: readonly ApplianceSummary[],
  remembers: (device: string) => boolean,
): ApplianceSummary[] {
  return [...list.filter((a) => !isRetired(a)), ...list.filter((a) => isRetired(a) && remembers(a.device))];
}

/**
 * The list's line without a Whombat in use (AP-695): “No Whombats yet. …” for an organization that never had one, “No
 * Whombats in use. …” when every one is retired; null while one is in use.
 */
export function appliancesEmptyText(list: readonly ApplianceSummary[]): string | null {
  if (list.some((a) => !isRetired(a))) return null;
  return list.length > 0 ? COPY.appliances.noneLive : COPY.appliances.none;
}
