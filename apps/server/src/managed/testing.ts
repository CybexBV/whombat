/**
 * Test fakes for the managed runtime's ports (MR-04): a manager that records what it was told, an in-memory
 * byte channel pair standing in for the Noise channel (it reports a fixed endpoint identity, as the responder
 * would after the handshake), and a session client that speaks `@whombat/protocol` (real frames and messages).
 * Never used outside tests.
 */
import { randomBytes } from 'node:crypto';
import {
  FEEDBACK_PULL_BUSY_S,
  type FeedbackCardRefusal,
  type FeedbackDrop,
  type PushResult,
} from '@whombat/control-contracts/device';
import {
  CableChangeResponse,
  CableSetRequest,
  HostHardwareResponse,
  type HostMetricsRequest,
  HostMetricsResponse,
  type LinkStateResponse,
  type LocalLinkStatus,
  MANAGER_PATHS,
  NetworkStateResponse,
  type OwnAddressCertResponse,
  type OwnAddressCheckResponse,
  type OwnAddressCtResponse,
  type OwnAddressStateResponse,
  type RuntimeFeedbackAckRequest,
  type RuntimeFeedbackCardsRequest,
  type RuntimeFeedbackPullRequest,
  type RuntimeFeedbackPullResponse,
  type RuntimeFeedbackReportersRequest,
  RuntimeKitEnvelopesRequest,
  RuntimeLinkMailSetRequest,
  type RuntimeLinkWhombatsResponse,
  RuntimeMailSendRequest,
  RuntimeShareDeleteRequest,
  RuntimeSharePutRequest,
  RuntimeShareViewsRequest,
  UpdateApproveRequest,
  UpdateAskRequest,
  UpdateChannelSetRequest,
  WifiChangeResponse,
  WifiForgetRequest,
  WifiJoinRequest,
  WifiScanResponse,
} from '@whombat/control-contracts/local';
import type { SignedFeedbackSiteCard } from '@whombat/core';
import { generateKeypair, hexToBytes, publicKeyOf, sha256Hex, signBytes } from '@whombat/core';
import { siteKeyFingerprint, verifySiteCard } from '@whombat/core/feedback/drop';
import { encodeFrame, FrameDecoder, SESSION_INITIAL_STREAM_CREDIT } from '@whombat/protocol';
import { ed25519Jwk } from '@whombat/protocol/admission';
import {
  type ClaimConfirmTags,
  type ClaimMethod,
  claimConfirmEqual,
  claimPakeInitiator,
  claimPakeInitiatorFinish,
  localClaimPakeInitiator,
  localClaimPakeInitiatorFinish,
  screenSignInPakeInitiator,
  screenSignInPakeInitiatorFinish,
} from '@whombat/protocol/claim';
import {
  LICENCE_LIFETIME_S,
  type LicenceClaims,
  type LicenceKeySet,
  signLicenceToken,
} from '@whombat/protocol/licence';
import {
  type ApplianceMessage,
  type ClientMessage,
  decodeApplianceMessage,
  encodeSessionMessage,
  HOST_METRICS_STEP_S,
  type HostMetrics,
  SESSION_PROTOCOL,
} from '@whombat/protocol/session';
import type { z } from 'zod';
import { FakeTailscale } from './direct/tailscale';
import type { SessionTransport } from './direct/transport';
import { FakeHost } from './fake-host';
import { peerIdFromEd25519PublicKey } from './identity';
import {
  type AdmissionTicket,
  type ControlPushRequest,
  type Frame,
  ManagerCallError,
  type ManagerPort,
  type SecureMessageChannel,
} from './ports';
import type { ManagedRuntime } from './runtime';
import { SessionConnection } from './session/connection';

/**
 * Control's side of the feedback drop, in memory (control FD-11, FD-12, FD-19, FD-20, FD-34): verifies and stores
 * each site's card (bound to the first signing key), withdraws cards missing from a sync, refuses stale seqs, queues
 * envelopes a test drops for a published site, leases them on pull and deletes them on ack.
 */
export class FakeFeedbackControl {
  /** `ok`, or how the manager answers the feedback paths: 501 (unsupported) or 503 (control unreachable). */
  mode: 'ok' | 501 | 503 | 404 = 'ok';
  cards = new Map<string, SignedFeedbackSiteCard>();
  bindings = new Map<string, string>();
  lastSyncSeq = 0;
  syncs: z.output<typeof RuntimeFeedbackCardsRequest>[] = [];
  queue: (FeedbackDrop & { leaseUntil: number })[] = [];
  expired: { site: string; count: number }[] = [];
  acked: string[] = [];
  /** The next ack fails like an unreachable control (a crash between commit and ack, for the runtime). */
  failNextAck = false;
  pulls = 0;
  nextPullS = 30;
  private n = 0;

  private fail(path: string): void {
    if (this.mode === 'ok') return;
    const code = this.mode === 503 ? 'unavailable' : this.mode === 404 ? 'not_found' : 'unsupported';
    throw new ManagerCallError(path, this.mode, code, `manager ${path}: ${this.mode}`);
  }

  sync(body: z.input<typeof RuntimeFeedbackCardsRequest>) {
    this.fail('/v1/runtime/feedback/cards');
    this.syncs.push(body as z.output<typeof RuntimeFeedbackCardsRequest>);
    const refused: FeedbackCardRefusal[] = [];
    const accepted: string[] = [];
    if (body.seq <= this.lastSyncSeq) {
      for (const [index, c] of body.cards.entries())
        refused.push({
          index,
          site: typeof c.card.site === 'string' ? c.card.site : null,
          code: 'stale_seq',
          seq: this.lastSyncSeq,
        });
      return { accepted, refused };
    }
    this.lastSyncSeq = body.seq;
    const now = Math.floor(Date.now() / 1000);
    const seen = new Set<string>();
    body.cards.forEach((wire, index) => {
      const checked = verifySiteCard(wire, null, { now });
      const site = typeof wire.card.site === 'string' ? wire.card.site : null;
      // A named site whose new card is refused keeps its stored card (FD-41).
      if (site) seen.add(site);
      if (!checked.ok) {
        refused.push({ index, site, code: checked.error === 'expired' ? 'expired' : 'bad_card' });
        return;
      }
      const card = checked.card;
      const pin = siteKeyFingerprint(card.signingKey);
      const bound = this.bindings.get(card.site);
      if (bound && bound !== pin) {
        refused.push({ index, site, code: 'site_bound_elsewhere' });
        return;
      }
      const stored = this.cards.get(card.site);
      if (stored && card.seq <= stored.card.seq && stored.sig !== wire.sig) {
        refused.push({ index, site, code: 'stale_seq', seq: stored.card.seq });
        return;
      }
      this.bindings.set(card.site, pin);
      this.cards.set(card.site, wire as SignedFeedbackSiteCard);
      seen.add(card.site);
      accepted.push(card.site);
    });
    for (const site of [...this.cards.keys()]) if (!seen.has(site)) this.cards.delete(site);
    return { accepted, refused };
  }

