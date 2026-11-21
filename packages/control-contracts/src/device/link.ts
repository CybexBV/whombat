/**
 * Whombat Link at control (4.4; Whombat docs/decisions/whombat-link.md), as device ops the manager signs: starting Link
 * (which is also how control first hears of a box), reading its state, leaving it, a phone's push token registered
 * through the box, and remote help's narrow heartbeat. The Link state also rides on every `ticket.issue` answer
 * (`TicketResponse.link`). Cross-language.
 */
import { LinkCode, LinkPageUrl, LinkState, NativePushToken, OwnAddressLabel } from '@whombat/protocol';
import { hostTextSchema, PushHandle } from '@whombat/protocol/session';
import { EpochSeconds } from '@whombat/release';
import { z } from 'zod';
import { AccountEmail } from './address.js';
import { DeviceRegistration } from './provisioning.js';
import { SupportReport } from './status.js';

/** The code the box shows while Link starts, and where the person types it (`https://app.whombat.com/link`). */
export const LinkPending = z.object({
  code: LinkCode,
  url: LinkPageUrl,
  expiresAt: EpochSeconds,
});
export type LinkPending = z.infer<typeof LinkPending>;

/**
 * A box's Link state as control answers it. `since`: when it took this state. `pending` only in `starting` (absent
 * once the code expired: the box asks again with `link.begin`); `waitingForAddress` in `starting` when the person
 * confirmed but the day's new labels ran out (“Waiting for an address”); `graceEndsAt` only in `grace`;
 * `trialEndsAt` while the free month runs; `label` once control gave the box its address (the manager then registers
 * it with `address.register`); `email` the account's, once linked. Every member but `state` and `since` is optional.
 */
export const DeviceLinkStatus = z.object({
  state: LinkState,
  since: EpochSeconds,
  pending: LinkPending.optional(),
  waitingForAddress: z.boolean().optional(),
  graceEndsAt: EpochSeconds.optional(),
  trialEndsAt: EpochSeconds.optional(),
  label: OwnAddressLabel.optional(),
  email: AccountEmail.optional(),
});
export type DeviceLinkStatus = z.infer<typeof DeviceLinkStatus>;

const Ok = z.object({ ok: z.literal(true) });

export const LINK_DEVICE_OPS = {
  /**
   * The owner turned Link on (or the installer's choice at first start): a fresh one-time code for this box. Works for
   * a box control has never seen: `registration` is the box's identity (`DeviceRegistration`, both proofs; the manager
   * signs `proof`, the runtime the content key's `contentProof`), and the envelope's `device` is the box's own id. An
   * unknown device is created with that id from the registration (whose keys must verify, `registration_invalid`, and
   * be nobody else's, `device_exists`, 409); a known one must match it (`device_exists`). The envelope is then checked
   * against the registration's management key. `name` is the box's name, when it has one, for the confirm page. A box
   * already `on` (or in `grace`) gets its state without a new code. Refuses a retired device (`device_revoked`) and
   * more than 10 an hour per device or address (`rate_limited`). Audited as `link.begun`.
   */
  'link.begin': {
    body: z.strictObject({ registration: DeviceRegistration, name: hostTextSchema(64).optional() }),
    response: z.object({ link: DeviceLinkStatus }),
  },
  /** This box's Link state, as `ticket.issue` carries it. A box control doesn't know is refused `unknown_device`. */
  'link.status': {
    body: z.strictObject({}),
    response: z.object({ link: DeviceLinkStatus }),
  },
  /**
   * The owner turned Link off on the box: control unlinks it from the account (the subscription's quantity drops) and
   * answers `off`. The label stays the box's for good, so turning Link on again brings the same address back.
   * Audited as `link.left`.
   */
  'link.leave': {
    body: z.strictObject({}),
    response: z.object({ link: DeviceLinkStatus }),
  },
  /**
   * A phone's push token, handed to the box over the session: control keeps it bound to this box and answers an
   * opaque handle for `push.send`. A handle reaches only the box that registered it; one unused for 90 days expires.
   * The same token again answers the same handle. Refused while the box's Link is `off` or `ended` (`link_off`).
   */
  'push.register': {
    body: z.strictObject({ token: NativePushToken }),
    response: z.object({ handle: PushHandle }),
  },
  /** The device that gave the token was removed: control forgets the handle. An unknown handle is fine. */
  'push.unregister': {
    body: z.strictObject({ handle: PushHandle }),
    response: Ok,
  },
  /**
   * Remote help's state for control, apart from `status.report`: what an operator's `support.open` reads (a heartbeat
   * of the last 15 minutes that isn't `off`). Send it every `nextS`, and at once when remote help changes.
   */
  'support.heartbeat': {
    body: z.strictObject({ support: SupportReport }),
    response: z.object({ ok: z.literal(true), nextS: z.number().int().min(60).max(3_600) }),
  },
} as const;
