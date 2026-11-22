/**
 * Whombat Link and the update channel on the manager socket (4.4; Whombat docs/decisions/whombat-link.md).
 * Cross-language (Go package `local`).
 *
 * The manager keeps the box's Link state, learnt from every `ticket.issue` answer and from `link.begin`, `link.status`
 * and `link.leave`; the runtime reads it at start and every `LINK_STATE_POLL_S` (and after its own changes) and shows
 * it in Reach, on the screen and in notices. Turning Link on or off is the owner's, through the runtime. The update
 * channel is a root-owned helper setting the manager changes only when the runtime asks for the owner. A phone's push
 * token goes to control through the manager (`push.register`, `push.unregister`, the device ops' own schemas). An older
 * manager answers 404 on these paths: the runtime reads that as “no Link here” and “no channel to choose”.
 */
import { LinkCode, LinkPageUrl, LinkState, OwnAddressClaimSecret, OwnAddressLabel } from '@whombat/protocol';
import { hostTextSchema, LocalIdent as ident, Rfc3339 } from '@whombat/protocol/session';
import { SignatureHex, UpdateChannel } from '@whombat/release';
import { z } from 'zod';
import { AccountEmail } from '../device/address.js';
import { DEVICE_OPS } from '../device/ops.js';

const V = z.literal(1);

/** How often the runtime reads `linkState`, in seconds (and once at start, and after `linkOn`/`linkOff`). */
export const LINK_STATE_POLL_S = 300;

/** `LocalError` codes of the Link and channel routes (with `control_unreachable` 503 and `control_refused` 502). */
export const LINK_ERRORS = [
  /** 404: this image has no Link (a development stand-in without control). */
  'link.unavailable',
  /** 409: a Link change is already running. */
  'link.busy',
  /** 409 (`linkOn`): control holds another device with this box's keys or id. */
  'link.device_exists',
  /** 429 (`linkOn`): control's limit on new codes; try again later. */
  'link.rate_limited',
  /** 404: this manager can't choose an update channel. */
  'update.channel_unavailable',
] as const;

/** The code to show while Link starts, and where to type it. */
export const LocalLinkPending = z.object({ code: LinkCode, url: LinkPageUrl, expiresAt: Rfc3339 });
export type LocalLinkPending = z.infer<typeof LocalLinkPending>;

/** The box's Link state as the manager keeps it: control's `DeviceLinkStatus` with RFC 3339 times. */
export const LocalLinkStatus = z.object({
  state: LinkState,
  since: Rfc3339,
  pending: LocalLinkPending.optional(),
  waitingForAddress: z.boolean().optional(),
  graceEndsAt: Rfc3339.optional(),
  trialEndsAt: Rfc3339.optional(),
  label: OwnAddressLabel.optional(),
  email: AccountEmail.optional(),
  /** When the manager last heard it from control; absent before it ever did. */
  checkedAt: Rfc3339.optional(),
});
export type LocalLinkStatus = z.infer<typeof LocalLinkStatus>;

/** `POST /v1/link/state`. */
export const LinkStateRequest = z.strictObject({ v: V });
/** The answer of `linkState`, `linkOn` and `linkOff`. `enabled` false: no Link in this image, `link` is `off`. */
export const LinkStateResponse = z.object({ v: V, enabled: z.boolean(), link: LocalLinkStatus });
export type LinkStateResponse = z.infer<typeof LinkStateResponse>;

/**
 * `POST /v1/link/on` (the owner's): the manager sends `link.begin` with the box's registration. The manager holds no
 * content key, so the runtime signs the registration's bytes (`registrationSigningBytes` over `device.json`'s
 * members) with the content key and sends that signature as `contentProof`; the manager adds its own `proof`. `name`
 * is the box's name for the confirm page, when it has one.
 */
export const LinkOnRequest = z.strictObject({
  v: V,
  contentProof: SignatureHex,
  name: hostTextSchema(64).optional(),
});
/** `POST /v1/link/off` (the owner's): the manager sends `link.leave` and forgets the code. */
export const LinkOffRequest = z.strictObject({ v: V });

/**
 * `POST /v1/link/claim` (4.13) → `LocalOk`: the claim link the box shows now, for the manager to send with `link.status`
 * (`claimLink`), so control can open the claim for the account that linked the box. The runtime sends it while nobody
 * claimed the box and its own address serves its page, again when it changes, and without `claimLink` once there is
 * none (claimed, or no page). The manager keeps it in memory only and calls control at once when it changed; the
 * runtime sends it again now and then, so a manager that restarted has it back. An older manager answers 404.
 */
export const LinkClaimRequest = z.strictObject({ v: V, claimLink: OwnAddressClaimSecret.optional() });
export type LinkClaimRequest = z.infer<typeof LinkClaimRequest>;

/**
 * The update channel. `staysOn`: the box runs a release newer than its channel's newest (it just moved from
 * development to production) and keeps it until the channel passes it.
 */
export const UpdateChannelResponse = z.object({
  v: V,
  channel: UpdateChannel,
  staysOn: ident(80).optional(),
});
export type UpdateChannelResponse = z.infer<typeof UpdateChannelResponse>;
/** `POST /v1/update/channel`: a read. */
export const UpdateChannelRequest = z.strictObject({ v: V });
/** `POST /v1/update/channel/set` (the owner's): the manager asks the helper and answers the setting it now has. */
export const UpdateChannelSetRequest = z.strictObject({ v: V, channel: UpdateChannel });

/** `POST /v1/runtime/push/register` and `/unregister`: the device ops' own schemas. */
export const RuntimePushRegisterRequest = DEVICE_OPS['push.register'].body;
export const RuntimePushRegisterResponse = DEVICE_OPS['push.register'].response;
export const RuntimePushUnregisterRequest = DEVICE_OPS['push.unregister'].body;
export const RuntimePushUnregisterResponse = DEVICE_OPS['push.unregister'].response;