  /**
   * A visitor's envelope arrives for a site (the public POST; `origin` is the browser's `Origin`). `reporter`: control's
   * attestation of a signed-in reporter (CT-164), as a drop posted with a valid reporter session carries it.
   */
  drop(
    site: string,
    envelope: Uint8Array,
    origin: string,
    reporter?: { id: string; emailDigest: string },
  ): string {
    const dropId = `fdr_${String(++this.n).padStart(22, '0')}`;
    this.queue.push({
      dropId,
      site,
      receivedAt: Math.floor(Date.now() / 1000),
      origin,
      bytes: envelope.length,
      envelope: Buffer.from(envelope).toString('base64url'),
      ...(reporter ? { reporter } : {}),
      leaseUntil: 0,
    });
    return dropId;
  }

  pull(body: z.input<typeof RuntimeFeedbackPullRequest>): z.output<typeof RuntimeFeedbackPullResponse> {
    this.fail('/v1/runtime/feedback/pull');
    this.pulls++;
    const now = Date.now();
    const drops: FeedbackDrop[] = [];
    let bytes = 0;
    for (const d of this.queue) {
      if (d.leaseUntil > now) continue;
      if (drops.length >= body.max || (drops.length > 0 && bytes + d.bytes > body.maxBytes)) break;
      d.leaseUntil = now + 120_000;
      bytes += d.bytes;
      const { leaseUntil: _lease, ...drop } = d;
      drops.push(drop);
    }
    const expired = this.expired;
    this.expired = [];
    const pending = this.queue.filter((d) => d.leaseUntil <= now).length;
    return { drops, pending, expired, nextPullS: pending > 0 ? FEEDBACK_PULL_BUSY_S : this.nextPullS };
  }

  ack(body: z.input<typeof RuntimeFeedbackAckRequest>): void {
    this.fail('/v1/runtime/feedback/ack');
    if (this.failNextAck) {
      this.failNextAck = false;
      throw new ManagerCallError('/v1/runtime/feedback/ack', 503, 'unavailable', 'control unreachable');
    }
    const ids = new Set(body.dropIds);
    this.acked.push(...body.dropIds);
    this.queue = this.queue.filter((d) => !ids.has(d.dropId));
  }

  /** How the manager answers `feedback.reporters.publish`, apart from the drop's `mode` (an older manager: 404). */
  reportersMode: 'ok' | 501 | 503 | 404 = 'ok';
  /** Every publish request, as sent. */
  reporterPublishes: z.output<typeof RuntimeFeedbackReportersRequest>[] = [];
  /** What control holds per `site|reference` (FR-10): the newest update wins, a removal deletes. */
  reporterEntries = new Map<string, z.output<typeof RuntimeFeedbackReportersRequest>['updates'][number]>();

  publishReporters(body: z.input<typeof RuntimeFeedbackReportersRequest>): void {
    const path = '/v1/runtime/feedback/reporters';
    this.fail(path);
    if (this.reportersMode !== 'ok') {
      const code =
        this.reportersMode === 503 ? 'unavailable' : this.reportersMode === 404 ? 'not_found' : 'unsupported';
      throw new ManagerCallError(path, this.reportersMode, code, `manager ${path}: ${this.reportersMode}`);
    }
    const request = body as z.output<typeof RuntimeFeedbackReportersRequest>;
    this.reporterPublishes.push(request);
    for (const u of request.updates) {
      const key = `${u.site}|${u.reference}`;
      const held = this.reporterEntries.get(key);
      if (!held || held.updatedAt <= u.updatedAt) this.reporterEntries.set(key, u);
    }
    for (const r of request.removals) this.reporterEntries.delete(`${r.site}|${r.reference}`);
  }

  /** Makes every lease run out (a redelivery after a crash between commit and ack). */
  expireLeases(): void {
    for (const d of this.queue) d.leaseUntil = 0;
  }
}

