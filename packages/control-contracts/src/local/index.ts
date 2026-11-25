/**
 * `@whombat/control-contracts/local` — appliance-local IPC between the runtime and the manager (CT-23),
 * cross-language (JSON Schema + Go package `local`). Two unix-socket HTTP/1.1 APIs, JSON bodies:
 *
 * - **Manager socket** (manager listens, runtime calls; `WHOMBAT_MANAGER_SOCKET`, peer uid = runtime):
 *   `POST /v1/runtime/ticket`, `POST /v1/runtime/claimed`, `POST /v1/runtime/revocations`, `POST /v1/runtime/push`.
 *   The manager turns them into device-signed control requests (it holds the management key; the runtime never
 *   talks to control). Also the AI clients (CT-73): `GET /v1/clients`, `POST /v1/clients/install|remove`; and
 *   `POST /v1/licence/renew` (LC-08, CT-77); the feedback drop (Whombat FD-21, CT-91): `POST /v1/runtime/feedback/cards`,
 *   `POST /v1/runtime/feedback/pull`, `POST /v1/runtime/feedback/ack`; reporter sign-in (CT-164):
 *   `POST /v1/runtime/feedback/reporters`; the passkey-locked backup details: `POST /v1/backup/kit-envelopes`; the
 *   box's measurements (CT-334): `POST /v1/host/metrics`; its hardware and
 *   network (0.102, CT-573): `POST /v1/host/hardware`, `POST /v1/network/state`, `POST /v1/network/wifi/scan|join|forget`;
 *   Tailscale (1.0, CT-1255): `POST /v1/tailscale/state|on|off|sign-in|cert`; its other devices (3.11, CT-1635):
 *   `POST /v1/tailscale/peers`; the own address (4.3, `own-address.ts`): `POST /v1/own-address/state|register|cert|ct`
 *   and (4.16) `check|rename`,
 *   `POST /v1/runtime/account/link-lookup|link`, `POST /v1/backup/kit-credentials`; Whombat Link (4.4, `link.ts`):
 *   `POST /v1/link/state|on|off`, `POST /v1/update/channel`, `/v1/update/channel/set`,
 *   `POST /v1/runtime/push/register|unregister`.
 * - **Admin socket** (runtime listens, manager and backup service call; `WHOMBAT_ADMIN_SOCKET`,
 *   `/run/whombat/admin.sock`, peer uid = manager or backup): `GET /health`, `POST /drain`, `POST /resume`,
 *   `POST /claim-window`, `POST /claim-lookup`, `POST /facts`, `POST /clients`, `POST /licence`. Bodies carry `v: 1`.
 * - **Console file** (runtime writes, `whombat-console` reads; `WHOMBAT_CONSOLE_FILE`): `ConsoleState` (CC-08).
 * - **Desk socket** (0.100, runtime listens, the console server calls; `WHOMBAT_DESK_SOCKET`): `DESK_PATHS`, `DeskState`
 *   and the screen's few requests (`desk.ts`, CT-528).
 * - **Voice socket** (0.100, `whombat-voice` listens, the runtime calls; `WHOMBAT_VOICE_SOCKET`): `VOICE_PATHS` (`voice.ts`,
 *   CT-532).
 * - **Voice models socket** (3.1, `whombat-voice-models` listens, the runtime calls; `WHOMBAT_VOICE_MODELS_SOCKET`):
 *   `VOICE_MODELS_PATHS` (`voice-models.ts`): the speech models, fetched after the box is installed.
 * - **Presence socket** (0.103, `whombat-presence` listens, the runtime calls; `WHOMBAT_PRESENCE_SOCKET`):
 *   `PRESENCE_PATHS` (`presence.ts`, CT-597): whether the camera sees someone in front of the desk screen.
 * - **Support socket** (0.120, `whombat-support` listens, the runtime and the manager call; `WHOMBAT_SUPPORT_SOCKET`):
 *   `SUPPORT_PATHS` (`support.ts`, CT-938): remote help's grant, visits and events.
 *
 * Times are RFC 3339 strings (Go's `time.Time` JSON). Errors: HTTP 4xx/5xx with `LocalError`; `POST /drain` answers
 * 409 with `LocalError{code: 'busy'}` while another caller's drain holds the runtime; `POST /licence` answers 409
 * `stale` for an older token; `POST /v1/licence/renew` answers 429 `busy` within 60 s of the last forced renewal.
 * `GET /health` answers 200 or 503, both with a `RuntimeHealth` body. Responses are tolerant (unknown members
 * stripped), requests strict.
 */

import { LinkCode, LinkPageUrl, LinkState } from '@whombat/protocol';
import { ClaimLetters, ClaimLookup, ScreenSignInLetters } from '@whombat/protocol/claim';
import { LicencePlan, LicenceReason, LicenceState, LicenceToken } from '@whombat/protocol/licence';
import {
  AsciiText as ascii,
  CableChange,
  CableUse,
  HostHardware,
  HostMetrics,
  HostMetricsRange,
  HostNetwork,
  hostTextSchema,
  IpAddress,
  LocalIdent as ident,
  NetworkChange,
  Rfc3339,
  Ssid,
  TAILSCALE_ADDRESSES_MAX,
  TailscaleLoginServer,
  TailscaleLoginUrl,
  TailscaleName,
  TailscaleStatus,
  TimeZoneName,
  WifiPassphrase,
  WifiScan,
} from '@whombat/protocol/session';
import {
  ClientAdapterLevel,
  ClientFloor,
  ClientProvider,
  Digest,
  ReleaseId,
  Sha256Hex,
  UpdateFailureDetail,
  UpdateJournalState,
  UpdateWaitReason,
  VersionString,
} from '@whombat/release';
import { z } from 'zod';
import { DEVICE_OPS } from '../device/ops.js';
import { PushRequest, PushResult } from '../device/push.js';

export { Rfc3339 };

export const LOCAL_API_VERSION = 1;
const V = z.literal(LOCAL_API_VERSION);
const Ms = z.number().int().min(0).max(86_400_000);

export const LocalError = z.object({
  error: z.object({
    /** `bad_request`, `forbidden`, `busy`, `unavailable`, `internal`, … */
    code: ident(),
    /** For logs on the appliance; free text (printable ASCII). */
    message: ascii(500, 0),
    /** Backup `checkpoint_failed`: where it failed. */
    stage: z.enum(['preflight', 'quiesce', 'snapshot', 'dump', 'upload', 'verify']).optional(),
  }),
});
export type LocalError = z.infer<typeof LocalError>;

/* Manager socket: runtime → manager ------------------------------------------------------------ */

