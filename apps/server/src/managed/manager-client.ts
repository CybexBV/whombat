/**
 * The manager as the runtime sees it (MA-10; docs/decisions/managed-runtime.md MR-16): a small JSON API on the
 * manager's unix socket (`WHOMBAT_MANAGER_SOCKET`). The manager holds the management key and talks to control; the
 * runtime asks it for admission tickets and hands it content-free reports and push requests. Nothing here carries
 * content: claim time, a revoked endpoint's PeerId and time, and push requests with opaque handles.
 *
 * Shapes: `@whombat/control-contracts/local` (CT-23, docs/local-ipc.md), validated both ways:
 *
 *   POST /v1/runtime/ticket       {class}                  → {ticket, relayUrl, worker, expiresAt}
 *   POST /v1/runtime/claimed      {claimedAt}              → {ok}
 *   POST /v1/runtime/revocations  {peerId, revokedAt}      → {ok}
 *   POST /v1/runtime/push         PushRequest (CT-11)      → PushResult
 *   POST /v1/licence/renew        {v}                      → {v, renewed, error?} (LC-08; 429 `busy`)
 *   POST /v1/runtime/feedback/cards {seq, cards}           → {accepted, refused}   (feedback-drop FD-21)
 *   POST /v1/runtime/feedback/pull  {max, maxBytes}        → {drops, pending, expired, nextPullS}
 *   POST /v1/runtime/feedback/ack   {dropIds}              → {ok}
 *   POST /v1/runtime/feedback/reporters {updates, removals} → {ok}          (feedback-reporters FR-10)
 *   POST /v1/backup/kit-envelopes  {envelopes, adoptedFrom?} → {stored, skipped} (backup-passkey.md; 503 control_unreachable)
 *   POST /v1/host/metrics          {v, range, since?, timeZone} → {v, metrics} (box-status BS-06; 404 before 0.78)
 *   POST /v1/host/hardware         {v}                      → {v, hardware} (hardware-support HD-03; 404 before 0.102)
 *   POST /v1/network/state         {v}                      → {v, network}  (HD-05, HD-10)
 *   POST /v1/network/wifi/scan     {v}                      → {v, scan}     (waits ≤ 10 s for a fresh scan)
 *   POST /v1/network/wifi/join     {v, ssid, passphrase?, hidden?, confirmTimeoutSec} → 202 {v, change} (HD-06)
 *   POST /v1/network/wifi/forget   {v, ssid}                → 202 {v, change}
 *   POST /v1/network/cable         {v, use, confirmTimeoutSec} → 202 {v, change} (network-move NM-01; 404 before 3.13)
 *   POST /v1/tailscale/state|sign-in {v}                    → {v, tailscale} (1.0, CT-1255; direct-connection.md DC-13)
 *   POST /v1/tailscale/on          {v, loginServer?}        → {v, tailscale} (1.1, CT-1306: the server wanted)
 *   POST /v1/tailscale/off         {v, signOut?}            → {v, tailscale}
 *   POST /v1/tailscale/cert        {v}                      → {v, name, certPem, keyPem, notAfter} (409 off / no HTTPS)
 *   POST /v1/tailscale/peers       {v}                      → {v, peers} (3.11, CT-1635; tailnet-reach.md TN-06)
 *   POST /v1/update/ask            {v, askFirst}            → {v, askFirst} (4.2; ask-before-updating.md)
 *   POST /v1/update/approve        {v, release}             → {v, release}  (409 not_waiting)
 *   POST /v1/own-address/state|register|cert|ct {v, label?} → state, the pair, the CT watch (4.3; own-address.md;
 *                                                              404 own_address.off or an older manager)
 *   POST /v1/runtime/account/link-lookup|link {code}         → {email, expiresAt|linkedAt} (4.3)
 *   POST /v1/backup/kit-credentials {credentialIds}          → {declared} (4.3)
 *   POST /v1/link/state|on|off     {v, contentProof?, name?} → {v, enabled, link} (4.4; whombat-link.md)
 *   POST /v1/update/channel[/set]  {v, channel?}            → {v, channel, staysOn?} (4.4; 404 update.channel_unavailable)
 *   POST /v1/runtime/push/register|unregister {token|handle} → {handle} | {ok} (4.4; push through the box)
 *
 * The manager answers 503 `unavailable` while control is unreachable; the runtime keeps claims and revocations
 * pending and retries them.
 */
