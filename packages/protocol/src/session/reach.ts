/**
 * Reach and Updates in Settings → This Whombat (4.4; Whombat docs/decisions/whombat-link.md): how the box is reached
 * (Whombat Link, its own address, Tailscale), the owner turning Link on or off, the update channel, and the phone
 * handing its push token to the box, which registers it at control while Link is on. All additions: a box before 4.4
 * answers `unknown_op`, which an app reads as “no Link or channel on this Whombat yet”.
 */
import { Email, Timestamp } from '@whombat/core/domain';
import { AccountId } from '@whombat/core/ids';
import { ReleaseId, UpdateChannel } from '@whombat/release';
import { z } from 'zod';
import { LinkCode, LinkPageUrl, LinkState, NativePushToken } from '../link.js';
import { OwnAddressHost } from '../own-address.js';
import { OwnAddressSummary } from './own-address.js';
import { TailscaleStatus } from './tailscale.js';

/** The code to show while Link starts, and where the person types it. */
export const LinkPendingSummary = z.object({ code: LinkCode, url: LinkPageUrl, expiresAt: Timestamp });
export type LinkPendingSummary = z.infer<typeof LinkPendingSummary>;

/**
 * Email through Whombat Link (4.15; whombat-link.md, link-email.md): the owner's two choices. `offline` (on unless the
 * owner turned it off): Whombat Link emails the Link account when it stops hearing from this box. `notifications` (off
 * unless the owner turned it on): this box's notification emails and notices go out through Whombat Link, to the Link
 * account's address, saying how many things wait, never what they are. Kept on the box in any Link state; they do
 * something only while Link runs, and a mail server of the owner's own still sends the notification emails itself.
 */
export const LinkMailSummary = z.object({ offline: z.boolean(), notifications: z.boolean() });
export type LinkMailSummary = z.infer<typeof LinkMailSummary>;

/**
 * The box's Link as the person's devices see it. `pending` only while it starts; `waitingForAddress` when the day's
 * new addresses ran out; `graceEndsAt` only in `grace`; `trialEndsAt` while the free month runs; `email` the account's.
 */
export const LinkSummary = z.object({
  state: LinkState,
  since: Timestamp,
  pending: LinkPendingSummary.optional(),
  waitingForAddress: z.boolean().optional(),
  graceEndsAt: Timestamp.optional(),
  trialEndsAt: Timestamp.optional(),
  email: Email.optional(),
  /** The owner's choices for email through Link (4.15); absent from a box before 4.15. */
  mail: LinkMailSummary.optional(),
});
export type LinkSummary = z.infer<typeof LinkSummary>;

/**
 * `reach.get` (any enrolled member): Reach in one answer. Each part is null when this box can't have it (no Link in
 * this image, no own address yet, no Tailscale).
 */
export const ReachGetInput = z.strictObject({});
export const ReachGetOutput = z.object({
  link: LinkSummary.nullable(),
  ownAddress: OwnAddressSummary.nullable(),
  tailscale: TailscaleStatus.nullable(),
});
export type ReachGetOutput = z.infer<typeof ReachGetOutput>;

/**
 * `link.on` (owners; audited `link.on`): start Link. The box asks control for a code and answers `starting` with it
 * (or the state control has, e.g. `on` for a box that was linked before). `link.off` (owners; audited `link.off`):
 * leave Link; the address comes back when it's turned on again. Refusals: `LINK_ERROR_CODES`.
 */
export const LinkOnInput = z.strictObject({});
export const LinkOffInput = z.strictObject({});
export const LinkOutput = z.object({ link: LinkSummary });
export type LinkOutput = z.infer<typeof LinkOutput>;

/**
 * `link.mail.set` (owners, 4.15; audited `link.mail_set`): change either choice (a member left out keeps its value),
 * answers Link with the choices now. The box tells control at once when control knows it, and again later when that
 * fails. A box before 4.15 answers `unknown_op`.
 */
export const LinkMailSetInput = z.strictObject({
  offline: z.boolean().optional(),
  notifications: z.boolean().optional(),
});

/**
 * Why `link.on` or `link.off` was refused (`error.details.code`). `whombat_` because `link_*` already names the device
 * links of 1.1.
 */
export const LINK_ERROR_CODES = [
  'whombat_link_unavailable',
  'whombat_link_busy',
  'whombat_link_rate_limited',
  'control_unreachable',
] as const;
export type LinkErrorCode = (typeof LINK_ERROR_CODES)[number];

/**
 * `link.whombats` (any enrolled member, 4.14): the other Whombats linked to the same Whombat Link account as this one,
 * for the menu under the box's name. Each with its name (null until its owner named it), its Link state, its own
 * address once it has one, and when control last heard from it (control hears from a Whombat about once an hour, so
 * this says nothing about the last minutes). An empty list while this box's Link doesn't run, from a box or control
 * that can't tell, and when control can't be reached. A box before 4.14 answers `unknown_op`.
 */
export const LinkWhombatSummary = z.object({
  device: z.string().min(1).max(64),
  name: z.string().min(1).max(80).nullable(),
  state: LinkState,
  host: OwnAddressHost.nullable(),
  lastSeenAt: Timestamp.nullable(),
});
export type LinkWhombatSummary = z.infer<typeof LinkWhombatSummary>;
export const LinkWhombatsInput = z.strictObject({});
export const LinkWhombatsOutput = z.object({ whombats: z.array(LinkWhombatSummary).max(100) });
export type LinkWhombatsOutput = z.infer<typeof LinkWhombatsOutput>;

/**
 * `updates.channel.get` (any enrolled member) and `updates.channel.set` (owners; audited `update.channel_set`): the
 * channel the box takes its updates from. `staysOn`: the box moved from development to production and keeps this
 * newer release until production passes it (the page says so). `update_channel_unavailable` on a box that can't choose.
 */
export const UpdatesChannelGetInput = z.strictObject({});
export const UpdatesChannelSetInput = z.strictObject({ channel: UpdateChannel });
export const UpdatesChannelOutput = z.object({ channel: UpdateChannel, staysOn: ReleaseId.optional() });
export type UpdatesChannelOutput = z.infer<typeof UpdatesChannelOutput>;

/**
 * `push.token.set` (any enrolled device, for itself): the phone app's APNs or FCM token. The box keeps it for this
 * device and registers it at control while Link is on (`registered`); otherwise it waits and registers it once Link
 * is on. `push.token.clear`: this device wants no more pushes through the box (the box unregisters it). The box does
 * the same when the device is removed.
 */
export const PushTokenSetInput = z.strictObject({ token: NativePushToken });
export const PushTokenSetOutput = z.object({ registered: z.boolean() });
export type PushTokenSetOutput = z.infer<typeof PushTokenSetOutput>;
export const PushTokenClearInput = z.strictObject({});

/** Payload of `link.on`, `link.off` (who) and `link.state_changed` (control moved it: no account). */
export const LinkAuditPayload = z.object({ byAccountId: AccountId.optional(), state: LinkState });
export type LinkAuditPayload = z.infer<typeof LinkAuditPayload>;

/** Payload of `link.mail_set` (4.15): who, and both choices as they are now. */
export const LinkMailAuditPayload = z.object({
  byAccountId: AccountId,
  offline: z.boolean(),
  notifications: z.boolean(),
});
export type LinkMailAuditPayload = z.infer<typeof LinkMailAuditPayload>;

/** Payload of `update.channel_set`: who chose which channel. */
export const UpdateChannelAuditPayload = z.object({ byAccountId: AccountId, channel: UpdateChannel });
export type UpdateChannelAuditPayload = z.infer<typeof UpdateChannelAuditPayload>;