export const MANAGER_PATHS = {
  ticket: '/v1/runtime/ticket',
  claimed: '/v1/runtime/claimed',
  revocations: '/v1/runtime/revocations',
  push: '/v1/runtime/push',
  /** GET; runtime and lock holders. */
  updateStatus: '/v1/update/status',
  /**
   * Runtime (the owner's, 4.2; Whombat ask-before-updating.md): `UpdateAskRequest` → `UpdateAskResponse`, whether every
   * update waits for the owner's approval before it installs. The manager keeps it in its own journal and enforces it.
   */
  updateAsk: '/v1/update/ask',
  /**
   * Runtime (the owner's, 4.2): `UpdateApproveRequest` → `UpdateApproveResponse`, the owner's approval of the one
   * release waiting for it. 409 `not_waiting` when no update waits for the owner or another release does.
   */
  updateApprove: '/v1/update/approve',
  /** Lock holders (the backup service). */
  lock: '/v1/maintenance/lock',
  unlock: '/v1/maintenance/unlock',
  /** Runtime (network changes the person asked for, MG-15). */
  networkCandidates: '/v1/network/candidates',
  /** GET; runtime. */
  networkStatus: '/v1/network/status',
  /** GET; runtime: `LocalClientsStatus` (CT-73). */
  clients: '/v1/clients',
  /** Runtime (the person's `clients.install`): `ClientInstallRequest`. */
  clientsInstall: '/v1/clients/install',
  /** Runtime (the person's `clients.remove`): `ClientRemoveRequest`. */
  clientsRemove: '/v1/clients/remove',
  /** Runtime (the person's `licence.refresh`, LC-08): `LicenceRenewNowRequest` → `LicenceRenewNowResult`. */
  licenceRenew: '/v1/licence/renew',
  /**
   * Runtime (managed feedback, FD-21): the device ops `feedback.cards.sync`, `feedback.drops.pull` and
   * `feedback.drops.ack`, bodies and answers exactly theirs; the manager signs, forwards and answers control's body
   * verbatim. It accepts request bodies up to `FEEDBACK_CARDS_SYNC_MAX_BYTES` (cards) and 64 KiB (pull, ack), and
   * control answers up to `FEEDBACK_PULL_RESPONSE_MAX_BYTES` (pull) and 1 MiB (cards, ack). While control is
   * unreachable: 503 `LocalError{code: 'unavailable'}`; when control refuses the op (400 `bad_envelope`, or 404
   * `feedback_drop_off` while the drop is off): 501 `unsupported`; control's other refusals as for push (502
   * `control_refused`).
   */
  feedbackCards: '/v1/runtime/feedback/cards',
  feedbackPull: '/v1/runtime/feedback/pull',
  feedbackAck: '/v1/runtime/feedback/ack',
  /**
   * Runtime (managed feedback, reporter sign-in, CT-164): the device op `feedback.reporters.publish`, body and answer
   * exactly its own, the same forwarding and error mapping as the three above (request bodies up to 64 KiB, answers up
   * to 1 MiB).
   */
  feedbackReporters: '/v1/runtime/feedback/reporters',
  /**
   * Runtime (Whombat backup-passkey.md): the device op `kit.envelopes.put`, body and answer exactly its own; the
   * manager signs and forwards it and answers control's body. While control is unreachable: 503
   * `LocalError{code: 'control_unreachable'}` (the runtime tries again later); control's refusals as for push (502
   * `control_refused`).
   */
  kitEnvelopes: '/v1/backup/kit-envelopes',
  /**
   * Runtime (Whombat share-links.md): the device ops `share.put`, `share.delete` and `share.views`, bodies and answers
   * exactly theirs; the manager signs and forwards them and answers control's body. It accepts request bodies up to
   * `SHARE_PUT_MAX_BYTES` (put) and 64 KiB (delete, views). While control is unreachable: 503
   * `LocalError{code: 'control_unreachable'}`; control's refusals as for push (502 `control_refused`, its code in the
   * message).
   */
  sharePut: '/v1/runtime/shares/put',
  shareDelete: '/v1/runtime/shares/delete',
  shareViews: '/v1/runtime/shares/views',
  /**
   * Runtime (Whombat team-reports.md): the device ops `team.reports.list`, `.get`, `.create`, `.reply` and `.act`,
   * bodies and answers exactly theirs; the manager signs and forwards them and answers control's body. It accepts
   * request bodies up to 64 KiB and control's answers up to `TEAM_PAYLOAD_ANSWER_MAX_BYTES` and a little. While control
   * is unreachable: 503 `LocalError{code: 'control_unreachable'}`; control's refusals as for shares (502
   * `control_refused`, its code first in the message).
   */
  teamReportsList: '/v1/runtime/team-reports/list',
  teamReportsGet: '/v1/runtime/team-reports/get',
  teamReportsCreate: '/v1/runtime/team-reports/create',
  teamReportsReply: '/v1/runtime/team-reports/reply',
  teamReportsAct: '/v1/runtime/team-reports/act',
  /**
   * Runtime (`host.metrics`, CT-334): `HostMetricsRequest` → `HostMetricsResponse`, the manager's processor,
   * memory, disk and network measurements. A read: at most a few a second, answered from memory.
   */
  hostMetrics: '/v1/host/metrics',
  /**
   * Runtime (`host.hardware`, 0.102, CT-573): `HostHardwareRequest` → `HostHardwareResponse`, the hardware
   * report collected when asked.
   */
  hostHardware: '/v1/host/hardware',
  /**
   * Runtime (`host.network` and the desk's network, 0.102, CT-573): `NetworkStateRequest` →
   * `NetworkStateResponse`, the cables, the Wi-Fi card, whether the box reached Whombat and the running change.
   */
  networkState: '/v1/network/state',
  /** Runtime: `WifiScanRequest` → `WifiScanResponse`, waiting at most 10 s for a fresh scan. */
  wifiScan: '/v1/network/wifi/scan',
  /** Runtime (the person's, guarded, MG-15): `WifiJoinRequest` → 202 `WifiChangeResponse`. */
  wifiJoin: '/v1/network/wifi/join',
  /** Runtime (the person's): `WifiForgetRequest` → 202 `WifiChangeResponse`. */
  wifiForget: '/v1/network/wifi/forget',
  /** Runtime (the person's, guarded, 3.13, CT-1644): `CableSetRequest` → 202 `CableChangeResponse`. */
  networkCable: '/v1/network/cable',
  /**
   * Root, the support service (0.120, CT-940; Whombat remote-help.md RH-06): `{}` → the device op `support.ticket`'s
   * `TicketResponse` (Go `device.SupportTicketResponse`), an appliance ticket for the device's support route; the
   * manager may answer from its cache until 60 s before `expiresAt`. Control's refusals pass through as `LocalError`
   * with their code (`device_unclaimed`, `device_revoked`, `rate_limited`); unreachable: 503 `unavailable`.
   */
  supportTicket: '/v1/support/ticket',
  /**
   * Runtime (Tailscale for This Whombat, 1.0, CT-1255; Whombat HE-51): the manager drives the box's Tailscale and is the
   * only caller of its local API. `tailscaleState`: `TailscaleStateRequest` → `TailscaleStateResponse`, a read answered
   * at once. `tailscaleOn` (`TailscaleOnRequest`), `tailscaleOff` (`TailscaleOffRequest`), `tailscaleSignIn`
   * (`TailscaleSignInRequest`), the person's: → `TailscaleStateResponse`, the status after the change (a login link
   * may follow in `tailscaleState`). `tailscaleCert`: `TailscaleCertRequest` → `TailscaleCertResponse`, the certificate
   * and key for the box's Tailscale name that the direct listener serves HTTPS with (asked at start and daily; 409
   * `tailscale.off` unless Tailscale is on, 409 `tailscale.no_https` when the tailnet has HTTPS certificates off). Errors:
   * 409 `tailscale.busy` while a change runs.
   */
  tailscaleState: '/v1/tailscale/state',
  tailscaleOn: '/v1/tailscale/on',
  tailscaleOff: '/v1/tailscale/off',
  tailscaleSignIn: '/v1/tailscale/sign-in',
  tailscaleCert: '/v1/tailscale/cert',
  /**
   * Runtime (3.11, CT-1635; Whombat tailnet-reach.md TN-06): the other devices on the box's tailnet, for the agent.
   * `TailscalePeersRequest` → `TailscalePeersResponse`, a read answered at once; no devices unless Tailscale is on.
   * Errors: 503 `unavailable` when tailscaled doesn't answer.
   */
  tailscalePeers: '/v1/tailscale/peers',
  /**
   * Runtime (the own address, 4.3; Whombat own-address.md, `own-address.ts`): `OwnAddressStateRequest` →
   * `OwnAddressStateResponse`, a read answered at once.
   */
  ownAddressState: '/v1/own-address/state',
  /**
   * Runtime: `OwnAddressRegisterRequest` → `OwnAddressStateResponse`, the manager registers the label at control
   * (`address.register`) and keeps it. 404 `own_address.off`; 409 `own_address.label_taken` or `.label_invalid`; 503
   * `control_unreachable`; 502 `control_refused`.
   */
  ownAddressRegister: '/v1/own-address/register',
  /** Runtime: `OwnAddressCertRequest` → `OwnAddressCertResponse`. 404 `own_address.off`; 409 `own_address.no_cert`. */
  ownAddressCert: '/v1/own-address/cert',
  /** Runtime: `OwnAddressCtRequest` → `OwnAddressCtResponse`. 404 `own_address.off`. */
  ownAddressCt: '/v1/own-address/ct',
  /**
   * Runtime (4.16): `OwnAddressCheckRequest` → `OwnAddressCheckResponse`, asked of control (`address.check`). 404
   * `own_address.off`; 409 `own_address.link_off`; 503 `control_unreachable`.
   */
  ownAddressCheck: '/v1/own-address/check',
  /**
   * Runtime (4.16): `OwnAddressRenameRequest` → `OwnAddressStateResponse`, the manager changes the name at control
   * (`address.rename`), keeps the earlier host as `leaving` and orders the new host's certificate. 404 `own_address.off`;
   * 409 `own_address.label_taken`, `.label_invalid`, `.label_reserved`, `.rename_limit`, `.link_off`; 503
   * `control_unreachable`.
   */
  ownAddressRename: '/v1/own-address/rename',
  /**
   * Runtime (4.3): the device ops `account.link.lookup` and `account.link`, bodies and answers exactly theirs; the
   * manager signs and forwards them and answers control's body, with the same error mapping as `kitEnvelopes`.
   */
  accountLinkLookup: '/v1/runtime/account/link-lookup',
  accountLink: '/v1/runtime/account/link',
  /** Runtime (4.3): the device op `kit.credentials.declare`, forwarded as `kitEnvelopes`. */
  kitCredentials: '/v1/backup/kit-credentials',
  /**
   * Runtime (Whombat Link, 4.4; Whombat whombat-link.md, `link.ts`): `LinkStateRequest` → `LinkStateResponse`, a read
   * answered at once from what the manager last heard from control.
   */
  linkState: '/v1/link/state',
  /**
   * Runtime (the owner's): `LinkOnRequest` → `LinkStateResponse`, after `link.begin` at control (`starting` with the
   * code to show, or the state control has). 404 `link.unavailable`; 409 `link.busy`, `link.device_exists`; 429
   * `link.rate_limited`; 503 `control_unreachable`; 502 `control_refused`.
   */
  linkOn: '/v1/link/on',
  /** Runtime (the owner's): `LinkOffRequest` → `LinkStateResponse` (`off`), after `link.leave`. Errors as `linkOn`. */
  linkOff: '/v1/link/off',
  /**
   * Runtime (4.13): `LinkClaimRequest` → `LocalOk`, answered at once. The claim link the box shows, which the manager
   * sends with `link.status`; without `claimLink` the manager forgets it.
   */
  linkClaim: '/v1/link/claim',
  /**
   * Runtime (4.14): the device op `link.whombats`, body and answer exactly its own (`RuntimeLinkWhombatsRequest`,
   * `RuntimeLinkWhombatsResponse`): the other Whombats linked to the same account, for the menu under the box's name.
   * 404 `link.unavailable` while Link doesn't run (or from an older manager); 503 `control_unreachable`; 502
   * `control_refused`.
   */
  linkWhombats: '/v1/link/whombats',
  /**
   * Runtime (4.15): the device op `link.mail.set`, body and answer its own (`RuntimeLinkMailSetRequest`): the owner's
   * choices for email through Link. 404 `unavailable` while control doesn't know the box (Link off, or an older
   * manager); 503 `unavailable` when control can't be reached; 502 `control_refused`.
   */
  linkMail: '/v1/link/mail',
  /**
   * Runtime (4.15): the device op `mail.send`, body and answer its own (`RuntimeMailSendRequest`): one email to the
   * Link account's own address. 404 `unavailable` while control doesn't know the box (Link off, or an older manager);
   * 503 `unavailable`; 502 `control_refused` (Link not running, the owner's choice says no, the day's limit).
   */
  mailSend: '/v1/runtime/mail',
  /** Runtime (4.4): `UpdateChannelRequest` → `UpdateChannelResponse`. 404 `update.channel_unavailable`. */
  updateChannel: '/v1/update/channel',
  /** Runtime (the owner's, 4.4): `UpdateChannelSetRequest` → `UpdateChannelResponse`. 409 `busy` while an update runs. */
  updateChannelSet: '/v1/update/channel/set',
  /**
   * Runtime (4.4): the device ops `push.register` and `push.unregister`, bodies and answers exactly theirs, forwarded
   * as `kitEnvelopes` (502 `control_refused` with control's code, e.g. `link_off`).
   */
  pushRegister: '/v1/runtime/push/register',
  pushUnregister: '/v1/runtime/push/unregister',
} as const;

