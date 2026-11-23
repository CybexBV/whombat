import type { PushRequest, PushResult } from '@whombat/control-contracts/device';
import type {
  CableChangeResponse,
  CableSetRequest,
  HostHardwareResponse,
  HostMetricsRequest,
  HostMetricsResponse,
  LicenceRenewNowResult,
  LinkClaimRequest,
  LinkOffRequest,
  LinkOnRequest,
  LinkStateResponse,
  NetworkStateResponse,
  OwnAddressCertResponse,
  OwnAddressCtResponse,
  OwnAddressStateResponse,
  RuntimeAccountLinkLookupRequest,
  RuntimeAccountLinkLookupResponse,
  RuntimeAccountLinkRequest,
  RuntimeAccountLinkResponse,
  RuntimeFeedbackAckRequest,
  RuntimeFeedbackCardsRequest,
  RuntimeFeedbackCardsResponse,
  RuntimeFeedbackPullRequest,
  RuntimeFeedbackPullResponse,
  RuntimeFeedbackReportersRequest,
  RuntimeKitCredentialsRequest,
  RuntimeKitCredentialsResponse,
  RuntimeKitEnvelopesRequest,
  RuntimeKitEnvelopesResponse,
  RuntimeLinkMailSetRequest,
  RuntimeLinkWhombatsResponse,
  RuntimeMailSendRequest,
  RuntimePushRegisterRequest,
  RuntimePushRegisterResponse,
  RuntimePushUnregisterRequest,
  RuntimeShareDeleteRequest,
  RuntimeSharePutRequest,
  RuntimeSharePutResponse,
  RuntimeShareViewsRequest,
  RuntimeShareViewsResponse,
  RuntimeTicketResponse,
  UpdateApproveRequest,
  UpdateApproveResponse,
  UpdateAskRequest,
  UpdateAskResponse,
  UpdateChannelResponse,
  UpdateChannelSetRequest,
  WifiChangeResponse,
  WifiForgetRequest,
  WifiJoinRequest,
  WifiScanResponse,
} from '@whombat/control-contracts/local';
import { encodeFrame, type Frame, FrameDecoder } from '@whombat/protocol/frame';
import type { z } from 'zod';
import type { TailscalePort } from './direct/tailscale';

/**
 * The managed runtime's ports (docs/decisions/managed-runtime.md MR-04): everything it needs from outside the
 * application — the manager, the relay's byte streams, the secure channel and the session protocol codec — as
 * interfaces. Production implementations: `manager-client.ts` (the manager's unix socket), `session/relay-client.ts`
 * (WebSockets), and adapters over `@whombat/secure-channel` / `@whombat/protocol` once contracts 0.2.x are
 * vendored. The frame codec is `@whombat/protocol`'s. Tests use the in-memory fakes in `testing.ts`.
 */

/* Manager ------------------------------------------------------------------------------------------ */

/** `@whombat/control-contracts/local` `RuntimeTicketResponse`: an appliance admission ticket (never logged). */
export type AdmissionTicket = RuntimeTicketResponse;

/** A content-free push request (CT-11): `PushRequest` with opaque push handles, a kind and an opaque ref. */
export type ControlPushRequest = PushRequest;

/**
 * The manager socket (CT-23): the runtime's calls to the manager. Tailscale (`TailscalePort`, contracts 1.0.0 CT-1255):
 * the state, the person's on, off and sign in, and the certificate for the box's Tailscale name; `ManagerCallError`
 * 409 `tailscale.busy` while a change runs, 404 from a manager without Tailscale.
 */
