/**
 * The box's own address in the session (4.3; Whombat docs/decisions/own-address.md): its state for the person's
 * devices, the owner's switch, and linking the box to the person's account at Whombat with a one-time code. All
 * additions: a box before 4.3 answers `unknown_op`, which a client reads as “this Whombat has no own address yet”.
 */
import { Email, Timestamp } from '@whombat/core/domain';
import { z } from 'zod';
import { OwnAddressHost } from '../own-address.js';

export const OwnAddressState = z.enum(['off', 'starting', 'ready', 'failing']);
export type OwnAddressState = z.infer<typeof OwnAddressState>;

const Spki = z.string().regex(/^[0-9a-f]{64}$/);
const DnsName = z
  .string()
  .max(253)
  .regex(/^[*a-z0-9.-]+$/);

/** A certificate for the box's host that the box didn't ask for, as the certificate watch found it. */
export const OwnAddressForeignCertificate = z.object({
  /** SHA-256 of its DER SubjectPublicKeyInfo, lower-case hex. */
  spkiSha256: Spki,
  names: z.array(DnsName).max(20),
  notBefore: Timestamp,
  notAfter: Timestamp,
  firstSeenAt: Timestamp,
});
export type OwnAddressForeignCertificate = z.infer<typeof OwnAddressForeignCertificate>;

/** A stretch of time without a fresh, complete certificate check (more than 12 h). */
export const OwnAddressMissedWindow = z.object({ from: Timestamp, to: Timestamp });

export const OwnAddressSummary = z.object({
  host: OwnAddressHost,
  /** `https://<host>/`. */
  url: z
    .string()
    .max(80)
    .regex(/^https:[/][/][a-z.-]+[/]$/),
  /** `ready`: a valid certificate is being served. */
  state: OwnAddressState,
  /** The owner's switch “Reach my Whombat's page from anywhere” (on unless an owner turned it off). */
  reachable: z.boolean(),
  certificateEndsAt: Timestamp.nullable(),
  watch: z.object({
    /** The last fresh, complete certificate check; silence and errors never count. */
    lastCheckAt: Timestamp.nullable(),
    missed: z.array(OwnAddressMissedWindow).max(64),
    foreign: z.array(OwnAddressForeignCertificate).max(32),
  }),
});
export type OwnAddressSummary = z.infer<typeof OwnAddressSummary>;

/** `ownAddress.status` (any enrolled member): the box's own address, null when it has none. */
export const OwnAddressStatusInput = z.strictObject({});
export const OwnAddressStatusOutput = z.object({ ownAddress: OwnAddressSummary.nullable() });

/** `ownAddress.reach.set` (owners; audited): the switch. `own_address_unavailable` on a box without one. */
export const OwnAddressReachSetInput = z.strictObject({ on: z.boolean() });
export const OwnAddressReachSetOutput = z.object({ ownAddress: OwnAddressSummary });

/**
 * The one-time code the person's account at Whombat shows, typed at the box to link it (`XXXX-XXXX`, claim alphabet).
 * It lives 10 minutes and links one box.
 */
export const AccountLinkCode = z.string().regex(/^[ABCDEFGHJKMNPQRTVWXY]{4}-[ABCDEFGHJKMNPQRTVWXY]{4}$/);
export type AccountLinkCode = z.infer<typeof AccountLinkCode>;

/**
 * `account.link.lookup` (owners): whose account the code belongs to, so the box can ask “Link to <email>?” first. A
 * read: nothing is linked or used up.
 */
export const AccountLinkLookupInput = z.strictObject({ code: AccountLinkCode });
export const AccountLinkLookupOutput = z.object({ email: Email, expiresAt: Timestamp });

/**
 * `account.link` (owners; audited): link this box to the code's account. The same account again is fine. Refusals in
 * `details.code`: `ACCOUNT_LINK_ERROR_CODES`.
 */
export const AccountLinkInput = z.strictObject({ code: AccountLinkCode });
export const AccountLinkOutput = z.object({ email: Email, linkedAt: Timestamp });

/** Why `account.link.lookup` or `account.link` was refused (`error.details.code`). */
export const ACCOUNT_LINK_ERROR_CODES = [
  'link_code_invalid',
  'link_code_expired',
  'link_code_used',
  'link_other_account',
  'link_devices_allowed',
  'link_terms',
  'control_unreachable',
] as const;
export type AccountLinkErrorCode = (typeof ACCOUNT_LINK_ERROR_CODES)[number];