/** An appliance admission ticket for the relay control/data connections (manager: device op `ticket.issue`). */
export const RuntimeTicketRequest = z.strictObject({ class: z.enum(['interactive', 'bulk']) });
export const RuntimeTicketResponse = z.object({
  /** Compact JWS; never logged. */
  ticket: z
    .string()
    .min(16)
    .max(4_096)
    .regex(/^[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$/),
  /** `wss://…/v1/connect` of the assigned worker. */
  relayUrl: z
    .string()
    .min(8)
    .max(256)
    .regex(/^(wss|ws):[/][/][\x21-\x7e]+$/),
  worker: ident(),
  expiresAt: Rfc3339,
});
export type RuntimeTicketResponse = z.infer<typeof RuntimeTicketResponse>;

/**
 * The claim completed (MA-04 §3); the manager reports `claim.claimed {claimId, claimedAt}` to control. `claimId` is
 * control's pending-claim id the enrolling client sent in `enroll.claim` (CT-27).
 */
export const RuntimeClaimedRequest = z.strictObject({
  claimId: z
    .string()
    .min(8)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
  claimedAt: Rfc3339,
});
/** An endpoint was revoked (MA-04 §6); the manager reports it as applied (`revocationRef(peerId)`). */
export const RuntimeRevocationRequest = z.strictObject({
  peerId: z.string().regex(/^12D3KooW[1-9A-HJ-NP-Za-km-z]{44}$/),
  revokedAt: Rfc3339,
});
export const LocalOk = z.object({ ok: z.literal(true) });
/** Content-free push (CT-11): the device API `push.send` body, forwarded as is. */
export const RuntimePushRequest = PushRequest;
export const RuntimePushResponse = PushResult;

/** The feedback drop through the manager (FD-21): the device ops' own schemas. */
export const RuntimeFeedbackCardsRequest = DEVICE_OPS['feedback.cards.sync'].body;
export const RuntimeFeedbackCardsResponse = DEVICE_OPS['feedback.cards.sync'].response;
export const RuntimeFeedbackPullRequest = DEVICE_OPS['feedback.drops.pull'].body;
export const RuntimeFeedbackPullResponse = DEVICE_OPS['feedback.drops.pull'].response;
export const RuntimeFeedbackAckRequest = DEVICE_OPS['feedback.drops.ack'].body;
export const RuntimeFeedbackAckResponse = DEVICE_OPS['feedback.drops.ack'].response;
/** The passkey-locked backup details through the manager (Whombat backup-passkey.md). */
export const RuntimeKitEnvelopesRequest = DEVICE_OPS['kit.envelopes.put'].body;
export const RuntimeKitEnvelopesResponse = DEVICE_OPS['kit.envelopes.put'].response;
/** `POST /v1/runtime/account/link-lookup` and `/link` (4.3): the device ops' own schemas. */
export const RuntimeAccountLinkLookupRequest = DEVICE_OPS['account.link.lookup'].body;
export const RuntimeAccountLinkLookupResponse = DEVICE_OPS['account.link.lookup'].response;
export const RuntimeAccountLinkRequest = DEVICE_OPS['account.link'].body;
export const RuntimeAccountLinkResponse = DEVICE_OPS['account.link'].response;
/** `POST /v1/backup/kit-credentials` (4.3): the device op `kit.credentials.declare`'s own schemas. */
export const RuntimeKitCredentialsRequest = DEVICE_OPS['kit.credentials.declare'].body;
export const RuntimeKitCredentialsResponse = DEVICE_OPS['kit.credentials.declare'].response;
/** Shared links through the manager (share-links.md): the device ops' own schemas. */
export const RuntimeSharePutRequest = DEVICE_OPS['share.put'].body;
export const RuntimeSharePutResponse = DEVICE_OPS['share.put'].response;
export const RuntimeShareDeleteRequest = DEVICE_OPS['share.delete'].body;
export const RuntimeShareDeleteResponse = DEVICE_OPS['share.delete'].response;
export const RuntimeShareViewsRequest = DEVICE_OPS['share.views'].body;
export const RuntimeShareViewsResponse = DEVICE_OPS['share.views'].response;

/** Reports to the Whombat Team through the manager (team-reports.md): the device ops' own schemas. */
export const RuntimeTeamReportsListRequest = DEVICE_OPS['team.reports.list'].body;
export const RuntimeTeamReportsListResponse = DEVICE_OPS['team.reports.list'].response;
export const RuntimeTeamReportsGetRequest = DEVICE_OPS['team.reports.get'].body;
export const RuntimeTeamReportsGetResponse = DEVICE_OPS['team.reports.get'].response;
export const RuntimeTeamReportsCreateRequest = DEVICE_OPS['team.reports.create'].body;
export const RuntimeTeamReportsCreateResponse = DEVICE_OPS['team.reports.create'].response;
export const RuntimeTeamReportsReplyRequest = DEVICE_OPS['team.reports.reply'].body;
export const RuntimeTeamReportsReplyResponse = DEVICE_OPS['team.reports.reply'].response;
export const RuntimeTeamReportsActRequest = DEVICE_OPS['team.reports.act'].body;
export const RuntimeTeamReportsActResponse = DEVICE_OPS['team.reports.act'].response;
/** Reporter statuses through the manager (CT-164). */
export const RuntimeFeedbackReportersRequest = DEVICE_OPS['feedback.reporters.publish'].body;
export const RuntimeFeedbackReportersResponse = DEVICE_OPS['feedback.reporters.publish'].response;

/* Manager socket: update status, maintenance lock, network changes (MG-11, MG-15) ------------------------------ */

/** `GET /v1/update/status`: the journal summarized for local callers. */
export const UpdateStatusResponse = z.object({
  state: UpdateJournalState,
  current: ident(80),
  knownGood: ident(80),
  candidate: ident(80).optional(),
  /** Why it waits or failed (printable ASCII). */
  explanation: ascii(500, 0).optional(),
  failure: ident().optional(),
  /** Control's assignment is `hold`. */
  hold: z.boolean(),
  /** The box's update channel is paused by its release key; absent when not paused. */
  paused: z.boolean().optional(),
  /** The known-good release can only read the database (a newer release migrated). */
  readOnly: z.boolean(),
});

/** Hold off update activation (and network changes) while a holder works; 409 `busy` while an update activates. */
export const MaintenanceLockRequest = z.strictObject({
  holder: ident(),
  reason: ident(),
  ttlS: z.number().int().min(1).max(21_600),
});
export const MaintenanceLock = z.object({
  holder: ident(),
  reason: ident(),
  since: Rfc3339,
  expires: Rfc3339,
});
export const MaintenanceUnlockRequest = z.strictObject({ holder: ident() });

/** A network change candidate (helper `netconfig`, MG-15); the helper validates addresses semantically. */
export const NetworkCandidate = z.strictObject({
  v: V,
  id: z.string().regex(/^n-[a-z0-9][a-z0-9-]{0,62}$/),
  interface: z.string().regex(/^(en|eth)[a-z0-9]{1,13}$/),
  ipv4: z.strictObject({
    mode: z.enum(['dhcp', 'static']),
    address: z
      .string()
      .regex(/^[0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}[/][0-9]{1,2}$/)
      .optional(),
    gateway: z
      .string()
      .regex(/^[0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}$/)
      .optional(),
  }),
  ipv6: z.strictObject({
    mode: z.enum(['auto', 'static', 'disabled']),
    address: z
      .string()
      .regex(/^[0-9a-fA-F:]{2,39}[/][0-9]{1,3}$/)
      .optional(),
    gateway: z
      .string()
      .regex(/^[0-9a-fA-F:]{2,39}$/)
      .optional(),
  }),
  dns: z.array(z.string().regex(/^[0-9a-fA-F:.]{2,45}$/)).max(4),
  mtu: z.number().int().min(576).max(9_216).optional(),
  confirmTimeoutSec: z.number().int().min(30).max(600),
});
export type NetworkCandidate = z.infer<typeof NetworkCandidate>;
export const NetworkPhase = z.enum(['applying', 'confirming', 'committed', 'reverting', 'reverted']);
export const NetworkSubmitResponse = z.object({ candidateId: ident(), phase: NetworkPhase });
export const NetworkStatus = z.object({
  candidateId: ident().optional(),
  phase: NetworkPhase.optional(),
  deadline: Rfc3339.optional(),
  /** What happened (printable ASCII). */
  result: ascii(300, 0).optional(),
  updatedAt: Rfc3339,
});

/* Manager socket: how the box is doing (CT-334) ---------------------------------------------------------------- */

/**
 * `POST /v1/host/metrics`: one range's points (only those starting at or after `since` when given) and the traffic per
 * day counted in `timeZone` (an IANA zone, the burrow's; the manager falls back to UTC for one it doesn't know).
 */
export const HostMetricsRequest = z.strictObject({
  v: V,
  range: HostMetricsRange,
  since: Rfc3339.optional(),
  timeZone: TimeZoneName,
});
export type HostMetricsRequest = z.infer<typeof HostMetricsRequest>;

export const HostMetricsResponse = z.object({ v: V, metrics: HostMetrics });
export type HostMetricsResponse = z.infer<typeof HostMetricsResponse>;

/* Manager socket: the box's hardware and network (0.102, CT-573) ----------------------------------------------- */

/** `POST /v1/host/hardware`: the hardware report (Whombat hardware-support.md HD-03), collected when asked. */
export const HostHardwareRequest = z.strictObject({ v: V });
export const HostHardwareResponse = z.object({ v: V, hardware: HostHardware });
export type HostHardwareResponse = z.infer<typeof HostHardwareResponse>;

/**
 * `POST /v1/network/state`: how the box is connected (HD-05, HD-10): wired from `/sys/class/net` and the addresses,
 * Wi-Fi from iwd, `online` from the guard's last check of control's endpoint (re-checked when older than 60 s).
 */
export const NetworkStateRequest = z.strictObject({ v: V });
export const NetworkStateResponse = z.object({ v: V, network: HostNetwork });
export type NetworkStateResponse = z.infer<typeof NetworkStateResponse>;

/** `POST /v1/network/wifi/scan`: the networks around the box; 409 `no_wifi` without a working Wi-Fi card. */
export const WifiScanRequest = z.strictObject({ v: V });
export const WifiScanResponse = z.object({ v: V, scan: WifiScan });
export type WifiScanResponse = z.infer<typeof WifiScanResponse>;

/**
 * `POST /v1/network/wifi/join`: join or switch to a network, guarded (HD-06, MG-15): when the box reached Whombat before
 * and can't within `confirmTimeoutSec` after joining, the new network is forgotten and the previous one comes back. The
 * passphrase is a secret: never logged, never in an answer. `ssid` must also pass `SsidValid` (32 UTF-8 bytes).
 */
export const WifiJoinRequest = z.strictObject({
  v: V,
  ssid: Ssid,
  passphrase: WifiPassphrase.optional(),
  hidden: z.boolean().optional(),
  confirmTimeoutSec: z.number().int().min(30).max(600),
});
export type WifiJoinRequest = z.infer<typeof WifiJoinRequest>;

/** `POST /v1/network/wifi/forget`: forget a saved network. */
export const WifiForgetRequest = z.strictObject({ v: V, ssid: Ssid });
export type WifiForgetRequest = z.infer<typeof WifiForgetRequest>;

/** 202 to a join or a forget: the change as it starts; `networkState` follows it. */
export const WifiChangeResponse = z.object({ v: V, change: NetworkChange });
export type WifiChangeResponse = z.infer<typeof WifiChangeResponse>;

/**
 * `POST /v1/network/cable` (3.13, CT-1644; Whombat network-move.md NM-01, NM-02): Wi-Fi only (`use: wifi`, the cables
 * keep their link but take no address) or the cable again (`use: cable`), guarded like a join: when the box reached
 * Whombat before and can't within `confirmTimeoutSec` after the change, it is undone. `LocalError` codes beyond
 * `bad_request` and `unavailable` are `CABLE_ERROR_CODES` (Go `local.CableError*`): 409 `busy`, `no_wifi`,
 * `not_connected`, `no_cable`, `unchanged`.
 */
export const CableSetRequest = z.strictObject({
  v: V,
  use: CableUse,
  confirmTimeoutSec: z.number().int().min(30).max(600),
});
export type CableSetRequest = z.infer<typeof CableSetRequest>;

/** 202 to a cable change: the change as it starts; `networkState` follows it (`cableChange`). */
export const CableChangeResponse = z.object({ v: V, change: CableChange });
export type CableChangeResponse = z.infer<typeof CableChangeResponse>;

/*
 * The Wi-Fi routes' `LocalError` codes beyond `bad_request` and `unavailable` are `WIFI_ERROR_CODES` of
 * `@whombat/protocol/session` (Go `local.WifiError*`): 409 `no_wifi`, 409 `busy` (a change is running, or the
 * maintenance lock is held), 409 `in_use`, 404 `not_saved`, 400 `invalid_passphrase`.
 */

/* Manager socket: Tailscale (1.0, CT-1255) ---------------------------------------------------------------------- */

/** `POST /v1/tailscale/state`: Tailscale on the box, as `host.tailscale` shows it. */
export const TailscaleStateRequest = z.strictObject({ v: V });
export const TailscaleStateResponse = z.object({ v: V, tailscale: TailscaleStatus });
export type TailscaleStateResponse = z.infer<typeof TailscaleStateResponse>;
/**
 * `POST /v1/tailscale/on`: turn it on (it comes back signed in, or needs a sign-in). `loginServer` (1.1, CT-1306; HE-64):
 * the coordination server to sign in to, absent for Tailscale's own. The runtime always sends the one wanted (from
 * `host.tailscale.on`, else the status's `loginServer`); when it differs from the one the box is signed in to, the manager
 * signs the box out of that tailnet first and keeps the new one across restarts.
 */
export const TailscaleOnRequest = z.strictObject({ v: V, loginServer: TailscaleLoginServer.optional() });
/** `POST /v1/tailscale/off`: turn it off; `signOut` also signs the box out of the tailnet. */
export const TailscaleOffRequest = z.strictObject({ v: V, signOut: z.boolean().optional() });
/** `POST /v1/tailscale/sign-in`: a fresh login link (sign in again, or as someone else). */
export const TailscaleSignInRequest = z.strictObject({ v: V });

/** A PEM document (certificate chain or private key): printable ASCII lines. */
const Pem = z
  .string()
  .min(64)
  .max(16_384)
  .regex(/^[\n\x20-\x7e]+$/);

/** `POST /v1/tailscale/cert`: the certificate the direct listener serves on the box's Tailscale name. */
export const TailscaleCertRequest = z.strictObject({ v: V });
/** `certPem`: the chain, leaf first; `keyPem`: its private key (a secret: never logged); `notAfter`: the leaf's end. */
export const TailscaleCertResponse = z.object({
  v: V,
  name: TailscaleName,
  certPem: Pem,
  keyPem: Pem,
  notAfter: Rfc3339,
});
export type TailscaleCertResponse = z.infer<typeof TailscaleCertResponse>;

/** A network a tailnet device routes for the others (a subnet router's), as CIDR (3.11, CT-1635). */
export const TailscaleRoute = z.string().regex(/^[0-9A-Fa-f:.]{2,45}[/][0-9]{1,3}$/);
/** At most this many devices in `TailscalePeersResponse`. */
export const TAILSCALE_PEERS_MAX = 500;
/**
 * One other device on the box's tailnet (3.11, CT-1635): its MagicDNS name without the dot (null when Tailscale gave none
 * the contract takes), its addresses (IPv4 first), its operating system as Tailscale names it, whether it is online,
 * when it was last seen (null: online now, or never), the networks it routes for the tailnet, and whether it offers
 * itself as an exit node.
 */
export const TailscalePeer = z.object({
  name: TailscaleName.nullable(),
  addresses: z.array(IpAddress).max(TAILSCALE_ADDRESSES_MAX),
  os: hostTextSchema(32).nullable(),
  online: z.boolean(),
  lastSeen: Rfc3339.nullable(),
  routes: z.array(TailscaleRoute).max(64),
  exitNode: z.boolean(),
});
export type TailscalePeer = z.infer<typeof TailscalePeer>;
/** `POST /v1/tailscale/peers`: the tailnet's other devices, as the agent may reach them (TN-06). */
export const TailscalePeersRequest = z.strictObject({ v: V });
export const TailscalePeersResponse = z.object({
  v: V,
  peers: z.array(TailscalePeer).max(TAILSCALE_PEERS_MAX),
});
export type TailscalePeersResponse = z.infer<typeof TailscalePeersResponse>;

/* Manager socket: AI clients (SUB-09, CT-73) ------------------------------------------------------------------- */

/** An absolute path of plain segments (no `.`/`..` segment, no spaces). */
const AbsPath = z
  .string()
  .min(2)
  .max(255)
  .regex(/^[/][A-Za-z0-9_][A-Za-z0-9._+-]*([/][A-Za-z0-9_][A-Za-z0-9._+-]*)*$/);

/** `ClientState` of `@whombat/core` (the manager's view of one client). */
export const LocalClientState = z.enum(['not_installed', 'installing', 'installed', 'updating', 'failed']);

/**
 * One client as the manager keeps it. `installed.executable` is what the runner runs and checks before each turn
 * (its sha256 and version replace the image's provider pins, PV-01); `fixturesDigest` names the provider fixtures the
 * bundle was tested against. While `updating`, `installed` is still the running version.
 */
export const LocalClient = z.object({
  provider: ClientProvider,
  state: LocalClientState,
  installed: z
    .object({
      version: VersionString,
      installedAt: Rfc3339,
      executable: z.object({ path: AbsPath, sha256: Sha256Hex }),
      fixturesDigest: Digest,
    })
    .nullable(),
  /** The bundle `selectClientBundle` picks for this device and the runtime's adapter level (null: none). */
  latest: z.object({ version: VersionString, publishedAt: Rfc3339 }).nullable(),
  progress: z.number().int().min(0).max(100).nullable(),
  /** `failed`: `unavailable`, `digest_mismatch`, `download_failed`, `disk_full`, … and what happened (ASCII). */
  error: z.object({ code: ident(), message: ascii(500, 0) }).nullable(),
});
export type LocalClient = z.infer<typeof LocalClient>;

/** The clients the manager keeps, and the channel it last verified (`sequence`, when). */
export const LocalClientsStatus = z.object({
  v: V,
  clients: z.array(LocalClient).max(8),
  channel: z
    .object({ sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), checkedAt: Rfc3339 })
    .nullable(),
});
export type LocalClientsStatus = z.infer<typeof LocalClientsStatus>;