import { FEEDBACK_PULL_RESPONSE_MAX_BYTES, type PushResult } from '@whombat/control-contracts/device';
import {
  CableChangeResponse,
  CableSetRequest,
  HostHardwareRequest,
  HostHardwareResponse,
  HostMetricsRequest,
  HostMetricsResponse,
  LicenceRenewNowRequest,
  LicenceRenewNowResult,
  LinkClaimRequest,
  LinkOffRequest,
  LinkOnRequest,
  LinkStateRequest,
  LinkStateResponse,
  LOCAL_API_VERSION,
  LocalOk,
  MANAGER_PATHS,
  NetworkStateRequest,
  NetworkStateResponse,
  OwnAddressCertRequest,
  OwnAddressCertResponse,
  OwnAddressCtRequest,
  OwnAddressCtResponse,
  OwnAddressRegisterRequest,
  OwnAddressStateRequest,
  OwnAddressStateResponse,
  RuntimeAccountLinkLookupRequest,
  RuntimeAccountLinkLookupResponse,
  RuntimeAccountLinkRequest,
  RuntimeAccountLinkResponse,
  RuntimeClaimedRequest,
  RuntimeFeedbackAckRequest,
  RuntimeFeedbackAckResponse,
  RuntimeFeedbackCardsRequest,
  RuntimeFeedbackCardsResponse,
  RuntimeFeedbackPullRequest,
  RuntimeFeedbackPullResponse,
  RuntimeFeedbackReportersRequest,
  RuntimeFeedbackReportersResponse,
  RuntimeKitCredentialsRequest,
  RuntimeKitCredentialsResponse,
  RuntimeKitEnvelopesRequest,
  RuntimeKitEnvelopesResponse,
  RuntimeLinkWhombatsRequest,
  RuntimeLinkWhombatsResponse,
  RuntimePushRegisterRequest,
  RuntimePushRegisterResponse,
  RuntimePushRequest,
  RuntimePushResponse,
  RuntimePushUnregisterRequest,
  RuntimeRevocationRequest,
  RuntimeShareDeleteRequest,
  RuntimeShareDeleteResponse,
  RuntimeSharePutRequest,
  RuntimeSharePutResponse,
  RuntimeShareViewsRequest,
  RuntimeShareViewsResponse,
  RuntimeTicketRequest,
  RuntimeTicketResponse,
  TailscaleCertRequest,
  TailscaleCertResponse,
  TailscaleOffRequest,
  TailscaleOnRequest,
  TailscalePeersRequest,
  TailscalePeersResponse,
  TailscaleSignInRequest,
  TailscaleStateRequest,
  TailscaleStateResponse,
  UpdateApproveRequest,
  UpdateApproveResponse,
  UpdateAskRequest,
  UpdateAskResponse,
  UpdateChannelRequest,
  UpdateChannelResponse,
  UpdateChannelSetRequest,
  WifiChangeResponse,
  WifiForgetRequest,
  WifiJoinRequest,
  WifiScanRequest,
  WifiScanResponse,
} from '@whombat/control-contracts/local';
import { requestUnixHttp, UnixHttpError } from '@whombat/node-io/http';
import type { TailscaleStatus } from '@whombat/protocol/session';
import type { z } from 'zod';
import { type AdmissionTicket, type ControlPushRequest, ManagerCallError, type ManagerPort } from './ports';

/** A forced renewal waits for control; the manager answers after the attempt (LC-08). */
const RENEW_TIMEOUT_MS = 45_000;
/** Answers of the manager (MR-16): 64 KiB, except the feedback drop's (FD-21, FD-33). */
const ANSWER_MAX_BYTES = 64 * 1024;
const FEEDBACK_ANSWER_MAX_BYTES = 1024 * 1024;
/** A pull carries up to 64 MiB of envelopes; a card sync up to 4 MiB goes to control. */
const FEEDBACK_PULL_TIMEOUT_MS = 120_000;
const FEEDBACK_CARDS_TIMEOUT_MS = 30_000;
/** The manager answers the measurements from memory (BS-06): 2 s, and a month's points with the days fit in 256 KiB. */
const HOST_METRICS_TIMEOUT_MS = 2_000;
const HOST_METRICS_ANSWER_MAX_BYTES = 256 * 1024;
/**
 * The box's hardware and network (hardware-support-server.md HD-S03): the network state from the manager's memory in
 * 2 s; the hardware report is collected when asked (10 s); a scan and a change's answer within 15 s. Answers capped as
 * the measurements are (256 devices with their names fit easily).
 */