export interface ManagerPort extends TailscalePort {
  /** An appliance admission ticket for relay control/data connections of a class. */
  ticket(cls: 'interactive' | 'bulk'): Promise<AdmissionTicket>;
  /** MA-04 §3: the claim happened (the manager signs `claim.claimed`). */
  reportClaimed(input: { claimId: string; claimedAt: string }): Promise<void>;
  /** MA-04 §6: an endpoint was revoked (the manager reports `revocationRef(peerId)` as applied). */
  reportRevocation(input: { peerId: string; revokedAt: string }): Promise<void>;
  /** A content-free push request. */
  push(request: ControlPushRequest): Promise<PushResult>;
  /**
   * Renew the licence now (the person's `licence.refresh`, LC-08, CT-77): answers after the attempt, once the manager
   * pushed any new token to `POST /licence`. Throws `ManagerCallError` with status 429 (`busy`) within 60 s of the
   * last forced renewal.
   */
  renewLicence(): Promise<z.output<typeof LicenceRenewNowResult>>;
  /**
   * Bringing the box back from a backup (backup-options.md BKO-11): the manager has the update helper start the root
   * restore of `checkpointId` (it stops this runtime). Absent on a manager stand-in without it.
   */
  backupRestore?(checkpointId: string): Promise<void>;
  /** Once the person's answers ended the quarantine: the manager restarts the runtime and the hosts service. */
  backupRestored?(): Promise<void>;
  /**
   * The feedback drop (docs/decisions/feedback-drop.md FD-21): the device ops `feedback.cards.sync`,
   * `feedback.drops.pull` and `feedback.drops.ack`, signed and forwarded by the manager. `ManagerCallError` status 501
   * (or 404 from an older manager) means the manager or control doesn't support them; 503 / 0: control or the manager
   * unreachable.
   */
  feedbackCards(
    request: z.input<typeof RuntimeFeedbackCardsRequest>,
  ): Promise<z.output<typeof RuntimeFeedbackCardsResponse>>;
  feedbackPull(
    request: z.input<typeof RuntimeFeedbackPullRequest>,
  ): Promise<z.output<typeof RuntimeFeedbackPullResponse>>;
  feedbackAck(request: z.input<typeof RuntimeFeedbackAckRequest>): Promise<void>;
  /**
   * Signed-in reporters' report statuses (feedback-reporters FR-10, CT-164): the device op
   * `feedback.reporters.publish`. Same errors as the drop's: 501 or 404 unsupported, 503 / 0 unreachable.
   */
  feedbackReporters(request: z.input<typeof RuntimeFeedbackReportersRequest>): Promise<void>;
  /**
   * The passkey-locked backup details (backup-passkey.md): the device op `kit.envelopes.put`, signed and forwarded by
   * the manager. `ManagerCallError` 503 `control_unreachable` (or status 0): try again later; 404 from an older manager.
   * Absent on a manager stand-in without it.
   */
  kitEnvelopes?(
    request: z.input<typeof RuntimeKitEnvelopesRequest>,
  ): Promise<z.output<typeof RuntimeKitEnvelopesResponse>>;
  /**
   * The box's own address (docs/decisions/own-address.md): the manager's state, registering the label the runtime drew,
   * the certificate pair it serves and what the certificate watch found. `ManagerCallError` 404 (`own_address.off`, or
   * an older manager without the routes) means this box has none; 409 `own_address.label_taken` / `.label_invalid` on
   * register, `own_address.no_cert` on cert. Absent on a manager stand-in without them.
   */
  ownAddressState?(): Promise<OwnAddressStateResponse>;
  ownAddressRegister?(label: string): Promise<OwnAddressStateResponse>;
  ownAddressCert?(): Promise<OwnAddressCertResponse>;
  ownAddressCt?(): Promise<OwnAddressCtResponse>;
  /**
   * Linking the box to the person's Whombat account by the code it shows (own-address.md): the device ops
   * `account.link.lookup` and `account.link`, signed and forwarded by the manager. Errors as `kitEnvelopes`', control's
   * refusals as 502 `control_refused` with control's code in the message.
   */
  accountLinkLookup?(
    request: z.input<typeof RuntimeAccountLinkLookupRequest>,
  ): Promise<z.output<typeof RuntimeAccountLinkLookupResponse>>;
  accountLink?(
    request: z.input<typeof RuntimeAccountLinkRequest>,
  ): Promise<z.output<typeof RuntimeAccountLinkResponse>>;
  /** The full set of box-passkey credentials whose backup envelopes control may keep (`kit.credentials.declare`). */
  kitCredentials?(
    request: z.input<typeof RuntimeKitCredentialsRequest>,
  ): Promise<z.output<typeof RuntimeKitCredentialsResponse>>;
  /**
   * Shared links (docs/decisions/share-links.md): the device ops `share.put`, `share.delete` and `share.views`, signed
   * and forwarded by the manager. `ManagerCallError` 503 `control_unreachable` (or status 0): control can't be reached
   * now; 502 `control_refused` with control's code in the message; 404/501: no control here. Absent on a manager
   * stand-in without them.
   */
  sharePut?(
    request: z.input<typeof RuntimeSharePutRequest>,
  ): Promise<z.output<typeof RuntimeSharePutResponse>>;
  shareDelete?(request: z.input<typeof RuntimeShareDeleteRequest>): Promise<void>;
  shareViews?(
    request: z.input<typeof RuntimeShareViewsRequest>,
  ): Promise<z.output<typeof RuntimeShareViewsResponse>>;
  /**
   * How the box is doing (the person's `host.metrics`, docs/decisions/box-status.md BS-06, CT-334): one range of the
   * manager's measurements, the days counted in `timeZone`. `ManagerCallError` status 404 from a manager before 0.78.
   */
  hostMetrics(request: z.input<typeof HostMetricsRequest>): Promise<z.output<typeof HostMetricsResponse>>;
  /**
   * The box's hardware report (the person's `host.hardware`, hardware-support.md HD-03, HD-S02): collected by the manager
   * when asked. `ManagerCallError` status 404 from a manager before 0.102.
   */
  hostHardware(): Promise<z.output<typeof HostHardwareResponse>>;
  /** The box's cable and Wi-Fi, whether it reaches Whombat, and a running change (HD-05, HD-10). 404 before 0.102. */
  networkState(): Promise<z.output<typeof NetworkStateResponse>>;
  /** The Wi-Fi networks in reach, strongest first (the manager waits up to 10 s for a fresh scan). */
  wifiScan(): Promise<z.output<typeof WifiScanResponse>>;
  /**
   * Joins a Wi-Fi network under the guard (HD-06): answers once the change runs (`applying`). Refusals as
   * `ManagerCallError` codes `no_wifi`, `busy`, `invalid_passphrase`. The passphrase is a secret: never logged.
   */
  wifiJoin(request: z.input<typeof WifiJoinRequest>): Promise<z.output<typeof WifiChangeResponse>>;
  /** Forgets a saved Wi-Fi network (HD-06). Refusals: `no_wifi`, `busy`, `in_use`, `not_saved`. */
  wifiForget(request: z.input<typeof WifiForgetRequest>): Promise<z.output<typeof WifiChangeResponse>>;
  /**
   * Wi-Fi only, or the cable again, under the guard (network-move.md NM-01, NM-02): answers once the change runs.
   * Refusals: `busy`, `no_wifi`, `not_connected`, `no_cable`, `unchanged`. 404 from a manager before 3.13.
   */
  networkCable(request: z.input<typeof CableSetRequest>): Promise<z.output<typeof CableChangeResponse>>;
  /**
   * The owner's “Ask before updating” (ask-before-updating.md ABU-02): the manager keeps it and holds every update
   * until it is approved; answers the setting it now keeps. 404 from a manager before contracts 4.2.
   */
  updateAsk?(request: z.input<typeof UpdateAskRequest>): Promise<z.output<typeof UpdateAskResponse>>;
  /** The owner approves the release waiting for them (ABU-03). Refusal: 409 `not_waiting`. 404 before 4.2. */
  updateApprove?(
    request: z.input<typeof UpdateApproveRequest>,
  ): Promise<z.output<typeof UpdateApproveResponse>>;
  /**
   * Whombat Link (contracts 4.4; docs/decisions/whombat-link.md): the state the manager last heard from control, the
   * owner turning it on (the runtime signs its part of the box's registration, `contentProof`) or off. 404
   * `link.unavailable` from a manager without Link (an older one answers 404 too); 409 `link.busy` /
   * `link.device_exists`; 429 `link.rate_limited`; 503 `control_unreachable`; 502 `control_refused`.
   */
  linkState?(): Promise<LinkStateResponse>;
  linkOn?(request: z.input<typeof LinkOnRequest>): Promise<LinkStateResponse>;
  linkOff?(request?: z.input<typeof LinkOffRequest>): Promise<LinkStateResponse>;
  /**
   * The claim link the box shows (4.13), for the manager to send with `link.status`; without `claimLink` it forgets the
   * one it had. 404 from an older manager.
   */
  linkClaim?(request: z.input<typeof LinkClaimRequest>): Promise<void>;
  /**
   * The other Whombats linked to the same account (4.14, the device op `link.whombats`), for the menu under the box's
   * name. 404 `link.unavailable` while Link doesn't run (an older manager answers 404 too); 503 `control_unreachable`;
   * 502 `control_refused`.
   */
  linkWhombats?(): Promise<RuntimeLinkWhombatsResponse>;
  /**
   * Email through Whombat Link (4.15): the owner's choices (`link.mail.set`) and one email to the Link account's own
   * address (`mail.send`). 404 while control doesn't know the box (an older manager answers 404 too); 503 when control
   * can't be reached; 502 `control_refused` (Link not running, the choice says no, the day's limit).
   */
  linkMailSet?(request: z.input<typeof RuntimeLinkMailSetRequest>): Promise<void>;
  mailSend?(request: z.input<typeof RuntimeMailSendRequest>): Promise<void>;
  /** The update channel (4.4): read and the owner's change. 404 `update.channel_unavailable`; 409 `busy`. */
  updateChannel?(): Promise<UpdateChannelResponse>;
  updateChannelSet?(request: z.input<typeof UpdateChannelSetRequest>): Promise<UpdateChannelResponse>;
  /**
   * A phone's push token registered at control for this box (4.4 `push.register`, `push.unregister`): the handle
   * control gave. 404 while Link isn't on (or an older manager); 502 `control_refused` (`link_off`).
   */
  pushRegister?(
    request: z.input<typeof RuntimePushRegisterRequest>,
  ): Promise<z.output<typeof RuntimePushRegisterResponse>>;
  pushUnregister?(request: z.input<typeof RuntimePushUnregisterRequest>): Promise<void>;
}