/**
 * Install the provider's selected bundle (the runtime asks after the person's `clients.install`). Answers 202 with the
 * `LocalClient` (`installing`), or the current one when it is already installing or installed; `LocalError` 409
 * `busy` while it is being removed, 404 `unavailable` when no bundle fits this device and the runtime's adapter.
 */
export const ClientInstallRequest = z.strictObject({ v: V, provider: ClientProvider });
/** Remove the provider's client (stops an install in progress). Answers the `LocalClient` (`not_installed`). */
export const ClientRemoveRequest = z.strictObject({ v: V, provider: ClientProvider });

/* Manager socket: renew the licence now (LC-08, CT-77) ----------------------------------------------------------- */

/**
 * Renew the licence now (the runtime asks for the person's `licence.refresh`). The manager answers after the
 * attempt: `renewed: true` once it verified and pushed the new token (`POST /licence`), otherwise `renewed: false`
 * with `error` (`unreachable`, `device_unclaimed`, `device_revoked`, `devices_allowed_reached`, `rate_limited`,
 * `bad_token`, …). Within 60 s of the last forced renewal it answers 429 `LocalError{code: 'busy'}`. Named
 * `…RenewNow…` because the device op's body is `LicenceRenewRequest` in the cross-language registry.
 */
export const LicenceRenewNowRequest = z.strictObject({ v: V });
export const LicenceRenewNowResult = z.object({
  v: V,
  renewed: z.boolean(),
  error: ident().optional(),
});

