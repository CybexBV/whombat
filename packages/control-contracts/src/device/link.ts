/**
 * Whombat Link at control (4.4; Whombat docs/decisions/whombat-link.md), as device ops the manager signs: starting Link
 * (which is also how control first hears of a box), reading its state, leaving it, a phone's push token registered
 * through the box, and remote help's narrow heartbeat. The Link state also rides on every `ticket.issue` answer
 * (`TicketResponse.link`). Cross-language.
 */
import {
  LinkCode,
  LinkPageUrl,
  LinkState,
  NativePushToken,
  OwnAddressClaimSecret,
  OwnAddressHost,
  OwnAddressLabel,
  OwnAddressZone,
} from '@whombat/protocol';
import { hostTextSchema, PushHandle } from '@whombat/protocol/session';
import { EpochSeconds } from '@whombat/release';
import { z } from 'zod';
import { DeviceId } from '../common.js';
import { AccountEmail, AddressLeaving } from './address.js';
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
 * it with `address.register`); `email` the account's, once linked. Since 4.16: `host`, the box's live host as control
 * has it (the manager serves that one); `zone`, where control gives names now (a box at a host under an old zone moves
 * with `address.rename` of its own label); `leaving`, the earlier address while it still works. Every member but
 * `state` and `since` is optional.
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
  host: OwnAddressHost.optional(),
  zone: OwnAddressZone.optional(),
  leaving: AddressLeaving.optional(),
});
export type DeviceLinkStatus = z.infer<typeof DeviceLinkStatus>;

const Ok = z.object({ ok: z.literal(true) });

/**
 * One of the other Whombats linked to the same account (4.14), as the box's menu shows it: its name (null until its
 * owner named it), its Link state, its own address once it has one, and when control last heard from it.
 */
export const LinkWhombat = z.object({
  device: DeviceId,
  name: hostTextSchema(80).nullable(),
  state: LinkState,
  host: OwnAddressHost.nullable(),
  lastSeenAt: EpochSeconds.nullable(),
});
export type LinkWhombat = z.infer<typeof LinkWhombat>;

/** At most this many other Whombats in one answer. */
export const LINK_WHOMBATS_MAX = 100;

/**
 * Email through Whombat Link (4.15; Whombat docs/decisions/link-email.md): the owner's two choices, kept on the box and
 * told to control with `link.mail.set`. `offline`: control emails the Link account's address when it hasn't heard from
 * the box for `LINK_MAIL_OFFLINE_AFTER_S`. `notifications`: the box may hand control its notification emails and its
 * notices in fixed words (`mail.send`), which control sends to that same address and nowhere else.
 */
export const LinkMailChoices = z.object({ offline: z.boolean(), notifications: z.boolean() });
export type LinkMailChoices = z.infer<typeof LinkMailChoices>;

/** How long control waits without hearing from a box before it emails that the box went quiet. */
export const LINK_MAIL_OFFLINE_AFTER_S = 7_200;

/** At most this many `mail.send` a day per box: an hourly email and the odd notice fit with room to spare. */
export const LINK_MAIL_PER_DAY = 40;

/**
 * The box's own name for one email, the same for every try of it (an opaque keyed hash, never an id): control sends a
 * mail with a ref it already sent once only.
 */
export const LinkMailRef = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

/** A page of the box the email's button opens, under the box's own address (`/home/settings?tab=notifications`). */
export const LinkMailPath = z.string().regex(/^\/[A-Za-z0-9/_.~%?&=-]{0,199}$/);

/**
 * One email the box asks control to send (`mail.send`); one flat shape, so the manager's Go reads it as it is. By
 * `kind`:
 *
 * - `waiting`: the notification email, as a count only: `count` things wait unread, sent `hourly` or `daily` as the
 *   person chose; `path` the box's page that shows them. Never who, where or what: control learns how many, not what
 *   they are.
 * - `notice`: a notice about the box in fixed words (a new device, the recovery kit, remote help, a restore that is
 *   done), the same two lines a phone notification shows (`title`, `body`); `path` the page of the box its button
 *   opens.
 *
 * Control refuses a `waiting` without `count` and `cadence`, a `notice` without `title` and `body`, and either with the
 * other kind's members (`validation_failed`).
 */
export const LinkMail = z.strictObject({
  kind: z.enum(['waiting', 'notice']),
  ref: LinkMailRef,
  count: z.number().int().min(1).max(999).optional(),
  cadence: z.enum(['hourly', 'daily']).optional(),
  title: hostTextSchema(80).optional(),
  body: hostTextSchema(240).optional(),
  path: LinkMailPath.optional(),
});
export type LinkMail = z.infer<typeof LinkMail>;

/** Whether a `LinkMail` has the members its kind needs and none of the other's (what control checks). */
export function linkMailComplete(mail: LinkMail): boolean {
  if (mail.kind === 'waiting')
    return (
      mail.count !== undefined &&
      mail.cadence !== undefined &&
      mail.title === undefined &&
      mail.body === undefined
    );
  return (
    mail.title !== undefined &&
    mail.body !== undefined &&
    mail.count === undefined &&
    mail.cadence === undefined
  );
}

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
  /**
   * This box's Link state, as `ticket.issue` carries it. A box control doesn't know is refused `unknown_device`.
   * `claimLink` (4.13): the six letters of the box's claim link (`https://<host>/c/<letters>`), sent only while nobody
   * claimed the box and its own address serves its page. Control keeps the last one and shows the link only to the
   * account the box is linked to (`LinkedBox.claimUrl`), so the person who just linked it opens the claim directly;
   * a request without it makes control forget the one it had. A secret: never logged, never in an audit record. A
   * control before 4.13 refuses the member (strict body), so a box sends it only to a control on 4.13.
   */
  'link.status': {
    body: z.strictObject({ claimLink: OwnAddressClaimSecret.optional() }),
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
  /**
   * The other Whombats linked to the same account as this box (4.14), for the menu under the box's name: an answer only
   * while this box's Link runs (`on`, `grace`, or `starting` once confirmed); otherwise, and for a box in no account,
   * an empty list. Never this box itself, never another account's. Reads only; its own budget of 120 an hour.
   */
  'link.whombats': {
    body: z.strictObject({}),
    response: z.object({ whombats: z.array(LinkWhombat).max(LINK_WHOMBATS_MAX) }),
  },
  /**
   * The owner's choices for email through Link (4.15): control keeps them for this box, the latest wins. Send them when
   * they change and whenever control may not have them (a start, Link on again). Control emails that a box went quiet
   * only for a box that sent `offline: true`, and sends `mail.send` only for one that sent `notifications: true`.
   * Accepted in any Link state but `off` (the box sends nothing then).
   */
  'link.mail.set': {
    body: z.strictObject({ offline: z.boolean(), notifications: z.boolean() }),
    response: Ok,
  },
  /**
   * One email to the Link account's own address (4.15), the only recipient there is: the box names none. Control
   * writes the email from its own words around these few facts, with a button to the box's own address. Needs Link on
   * or in grace (`link_off`); a `notice` also after Link ended, as a `security` push does. Refused when the box's
   * choices say no (`mail_off`, 409), when the box is in no account (`no_account`, 409), and beyond `LINK_MAIL_PER_DAY`
   * a day (`rate_limited`). A ref control already sent answers `ok` again without a second email.
   */
  'mail.send': {
    body: LinkMail,
    response: Ok,
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
