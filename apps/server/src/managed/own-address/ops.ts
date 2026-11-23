/**
 * The own address's session ops (docs/decisions/own-address.md; contracts 4.3 `session/own-address.ts`):
 *
 * - `ownAddress.status {}` (any of the person's devices): the address, its certificate, the owner's switch and the
 *   certificate watch; null on a box without one.
 * - `ownAddress.reach.set {on}` (the person): “Reach my Whombat's page from anywhere”. Off, the box takes only the
 *   certificate authority's validations from the door, so renewals go on.
 * - `ownAddress.check {label}` and `ownAddress.rename {label}` (the person, and the assistant for them: the check is a
 *   read, the rename asks first): whether the box could change its address to that name, and changing it. Both go to
 *   control through the manager. A rename keeps the address it replaces working for 30 days (the leaving one).
 *
 * An app before session minor 6 reads only the older three-word hosts: it gets no address rather than one it can't
 * parse (`older-apps.ts`).
 * - `account.link.lookup {code}` and `account.link {code}` (the person): linking the box to the person's Whombat account
 *   with the one-time code that account shows. The lookup names the account (“Link to <email>?”), the link ties them;
 *   both go to control through the manager, signed with the box's key. Control's refusals come back by their codes.
 */
import { ownAddressNameProblem } from '@whombat/core/own-address';
import { ownAddressHost, ownAddressZoneOf } from '@whombat/protocol/own-address';
import type {
  AccountLinkErrorCode,
  OwnAddressCheckOutput,
  OwnAddressReachSetOutput,
  OwnAddressRenameErrorCode,
  OwnAddressRenameOutput,
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
import { ownAddressFor } from './older-apps';
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

/** What the person reads for each refusal of a check or a rename, with the session's error code. */
const RENAME_REFUSALS: Readonly<
  Record<
    OwnAddressRenameErrorCode,
    {
      code: 'validation_failed' | 'not_allowed' | 'conflict' | 'rate_limited' | 'unavailable';
      message: string;
    }
  >
> = {
  label_invalid: {
    code: 'validation_failed',
    message: 'Use 3 to 32 lower-case letters, digits and single hyphens, starting with a letter.',
  },
  label_reserved: { code: 'not_allowed', message: 'That name isn’t available.' },
  label_taken: { code: 'conflict', message: 'That name is taken.' },
  rename_limit: {
    code: 'rate_limited',
    message: 'Your Whombat’s address was changed 3 times this year already. Try again later.',
  },
  link_off: { code: 'not_allowed', message: 'Turn on Whombat Link to change your Whombat’s address.' },
  own_address_off: { code: 'unavailable', message: 'Whombat can’t give this Whombat an address right now.' },
  own_address_unavailable: { code: 'unavailable', message: 'This Whombat can’t change its address yet.' },
  control_unreachable: {
    code: 'unavailable',
    message: 'Whombat can’t reach its service right now. Try again in a minute.',
  },
};

export function renameError(reason: OwnAddressRenameErrorCode): ApiError {
  const refusal = RENAME_REFUSALS[reason];
  return new ApiError(refusal.code, refusal.message, { details: { code: reason } });
}

/** The manager's codes (`own_address.*`) and control's (in a `control_refused` message) as the session's. */
const MANAGER_RENAME_CODES: Readonly<Record<string, OwnAddressRenameErrorCode>> = {
  'own_address.label_invalid': 'label_invalid',
  'own_address.label_reserved': 'label_reserved',
  'own_address.label_taken': 'label_taken',
  'own_address.rename_limit': 'rename_limit',
  'own_address.link_off': 'link_off',
  'own_address.off': 'own_address_off',
};
const CONTROL_RENAME_CODES = [
  'label_invalid',
  'label_reserved',
  'label_taken',
  'rename_limit',
  'link_off',
  'own_address_off',
] as const satisfies readonly OwnAddressRenameErrorCode[];

/** A manager or control refusal of `ownAddress.check` / `.rename` as the session's error. */
export function renameRefusal(err: unknown): ApiError {
  if (!(err instanceof ManagerCallError))
    return err instanceof ApiError ? err : renameError('control_unreachable');
  const mapped = MANAGER_RENAME_CODES[err.code];
  if (mapped) return renameError(mapped);
  if (err.code === 'control_refused') {
    const text = `${err.code} ${err.message}`;
    const found = CONTROL_RENAME_CODES.find((c) => new RegExp(`\\b${c}\\b`).test(text));
    if (found) return renameError(found);
    return renameError('control_unreachable');
  }
  // A manager without the routes (an older one) answers 404 with its own code.
  if (err.status === 404) return renameError('own_address_unavailable');
  return renameError('control_unreachable');
}

function own(c: SessionOpContext): OwnAddressService {
  const service = c.ownAddress;
  if (!service?.summary())
    throw new ApiError('unavailable', 'This Whombat has no address of its own yet.', {
      details: { code: 'own_address_unavailable' },
    });
  return service;
}

/** The host `label` would have: in the zone of the current host, which is control's for every box that moved. */
function hostOf(label: string, service: OwnAddressService): string | undefined {
  const current = service.host();
  const zone = current ? ownAddressZoneOf(current) : null;
  if (!zone) return undefined;
  try {
    return ownAddressHost(label, zone);
  } catch {
    return undefined;
  }
}

const iso = (epochSeconds: number) => new Date(epochSeconds * 1000).toISOString();

export const OWN_ADDRESS_SESSION_HANDLERS = {
  'ownAddress.status': async (c: SessionOpContext): Promise<z.input<typeof OwnAddressStatusOutput>> => {
    requireEnrolled(c.principal);
    return { ownAddress: ownAddressFor(c.ownAddress?.summary() ?? null, c.principal.protocolMinor) };
  },
  'ownAddress.reach.set': async (
    c: SessionOpContext,
    input: { on: boolean },
  ): Promise<z.input<typeof OwnAddressReachSetOutput>> => {
    requirePerson(c.principal);
    const service = own(c);
    // An older app that can't read the address never had the switch to press.
    const before = ownAddressFor(service.summary(), c.principal.protocolMinor);
    if (!before) throw renameError('own_address_unavailable');
    await service.setReach(input.on);
    return { ownAddress: ownAddressFor(service.summary(), c.principal.protocolMinor) ?? before };
  },
  'ownAddress.check': async (
    c: SessionOpContext,
    input: { label: string },
  ): Promise<z.input<typeof OwnAddressCheckOutput>> => {
    requirePerson(c.principal);
    const service = own(c);
    // The rules every box knows are answered here, without spending control's hourly checks.
    const problem = ownAddressNameProblem(input.label);
    if (problem) return { label: input.label, verdict: problem };
    const check = c.manager?.ownAddressCheck?.bind(c.manager);
    if (!check) throw renameError('own_address_unavailable');
    let verdict: z.input<typeof OwnAddressCheckOutput>['verdict'];
    try {
      verdict = (await check(input.label)).verdict;
    } catch (err) {
      throw renameRefusal(err);
    }
    const host = verdict === 'free' || verdict === 'yours' ? hostOf(input.label, service) : undefined;
    return { label: input.label, verdict, ...(host ? { host } : {}) };
  },
  'ownAddress.rename': async (
    c: SessionOpContext,
    input: { label: string },
  ): Promise<z.input<typeof OwnAddressRenameOutput>> => {
    requirePerson(c.principal);
    const service = own(c);
    const problem = ownAddressNameProblem(input.label);
    if (problem) throw renameError(problem === 'reserved' ? 'label_reserved' : 'label_invalid');
    const rename = c.manager?.ownAddressRename?.bind(c.manager);
    if (!rename) throw renameError('own_address_unavailable');
    const from = service.host();
    let state: Awaited<ReturnType<typeof rename>>;
    try {
      state = await rename(input.label);
    } catch (err) {
      throw renameRefusal(err);
    }
    await service.accept(state);
    const summary = service.summary();
    if (!summary) throw renameError('own_address_off');
    if (summary.host !== from) c.services.log.info({}, 'own address: the owner changed its name');
    return { ownAddress: summary };
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