/* Admin socket: manager / backup → runtime --------------------------------------------------------- */

export const ADMIN_PATHS = {
  health: '/health',
  drain: '/drain',
  resume: '/resume',
  claimWindow: '/claim-window',
  /** The claim-code lookup lease (CC-03): `ClaimLookupLeaseRequest`. */
  claimLookup: '/claim-lookup',
  /** `POST` (manager → runtime facts) and `GET` (runtime facts for the manager's `status.report`). */
  facts: '/facts',
  /** `POST` (manager → runtime): `ClientsPushRequest` whenever a client changes, and at runtime start (CT-73). */
  clients: '/clients',
  /** `POST` (manager → runtime): `LicencePushRequest` → `LicencePushResponse` (LC-06, CT-77). */
  licence: '/licence',
} as const;

export const HealthCheck = z.object({ ok: z.boolean(), detail: ascii(500, 0).optional() });
export const MigrationsCheck = z.object({
  ok: z.boolean(),
  compatible: z.boolean(),
  /** `read-write`, `read-only` (a newer release migrated; reads only) or `none`. */
  access: z.enum(['read-write', 'read-only', 'none']),
  verdict: ident().optional(),
  schemaVersion: z.number().int().min(0).max(1_000_000),
  detail: ascii(500, 0).optional(),
});
export const ExternalState = z.enum(['ok', 'degraded', 'down', 'unknown']);