/** The manager or control doesn't offer the feedback drop (FD-21, FD-38: 501, or 404 from an older manager). */
export function dropUnsupported(err: unknown): boolean {
  return err instanceof ManagerCallError && (err.status === 501 || err.status === 404);
}

/** A manager call answered with an error status (`LocalError {error: {code}}`), or not answered at all (status 0). */
export class ManagerCallError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ManagerCallError';
  }
}

/**
 * Whether a manager call failed only because the manager, or control behind it, can't be reached now (box-health.md
 * BH-09): its socket isn't there or doesn't answer (`unreachable`: the manager restarting with an update), or it
 * answered 5xx (`unavailable`: “control unavailable: control HTTP 502”, the control plane restarting). A retry later is
 * the cure; anything else — a refusal, a bad request — is a real error.
 */
export function managerUnreachable(err: unknown): boolean {
  return err instanceof ManagerCallError && (err.code === 'unreachable' || err.status >= 500);
}

/* Bytes and channels ------------------------------------------------------------------------------- */

/** A relay data connection after `ready`: `@whombat/secure-channel`'s `ByteStream`. */
export type { ByteStream } from '@whombat/secure-channel';

/**
 * The authenticated, encrypted connection a session runs over (`session/secure.ts` adapts
 * `@whombat/secure-channel`'s responder to it). `send`/`receive` carry session frame bytes in any split.
 */
