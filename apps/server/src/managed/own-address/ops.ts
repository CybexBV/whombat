/**
 * The own address's session ops (docs/decisions/own-address.md; contracts 4.3 `session/own-address.ts`):
 *
 * - `ownAddress.status {}` (any of the person's devices): the address, its certificate, the owner's switch and the
 *   certificate watch; null on a box without one.
 * - `ownAddress.reach.set {on}` (the person): “Reach my Whombat's page from anywhere”. Off, the box takes only the
 *   certificate authority's validations from the door, so renewals go on.
 * - `account.link.lookup {code}` and `account.link {code}` (the person): linking the box to the person's Whombat account
 *   with the one-time code that account shows. The lookup names the account (“Link to <email>?”), the link ties them;
 *   both go to control through the manager, signed with the box's key. Control's refusals come back by their codes.
 */
import type {
  AccountLinkErrorCode,
  OwnAddressReachSetOutput,
  OwnAddressStatusOutput,
} from '@whombat/protocol/session';
import { ACCOUNT_LINK_ERROR_CODES } from '@whombat/protocol/session';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { applianceState } from '../../db/schema/index';
import { ApiError } from '../../lib/errors';
import type { SessionOpContext } from '../dispatcher';
import { ManagerCallError, managerUnreachable } from '../ports';
import { requireEnrolled, requirePerson } from '../trust';
import type { OwnAddressService } from './state';

const STATE_ID = 1;

/** What the person reads for each of control's refusals of a link code. */
const LINK_REFUSALS: Readonly<Record<AccountLinkErrorCode, { code: string; message: string }>> = {
  link_code_invalid: {
    code: 'not_found',
    message: 'That code doesn’t work. Check the code on your account’s page, or make a new one.',
  },
  link_code_expired: { code: 'expired', message: 'That code’s ten minutes are over. Make a new one.' },
  link_code_used: { code: 'conflict', message: 'That code was used already. Make a new one.' },
  link_other_account: { code: 'conflict', message: 'This Whombat is already linked to another account.' },
  link_devices_allowed: {
    code: 'not_allowed',
    message: 'Your plan has no room for another Whombat. Change your plan on your account’s page first.',
  },
  link_terms: {
    code: 'not_allowed',
    message: 'Accept the Whombat terms on your account’s page first, then try again.',
  },
  control_unreachable: {
    code: 'unavailable',
    message: 'Whombat can’t reach your account right now. Try again in a minute.',
  },
};

/** A manager or control refusal of `account.link*` as the session's error. */
export function linkRefusal(err: unknown): ApiError {
  let reason: AccountLinkErrorCode | null = null;
  if (err instanceof ManagerCallError) {
    if (managerUnreachable(err) && err.code !== 'control_refused') reason = 'control_unreachable';
    else {
      const text = `${err.code} ${err.message}`;
      reason = ACCOUNT_LINK_ERROR_CODES.find((c) => new RegExp(`\\b${c}\\b`).test(text)) ?? null;
    }
  }
  if (!reason) {
    if (err instanceof ApiError) return err;
    return new ApiError('unavailable', LINK_REFUSALS.control_unreachable.message, {
      details: { code: 'control_unreachable' },
    });
  }
  const refusal = LINK_REFUSALS[reason];
  return new ApiError(refusal.code as never, refusal.message, { details: { code: reason } });
}

function own(c: SessionOpContext): OwnAddressService {
  const service = c.ownAddress;
  if (!service?.summary())
    throw new ApiError('unavailable', 'This Whombat has no address of its own yet.', {
      details: { code: 'own_address_unavailable' },
    });
  return service;
}

const iso = (epochSeconds: number) => new Date(epochSeconds * 1000).toISOString();

export const OWN_ADDRESS_SESSION_HANDLERS = {
  'ownAddress.status': async (c: SessionOpContext): Promise<z.input<typeof OwnAddressStatusOutput>> => {
    requireEnrolled(c.principal);
    return { ownAddress: c.ownAddress?.summary() ?? null };
  },
  'ownAddress.reach.set': async (
    c: SessionOpContext,
    input: { on: boolean },
  ): Promise<z.input<typeof OwnAddressReachSetOutput>> => {
    requirePerson(c.principal);
    const service = own(c);
    await service.setReach(input.on);
    return { ownAddress: service.summary() as NonNullable<ReturnType<OwnAddressService['summary']>> };
  },
  'account.link.lookup': async (c: SessionOpContext, input: { code: string }) => {
    requirePerson(c.principal);
    const lookup = c.manager?.accountLinkLookup?.bind(c.manager);
    if (!lookup || c.trust.community)
      throw new ApiError('not_allowed', 'This Whombat isn’t linked to a Whombat account.');
    try {
      const found = await lookup({ code: input.code });
      return { email: found.email, expiresAt: iso(found.expiresAt) };
    } catch (err) {
      throw linkRefusal(err);
    }
  },
  'account.link': async (c: SessionOpContext, input: { code: string }) => {
    requirePerson(c.principal);
    const link = c.manager?.accountLink?.bind(c.manager);
    if (!link || c.trust.community)
      throw new ApiError('not_allowed', 'This Whombat isn’t linked to a Whombat account.');
    let linked: { email: string; linkedAt: number };
    try {
      linked = await link({ code: input.code });
    } catch (err) {
      throw linkRefusal(err);
    }
    const linkedAt = new Date(linked.linkedAt * 1000);
    await c.services.db
      .update(applianceState)
      .set({ accountLinkedAt: linkedAt, accountLinkedEmail: linked.email, updatedAt: c.services.clock() })
      .where(eq(applianceState.id, STATE_ID));
    // Control keeps backup envelopes for this box's passkeys only once it is linked: declare them now.
    c.trust.boxPasskeys.declareSoon();
    return { email: linked.email, linkedAt: linkedAt.toISOString() };
  },
} as const;