export class FakeManager implements ManagerPort {
  /** Control's feedback drop behind this manager. */
  readonly feedback = new FakeFeedbackControl();
  async feedbackCards(request: z.input<typeof RuntimeFeedbackCardsRequest>) {
    return this.feedback.sync(request);
  }
  async feedbackPull(request: z.input<typeof RuntimeFeedbackPullRequest>) {
    return this.feedback.pull(request);
  }
  async feedbackAck(request: z.input<typeof RuntimeFeedbackAckRequest>) {
    this.feedback.ack(request);
  }
  async feedbackReporters(request: z.input<typeof RuntimeFeedbackReportersRequest>) {
    this.feedback.publishReporters(request);
  }
  /** The passkey-locked backup details pushed (`kitEnvelopes`); `kitFails` answers with that error instead. */
  kitPushes: z.output<typeof RuntimeKitEnvelopesRequest>[] = [];
  kitFails: ManagerCallError | null = null;
  /** A manager (or control) from before names: a push with `applianceName` is refused as a bad request. */
  refusesNames = false;
  async kitEnvelopes(request: z.input<typeof RuntimeKitEnvelopesRequest>) {
    if (this.kitFails) throw this.kitFails;
    if (this.refusesNames && request.applianceName !== undefined)
      throw new ManagerCallError(
        '/v1/backup/kit-envelopes',
        400,
        'bad_request',
        'unknown member applianceName',
      );
    const parsed = RuntimeKitEnvelopesRequest.parse(request);
    this.kitPushes.push(parsed);
    return { stored: parsed.envelopes.length, skipped: 0 };
  }
  /**
   * Shared links kept as control would (share-links.md): the sealed copy and expiry by id, how often each was opened
   * (tests set `views`); `shareFails` answers every share call with that error instead.
   */
  shares = new Map<string, { envelope: string; expiresAt?: number; views: number; lastViewedAt?: number }>();
  shareFails: ManagerCallError | null = null;
  shareBase = 'https://app.whombat.test/s/';
  async sharePut(request: z.input<typeof RuntimeSharePutRequest>) {
    if (this.shareFails) throw this.shareFails;
    const { shareId, envelope, expiresAt } = RuntimeSharePutRequest.parse(request);
    const views = this.shares.get(shareId)?.views ?? 0;
    this.shares.set(shareId, { envelope, ...(expiresAt === undefined ? {} : { expiresAt }), views });
    return { url: `${this.shareBase}${shareId}` };
  }
  async shareDelete(request: z.input<typeof RuntimeShareDeleteRequest>) {
    if (this.shareFails) throw this.shareFails;
    for (const id of RuntimeShareDeleteRequest.parse(request).shareIds) this.shares.delete(id);
  }
  async shareViews(request: z.input<typeof RuntimeShareViewsRequest>) {
    if (this.shareFails) throw this.shareFails;
    const shares = RuntimeShareViewsRequest.parse(request).shareIds.flatMap((shareId) => {
      const s = this.shares.get(shareId);
      if (!s) return [];
      return [
        {
          shareId,
          views: s.views,
          ...(s.lastViewedAt === undefined ? {} : { lastViewedAt: s.lastViewedAt }),
        },
      ];
    });
    return { shares };
  }
  claimed: { claimId: string; claimedAt: string }[] = [];
  revocations: { peerId: string; revokedAt: string }[] = [];
  pushes: ControlPushRequest[] = [];
  failReports = false;
  tickets = 0;
  /** Where the fake relay listens (tests set it). */
  relayUrl = 'ws://127.0.0.1:1/v1/connect';
  classes: string[] = [];
  /* The own address (own-address.md): null answers 404, as a manager without one. */
  ownAddress: OwnAddressStateResponse | null = null;
  ownAddressPair: OwnAddressCertResponse | null = null;
  ownAddressWatch: OwnAddressCtResponse | null = null;
  /** Labels the runtime asked to register; refusals answered first, in order (`own_address.label_taken`, …). */
  registered: string[] = [];
  registerRefusals: ManagerCallError[] = [];
  async ownAddressState(): Promise<OwnAddressStateResponse> {
    if (!this.ownAddress) throw new ManagerCallError('/v1/own-address/state', 404, 'own_address.off', 'off');
    return this.ownAddress;
  }
  async ownAddressRegister(label: string): Promise<OwnAddressStateResponse> {
    if (!this.ownAddress)
      throw new ManagerCallError('/v1/own-address/register', 404, 'own_address.off', 'off');
    this.registered.push(label);
    const refusal = this.registerRefusals.shift();
    if (refusal) throw refusal;
    this.ownAddress = { ...this.ownAddress, label, host: `${label}.dev.whombat.app` };
    return this.ownAddress;
  }
  /** The pairs of other hosts (the leaving one), asked for by host; the hosts asked for, in order. */
  ownAddressPairs = new Map<string, OwnAddressCertResponse>();
  certAsked: (string | null)[] = [];
  async ownAddressCert(host?: string): Promise<OwnAddressCertResponse> {
    this.certAsked.push(host ?? null);
    const pair = host ? this.ownAddressPairs.get(host) : this.ownAddressPair;
    if (!pair) throw new ManagerCallError('/v1/own-address/cert', 409, 'own_address.no_cert', 'none');
    return pair;
  }
  /** Control's verdicts of other names (`free` when not set); a refusal answered first; the names checked. */
  checkVerdicts = new Map<string, OwnAddressCheckResponse['verdict']>();
  checkRefusal: ManagerCallError | null = null;
  checked: string[] = [];
  async ownAddressCheck(label: string): Promise<OwnAddressCheckResponse> {
    this.checked.push(label);
    const refusal = this.checkRefusal;
    this.checkRefusal = null;
    if (refusal) throw refusal;
    return { v: 1, label, verdict: this.checkVerdicts.get(label) ?? 'free' };
  }
  /**
   * A rename as control does it: the new name in the current host's zone, no certificate yet, and the earlier host
   * leaving for 30 days (an address already leaving keeps its date). A refusal answered first; the names asked for.
   */
  renameRefusal: ManagerCallError | null = null;
  renamed: string[] = [];
  async ownAddressRename(label: string): Promise<OwnAddressStateResponse> {
    this.renamed.push(label);
    const before = this.ownAddress;
    if (!before?.host || !before.label)
      throw new ManagerCallError('/v1/own-address/rename', 404, 'own_address.off', 'off');
    const refusal = this.renameRefusal;
    this.renameRefusal = null;
    if (refusal) throw refusal;
    if (label === before.label) return before;
    const zone = before.host.slice(before.host.indexOf('.') + 1);
    const until = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const { cert: _cert, ...rest } = before;
    this.ownAddress = {
      ...rest,
      label,
      host: `${label}.${zone}`,
      acme: { state: 'probing' },
      leaving: before.leaving ?? { label: before.label, host: before.host, until },
    };
    return this.ownAddress;
  }
  async ownAddressCt(): Promise<OwnAddressCtResponse> {
    if (!this.ownAddressWatch)
      throw new ManagerCallError('/v1/own-address/ct', 404, 'own_address.off', 'off');
    return this.ownAddressWatch;
  }
  /** Control's account link codes: code → email; refusals by code (`link_code_invalid`, …). */
  linkCodes = new Map<string, string>();
  linkRefusal: ManagerCallError | null = null;
  linked: string[] = [];
  async accountLinkLookup(request: { code: string }) {
    if (this.linkRefusal) throw this.linkRefusal;
    const email = this.linkCodes.get(request.code);
    if (!email)
      throw new ManagerCallError(
        '/v1/runtime/account/link-lookup',
        502,
        'control_refused',
        'link_code_invalid',
      );
    return { email, expiresAt: Math.floor(Date.now() / 1000) + 600 };
  }
  async accountLink(request: { code: string }) {
    if (this.linkRefusal) throw this.linkRefusal;
    const email = this.linkCodes.get(request.code);
    if (!email)
      throw new ManagerCallError('/v1/runtime/account/link', 502, 'control_refused', 'link_code_invalid');
    this.linked.push(request.code);
    return { email, linkedAt: Math.floor(Date.now() / 1000) };
  }
  /** The box-passkey sets declared; `declareFails` answers with that error instead. */
  declared: string[][] = [];
  declareFails: ManagerCallError | null = null;
  async kitCredentials(request: { credentialIds: string[] }) {
    if (this.declareFails) throw this.declareFails;
    this.declared.push([...request.credentialIds]);
    return { declared: request.credentialIds.length };
  }
  /** The own-address label control signs into the tickets (`lbl`); null: none, as before contracts 4.3. */
  ticketLabel: string | null = null;
  async ticket(cls: 'interactive' | 'bulk'): Promise<AdmissionTicket> {
    this.tickets++;
    this.classes.push(cls);
    const payload = this.ticketLabel
      ? Buffer.from(JSON.stringify({ lbl: this.ticketLabel })).toString('base64url')
      : 'bbbbbbbb';
    return {
      ticket: `aaaaaaaaaaaaaaaa.${payload}.c${this.tickets}`,
      relayUrl: this.relayUrl,
      worker: 'wrk-test',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
  }
  async reportClaimed(input: { claimId: string; claimedAt: string }): Promise<void> {
    if (this.failReports) throw new Error('control unreachable');
    this.claimed.push(input);
  }
  async reportRevocation(input: { peerId: string; revokedAt: string }): Promise<void> {
    if (this.failReports) throw new Error('control unreachable');
    this.revocations.push(input);
  }
  /** A manager on contracts 0.50: a request with `preview` or `clear` is refused (strict schema, NT-18). */
  before051 = false;
  async push(request: ControlPushRequest): Promise<PushResult> {
    if (this.before051 && ('preview' in request || 'clear' in request))
      throw new ManagerCallError('/v1/runtime/push', 400, 'bad_request', 'unrecognized key(s) in object');
    this.pushes.push(request);
    return { accepted: request.handles.length, invalidHandles: [], rateLimited: false };
  }
  /** Forced licence renewals asked for; `onRenew` answers them (default: control unreachable). */
  renewals = 0;
  onRenew: () => Promise<{ v: 1; renewed: boolean; error?: string }> = async () => ({
    v: 1,
    renewed: false,
    error: 'unreachable',
  });
  async renewLicence() {
    this.renewals++;
    return this.onRenew();
  }
  /** What `hostMetrics` was asked; `onHostMetrics` answers (default: a manager before 0.78, 404). */
  hostMetricsRequests: z.output<typeof HostMetricsRequest>[] = [];
  onHostMetrics: ((request: z.output<typeof HostMetricsRequest>) => Promise<unknown>) | null = null;
  async hostMetrics(request: z.input<typeof HostMetricsRequest>) {
    this.hostMetricsRequests.push(request);
    if (!this.onHostMetrics)
      throw new ManagerCallError(MANAGER_PATHS.hostMetrics, 404, 'not_found', 'manager: 404 not found');
    // Checked as the socket client checks the manager's answer.
    return HostMetricsResponse.parse(await this.onHostMetrics(request));
  }
  /**
   * The box behind the hardware and network routes (hardware-support-server.md HD-S08): a Z13-like machine with a cable
   * and Wi-Fi in reach. Tests replace it to give it their clock (`new FakeHost(clock, timings)`) or set its knobs.
   */
  host = new FakeHost();
  async hostHardware() {
    return HostHardwareResponse.parse(this.host.hostHardware());
  }
  async networkState() {
    return NetworkStateResponse.parse(this.host.networkState());
  }
  async wifiScan() {
    return WifiScanResponse.parse(this.host.wifiScan());
  }
  async wifiJoin(request: z.input<typeof WifiJoinRequest>) {
    return WifiChangeResponse.parse(this.host.wifiJoin(WifiJoinRequest.parse(request)));
  }
  async wifiForget(request: z.input<typeof WifiForgetRequest>) {
    return WifiChangeResponse.parse(this.host.wifiForget(WifiForgetRequest.parse(request)));
  }
  async networkCable(request: z.input<typeof CableSetRequest>) {
    return CableChangeResponse.parse(this.host.cableSet(CableSetRequest.parse(request)));
  }
  /**
   * Ask before updating (ask-before-updating.md ABU-02), kept as the manager keeps it: the switch, the release waiting
   * for the owner (tests set it) and the releases approved.
   */
  askFirst = false;
  ownerWaits: string | null = null;
  approved: string[] = [];
  async updateAsk(request: z.input<typeof UpdateAskRequest>) {
    this.askFirst = UpdateAskRequest.parse(request).askFirst;
    return { v: 1 as const, askFirst: this.askFirst };
  }
  /**
   * Whombat Link as the manager keeps it (4.4; whombat-link.md): null answers 404, as a manager from before Link. `linkOn`
   * answers `starting` with a code (the state it has while Link runs); `linkFails` answers the owner's changes with that error instead.
   */
  link: LinkStateResponse | null = null;
  linkOns: { contentProof: string; name?: string | undefined }[] = [];
  linkOffs = 0;
  linkFails: ManagerCallError | null = null;
  /** Sets Link's state as control would have moved it (tests). */
  setLink(state: LocalLinkStatus['state'], extra: Partial<LocalLinkStatus> = {}): void {
    this.link = {
      v: 1,
      enabled: true,
      link: { state, since: new Date().toISOString(), ...extra },
    };
  }
  async linkState(): Promise<LinkStateResponse> {
    if (!this.link)
      throw new ManagerCallError(MANAGER_PATHS.linkState, 404, 'not_found', 'manager: 404 not found');
    return this.link;
  }
  async linkOn(request: { contentProof: string; name?: string | undefined }): Promise<LinkStateResponse> {
    if (!this.link) throw new ManagerCallError(MANAGER_PATHS.linkOn, 404, 'link.unavailable', 'no Link');
    if (this.linkFails) throw this.linkFails;
    this.linkOns.push({ contentProof: request.contentProof, name: request.name });
    // While Link runs the manager answers the state control has (the box giving its name), as the real one does.
    const runs = this.link.link.state === 'on' || this.link.link.state === 'grace';
    if (runs) return this.link;
    this.setLink('starting', {
      pending: {
        code: 'ABCD-EFGH',
        url: 'https://app.whombat.test/link',
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      },
    });
    return this.link;
  }
  async linkOff(): Promise<LinkStateResponse> {
    if (!this.link) throw new ManagerCallError(MANAGER_PATHS.linkOff, 404, 'link.unavailable', 'no Link');
    if (this.linkFails) throw this.linkFails;
    this.linkOffs++;
    this.setLink('off');
    return this.link;
  }
  /**
   * The claim links the runtime handed over (4.13), null for “none”; `linkClaimMissing` answers 404, as a manager from
   * before the route.
   */
  linkClaims: (string | null)[] = [];
  linkClaimMissing = false;
  async linkClaim(request: { claimLink?: string | undefined }): Promise<void> {
    if (this.linkClaimMissing)
      throw new ManagerCallError(MANAGER_PATHS.linkClaim, 404, 'not_found', 'manager: 404 not found');
    this.linkClaims.push(request.claimLink ?? null);
  }
  /**
   * The account's other Whombats as control answers them (4.14); answered only while Link runs (404 otherwise, as the
   * manager). `whombatsFail` answers with that error instead; `whombatsCalls` counts the asks.
   */
  whombats: RuntimeLinkWhombatsResponse['whombats'] = [];
  whombatsFail: ManagerCallError | null = null;
  whombatsCalls = 0;
  async linkWhombats(): Promise<RuntimeLinkWhombatsResponse> {
    this.whombatsCalls++;
    const state = this.link?.link.state;
    if (!this.link || !(state === 'starting' || state === 'on' || state === 'grace'))
      throw new ManagerCallError(MANAGER_PATHS.linkWhombats, 404, 'link.unavailable', 'Link isn’t on');
    if (this.whombatsFail) throw this.whombatsFail;
    return { whombats: this.whombats };
  }
  /**
   * Email through Link (4.15): the choices and emails as control was handed them, while control knows the box (404
   * otherwise, as the manager). `mailFail` answers with that error instead.
   */
  mailChoices: { offline: boolean; notifications: boolean }[] = [];
  mails: z.output<typeof RuntimeMailSendRequest>[] = [];
  mailFail: ManagerCallError | null = null;
  private mailKnown(path: string): void {
    if (!this.link || this.link.link.state === 'off')
      throw new ManagerCallError(path, 404, 'unavailable', 'Whombat Link is off on this Whombat');
    if (this.mailFail) throw this.mailFail;
  }
  async linkMailSet(request: z.input<typeof RuntimeLinkMailSetRequest>): Promise<void> {
    this.mailKnown(MANAGER_PATHS.linkMail);
    this.mailChoices.push(RuntimeLinkMailSetRequest.parse(request));
  }
  async mailSend(request: z.input<typeof RuntimeMailSendRequest>): Promise<void> {
    this.mailKnown(MANAGER_PATHS.mailSend);
    this.mails.push(RuntimeMailSendRequest.parse(request));
  }
  /** The update channel the helper keeps (4.4); null answers 404 `update.channel_unavailable`. */
  channel: { channel: 'production' | 'development'; staysOn?: string } | null = null;
  /** What a switch to production leaves the box on until production passes it (tests set it). */
  staysOnAfterSwitch: string | null = null;
  async updateChannel() {
    if (!this.channel)
      throw new ManagerCallError(MANAGER_PATHS.updateChannel, 404, 'update.channel_unavailable', 'none');
    return { v: 1 as const, ...this.channel };
  }
  async updateChannelSet(request: z.input<typeof UpdateChannelSetRequest>) {
    if (!this.channel)
      throw new ManagerCallError(MANAGER_PATHS.updateChannelSet, 404, 'update.channel_unavailable', 'none');
    const { channel } = UpdateChannelSetRequest.parse(request);
    const stays =
      channel === 'production' && this.channel.channel === 'development' ? this.staysOnAfterSwitch : null;
    this.channel = { channel, ...(stays ? { staysOn: stays } : {}) };
    return { v: 1 as const, ...this.channel };
  }
  /** Phones' tokens control registered for this box, by handle; refused (404) while Link isn't running. */
  pushHandles = new Map<string, { platform: string; token: string; appId: string }>();
  pushUnregistered: string[] = [];
  async pushRegister(request: { token: { platform: 'apns' | 'fcm'; token: string; appId: string } }) {
    const state = this.link?.link.state;
    if (!this.link || !(state === 'starting' || state === 'on' || state === 'grace'))
      throw new ManagerCallError(MANAGER_PATHS.pushRegister, 404, 'unavailable', 'Link isn’t on');
    // As control: one handle per token of the box (an upsert), so the same token registered again gets the same one.
    const same = [...this.pushHandles].find(
      ([, t]) =>
        t.platform === request.token.platform &&
        t.token === request.token.token &&
        t.appId === request.token.appId,
    );
    const handle = same?.[0] ?? `box-${randomBytes(16).toString('hex')}`;
    this.pushHandles.set(handle, request.token);
    return { handle };
  }
  async pushUnregister(request: { handle: string }) {
    this.pushHandles.delete(request.handle);
    this.pushUnregistered.push(request.handle);
  }
  async updateApprove(request: z.input<typeof UpdateApproveRequest>) {
    const { release } = UpdateApproveRequest.parse(request);
    if (this.ownerWaits !== release)
      throw new ManagerCallError(
        MANAGER_PATHS.updateApprove,
        409,
        'not_waiting',
        'no update waits for the owner',
      );
    this.approved.push(release);
    this.ownerWaits = null;
    return { v: 1 as const, release };
  }
  /** The box's Tailscale behind the manager (direct-connection.md DC-16): never this machine's own. */
  tailscale = new FakeTailscale();
  tailscaleState() {
    return this.tailscale.tailscaleState();
  }
  tailscaleOn(input: { loginServer?: string } = {}) {
    return this.tailscale.tailscaleOn(input);
  }
  tailscaleOff(input: { signOut?: boolean }) {
    return this.tailscale.tailscaleOff(input);
  }
  tailscaleSignIn() {
    return this.tailscale.tailscaleSignIn();
  }
  tailscalePeers() {
    return this.tailscale.tailscalePeers();
  }
  tailscaleCert() {
    return this.tailscale.tailscaleCert();
  }
}

/**
 * A manager's measurements (BS-02…BS-05): a data disk of 100 GB with 86 GB used and 13 GB free, its parts, and the
 * range's points (`points` of them, all measured) ending a step before `at`.
 */
export function sampleHostMetrics(
  over: { at?: string; range?: HostMetrics['series']['range']; points?: number; timeZone?: string } = {},
  disks: Partial<HostMetrics['disks']['data']> = {},
): HostMetrics {
  const at = over.at ?? '2026-10-11T10:00:00.000Z';
  const range = over.range ?? 'hour';
  const stepS = HOST_METRICS_STEP_S[range];
  const n = over.points ?? 3;
  const point = {
    cpuPermille: 124,
    cpuPeakPermille: 860,
    memoryUsedBytes: 6_000_000_000,
    inBytes: 1_200_000,
    outBytes: 300_000,
  };
  return {
    now: {
      at,
      cpuPermille: 124,
      cores: 8,
      memoryTotalBytes: 16_000_000_000,
      memoryUsedBytes: 6_000_000_000,
      containersMemoryBytes: 2_500_000_000,
      uplink: ['enp1s0'],
    },
    disks: {
      data: {
        totalBytes: 100_000_000_000,
        usedBytes: 86_000_000_000,
        freeBytes: 13_000_000_000,
        parts: [
          { key: 'containers', bytes: 22_900_000_000 },
          { key: 'whombat', bytes: 9_000_000_000 },
          { key: 'work', bytes: 30_100_000_000 },
          { key: 'database', bytes: 2_000_000_000 },
        ],
        ...disks,
      },
      system: { totalBytes: 20_000_000_000, usedBytes: 8_000_000_000, freeBytes: 12_000_000_000 },
      backup: null,
    },
    series: {
      range,
      start: new Date(new Date(at).getTime() - (n + 1) * stepS * 1000).toISOString(),
      stepS,
      points: Array.from({ length: n }, () => point),
    },
    days: [
      {
        date: at.slice(0, 10),
        inBytes: 41_000_000,
        outBytes: 9_000_000,
      },
    ],
    timeZone: over.timeZone ?? 'UTC',
    measuringSince: '2026-10-01T00:00:00.000Z',
  };
}

class Queue {
  private items: (Uint8Array | null)[] = [];
  private waiters: ((v: Uint8Array | null) => void)[] = [];
  push(v: Uint8Array | null): void {
    const w = this.waiters.shift();
    if (w) w(v);
    else this.items.push(v);
  }
  next(): Promise<Uint8Array | null> {
    if (this.items.length) return Promise.resolve(this.items.shift() as Uint8Array | null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export interface TestIdentity {
  peerId: string;
  publicKey: string;
  secretKey: string;
}

/** A real Ed25519 key and its libp2p PeerId. */
export function testIdentity(): TestIdentity {
  const pair = generateKeypair();
  return {
    peerId: peerIdFromEd25519PublicKey(hexToBytes(pair.publicKey)),
    publicKey: pair.publicKey,
    secretKey: pair.secretKey,
  };
}

/** A pair of connected byte pipes; the appliance side reports the client's identity like Noise would. */
export function memoryChannelPair(identity: TestIdentity): {
  server: SecureMessageChannel;
  client: { send(b: Uint8Array): void; receive(): Promise<Uint8Array | null>; close(): void };
} {
  const toServer = new Queue();
  const toClient = new Queue();
  let open = true;
  const server: SecureMessageChannel = {
    remotePeerId: identity.peerId,
    remotePublicKey: hexToBytes(identity.publicKey),
    async send(m) {
      if (open) toClient.push(m);
    },
    receive: () => toServer.next(),
    async close() {
      if (!open) return;
      open = false;
      toClient.push(null);
      toServer.push(null);
    },
    abort() {
      void server.close();
    },
  };
  return {
    server,
    client: {
      send: (b) => {
        if (open) toServer.push(b);
      },
      receive: () => toClient.next(),
      close: () => void server.close(),
    },
  };
}

type Answer = Extract<ApplianceMessage, { t: 'result' | 'error' | 'outcome' }>;

/** A session client for tests: CONTROL messages, streams with credit, and a log of everything received. */
export class TestSessionClient {
  readonly identity: TestIdentity;
  readonly connection: SessionConnection;
  readonly received: ApplianceMessage[] = [];
  readonly streamData = new Map<number, Uint8Array[]>();
  readonly streamEnded = new Set<number>();
  readonly streamReset = new Map<number, number>();
  /** Bytes this client may still send per stream (the appliance's initial window plus its CREDIT frames). */
  readonly sendCredit = new Map<number, number>();
  /** Drop `accepted` messages (a lost acknowledgement). */
  dropAccepted = false;
  /** Grant credit automatically as stream bytes arrive (a well-behaved reader). */
  autoCredit = true;
  private readonly pipe: ReturnType<typeof memoryChannelPair>['client'];
  private readonly waiters: {
    pred: (m: ApplianceMessage) => boolean;
    resolve: (m: ApplianceMessage) => void;
  }[] = [];
  private streamWaiters: (() => void)[] = [];
  private nextStream = 1;
  readonly closed: Promise<string>;

  constructor(
    runtime: ManagedRuntime,
    identity: TestIdentity = testIdentity(),
    /** `doorPeer`: at the box's own address, the visitor's address as the door saw it. */
    options: { transport?: SessionTransport; doorPeer?: string } = {},
  ) {
    this.identity = identity;
    const pair = memoryChannelPair(identity);
    this.pipe = pair.client;
    this.connection = new SessionConnection(
      runtime,
      pair.server,
      {
        encode: encodeFrame,
        decoder: () => new FrameDecoder(),
      },
      {
        ...(options.transport ? { transport: options.transport } : {}),
        ...(options.doorPeer ? { doorPeer: options.doorPeer } : {}),
      },
    );
    this.closed = this.connection.run();
    void this.pump();
  }

  private async pump(): Promise<void> {
    const decoder = new FrameDecoder();
    for (;;) {
      const bytes = await this.pipe.receive();
      if (bytes === null) return;
      for (const frame of decoder.push(bytes)) {
        if (frame.type === 'control') {
          const decoded = decodeApplianceMessage(frame.payload);
          // A message type this client's contracts don't know is ignored, as the protocol says (a newer minor's).
          if (!decoded.ok && decoded.kind === 'unknown_type') continue;
          if (!decoded.ok)
            throw new Error(`the appliance sent an invalid message: ${JSON.stringify(decoded)}`);
          const msg = decoded.message;
          if (msg.t === 'accepted' && this.dropAccepted) continue;
          this.received.push(msg);
          for (const w of [...this.waiters])
            if (w.pred(msg)) {
              this.waiters.splice(this.waiters.indexOf(w), 1);
              w.resolve(msg);
            }
        } else if (frame.type === 'data') {
          const list = this.streamData.get(frame.streamId) ?? [];
          list.push(frame.payload);
          this.streamData.set(frame.streamId, list);
          if (this.autoCredit)
            this.frame({ type: 'credit', streamId: frame.streamId, credit: frame.payload.length });
        } else if (frame.type === 'credit') {
          this.sendCredit.set(
            frame.streamId,
            (this.sendCredit.get(frame.streamId) ?? INITIAL_CREDIT) + frame.credit,
          );
        } else if (frame.type === 'end') this.streamEnded.add(frame.streamId);
        else if (frame.type === 'reset') this.streamReset.set(frame.streamId, frame.code);
        this.notifyStream();
      }
    }
  }

  private notifyStream(): void {
    for (const w of this.streamWaiters.splice(0)) w();
  }

  frame(frame: Frame): void {
    this.pipe.send(encodeFrame(frame));
  }

  send(msg: ClientMessage): void {
    this.frame({ type: 'control', streamId: 0, payload: encodeSessionMessage(msg) });
  }

  waitFor(pred: (m: ApplianceMessage) => boolean, timeoutMs = 10_000): Promise<ApplianceMessage> {
    const found = this.received.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a session message')), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  async hello(
    /** `claimLink`: the claim link's secret a page at the box's own address was opened with. */
    options: { cachedAuthzGeneration?: number; cachedAccountId?: string; claimLink?: string } = {},
    /** The session minor this client speaks (an older app's is lower). */
    minor: number = SESSION_PROTOCOL.minor,
  ): Promise<ApplianceMessage> {
    this.send({
      t: 'hello',
      versions: [{ ...SESSION_PROTOCOL, minor }],
      capabilities: [
        'events',
        'stream.download',
        'stream.upload',
        'stream.export',
        'stream.collab',
        'stream.console',
        'enroll',
        'recovery',
      ],
      client: { build: 'test', platform: 'web' },
      ...options,
    });
    return this.waitFor((m) => m.t === 'welcome' || m.t === 'error');
  }

  newId(): string {
    return `req_${randomBytes(12).toString('base64url')}`;
  }

  /** Sends a request and waits for its final answer (`result`, `error` or `outcome`). */
  async request(
    op: string,
    input: unknown,
    options: { id?: string; deadlineMs?: number } = {},
  ): Promise<Answer> {
    const id = options.id ?? this.newId();
    const already = this.received.length;
    this.send({
      t: 'request',
      id,
      op,
      input: (input ?? {}) as never,
      deadlineMs: options.deadlineMs ?? 30_000,
    });
    return (await this.waitFor(
      (m) =>
        this.received.indexOf(m) >= already &&
        (m.t === 'result' || m.t === 'error' || m.t === 'outcome') &&
        (m as { id?: string }).id === id,
    )) as Answer;
  }

  /** Opens a stream; resolves with `opened` or the refusing `error`. */
  async open(
    spec: Extract<ClientMessage, { t: 'open' }>['spec'],
  ): Promise<{ stream: number; answer: ApplianceMessage }> {
    const stream = this.nextStream;
    this.nextStream += 2;
    this.send({ t: 'open', stream, spec });
    const answer = await this.waitFor(
      (m) => (m.t === 'opened' || m.t === 'error') && (m as { stream?: number }).stream === stream,
    );
    return { stream, answer };
  }

  /** Waits until a stream ended (or was reset) and returns its bytes. */
  async readStream(
    streamId: number,
    timeoutMs = 10_000,
  ): Promise<{ bytes: Uint8Array; reset: number | null }> {
    const deadline = Date.now() + timeoutMs;
    while (!this.streamEnded.has(streamId) && !this.streamReset.has(streamId)) {
      if (Date.now() > deadline) throw new Error('timed out reading a stream');
      await new Promise<void>((resolve) => {
        this.streamWaiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
    return {
      bytes: new Uint8Array(Buffer.concat(this.streamData.get(streamId) ?? [])),
      reset: this.streamReset.get(streamId) ?? null,
    };
  }

  /** Sends bytes on a stream in DATA frames (≤ 64 KiB). The initial credit covers what tests send per chunk. */
  write(streamId: number, bytes: Uint8Array): void {
    for (let o = 0; o < bytes.length; o += 65_536)
      this.frame({ type: 'data', streamId, payload: bytes.subarray(o, Math.min(bytes.length, o + 65_536)) });
  }

  /** Sends bytes on a stream as the appliance's credit allows (waits for CREDIT frames). */
  async writeWithCredit(streamId: number, bytes: Uint8Array, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let offset = 0;
    while (offset < bytes.length) {
      if (this.streamReset.has(streamId))
        throw new Error(
          `stream ${streamId} was reset (${this.streamReset.get(streamId)}) ${JSON.stringify(this.received.filter((m) => m.t === 'error').slice(-2))}`,
        );
      const credit = this.sendCredit.get(streamId) ?? INITIAL_CREDIT;
      if (credit <= 0) {
        if (Date.now() > deadline) throw new Error('timed out waiting for credit');
        await new Promise<void>((resolve) => {
          this.streamWaiters.push(resolve);
          setTimeout(resolve, 20);
        });
        continue;
      }
      const n = Math.min(credit, 65_536, bytes.length - offset);
      this.sendCredit.set(streamId, credit - n);
      this.frame({ type: 'data', streamId, payload: bytes.subarray(offset, offset + n) });
      offset += n;
    }
  }

  close(): void {
    this.pipe.close();
  }
}

export const INITIAL_CREDIT = SESSION_INITIAL_STREAM_CREDIT;

type ClaimAnswer = Awaited<ReturnType<TestSessionClient['request']>>;

/**
 * The client side of the claim ceremony (CC-06, CC-07) with the contracts' real initiator: `enroll.claim.begin`, then
 * `enroll.claim` with the client's tag. `appliancePeerId` is the PeerId the client believes it talks to (a different
 * one is the MITM case). `confirm` overrides the tag sent; `beginOnly` stops after the begin. Returns both answers and
 * the client's tags.
 */
export async function pakeClaim(
  client: TestSessionClient,
  ctx: {
    method: ClaimMethod;
    password: string;
    deviceId: string;
    appliancePeerId: string;
    claimId?: string;
  },
  input: {
    account: { name: string; email: string };
    endpoint: { label: string; platform: 'web' | 'android' | 'ios' | 'desktop' | 'cli' };
  },
  options: { confirm?: string; beginOnly?: boolean } = {},
): Promise<{ begin: ClaimAnswer; claim: ClaimAnswer | null; tags: ClaimConfirmTags | null }> {
  const claimId = ctx.claimId ?? 'clm_test_0001';
  const { share, state } = claimPakeInitiator(
    { ...ctx, claimId, clientPeerId: client.identity.peerId },
    (n) => new Uint8Array(randomBytes(n)),
  );
  const begin = await client.request('enroll.claim.begin', { claimId, method: ctx.method, share });
  if (begin.t !== 'result') return { begin, claim: null, tags: null };
  const tags = claimPakeInitiatorFinish(state, (begin.output as { share: string }).share);
  if (options.beginOnly) return { begin, claim: null, tags };
  const claim = await client.request('enroll.claim', {
    claimId,
    method: ctx.method,
    confirm: options.confirm ?? tags.client,
    ...input,
  });
  return { begin, claim, tags };
}

/**
 * The client side of the claim on the box's own page with the contracts' real initiator: `enroll.claim.local.start`
 * (skipped with `claimId`), `.begin`, `.prove` with the client's tag, and, only once the box's own tag checked out, the
 * claim with the person's account. `confirm` overrides the tag sent; `stop` ends after that step. Returns every answer
 * (null for a step not reached) and the client's tags.
 */
export async function pakeLocalClaim(
  client: TestSessionClient,
  ctx: { password: string; appliancePeerId: string; claimId?: string; link?: string },
  input: {
    account: { name: string; email: string };
    endpoint: { label: string; platform: 'web' | 'android' | 'ios' | 'desktop' | 'cli' };
  } = {
    account: { name: 'Mara', email: 'mara@example.com' },
    endpoint: { label: 'Laptop', platform: 'web' },
  },
  options: { confirm?: string; stop?: 'begin' | 'prove' } = {},
): Promise<{
  start: ClaimAnswer | null;
  begin: ClaimAnswer | null;
  prove: ClaimAnswer | null;
  claim: ClaimAnswer | null;
  tags: ClaimConfirmTags | null;
}> {
  const none = { start: null, begin: null, prove: null, claim: null, tags: null };
  let claimId = ctx.claimId;
  let start: ClaimAnswer | null = null;
  if (!claimId) {
    start = await client.request('enroll.claim.local.start', ctx.link ? { link: ctx.link } : {});
    if (start.t !== 'result') return { ...none, start };
    claimId = (start.output as { claimId: string }).claimId;
  }
  const { share, state } = localClaimPakeInitiator(
    {
      password: ctx.password,
      appliancePeerId: ctx.appliancePeerId,
      clientPeerId: client.identity.peerId,
      claimId,
    },
    (n) => new Uint8Array(randomBytes(n)),
  );
  const begin = await client.request('enroll.claim.local.begin', { claimId, share });
  if (begin.t !== 'result') return { ...none, start, begin };
  const tags = localClaimPakeInitiatorFinish(state, (begin.output as { share: string }).share);
  if (options.stop === 'begin') return { ...none, start, begin, tags };
  const prove = await client.request('enroll.claim.local.prove', {
    claimId,
    confirm: options.confirm ?? tags.client,
  });
  // As an app does: the person is named only to a box whose own proof checked out.
  const proved =
    prove.t === 'result' && claimConfirmEqual(tags.appliance, (prove.output as { confirm: string }).confirm);
  if (!proved || options.stop === 'prove') return { ...none, start, begin, prove, tags };
  const claim = await client.request('enroll.claim.local', { claimId, ...input });
  return { start, begin, prove, claim, tags };
}

/**
 * The device side of the screen sign-in (signin-at-box BX-02, BX-03) with the contracts' initiator:
 * `enroll.screen.request`, then `enroll.screen.begin` with the letters `letters()` reads off the box's screen after
 * the request (or `signinId` to skip the request), then `enroll.screen` with the device's tag. `appliancePeerId` is the
 * PeerId the device believes it talks to. Returns every answer and the device's tags.
 */
export async function pakeScreen(
  client: TestSessionClient,
  ctx: {
    endpoint: { label: string; platform: 'web' | 'android' | 'ios' | 'desktop' | 'cli' };
    deviceId: string;
    appliancePeerId: string;
    letters: () => string;
    signinId?: string;
  },
  options: { beginOnly?: boolean } = {},
): Promise<{
  request: ClaimAnswer | null;
  begin: ClaimAnswer | null;
  enroll: ClaimAnswer | null;
  signinId: string | null;
  tags: ClaimConfirmTags | null;
}> {
  let signinId = ctx.signinId ?? null;
  let request: ClaimAnswer | null = null;
  if (!signinId) {
    request = await client.request('enroll.screen.request', { endpoint: ctx.endpoint });
    if (request.t !== 'result') return { request, begin: null, enroll: null, signinId: null, tags: null };
    signinId = (request.output as { signinId: string }).signinId;
  }
  const { share, state } = screenSignInPakeInitiator(
    {
      password: ctx.letters(),
      deviceId: ctx.deviceId,
      appliancePeerId: ctx.appliancePeerId,
      clientPeerId: client.identity.peerId,
      signinId,
    },
    (n) => new Uint8Array(randomBytes(n)),
  );
  const begin = await client.request('enroll.screen.begin', { signinId, share });
  if (begin.t !== 'result') return { request, begin, enroll: null, signinId, tags: null };
  const tags = screenSignInPakeInitiatorFinish(state, (begin.output as { share: string }).share);
  if (options.beginOnly) return { request, begin, enroll: null, signinId, tags };
  const enroll = await client.request('enroll.screen', { signinId, confirm: tags.client });
  return { request, begin, enroll, signinId, tags };
}

/* Licence tokens (MR-55) ------------------------------------------------------------------------------------------ */

/** The TEST licence key behind `managed/__fixtures__/licence-keys.json` (public seed; never a real key). */
export const TEST_LICENCE_SECRET = sha256Hex('whombat/test-licence-key/1');
export const TEST_LICENCE_KID = 'lic-test-1';

/** A licence key set for `secret` (tests make foreign ones). */
export function testLicenceKeySet(
  secret = TEST_LICENCE_SECRET,
  kid = TEST_LICENCE_KID,
  env = 'test',
): LicenceKeySet {
  return { v: 1, env, keys: [ed25519Jwk(kid, hexToBytes(publicKeyOf(secret)))] };
}

/** Claims control would sign for `device`: active, issued at `iat` (epoch seconds, default now), 14 days. */
export function testLicenceClaims(
  device: string,
  overrides: Partial<LicenceClaims> & { iat?: number } = {},
): LicenceClaims {
  const iat = overrides.iat ?? Math.floor(Date.now() / 1000);
  return {
    iss: 'https://api.whombat.test',
    aud: 'whombat-appliance:test',
    sub: device,
    org: 'org_test',
    plan: 'team',
    state: 'active',
    limits: { devices: 3, connectors: null },
    nbf: iat,
    exp: iat + LICENCE_LIFETIME_S,
    jti: randomBytes(18).toString('base64url'),
    ...overrides,
    iat,
  };
}

/** A licence token signed with the TEST key (or `secret`/`kid`). */
export function signTestLicence(
  claims: LicenceClaims,
  options: { secret?: string; kid?: string } = {},
): string {
  const secret = options.secret ?? TEST_LICENCE_SECRET;
  return signLicenceToken(
    { alg: 'EdDSA', kid: options.kid ?? TEST_LICENCE_KID, typ: 'whombat-licence+jwt' },
    claims,
    (message) => hexToBytes(signBytes(message, secret)),
  );
}

/** A way into the box on its local network, for tests that make device links (`enroll.link.create`, HE-S212). */
export const TEST_WAYS = [
  { way: 'lan' as const, socket: 'ws://192.168.1.20:4900/v1/direct', web: 'http://192.168.1.20:4900/' },
];
