/**
 * The box's own address at control (4.3; Whombat docs/decisions/own-address.md), as device ops the manager signs:
 * registering the label the box drew, linking the box to the person's account with the one-time code from the account's
 * page, and declaring the box's own passkeys so control keeps their backup envelopes. Cross-language. Control checks a
 * label against the word list (`isOwnAddressLabel` in `@whombat/core/own-address`); these schemas know its shape only.
 */
import {
  AccountLinkCode,
  BackupPasskeyCredentialId,
  OwnAddressHost,
  OwnAddressLabel,
} from '@whombat/protocol';
import { EpochSeconds } from '@whombat/release';
import { z } from 'zod';

/** An account's email as control answers it: printable ASCII with one `@`. */
export const AccountEmail = z
  .string()
  .min(3)
  .max(254)
  .regex(/^[\x21-\x3f\x41-\x7e]+@[\x21-\x3f\x41-\x7e]+$/);

/** The most box passkeys one declaration names (`kit.credentials.declare`). */
export const KIT_CREDENTIALS_DECLARE_MAX = 64;

export const ADDRESS_DEVICE_OPS = {
  /**
   * Register the label the box drew. A device that has one gets it back, whatever it sent: one per device, never
   * changed. Otherwise the label must be a valid one (`label_invalid`) never used before (`label_taken`, 409). Refuses a
   * retired device (`device_revoked`) and more than 10 an hour per device or 600 an hour per environment
   * (`rate_limited`). The manager checks that `host` is the label under its own zone. Audited as `address.registered`.
   */
  'address.register': {
    body: z.strictObject({ label: OwnAddressLabel }),
    response: z.object({ label: OwnAddressLabel, host: OwnAddressHost, registeredAt: EpochSeconds }),
  },
  /**
   * Whose account a link code is, so the box can ask “Link to <email>?” before it links. Unknown, expired and used
   * codes all answer `link_code_invalid`. 10 an hour per device.
   */
  'account.link.lookup': {
    body: z.strictObject({ code: AccountLinkCode }),
    response: z.object({ email: AccountEmail, expiresAt: EpochSeconds }),
  },
  /**
   * Link the box to the code's account, in one transaction: the code is live and unused (`link_code_invalid`,
   * `link_code_expired`, `link_code_used`), the device isn't retired (`device_revoked`) or in another org
   * (`link_other_account`), the account accepted the current appliance terms (`link_terms`) and its plan allows one more
   * box (`link_devices_allowed`). Then the device is claimed by that org, the code used up and the claim lookup lease
   * dropped, as a claim does. The same org again is fine. Audited as `device.linked`.
   */
  'account.link': {
    body: z.strictObject({ code: AccountLinkCode }),
    response: z.object({ email: AccountEmail, linkedAt: EpochSeconds }),
  },
  /**
   * The box's passkeys whose backup envelopes control should keep for it: the full set each time (it heals itself
   * after a lost request). Control replaces the set for this box and, in the same transaction, deletes the envelopes of
   * the credentials that dropped out. Only for a linked device (`device_unlinked`). Audited as
   * `kit.credentials.declared` with counts.
   */
  'kit.credentials.declare': {
    body: z.strictObject({
      credentialIds: z.array(BackupPasskeyCredentialId).max(KIT_CREDENTIALS_DECLARE_MAX),
    }),
    response: z.object({ declared: z.number().int().min(0).max(KIT_CREDENTIALS_DECLARE_MAX) }),
  },
} as const;