/**
 * The runtime's local health (MA-11: local health never depends on relay, control or providers; `external` is
 * informational only and never decides update health; no check makes a paid model call).
 */
export const RuntimeHealth = z.object({
  v: V,
  status: z.enum(['ok', 'degraded', 'starting']),
  releaseId: ident(80),
  version: ident(64),
  checks: z.object({
    db: HealthCheck,
    migrations: MigrationsCheck,
    sessionEndpoint: HealthCheck,
    /**
     * Whether the runtime's periodic maintenance keeps up: not ok when a job hasn't finished a run for a while
     * (three of its periods, at least 15 minutes), with which ones in `detail`. Informational: it doesn't make
     * `status` degraded, since a job can fail for a reason outside the box.
     */
    maintenance: HealthCheck.optional(),
  }),
  external: z
    .object({
      relay: ExternalState.optional(),
      control: ExternalState.optional(),
      providers: ExternalState.optional(),
    })
    .optional(),
  draining: z.boolean(),
});
export type RuntimeHealth = z.infer<typeof RuntimeHealth>;

/**
 * Ask for a safe boundary (MA-11, MA-13). Idempotent per `requestId`, which also renews the lease; without renewal
 * the runtime resumes on its own after `leaseMs` (a crashed caller never leaves it drained).
 * - scope `all` (updates, network changes, backup copy fallback): no new turns/jobs/approved executions,
 *   outbound effects paused, running work finishes; session commands answer `unavailable`, reads work.
 * - scope `writes` (backup checkpoint): a write barrier; new write transactions wait at the commit pipeline,
 *   in-flight ones finish, file-moving workers pause; running turns continue.
 */
export const DrainRequest = z.strictObject({
  v: V,
  requestId: ident(),
  reason: z.enum(['update', 'host-update', 'network', 'backup']),
  scope: z.enum(['all', 'writes']),
  releaseId: ident(80).optional(),
  leaseMs: z.number().int().min(1_000).max(3_600_000),
});
export type DrainRequest = z.infer<typeof DrainRequest>;

/** Acknowledged work that prevents the boundary. */
export const DrainBlocker = z.object({
  kind: z.enum(['turn', 'job', 'approval-execution', 'migration', 'backup', 'upload', 'other']),
  id: ident(),
  /** For the app's “waiting for …” explanation (printable ASCII). */
  description: ascii(300, 0),
  since: Rfc3339,
  estimatedMs: Ms.optional(),
});
export const DrainStatus = z.object({
  v: V,
  requestId: ident(),
  draining: z.boolean(),
  /** The boundary is reached (no blockers). */
  safe: z.boolean(),
  blockers: z.array(DrainBlocker).max(256),
  estimatedMs: Ms,
});
export type DrainStatus = z.infer<typeof DrainStatus>;

export const ResumeRequest = z.strictObject({ v: V, requestId: ident() });
export const ResumeResponse = z.object({ v: V, requestId: ident(), draining: z.boolean() });

/** The physical claim window (MA-04 §3): whether it is required, and until when it is open (null = closed). */
export const ClaimWindowRequest = z.strictObject({
  v: V,
  required: z.boolean(),
  openUntil: Rfc3339.nullable(),
});

/**
 * The claim-code lookup lease (CC-03, CT-63): the manager leases the number from control (device op `claim.lookup`)
 * and hands it to the runtime whenever it changes and at runtime start — `{v, lookup, expiresAt}` while it holds a
 * lease, `{v, lookup: null}` when it has none (control unreachable, or the device is claimed). `expiresAt` is present
 * exactly when `lookup` is (`claimLookupLeaseValid`). Named `…Lease…` because the device op's body is
 * `ClaimLookupRequest` in the cross-language registry.
 */
export const ClaimLookupLeaseRequest = z.strictObject({
  v: V,
  lookup: ClaimLookup.nullable(),
  expiresAt: Rfc3339.optional(),
});
export type ClaimLookupLeaseRequest = z.infer<typeof ClaimLookupLeaseRequest>;

/** `expiresAt` accompanies a lookup number and nothing else. */
export function claimLookupLeaseValid(r: { lookup: string | null; expiresAt?: string }): boolean {
  return (r.lookup !== null) === (r.expiresAt !== undefined);
}

/* Console file (CC-08, CT-64) ------------------------------------------------------------------------------ */

/** Where the runtime writes the console file (atomic replace, mode 0640, group `whombat-console`). */
export const CONSOLE_FILE_ENV = 'WHOMBAT_CONSOLE_FILE';
export const CONSOLE_FILE_DEFAULT = '/run/whombat/console.json';

/**
 * - `starting`: the runtime is starting; `waiting`: no lookup lease yet (control unreachable), so no code;
 * - `claimable`: the code is on the console; `backoff`: too many wrong codes until `retryAt`; `claimed`: set up.
 */
export const ConsoleClaimState = z.enum(['starting', 'waiting', 'claimable', 'backoff', 'claimed']);
export type ConsoleClaimState = z.infer<typeof ConsoleClaimState>;

/**
 * The regex behind `ConsoleDisplayText` (CT-116): 1–64 code points, none of them a control (Cc), format (Cf, e.g. the
 * bidi override U+202E or the zero-width space U+200B), surrogate (Cs) or separator (Z: line, paragraph and every
 * space) character except U+0020, and no space at either end. The length is in the pattern (code points in both
 * ECMAScript `u` mode and Go RE2), not in `.min`/`.max` (UTF-16 units). The one Unicode pattern the cross-language
 * subset admits (docs/contracts/cross-language.md).
 */
export const CONSOLE_DISPLAY_TEXT_RE =
  /^[^\p{Cc}\p{Cf}\p{Cs}\p{Z}](?:(?:[^\p{Cc}\p{Cf}\p{Cs}\p{Z}]| ){0,62}[^\p{Cc}\p{Cf}\p{Cs}\p{Z}])?$/u;
export const CONSOLE_DISPLAY_TEXT_MAX = 64;

/** A user-chosen name the console shows (a burrow's name, CT-116): any script, one line, nothing invisible. */
export const ConsoleDisplayText = z.string().regex(CONSOLE_DISPLAY_TEXT_RE);
export type ConsoleDisplayText = z.infer<typeof ConsoleDisplayText>;

/** The burrows on a claimed box (CT-116): the oldest one's name and how many others there are. */
export const ConsoleBurrows = z.object({
  first: ConsoleDisplayText,
  more: z.number().int().min(0).max(9999),
});
export type ConsoleBurrows = z.infer<typeof ConsoleBurrows>;

/**
 * A device waiting to sign in at the box's screen (0.106, CT-626; Whombat signin-at-box.md BX-06): only in `claimed`.
 * The console shows it over whatever is on screen — “{name} wants to sign in”, the device, the letters large and
 * grouped 3 + 3 (`formatScreenSignInLetters`), “Type these letters on that device.” — and wakes the screen; it hides
 * it once `expiresAt` passed even if the file wasn't rewritten. `name` and `device` are the requester's text, drawn as
 * text only (`ConsoleDisplayText`, as `burrows.first`).
 */