export const HOST_STATE_TIMEOUT_MS = 2_000;
export const HOST_HARDWARE_TIMEOUT_MS = 10_000;
export const HOST_WIFI_TIMEOUT_MS = 15_000;
const HOST_ANSWER_MAX_BYTES = 256 * 1024;
/** The envelopes go on to control: the manager answers once control did. */
const KIT_ENVELOPES_TIMEOUT_MS = 30_000;
/** A shared link's copy goes on to control (up to 11 MiB): the manager answers once control kept it. */
const SHARE_TIMEOUT_MS = 60_000;
/** Tailscale's changes answer once tailscaled took them. */
const TAILSCALE_TIMEOUT_MS = 30_000;
/**
 * A new certificate waits for Let's Encrypt's DNS check through Tailscale's servers: about 35 s on Home, so 30 s gave
 * up on every try and the box's Tailscale name never got its page. The manager allows 3 minutes.
 */
const TAILSCALE_CERT_TIMEOUT_MS = 150_000;

export class ManagerSocketClient implements ManagerPort {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 10_000,
  ) {}

  private async call<T>(
    path: string,
    body: unknown,
    timeoutMs = this.timeoutMs,
    maxAnswerBytes = ANSWER_MAX_BYTES,
  ): Promise<T> {
    const payload = JSON.stringify(body ?? {});
    let response: Awaited<ReturnType<typeof requestUnixHttp>>;
    try {
      response = await requestUnixHttp({
        socketPath: this.socketPath,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        body: payload,
        idleTimeoutMs: timeoutMs,
        maxResponseBytes: maxAnswerBytes,
      });
    } catch (err) {
      const message =
        err instanceof UnixHttpError && err.kind === 'timeout'
          ? `manager ${path}: timed out`
          : err instanceof UnixHttpError && err.kind === 'too_large'
            ? String(new Error('manager answer too large'))
            : String(err);
      throw new ManagerCallError(path, 0, 'unreachable', message);
    }
    const text = response.body.toString('utf8');
    const status = response.status || 500;
    if (status >= 300) {
      let code = 'error';
      try {
        const parsed = JSON.parse(text) as { error?: { code?: unknown } };
        if (typeof parsed.error?.code === 'string') code = parsed.error.code.slice(0, 64);
      } catch {
        /* not a LocalError */
      }
      throw new ManagerCallError(path, status, code, `manager ${path}: ${status} ${text.slice(0, 200)}`);
    }
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      throw new Error(`manager ${path}: not JSON`);
    }
  }

  async ticket(cls: 'interactive' | 'bulk'): Promise<AdmissionTicket> {
    return RuntimeTicketResponse.parse(
      await this.call(MANAGER_PATHS.ticket, RuntimeTicketRequest.parse({ class: cls })),
    );
  }

  async reportClaimed(input: { claimId: string; claimedAt: string }): Promise<void> {
    LocalOk.parse(await this.call(MANAGER_PATHS.claimed, RuntimeClaimedRequest.parse(input)));
  }

  async reportRevocation(input: { peerId: string; revokedAt: string }): Promise<void> {
    LocalOk.parse(await this.call(MANAGER_PATHS.revocations, RuntimeRevocationRequest.parse(input)));
  }

  async push(requestBody: ControlPushRequest): Promise<PushResult> {
    return RuntimePushResponse.parse(
      await this.call(MANAGER_PATHS.push, RuntimePushRequest.parse(requestBody)),
    );
  }

  async feedbackCards(body: z.input<typeof RuntimeFeedbackCardsRequest>) {
    return RuntimeFeedbackCardsResponse.parse(
      await this.call(
        MANAGER_PATHS.feedbackCards,
        RuntimeFeedbackCardsRequest.parse(body),
        FEEDBACK_CARDS_TIMEOUT_MS,
        FEEDBACK_ANSWER_MAX_BYTES,
      ),
    );
  }

  async feedbackPull(body: z.input<typeof RuntimeFeedbackPullRequest>) {
    return RuntimeFeedbackPullResponse.parse(
      await this.call(
        MANAGER_PATHS.feedbackPull,
        RuntimeFeedbackPullRequest.parse(body),
        FEEDBACK_PULL_TIMEOUT_MS,
        FEEDBACK_PULL_RESPONSE_MAX_BYTES,
      ),
    );
  }

  async feedbackAck(body: z.input<typeof RuntimeFeedbackAckRequest>): Promise<void> {
    RuntimeFeedbackAckResponse.parse(
      await this.call(
        MANAGER_PATHS.feedbackAck,
        RuntimeFeedbackAckRequest.parse(body),
        this.timeoutMs,
        FEEDBACK_ANSWER_MAX_BYTES,
      ),
    );
  }

  async feedbackReporters(body: z.input<typeof RuntimeFeedbackReportersRequest>): Promise<void> {
    RuntimeFeedbackReportersResponse.parse(
      await this.call(
        MANAGER_PATHS.feedbackReporters,
        RuntimeFeedbackReportersRequest.parse(body),
        this.timeoutMs,
        FEEDBACK_ANSWER_MAX_BYTES,
      ),
    );
  }

  async kitEnvelopes(body: z.input<typeof RuntimeKitEnvelopesRequest>) {
    return RuntimeKitEnvelopesResponse.parse(
      await this.call(
        MANAGER_PATHS.kitEnvelopes,
        RuntimeKitEnvelopesRequest.parse(body),
        KIT_ENVELOPES_TIMEOUT_MS,
      ),
    );
  }

  async ownAddressState() {
    return OwnAddressStateResponse.parse(
      await this.call(MANAGER_PATHS.ownAddressState, OwnAddressStateRequest.parse({ v: LOCAL_API_VERSION })),
    );
  }

  /** Registering waits for control (the manager forwards `address.register`). */
  async ownAddressRegister(label: string) {
    return OwnAddressStateResponse.parse(
      await this.call(
        MANAGER_PATHS.ownAddressRegister,
        OwnAddressRegisterRequest.parse({ v: LOCAL_API_VERSION, label }),
        KIT_ENVELOPES_TIMEOUT_MS,
      ),
    );
  }

  /** The pair carries a private key: the answer is never logged. */
  async ownAddressCert() {
    return OwnAddressCertResponse.parse(
      await this.call(MANAGER_PATHS.ownAddressCert, OwnAddressCertRequest.parse({ v: LOCAL_API_VERSION })),
    );
  }

  /** Up to 256 certificates with their names: the measurements' cap. */
  async ownAddressCt() {
    return OwnAddressCtResponse.parse(
      await this.call(
        MANAGER_PATHS.ownAddressCt,
        OwnAddressCtRequest.parse({ v: LOCAL_API_VERSION }),
        this.timeoutMs,
        HOST_ANSWER_MAX_BYTES,
      ),
    );
  }

  async accountLinkLookup(body: z.input<typeof RuntimeAccountLinkLookupRequest>) {
    return RuntimeAccountLinkLookupResponse.parse(
      await this.call(
        MANAGER_PATHS.accountLinkLookup,
        RuntimeAccountLinkLookupRequest.parse(body),
        KIT_ENVELOPES_TIMEOUT_MS,
      ),
    );
  }

  async accountLink(body: z.input<typeof RuntimeAccountLinkRequest>) {
    return RuntimeAccountLinkResponse.parse(
      await this.call(
        MANAGER_PATHS.accountLink,
        RuntimeAccountLinkRequest.parse(body),
        KIT_ENVELOPES_TIMEOUT_MS,
      ),
    );
  }

  async kitCredentials(body: z.input<typeof RuntimeKitCredentialsRequest>) {
    return RuntimeKitCredentialsResponse.parse(
      await this.call(
        MANAGER_PATHS.kitCredentials,
        RuntimeKitCredentialsRequest.parse(body),
        KIT_ENVELOPES_TIMEOUT_MS,
      ),
    );
  }

  async sharePut(body: z.input<typeof RuntimeSharePutRequest>) {
    return RuntimeSharePutResponse.parse(
      await this.call(MANAGER_PATHS.sharePut, RuntimeSharePutRequest.parse(body), SHARE_TIMEOUT_MS),
    );
  }

  async shareDelete(body: z.input<typeof RuntimeShareDeleteRequest>): Promise<void> {
    RuntimeShareDeleteResponse.parse(
      await this.call(MANAGER_PATHS.shareDelete, RuntimeShareDeleteRequest.parse(body), SHARE_TIMEOUT_MS),
    );
  }

  async shareViews(body: z.input<typeof RuntimeShareViewsRequest>) {
    return RuntimeShareViewsResponse.parse(
      await this.call(MANAGER_PATHS.shareViews, RuntimeShareViewsRequest.parse(body), SHARE_TIMEOUT_MS),
    );
  }

  async hostMetrics(body: z.input<typeof HostMetricsRequest>) {
    return HostMetricsResponse.parse(
      await this.call(
        MANAGER_PATHS.hostMetrics,
        HostMetricsRequest.parse(body),
        HOST_METRICS_TIMEOUT_MS,
        HOST_METRICS_ANSWER_MAX_BYTES,
      ),
    );
  }

  async hostHardware() {
    return HostHardwareResponse.parse(
      await this.call(
        MANAGER_PATHS.hostHardware,
        HostHardwareRequest.parse({ v: LOCAL_API_VERSION }),
        HOST_HARDWARE_TIMEOUT_MS,
        HOST_ANSWER_MAX_BYTES,
      ),
    );
  }

  async networkState() {
    return NetworkStateResponse.parse(
      await this.call(
        MANAGER_PATHS.networkState,
        NetworkStateRequest.parse({ v: LOCAL_API_VERSION }),
        HOST_STATE_TIMEOUT_MS,
        HOST_ANSWER_MAX_BYTES,
      ),
    );
  }

  async wifiScan() {
    return WifiScanResponse.parse(
      await this.call(
        MANAGER_PATHS.wifiScan,
        WifiScanRequest.parse({ v: LOCAL_API_VERSION }),
        HOST_WIFI_TIMEOUT_MS,
        HOST_ANSWER_MAX_BYTES,
      ),
    );
  }

  async wifiJoin(body: z.input<typeof WifiJoinRequest>) {
    return WifiChangeResponse.parse(
      await this.call(
        MANAGER_PATHS.wifiJoin,
        WifiJoinRequest.parse(body),
        HOST_WIFI_TIMEOUT_MS,
        HOST_ANSWER_MAX_BYTES,
      ),
    );
  }

  async wifiForget(body: z.input<typeof WifiForgetRequest>) {
    return WifiChangeResponse.parse(
      await this.call(
        MANAGER_PATHS.wifiForget,
        WifiForgetRequest.parse(body),
        HOST_WIFI_TIMEOUT_MS,
        HOST_ANSWER_MAX_BYTES,
      ),
    );
  }

  async networkCable(body: z.input<typeof CableSetRequest>) {
    return CableChangeResponse.parse(
      await this.call(
        MANAGER_PATHS.networkCable,
        CableSetRequest.parse(body),
        HOST_WIFI_TIMEOUT_MS,
        HOST_ANSWER_MAX_BYTES,
      ),
    );
  }

  /* Tailscale (CT-1255): the manager is tailscaled's only caller. */

  private async tailscale(path: string, body: unknown): Promise<TailscaleStatus> {
    return TailscaleStateResponse.parse(await this.call(path, body, TAILSCALE_TIMEOUT_MS)).tailscale;
  }

  tailscaleState() {
    return this.tailscale(
      MANAGER_PATHS.tailscaleState,
      TailscaleStateRequest.parse({ v: LOCAL_API_VERSION }),
    );
  }

  tailscaleOn(input: { loginServer?: string } = {}) {
    return this.tailscale(
      MANAGER_PATHS.tailscaleOn,
      TailscaleOnRequest.parse({
        v: LOCAL_API_VERSION,
        ...(input.loginServer ? { loginServer: input.loginServer } : {}),
      }),
    );
  }

  tailscaleOff(input: { signOut?: boolean }) {
    return this.tailscale(
      MANAGER_PATHS.tailscaleOff,
      TailscaleOffRequest.parse({ v: LOCAL_API_VERSION, ...(input.signOut ? { signOut: true } : {}) }),
    );
  }

  tailscaleSignIn() {
    return this.tailscale(
      MANAGER_PATHS.tailscaleSignIn,
      TailscaleSignInRequest.parse({ v: LOCAL_API_VERSION }),
    );
  }

  async tailscalePeers() {
    return TailscalePeersResponse.parse(
      await this.call(
        MANAGER_PATHS.tailscalePeers,
        TailscalePeersRequest.parse({ v: LOCAL_API_VERSION }),
        TAILSCALE_TIMEOUT_MS,
      ),
    ).peers;
  }

  async tailscaleCert() {
    return TailscaleCertResponse.parse(
      await this.call(
        MANAGER_PATHS.tailscaleCert,
        TailscaleCertRequest.parse({ v: LOCAL_API_VERSION }),
        TAILSCALE_CERT_TIMEOUT_MS,
      ),
    );
  }

  /* Ask before updating (ask-before-updating.md): the manager keeps the switch and the owner's approval. */

  async updateAsk(body: z.input<typeof UpdateAskRequest>) {
    return UpdateAskResponse.parse(await this.call(MANAGER_PATHS.updateAsk, UpdateAskRequest.parse(body)));
  }

  async updateApprove(body: z.input<typeof UpdateApproveRequest>) {
    return UpdateApproveResponse.parse(
      await this.call(MANAGER_PATHS.updateApprove, UpdateApproveRequest.parse(body)),
    );
  }

  /* Whombat Link (4.4; whombat-link.md): the state, the owner's on and off, the channel, push tokens. */

  async linkState() {
    return LinkStateResponse.parse(
      await this.call(MANAGER_PATHS.linkState, LinkStateRequest.parse({ v: LOCAL_API_VERSION })),
    );
  }

  /** Waits for control (`link.begin`). */
  async linkOn(body: z.input<typeof LinkOnRequest>) {
    return LinkStateResponse.parse(
      await this.call(MANAGER_PATHS.linkOn, LinkOnRequest.parse(body), KIT_ENVELOPES_TIMEOUT_MS),
    );
  }

  async linkOff(body: z.input<typeof LinkOffRequest> = { v: LOCAL_API_VERSION }) {
    return LinkStateResponse.parse(
      await this.call(MANAGER_PATHS.linkOff, LinkOffRequest.parse(body), KIT_ENVELOPES_TIMEOUT_MS),
    );
  }

  /** The claim link is a secret: the request is never logged. */
  async linkClaim(body: z.input<typeof LinkClaimRequest>) {
    LocalOk.parse(await this.call(MANAGER_PATHS.linkClaim, LinkClaimRequest.parse(body)));
  }

  /** Asks control through the manager: a read, but one that waits for control. */
  async linkWhombats() {
    return RuntimeLinkWhombatsResponse.parse(
      await this.call(MANAGER_PATHS.linkWhombats, RuntimeLinkWhombatsRequest.parse({})),
    );
  }

  async updateChannel() {
    return UpdateChannelResponse.parse(
      await this.call(MANAGER_PATHS.updateChannel, UpdateChannelRequest.parse({ v: LOCAL_API_VERSION })),
    );
  }

  async updateChannelSet(body: z.input<typeof UpdateChannelSetRequest>) {
    return UpdateChannelResponse.parse(
      await this.call(
        MANAGER_PATHS.updateChannelSet,
        UpdateChannelSetRequest.parse(body),
        KIT_ENVELOPES_TIMEOUT_MS,
      ),
    );
  }

  /** The token is a secret of the phone's: the request is never logged. */
  async pushRegister(body: z.input<typeof RuntimePushRegisterRequest>) {
    return RuntimePushRegisterResponse.parse(
      await this.call(
        MANAGER_PATHS.pushRegister,
        RuntimePushRegisterRequest.parse(body),
        KIT_ENVELOPES_TIMEOUT_MS,
      ),
    );
  }

  async pushUnregister(body: z.input<typeof RuntimePushUnregisterRequest>) {
    await this.call(
      MANAGER_PATHS.pushUnregister,
      RuntimePushUnregisterRequest.parse(body),
      KIT_ENVELOPES_TIMEOUT_MS,
    );
  }

  async backupRestore(checkpointId: string) {
    await this.call('/v1/backup/restore', { checkpointId }, 30_000);
  }

  async backupRestored() {
    await this.call('/v1/backup/restored', {}, 30_000);
  }

  async renewLicence() {
    return LicenceRenewNowResult.parse(
      await this.call(
        MANAGER_PATHS.licenceRenew,
        LicenceRenewNowRequest.parse({ v: LOCAL_API_VERSION }),
        RENEW_TIMEOUT_MS,
      ),
    );
  }
}
