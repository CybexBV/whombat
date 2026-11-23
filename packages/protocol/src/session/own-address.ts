/**
 * The box's own address in the session (4.3; Whombat docs/decisions/own-address.md): its state for the person's
 * devices, the owner's switch, and linking the box to the person's account at Whombat with a one-time code. All
 * additions: a box before 4.3 answers `unknown_op`, which a client reads as “this Whombat has no own address yet”.
 * Choosing and changing the name (4.16, session minor 6): `ownAddress.check`, `ownAddress.rename` and the summary's
 * `leaving`.
 */
import { Email, Timestamp } from '@whombat/core/domain';
import { z } from 'zod';
import {
  OwnAddressHost,
  OwnAddressLabel,
  OwnAddressNameCandidate,
  OwnAddressNameVerdict,
} from '../own-address.js';

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

/** `https://<host>/`: an own-address page's root. */
const OwnAddressUrl = z
  .string()
  .max(80)
  .regex(/^https:[/][/][a-z0-9.-]+[/]$/);

/**
 * The box's earlier address while it still answers there (4.16): after a rename, or a move to `whombat.app`, it keeps
 * working until `until` (`OWN_ADDRESS_LEAVING_DAYS` after the change, or sooner when its certificate ends), then stops.
 */
export const OwnAddressLeaving = z.object({
  host: OwnAddressHost,
  url: OwnAddressUrl,
  until: Timestamp,
});
export type OwnAddressLeaving = z.infer<typeof OwnAddressLeaving>;

export const OwnAddressSummary = z.object({
  host: OwnAddressHost,
  /** `https://<host>/`. */
  url: OwnAddressUrl,
  /** `ready`: a valid certificate is being served. */
  state: OwnAddressState,
  /** The owner's switch “Reach my Whombat's page from anywhere” (on unless an owner turned it off). */
  reachable: z.boolean(),
  certificateEndsAt: Timestamp.nullable(),
  /**
   * While `failing`: why the certificate didn't come (`rate_limited`, `probe_failed`, `validation_failed`,
   * `ca_unreachable`, `order_failed`, …) and when the box tries again by itself. Older boxes leave it out, and so does
   * a box with nothing to say.
   */
  failure: z
    .object({
      reason: z
        .string()
        .max(40)
        .regex(/^[a-z0-9_]+$/),
      retryAt: Timestamp.nullable(),
    })
    .optional(),
  watch: z.object({
    /** The last fresh, complete certificate check; silence and errors never count. */
    lastCheckAt: Timestamp.nullable(),
    missed: z.array(OwnAddressMissedWindow).max(64),
    foreign: z.array(OwnAddressForeignCertificate).max(32),
  }),
  /**
   * The earlier address while it still works (4.16): `host` above is always the current one. Absent from older boxes,
   * and when nothing is leaving.
   */
  leaving: OwnAddressLeaving.optional(),
});
export type OwnAddressSummary = z.infer<typeof OwnAddressSummary>;

/** `ownAddress.status` (any enrolled member): the box's own address, null when it has none. */
export const OwnAddressStatusInput = z.strictObject({});
export const OwnAddressStatusOutput = z.object({ ownAddress: OwnAddressSummary.nullable() });

/** `ownAddress.reach.set` (owners; audited): the switch. `own_address_unavailable` on a box without one. */
export const OwnAddressReachSetInput = z.strictObject({ on: z.boolean() });
export const OwnAddressReachSetOutput = z.object({ ownAddress: OwnAddressSummary });

/**
 * `ownAddress.check` (owners, 4.16; a read, about 60 an hour): whether the box could change its address to `label`.
 * `host` is the address it would have, when the verdict is `free` or `yours`. Refusals `OWN_ADDRESS_RENAME_ERROR_CODES`
 * (`link_off`, `own_address_off`, `own_address_unavailable`, `control_unreachable`). A box before session minor 6
 * answers `unknown_op`.
 */
export const OwnAddressCheckInput = z.strictObject({ label: OwnAddressNameCandidate });
export const OwnAddressCheckOutput = z.object({
  label: OwnAddressNameCandidate,
  verdict: OwnAddressNameVerdict,
  host: OwnAddressHost.optional(),
});
export type OwnAddressCheckOutput = z.infer<typeof OwnAddressCheckOutput>;

/**
 * `ownAddress.rename` (owners, 4.16; audited): change the box's address to `label`. The current address becomes the
 * leaving one and keeps working for `OWN_ADDRESS_LEAVING_DAYS` (an address already leaving keeps its date, and the one
 * being replaced stops at once). The answer is the new state; its certificate comes a little later. Refusals
 * `OWN_ADDRESS_RENAME_ERROR_CODES`.
 */
export const OwnAddressRenameInput = z.strictObject({ label: OwnAddressLabel });
export const OwnAddressRenameOutput = z.object({ ownAddress: OwnAddressSummary });

/** Why `ownAddress.check` or `ownAddress.rename` was refused (`error.details.code`). */
export const OWN_ADDRESS_RENAME_ERROR_CODES = [
  'label_invalid',
  'label_reserved',
  'label_taken',
  'rename_limit',
  'link_off',
  'own_address_off',
  'own_address_unavailable',
  'control_unreachable',
] as const;
export type OwnAddressRenameErrorCode = (typeof OWN_ADDRESS_RENAME_ERROR_CODES)[number];

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