export const ConsoleSignIn = z.object({
  /** The six letters; the PAKE password of `enroll.screen` (never logged, never sent anywhere but this file). */
  code: ScreenSignInLetters,
  /** The account's name, else its email. */
  name: ConsoleDisplayText,
  /** The new device's label, as it asked. */
  device: ConsoleDisplayText,
  expiresAt: Rfc3339,
});
export type ConsoleSignIn = z.infer<typeof ConsoleSignIn>;

/** What a console alert is about (4.3): `own_address_foreign`, a certificate for the box's address it didn't ask for. */
export const ConsoleAlertKind = z.enum(['own_address_foreign']);
export type ConsoleAlertKind = z.infer<typeof ConsoleAlertKind>;
/** A banner the console shows over whatever is on screen, since `since`. */
export const ConsoleAlert = z.object({ kind: ConsoleAlertKind, since: Rfc3339 });
export type ConsoleAlert = z.infer<typeof ConsoleAlert>;

/**
 * Whombat Link on the screen (4.4; Whombat whombat-link.md): its state and, while it starts, the code and page
 * (“Open app.whombat.com/link and enter ABCD-EFGH”), “Waiting for an address”, or when grace ends.
 */
export const ConsoleLink = z.object({
  state: LinkState,
  code: LinkCode.optional(),
  /** The page to type the code at; the console shows it without the scheme (`consoleDisplayUrl`). */
  url: LinkPageUrl.optional(),
  expiresAt: Rfc3339.optional(),
  waitingForAddress: z.boolean().optional(),
  graceEndsAt: Rfc3339.optional(),
});
export type ConsoleLink = z.infer<typeof ConsoleLink>;

/**
 * Tailscale on the screen (4.4): the sign-in link whenever Tailscale needs a login (shown as text), whether the
 * tailnet has HTTPS certificates off (“Turn on HTTPS in Tailscale's DNS settings”), and the box's name once it's in.
 */
export const ConsoleTailscale = z.object({
  loginUrl: TailscaleLoginUrl.optional(),
  needsHttps: z.boolean().optional(),
  name: TailscaleName.optional(),
});
export type ConsoleTailscale = z.infer<typeof ConsoleTailscale>;

/** How the box is reached, for the screen (4.4): any state; each part only when it has something to show. */
export const ConsoleReach = z.object({
  link: ConsoleLink.optional(),
  tailscale: ConsoleTailscale.optional(),
});
export type ConsoleReach = z.infer<typeof ConsoleReach>;

/**
 * The console file (CC-08): what `whombat-console` shows on tty1. The runtime is the authority on the letters,
 * rotation, backoff and claim state. `code` (the four letters, `KXQM`; the lookup number is never shown, CC-13, CT-67)
 * is present exactly in `claimable`, `retryAt`
 * exactly in `backoff`, `burrows` and `signIn` (0.106, a screen sign-in) only in `claimed` and optional there,
 * `lettersUntil`, `fallbackUrl` and `pageOpen` only in `claimable` and `newLetters` only in `claimable` and `backoff`,
 * optional there, `ipv6Only` in any state but `claimed`
 * (`consoleStateValid`). `url` is
 * `WHOMBAT_APP_URL` + `/claim`, or on a box that has its own address ready and is still unclaimed, its claim link
 * (`https://<host>/c/<secret>`, 4.3); the console shows it without the scheme (`consoleDisplayUrl`). Every string except
 * `burrows.first`, `signIn.name` and `signIn.device` is printable ASCII without spaces, so a crafted file can't carry
 * escape sequences. Those three are user-chosen text (`ConsoleDisplayText`, CT-116): the schema already refuses
 * control, format and separator characters (so no ESC, no bidi override, no line break), but a consumer must still
 * strip control and format characters itself before drawing them (defence in depth: its Unicode tables may be newer
 * than the validator's) and render them as text only. Tolerant (unknown members stripped).
 */
export const ConsoleState = z.object({
  v: V,
  state: ConsoleClaimState,
  code: ClaimLetters.optional(),
  url: z
    .string()
    .min(8)
    .max(256)
    .regex(/^https?:[/][/][\x21-\x7e]+$/),
  retryAt: Rfc3339.optional(),
  /**
   * The letters were asked for at the box's own screen and stay until then, whatever is tried (Whombat
   * whombat-link.md): only in `claimable`. Without it the letters change after a wrong try.
   */
  lettersUntil: Rfc3339.optional(),
  /**
   * The person at the box can ask for new letters now (the desk socket's `claimLetters`): the screen offers it. Only in
   * `claimable` and `backoff`, on a box that shows letters of its own.
   */
  newLetters: z.literal(true).optional(),
  /**
   * The box's network gave it an IPv6 address and no IPv4 one (Whombat whombat-link.md): the Whombat app takes an IPv4
   * address only, so the screen of a box without an address to open says that an IPv4 address is another way. Said on
   * its own, whatever `url` names: a box whose only IPv6 addresses can't be told to anyone names none. Never in
   * `claimed`.
   */
  ipv6Only: z.literal(true).optional(),
  /**
   * Another address for the claim, for when `url` doesn't open (Whombat own-address.md): only in `claimable`, beside
   * the claim link at the box's own address. That address is on the internet, where strangers can keep it busy; this
   * one they can't reach. The box's Tailscale page (`https://`) when it has one, else its address on the local network
   * (`http://<IPv4>:<port>/`), which the Whombat app there takes. The console shows it under the letters, by the rules
   * of `url`, and leaves it out when it can't.
   */
  fallbackUrl: z
    .string()
    .min(8)
    .max(256)
    .regex(/^https?:[/][/][\x21-\x7e]+$/)
    .optional(),
  /**
   * A browser has the claim link open and waits for the letters (Whombat console-gui.md): a session at the box's own
   * address showed the link. Only in `claimable`. The screen then says to type the letters there, and leaves out the
   * link to open, its QR code and the second way in: scanning the code would move the claim to another device.
   */
  pageOpen: z.literal(true).optional(),
  burrows: ConsoleBurrows.optional(),
  /** A screen sign-in is showing (0.106, CT-626): only in `claimed`. */
  signIn: ConsoleSignIn.optional(),
  /** Something the screen must show over everything else, in any state (4.3). */
  alert: ConsoleAlert.optional(),
  /** How the box is reached: Link's code and state, Tailscale's sign-in (4.4), in any state. */
  reach: ConsoleReach.optional(),
});
export type ConsoleState = z.infer<typeof ConsoleState>;

/**
 * `code` exactly when `claimable`, `retryAt` exactly when `backoff`, `lettersUntil`, `fallbackUrl` and `pageOpen` only
 * when `claimable`, `newLetters` only when `claimable` or `backoff`, `ipv6Only` never when `claimed`, `burrows` and `signIn` only when `claimed` (a runtime that doesn't
 * send them, a box without a burrow or without a sign-in showing, leaves them out). A consumer that finds a `signIn` outside `claimed` may drop the sign-in and keep the rest
 * (the console does).
 */
export function consoleStateValid(s: {
  state: string;
  code?: string;
  retryAt?: string;
  lettersUntil?: string;
  newLetters?: boolean;
  ipv6Only?: boolean;
  fallbackUrl?: string;
  pageOpen?: boolean;
  burrows?: unknown;
  signIn?: unknown;
}): boolean {
  return (
    (s.state === 'claimable') === (s.code !== undefined) &&
    (s.state === 'backoff') === (s.retryAt !== undefined) &&
    (s.lettersUntil === undefined || s.state === 'claimable') &&
    (s.newLetters === undefined || s.state === 'claimable' || s.state === 'backoff') &&
    (s.ipv6Only === undefined || s.state !== 'claimed') &&
    (s.fallbackUrl === undefined || s.state === 'claimable') &&
    (s.pageOpen === undefined || s.state === 'claimable') &&
    (s.burrows === undefined || s.state === 'claimed') &&
    (s.signIn === undefined || s.state === 'claimed')
  );
}

/** The URL as the console shows it: without `https://` / `http://`. */
export function consoleDisplayUrl(url: string): string {
  return url.replace(/^https?:[/][/]/, '');
}

/* Backup service status (MA-13; feeds `/facts`): defined in `@whombat/protocol/session` (shared with the
 * `backup.status` op) and re-exported here. */
import { BackupServiceStatus } from '@whombat/protocol/session';

export {
  BACKUP_PATHS,
  BACKUP_STATUS_KIND,
  BackupServiceStatus,
  CheckpointRequest,
  CheckpointResult,
} from '@whombat/protocol/session';

