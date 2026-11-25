/**
 * The device API (`POST /v1/device/<op>` with a `DeviceRequestEnvelope` body): what the manager may ask
 * control. Every body and response is cross-language (JSON Schema + Go bindings).
 */
import { ClaimLookup, CompactJws, LicenceToken, RelayClass, TicketChannel } from '@whombat/protocol';
import { EpochSeconds, ReleaseId, SignedAssignment } from '@whombat/release';
import { z } from 'zod';
import { ClaimId, RelayWorkerId, ServiceUrl } from '../common.js';
import { ADDRESS_DEVICE_OPS } from './address.js';
import { FEEDBACK_DEVICE_OPS } from './feedback.js';
import { KitEnvelopesPush, KitEnvelopesStored } from './kit.js';
import { DeviceLinkStatus, LINK_DEVICE_OPS } from './link.js';
import { PushRequest, PushResult } from './push.js';
import { SHARE_DEVICE_OPS } from './share.js';
import { DeviceStatusReport, RevocationReport, UpdateProgressReport } from './status.js';
import { TEAM_REPORTS_DEVICE_OPS } from './team-reports.js';

/** Where a connection should go: the assigned worker's URL (control assigns; the relay enforces `wrk`). */
export const RelayAssignment = z.object({
  worker: RelayWorkerId,
  url: ServiceUrl,
  /** Ask again (new ticket) after this time, or on 4503 draining. */
  reassignAfter: EpochSeconds,
});
export type RelayAssignment = z.infer<typeof RelayAssignment>;

export const TicketResponse = z.object({
  ticket: CompactJws,
  expiresAt: EpochSeconds,
  relay: RelayAssignment,
  channel: TicketChannel,
  /**
   * The box's Link state (4.4; Whombat whombat-link.md), in `ticket.issue` answers only: the manager keeps it for the
   * runtime. Absent from an older control, and from `support.ticket` and client tickets.
   */
  link: DeviceLinkStatus.optional(),
});
export type TicketResponse = z.infer<typeof TicketResponse>;

const Ok = z.object({ ok: z.literal(true) });