export interface SecureMessageChannel {
  /** The client's Ed25519 identity as a libp2p PeerId: the endpoint key. */
  readonly remotePeerId: string;
  /** Raw 32-byte Ed25519 public key of the endpoint. */
  readonly remotePublicKey: Uint8Array;
  send(message: Uint8Array): Promise<void>;
  receive(): Promise<Uint8Array | null>;
  close(): Promise<void>;
  abort(reason?: Error): void;
}

/** Runs the Noise responder handshake over a relay byte stream with the appliance content identity. */
export type SecureResponder = (
  stream: import('@whombat/secure-channel').ByteStream,
) => Promise<SecureMessageChannel>;

/* Session protocol frames ---------------------------------------------------------------------------- */

export type { Frame } from '@whombat/protocol/frame';
export { STREAM_RESET } from '@whombat/protocol/frame';

/** Encodes frames onto the secure channel and decodes what arrives. */
export interface FrameCodec {
  encode(frame: Frame): Uint8Array;
  /** A decoder for one connection: bytes in (any split), whole frames out; throws on a broken frame. */
  decoder(): { push(bytes: Uint8Array): Frame[] };
}

/** The protocol's frame codec (CT-05: `[u32 length][u8 type][u32 stream][payload]`). */
export const protocolFrameCodec: FrameCodec = {
  encode: (frame) => encodeFrame(frame),
  decoder: () => new FrameDecoder(),
};