/**
 * Why a staged update waits (CT-138, UP-E4): the reason (`UpdateWaitReason`), since when, and what holds it (for
 * `boundary`: the running work by kind, e.g. `{kind: 'run', count: 2}`; for `checkpoint`: `{kind: 'no_destination'}`).
 */
export const UpdateWaiting = z.object({
  reason: UpdateWaitReason,
  since: Rfc3339,
  blockers: z.array(z.object({ kind: ident(), count: z.number().int().min(0).max(1_000_000) })).max(16),
});
export type UpdateWaiting = z.infer<typeof UpdateWaiting>;

/** The last update that went through (CT-138): the release now running, the one before it (null: unknown), when. */
export const LastUpdate = z.object({
  release: ReleaseId,
  from: ReleaseId.nullable(),
  at: Rfc3339,
});
export type LastUpdate = z.infer<typeof LastUpdate>;

/**
 * The manager's update state for `appliance.status.update` (MA-11 journal names). The 0.22 members (CT-138) are
 * absent when there is nothing to say (no optional-nullable in the cross-language subset) and stripped by older
 * runtimes.
 */
export const UpdateFacts = z.object({
  state: UpdateJournalState,
  current: ident(80),
  candidate: ident(80).nullable(),
  lastCheckedAt: Rfc3339.nullable(),
  deferredReason: ident().nullable(),
  failure: ident().nullable(),
  /**
   * The running (`current`) tuple's client security floor (CT-53), copied from the verified tuple; absent when the
   * tuple has none (or from a manager older than 0.5.3). The runtime enforces it on `hello` and keeps the last value
   * it received across restarts, so a restart doesn't reopen the gap before the manager's first facts push.
   */
  clientFloor: ClientFloor.optional(),
  /** The last failure's detail (CT-137): what `describeUpdateFailure` renders for the person. */
  failureDetail: UpdateFailureDetail.optional(),
  /** Set while a staged candidate waits to activate. */
  waiting: UpdateWaiting.optional(),
  /** The last successful update. */
  lastUpdate: LastUpdate.optional(),
  /**
   * The owner's “Ask before updating” (4.2): every update waits for the owner's approval (`waiting.reason` `owner`)
   * before it installs. Absent from a manager that can't hold updates for the owner, so the app offers no switch.
   */
  askFirst: z.boolean().optional(),
  /** The box's update channel is paused by its release key; absent when not paused. */
  paused: z.boolean().optional(),
});
export type UpdateFacts = z.infer<typeof UpdateFacts>;

/**
 * `POST /v1/update/ask` (4.2): the owner's “Ask before updating”. On, a staged update waits (`owner`) until the owner
 * approves that release; off, updates install by themselves again, one already waiting at the next safe moment.
 */
export const UpdateAskRequest = z.strictObject({ v: V, askFirst: z.boolean() });
export type UpdateAskRequest = z.infer<typeof UpdateAskRequest>;
export const UpdateAskResponse = z.object({ v: V, askFirst: z.boolean() });
export type UpdateAskResponse = z.infer<typeof UpdateAskResponse>;

/**
 * `POST /v1/update/approve` (4.2): the owner approves `release`, the update waiting for them, which then installs at
 * the next safe moment as any update does. An approval covers that release only. 409 `not_waiting`: no update waits
 * for the owner, or another release does (the app shows the one waiting again).
 */
export const UpdateApproveRequest = z.strictObject({ v: V, release: ReleaseId });
export type UpdateApproveRequest = z.infer<typeof UpdateApproveRequest>;
export const UpdateApproveResponse = z.object({ v: V, release: ReleaseId });
export type UpdateApproveResponse = z.infer<typeof UpdateApproveResponse>;

/**
 * What only the manager knows, pushed to the runtime whenever it changes (and at runtime start): the backup
 * service's status (null: no backup service) and the update state (null: no journal yet). Replaces the previous
 * facts as a whole.
 */
export const FactsRequest = z.strictObject({
  v: V,
  backup: BackupServiceStatus.nullable(),
  update: UpdateFacts.nullable(),
});
export type FactsRequest = z.infer<typeof FactsRequest>;
export const AdminOk = z.object({ v: V, ok: z.literal(true) });

/**
 * The manager's client status pushed to the runtime (CT-73): whenever a client's state, version or progress changes
 * (progress at most once a second) and at runtime start. The same members as `LocalClientsStatus`; replaces the
 * previous push as a whole. The runtime answers `AdminOk` and runs turns only on `installed.executable`.
 */
export const ClientsPushRequest = z.strictObject({
  v: V,
  clients: LocalClientsStatus.shape.clients,
  channel: LocalClientsStatus.shape.channel,
});
export type ClientsPushRequest = z.infer<typeof ClientsPushRequest>;

/**
 * The manager's licence token and time high-water mark (LC-06), pushed whenever the token changes, at every runtime
 * (re)start and with the periodic facts re-send. `token: null`: the manager holds none (not renewed yet); the runtime
 * keeps any token it stored and only takes `highWater`. The runtime verifies the token with its pinned key set and
 * its device id (400 `LocalError{code: 'bad_request'}` when it doesn't verify), refuses one whose `iat` is older than
 * the stored one's (409 `stale`), stores it, raises its own mark to `highWater` (a newer token resets its clock mark
 * to it, LC-07) and answers its licence state.
 */
export const LicencePushRequest = z.strictObject({
  v: V,
  token: LicenceToken.nullable(),
  highWater: Rfc3339,
});
export type LicencePushRequest = z.infer<typeof LicencePushRequest>;

/** The runtime's licence state after a push (for the manager's log); null on an unclaimed appliance. */
export const LocalLicenceStatus = z.object({
  state: LicenceState,
  reason: LicenceReason,
  plan: LicencePlan.nullable(),
  expiresAt: Rfc3339.nullable(),
  graceEndsAt: Rfc3339.nullable(),
  effectiveAt: Rfc3339,
});
export const LicencePushResponse = z.object({ v: V, licence: LocalLicenceStatus.nullable() });
export type LicencePushResponse = z.infer<typeof LicencePushResponse>;

export * from './bluetooth.js';
export * from './desk.js';
export * from './link.js';
export * from './own-address.js';
export * from './presence.js';
export * from './summary.js';
export * from './support.js';
export * from './voice.js';
export * from './voice-models.js';

/**
 * `GET /facts` on the admin socket: runtime metadata for the manager's `status.report` (metadata only). The
 * manager maps it: `sessionsActive = activeSessions`, `recoveryKit = not_created | unconfirmed | confirmed` from
 * `recovery`, `lastBackupAt` from the backup service's status.
 */
export const RuntimeFacts = z.object({
  v: V,
  activeSessions: z.number().int().min(0).max(100_000),
  claimed: z.boolean(),
  claimReported: z.boolean(),
  recovery: z.object({ enrolled: z.boolean(), kitVerified: z.boolean() }),
  revocations: z.object({
    pending: z.number().int().min(0).max(1_000_000),
    applied: z.number().int().min(0).max(1_000_000),
  }),
  draining: z.boolean(),
  /** A restored replacement waits for its old appliance to be dealt with (backup quarantine marker, MR-20). */
  quarantined: z.boolean(),
  relay: z.enum(['stopped', 'connecting', 'connected', 'backoff']),
  /**
   * The runtime's adapter level for Claude Code (CT-73, `ClientAdapterLevel`): the manager selects its client bundles
   * for it (`selectClientBundle`). Claude only since 3.0 (CT-1564; Whombat hermes-native.md HN-A02): ChatGPT runs on
   * Hermes's own loop and needs no client, so there is no Codex level and the manager selects no Codex bundle.
   */
  clientAdapters: z.object({ claude: ClientAdapterLevel }),
});
export type RuntimeFacts = z.infer<typeof RuntimeFacts>;

/** `DeviceStatusReport.recoveryKit` from `RuntimeFacts.recovery`. */
export function recoveryKitState(
  recovery: RuntimeFacts['recovery'],
): 'not_created' | 'unconfirmed' | 'confirmed' {
  return !recovery.enrolled ? 'not_created' : recovery.kitVerified ? 'confirmed' : 'unconfirmed';
}