export const DEVICE_OPS = {
  /** Appliance ticket for the control connection and its data connections (until `exp`). */
  'ticket.issue': {
    body: z.strictObject({ class: RelayClass }),
    response: TicketResponse,
  },
  /** The claim completed on the appliance (MA-04 §3): control marks the device claimed by the pending claim's org. */
  'claim.claimed': {
    /**
     * `claimId`: the pending claim the enrolling client presented in `enroll.claim` (CT-27); control completes exactly
     * that claim (anti-squatting), or answers `claim_unknown`.
     */
    body: z.strictObject({ claimId: ClaimId, claimedAt: EpochSeconds }),
    response: Ok,
  },
  /**
   * An unclaimed device leases its claim-code lookup number (CC-03): control hands out the lowest free number (4
   * digits, 5 once more than 5,000 leases are live) and keeps it for the same device on every renewal. Renew every
   * `renewAfterS`; the lease is released when the device is claimed or retired, or after 24 h without a renewal. A
   * claimed device gets `already_claimed`. Signed like every device op, so control also records the device's network
   * tag for `claims.nearby` (CC-04).
   */
  'claim.lookup': {
    body: z.strictObject({}),
    response: z.object({
      lookup: ClaimLookup,
      expiresAt: EpochSeconds,
      renewAfterS: z.number().int().min(30).max(86_400),
    }),
  },
  'status.report': {
    body: DeviceStatusReport,
    response: z.object({ ok: z.literal(true), nextReportS: z.number().int().min(60).max(86_400) }),
  },
  'revocations.report': {
    body: z.strictObject({ revocations: z.array(RevocationReport).min(1).max(100) }),
    response: Ok,
  },
  'push.send': {
    body: PushRequest,
    response: PushResult,
  },
  /** The device's current signed assignment (or none), polled independently of the runtime. */
  'update.assignment': {
    body: z.strictObject({
      current: ReleaseId,
      lastSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    }),
    /**
     * `assigned`: `assignment` is new for this device (verify it); `unchanged`: the device already holds the current
     * assignment (`assignment` null); `none`: control has no assignment for it (`assignment` null) — keep running
     * (CT-28). Check `assignmentResultValid`.
     */
    response: z.object({
      result: z.enum(['assigned', 'unchanged', 'none']),
      assignment: SignedAssignment.nullable(),
      nextCheckS: z.number().int().min(60).max(86_400),
    }),
  },
  'update.progress': {
    body: UpdateProgressReport,
    response: Ok,
  },
  /**
   * A fresh licence token for this device (LC-05): control builds the claims from the org's entitlement (a missing row
   * means the configured default) and signs with its current licence key; `now` is control's clock (the manager's
   * high-water mark, LC-06). A cancelled org still gets a token, with `state: 'cancelled'`. `renewAfterS` is
   * `LICENCE_RENEW_S` (86,400) while the org is `trialing` or `active`, `LICENCE_RENEW_UNPAID_S` (3,600) otherwise; the
   * manager adds ±10 % jitter. Refuses an unclaimed device (`device_unclaimed`), a retired one (`device_revoked`), a
   * device claimed over the org's `devicesAllowed` (`devices_allowed_reached`, LC-16) and more than 12 renewals per
   * hour per device (`rate_limited`). Audited as `licence.issued`.
   */
  'licence.renew': {
    body: z.strictObject({}),
    response: z.object({
      token: LicenceToken,
      expiresAt: EpochSeconds,
      renewAfterS: z.number().int().min(60).max(86_400),
      now: EpochSeconds,
    }),
  },
  /** The encrypted feedback drop (Whombat FD-20, CT-91): `feedback.cards.sync`, `feedback.drops.pull`, `.ack`. */
  'feedback.cards.sync': FEEDBACK_DEVICE_OPS['feedback.cards.sync'],
  'feedback.drops.pull': FEEDBACK_DEVICE_OPS['feedback.drops.pull'],
  'feedback.drops.ack': FEEDBACK_DEVICE_OPS['feedback.drops.ack'],
  /** Reporter sign-in (Whombat FR-*, CT-164): the status of signed-in reporters' reports for “Your reports”. */
  'feedback.reporters.publish': FEEDBACK_DEVICE_OPS['feedback.reporters.publish'],
  /**
   * Remote help (0.120, CT-945; Whombat remote-help.md RH-06): an appliance ticket for the device's **support route**, a
   * second opaque route id control keeps per device (made on the first call) — `rol: 'appliance'`, `apl` that route,
   * `sub` the device, `org` its org, `chn: 'app'`, class `interactive`. The support service dials the relay with it only
   * while a grant is active. Refuses an unclaimed device (`device_unclaimed`), a retired one (`device_revoked`) and more
   * than 60 a minute per device (`rate_limited`). It opens nothing by itself: the box still checks the certificate, the
   * grant and the help code (RH-05).
   */
  'support.ticket': {
    body: z.strictObject({}),
    response: TicketResponse,
  },
  /**
   * The box's passkey-locked backup details (Whombat backup-passkey.md, `kit.ts`), signed like `status.report`: control
   * resolves the appliance from the device, keeps only envelopes of passkeys registered for it, upserts one per
   * (appliance, credential id) keeping the newest, and answers how many it kept and skipped. `adoptedFrom` feeds the kit
   * drop rule. An unclaimed device keeps nothing and is told so as a normal answer, `{stored: 0, skipped: n}` (no
   * passkey is its yet); a retired one is refused (`device_revoked`). Control also takes it at
   * `PUT /v1/device/kit-envelopes`. Since 4.3 it also keeps envelopes of the box's own passkeys that the box declared
   * (`kit.credentials.declare`), and names the skipped ones (`skippedCredentialIds`).
   */
  'kit.envelopes.put': {
    body: KitEnvelopesPush,
    response: KitEnvelopesStored,
  },
  /** Shared links (Whombat share-links.md): `share.put`, `share.delete`, `share.views`. */
  'share.put': SHARE_DEVICE_OPS['share.put'],
  'share.delete': SHARE_DEVICE_OPS['share.delete'],
  'share.views': SHARE_DEVICE_OPS['share.views'],
  /**
   * The box's own address (4.3; Whombat own-address.md): `address.register`, `address.check` and `address.rename`
   * (4.16), `account.link.lookup`, `account.link`, `kit.credentials.declare`.
   */
  'address.register': ADDRESS_DEVICE_OPS['address.register'],
  // Choosing and changing the name (4.16).
  'address.check': ADDRESS_DEVICE_OPS['address.check'],
  'address.rename': ADDRESS_DEVICE_OPS['address.rename'],
  'account.link.lookup': ADDRESS_DEVICE_OPS['account.link.lookup'],
  'account.link': ADDRESS_DEVICE_OPS['account.link'],
  'kit.credentials.declare': ADDRESS_DEVICE_OPS['kit.credentials.declare'],
  /**
   * Whombat Link (4.4; Whombat whombat-link.md): `link.begin`, `link.status`, `link.leave`, a phone's push token through
   * the box (`push.register`, `push.unregister`), remote help's `support.heartbeat`, and the account's other Whombats
   * (`link.whombats`, 4.14).
   */
  'link.begin': LINK_DEVICE_OPS['link.begin'],
  'link.status': LINK_DEVICE_OPS['link.status'],
  'link.leave': LINK_DEVICE_OPS['link.leave'],
  'link.whombats': LINK_DEVICE_OPS['link.whombats'],
  // Email through Link (4.15): the owner's choices, and one email to the Link account's own address.
  'link.mail.set': LINK_DEVICE_OPS['link.mail.set'],
  'mail.send': LINK_DEVICE_OPS['mail.send'],
  'push.register': LINK_DEVICE_OPS['push.register'],
  'push.unregister': LINK_DEVICE_OPS['push.unregister'],
  'support.heartbeat': LINK_DEVICE_OPS['support.heartbeat'],
  /**
   * Reports to the Whombat Team (4.18; Whombat team-reports.md): the person's reports and the team's answers, kept at
   * control: `team.reports.list`, `.get`, `.create`, `.reply`, `.act`.
   */
  'team.reports.list': TEAM_REPORTS_DEVICE_OPS['team.reports.list'],
  'team.reports.get': TEAM_REPORTS_DEVICE_OPS['team.reports.get'],
  'team.reports.create': TEAM_REPORTS_DEVICE_OPS['team.reports.create'],
  'team.reports.reply': TEAM_REPORTS_DEVICE_OPS['team.reports.reply'],
  'team.reports.act': TEAM_REPORTS_DEVICE_OPS['team.reports.act'],
} as const;

export type DeviceOp = keyof typeof DEVICE_OPS;
export const DeviceOpName = z.enum(Object.keys(DEVICE_OPS) as [DeviceOp, ...DeviceOp[]]);
export const DEVICE_API_PATH = (op: DeviceOp) => `/device/${op}`;

/** `assignment` is present exactly when `result` is `assigned`. */
export function assignmentResultValid(r: { result: string; assignment: unknown }): boolean {
  return (r.result === 'assigned') === (r.assignment !== null);
}
