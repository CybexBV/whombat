/**
 * One session (MA-08; `@whombat/protocol/session`): the CONTROL loop and the streams of one authenticated
 * channel. The channel's remote identity is the endpoint key; everything the session may do follows from it
 * (`trust.identify`), re-checked before every request. Frames are `@whombat/protocol`'s (`[u32 len][u8 type]
 * [u32 stream][payload]` over the Noise byte stream, CT-05); CONTROL payloads are `SessionMessage`s, validated by
 * the protocol's codec on the way in and out. Nothing here trusts the relay: the channel is end to end.
 */
import { bytesToHex, parseTopic } from '@whombat/core';
import {
  SESSION_HELLO_TIMEOUT_MS,
  SESSION_INITIAL_STREAM_CREDIT,
  SESSION_MAX_CONTROL_BYTES,
  SESSION_MAX_DATA_BYTES,
  SESSION_MAX_INFLIGHT_REQUESTS,
  SESSION_MAX_OPEN_STREAMS,
  SESSION_MAX_SUBSCRIPTIONS,
} from '@whombat/protocol';
import {
  ALL_CAPABILITIES,
  type ApplianceMessage,
  appErrorCode,
  type ClientMessage,
  decodeClientMessage,
  encodeSessionMessage,
  negotiateCapabilities,
  negotiateVersion,
  RETRYABLE_ERROR_CODES,
  SESSION_PROTOCOL,
  type SessionErrorCode,
} from '@whombat/protocol/session';
import { clientBelowFloor } from '@whombat/release';
import { and, eq, inArray } from 'drizzle-orm';
import { eventFor } from '../../automations/older-apps';
import { principals } from '../../db/schema/index';
import { hostsEventFor } from '../../hosts/older-apps';
import { presenceFor } from '../../realtime/presence-tracker';
import type { SessionScope } from '../claim';
import type { SessionTransport } from '../direct/transport';
import { errorAnswer, type RequestAnswer, RequestControl, SESSION_EXPORT_READS } from '../dispatcher';
import type { Frame, FrameCodec, SecureMessageChannel } from '../ports';
import { STREAM_RESET } from '../ports';
import {
  type OpenedStream,
  openCollab,
  openConsole,
  openDownload,
  openExport,
  type StreamContext,
} from '../resources';
import type { ManagedRuntime } from '../runtime';
import { isScreenSession, type SessionPrincipal } from '../trust';
import { CollabBudget } from './collab-decoder';
import type { SessionWay } from './registry';
import { SendBudget, SessionStream } from './streams';

export type CloseReason =
  | 'endpoint_revoked'
  | 'authz_changed'
  | 'protocol_error'
  | 'closed'
  | 'shutdown'
  | 'update'
  | 'rekey'
  | 'idle'
  | 'overload'
  // New letters were asked for at the box: every device still setting up starts again, at no cost to its address.
  | 'new_letters';

type Request = Extract<ClientMessage, { t: 'request' }>;
type EventMessage = Extract<ApplianceMessage, { t: 'event' }>;

/**
 * One subscription id of this session (docs/decisions/box-health.md BH-05): every `subscribe` and `unsubscribe` of the
 * id bumps `generation`, so a subscribe whose answer is superseded while it awaits sees it, closes what it registered
 * and sends nothing; `close` is the live registration in the event log, once a subscribe was answered.
 */
interface SubscriptionSlot {
  generation: number;
  close: (() => void) | null;
}

/** The bytes a CONTROL message takes as JSON (what the codec measures against `SESSION_MAX_CONTROL_BYTES`). */
function controlBytes(message: ApplianceMessage): number {
  try {
    return Buffer.byteLength(JSON.stringify(message), 'utf8');
  } catch {
    return 0;
  }
}

export interface SessionConnectionOptions {
  /** How the session reached the box (direct-connection.md DC-10); unset: the relay. */
  transport?: SessionTransport;
  /** Through the box's own address: the visitor's address as the door saw it, which its unenrolled sessions count under. */
  doorPeer?: string;
}

/** Sessions opened so far in this process: each gets its own presence key. */
let presenceSessions = 0;

export class SessionConnection {
  principal: SessionPrincipal | null = null;
  /** The session protocol's minor agreed at `hello`, carried on the principal. */
  private minor = 0;
  private readonly streams = new Map<number, SessionStream>();
  private readonly uploadChunks = new Map<number, NonNullable<OpenedStream['onChunk']>>();
  private readonly budget = new SendBudget();
  /** Partially received collaboration messages, across this session's collab streams (MR-33). */
  private readonly collabBudget = new CollabBudget();
  private readonly inflight = new Map<string, RequestControl>();
  /** This session's own state for session ops: the live claim and screen sign-in begins (CC-07, MR-49). Memory only. */
  readonly scope: SessionScope = { claimBegin: null, presenceKey: `session:${++presenceSessions}:` };
  private readonly subscriptions = new Map<string, SubscriptionSlot>();
  private sendChain: Promise<void> = Promise.resolve();
  private closed = false;
  /** Unenrolled sessions: the idle and lifetime timers (MR-28). */
  private idleTimer: NodeJS.Timeout | null = null;
  private lifeTimer: NodeJS.Timeout | null = null;
  private readonly frameDecoder: { push(bytes: Uint8Array): Frame[] };
  readonly done: Promise<CloseReason>;
  private finish!: (reason: CloseReason) => void;

  constructor(
    private readonly runtime: ManagedRuntime,
    private readonly channel: SecureMessageChannel,
    private readonly codec: FrameCodec,
    private readonly options: SessionConnectionOptions = {},
  ) {
    if (options.transport) this.scope.transport = options.transport;
    if (options.doorPeer !== undefined) this.scope.doorPeer = options.doorPeer;
    this.frameDecoder = codec.decoder();
    this.done = new Promise((resolve) => {
      this.finish = resolve;
    });
  }

  get peerId(): string {
    return this.channel.remotePeerId;
  }

  /* Sending ------------------------------------------------------------------------------------ */

  private sendFrame(frame: Frame): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.sendChain = this.sendChain
      .then(() => this.channel.send(this.codec.encode(frame)))
      .catch((err) => {
        // A channel at its rekey limit is closed cleanly; the client reconnects with a fresh handshake.
        void this.close(/rekey/i.test(String((err as Error)?.name ?? err)) ? 'rekey' : 'closed');
      });
    return this.sendChain;
  }

  /**
   * Validates (the protocol's codec) and sends one CONTROL message. `op` names the request a result answers, logged
   * (allowlisted, MR-42) when the answer doesn't encode, so an oversized read can be found. A subscription's events go
   * through `sendEvent`.
   */
  send(message: ApplianceMessage, op?: string): Promise<void> {
    let payload: Uint8Array;
    try {
      payload = encodeSessionMessage(message);
    } catch (err) {
      const named = op && this.runtime.dispatcher.allowlist.has(op) ? op : null;
      if (message.t === 'result' || message.t === 'outcome') {
        // Expected for a large read (a burrow's packs, a long activity list): the client reads it again through an
        // export stream (parity G-03), so this is a warning, not an error.
        this.runtime.services.log.warn(
          { err: String(err), t: message.t, op: named },
          'answer too large for a session message; the client reads it through an export stream',
        );
        return this.send(
          this.errorMessage(message.id, {
            code: 'too_large',
            message: 'The answer is larger than a session message; open an export stream for it.',
            details: { code: 'use_export_stream' },
          }),
        );
      }
      this.runtime.services.log.error(
        {
          err: String(err),
          t: message.t,
          op: named,
          ...(message.t === 'event' ? { type: message.event.type } : {}),
          bytes: controlBytes(message),
        },
        'session message did not encode',
      );
      return Promise.resolve();
    }
    return this.sendFrame({ type: 'control', streamId: 0, payload });
  }

  /**
   * Sends one event of a subscription (BH-03, BH-04). True when it went out, or when an ephemeral one was dropped
   * because it doesn't encode (warned: typing and presence are live only, the next one replaces it). False when a
   * lasting event doesn't encode — it was too large for a session message (logged as a warning) or invalid (an error):
   * nothing was sent and the caller drops the subscription with `snapshot_required` at its cursor, so the client
   * refetches that view instead of staying stale.
   */
  private sendEvent(message: EventMessage): boolean {
    let payload: Uint8Array;
    try {
      payload = encodeSessionMessage(message);
    } catch (err) {
      const bytes = controlBytes(message);
      const tooLarge = bytes > SESSION_MAX_CONTROL_BYTES;
      const about = { type: message.event.type, topic: message.topic, bytes };
      const log = this.runtime.services.log;
      if (message.ephemeral) {
        if (tooLarge) log.warn(about, 'ephemeral session event too large for a session message; dropped');
        else log.error({ ...about, err: String(err) }, 'session message did not encode');
        return true;
      }
      if (tooLarge)
        log.warn(about, 'session event too large for a session message; the client reloads that view');
      else
        log.error(
          { ...about, err: String(err) },
          'session event did not encode; the client reloads that view',
        );
      return false;
    }
    void this.sendFrame({ type: 'control', streamId: 0, payload });
    return true;
  }

  private errorMessage(
    id: string | undefined,
    e: { code: string; message: string; details?: unknown; fields?: Record<string, string[]> },
    stream?: number,
  ): ApplianceMessage {
    const code = e.code as SessionErrorCode;
    return {
      t: 'error',
      ...(id ? { id } : {}),
      ...(stream !== undefined ? { stream } : {}),
      code,
      message: e.message.slice(0, 1000),
      retryable: RETRYABLE_ERROR_CODES.has(code),
      ...(e.fields ? { fields: e.fields } : {}),
      ...(e.details !== undefined ? { details: e.details as never } : {}),
    } as ApplianceMessage;
  }

  /* Lifecycle ---------------------------------------------------------------------------------- */

  /** Runs the session until it closes. Resolves with why it closed. */
  async run(): Promise<CloseReason> {
    const helloTimer = setTimeout(() => void this.close('protocol_error'), SESSION_HELLO_TIMEOUT_MS);
    helloTimer.unref?.();
    try {
      for (;;) {
        const bytes = await this.channel.receive().catch(() => null);
        if (bytes === null || this.closed) break;
        let frames: Frame[];
        try {
          frames = this.frameDecoder.push(bytes);
        } catch {
          // Any framing error closes the session (CT-05).
          await this.close('protocol_error');
          break;
        }
        for (const frame of frames) {
          if (this.closed) break;
          if (frame.type !== 'control') {
            this.onStreamFrame(frame);
            continue;
          }
          const decoded = decodeClientMessage(frame.payload);
          if (!decoded.ok) {
            if (decoded.kind === 'unknown_type') continue; // a newer minor: skip
            await this.send(
              this.errorMessage(undefined, { code: 'invalid_message', message: decoded.error }),
            );
            await this.close('protocol_error');
            break;
          }
          if (!this.principal) {
            clearTimeout(helloTimer);
            if (!(await this.handshake(decoded.message))) break;
            continue;
          }
          this.onControl(decoded.message);
        }
      }
    } catch (err) {
      this.runtime.services.log.warn({ err: String(err) }, 'session failed');
    } finally {
      clearTimeout(helloTimer);
      await this.close('closed');
    }
    return this.done;
  }

  private async handshake(msg: ClientMessage): Promise<boolean> {
    if (msg.t !== 'hello') {
      await this.send(
        this.errorMessage(undefined, { code: 'protocol_error', message: 'The first message must be hello.' }),
      );
      await this.close('protocol_error');
      return false;
    }
    const version = negotiateVersion(msg.versions);
    if (!version) {
      this.runtime.counters.bump('sessionsRefusedVersion');
      await this.send(
        this.errorMessage(undefined, {
          code: 'unsupported_version',
          message: 'No common session protocol version.',
          details: {
            supported: { min: SESSION_PROTOCOL.major, max: SESSION_PROTOCOL.major },
            appliance: SESSION_PROTOCOL,
          },
        }),
      );
      await this.close('protocol_error');
      return false;
    }
    // The running release's client security floor (CT-53), on both channels: below it, refuse and close.
    const minBuild = clientBelowFloor(this.runtime.trust.clientFloor, msg.client);
    if (minBuild !== null) {
      this.runtime.counters.bump('sessionsRefusedVersion');
      await this.send(
        this.errorMessage(undefined, {
          code: 'unsupported_version',
          message: 'This app is too old for this appliance. Update it to connect.',
          details: {
            supported: { min: SESSION_PROTOCOL.major, max: SESSION_PROTOCOL.major },
            appliance: SESSION_PROTOCOL,
            code: 'client_below_security_floor',
            floor: { platform: msg.client.platform, minBuild },
          },
        }),
      );
      await this.close('protocol_error');
      return false;
    }
    const identity = await this.runtime.trust.identify(
      this.channel.remotePeerId,
      bytesToHex(this.channel.remotePublicKey),
      msg.client,
    );
    if (identity.revoked) {
      await this.send(
        this.errorMessage(undefined, {
          code: 'revoked',
          message: 'This device was removed from the appliance.',
        }),
      );
      await this.close('endpoint_revoked');
      return false;
    }
    // Capacity per class (MR-28): unenrolled keys never take the enrolled endpoints' places, those that came directly
    // never take the relay's (DC-06), and those at the box's own address never take the local network's.
    if (
      !this.runtime.sessions.attach(
        this,
        identity.endpoint !== null,
        this.way(identity.endpoint === null ? msg.claimLink : undefined),
        isScreenSession(identity) ? (identity.endpoint?.id ?? null) : null,
      )
    ) {
      await this.send(
        this.errorMessage(undefined, {
          code: 'too_many',
          message: identity.endpoint
            ? 'The appliance has too many sessions open. Try again in a moment.'
            : 'The appliance is busy with other devices that are enrolling. Try again in a minute.',
        }),
      );
      await this.close('overload');
      return false;
    }
    this.minor = version.minor;
    this.principal = { ...identity, protocolMinor: version.minor };
    this.runtime.counters.bump('sessionsOpened');
    // Which device opened a session, with which app build and which way: the box's own log of who was here when.
    if (identity.endpoint)
      this.runtime.services.log.info(
        { endpointId: identity.endpoint.id, build: msg.client.build, via: this.scope.transport?.via ?? null },
        'session opened',
      );
    if (!identity.endpoint) {
      this.touchUnenrolled();
      this.lifeTimer = setTimeout(
        () => this.runTask(this.closeIdle()),
        this.runtime.sessions.limits.unenrolledMaxMs,
      );
      this.lifeTimer.unref?.();
    }
    const summary = identity.account ? await this.runtime.trust.principalSummary(identity.account) : null;
    await this.send({
      t: 'welcome',
      version,
      capabilities: negotiateCapabilities(ALL_CAPABILITIES, msg.capabilities),
      appliance: this.runtime.trust.appliancePeerId,
      channel: identity.endpoint ? 'app' : 'enroll',
      principal: summary,
      endpointId: identity.endpoint?.id ?? null,
      authzGeneration: identity.authzGeneration,
      // A cache fetched under another generation, or as another account (CT-47; generations are unique across
      // accounts anyway, MR-36), must be cleared before use.
      clearCache:
        (msg.cachedAuthzGeneration !== undefined && msg.cachedAuthzGeneration !== identity.authzGeneration) ||
        (msg.cachedAccountId !== undefined && msg.cachedAccountId !== (identity.account?.id ?? null)),
      limits: {
        maxControlBytes: SESSION_MAX_CONTROL_BYTES,
        maxDataBytes: SESSION_MAX_DATA_BYTES,
        maxOpenStreams: SESSION_MAX_OPEN_STREAMS,
        maxInflightRequests: SESSION_MAX_INFLIGHT_REQUESTS,
        initialStreamCredit: SESSION_INITIAL_STREAM_CREDIT,
      },
      serverTime: this.runtime.services.clock().toISOString(),
      // How to reach the box without the relay (HE-50, DC-12): for enrolled devices only.
      direct: identity.endpoint ? (this.runtime.direct?.addresses() ?? null) : null,
      // Which edition this box is (CT-1300, HE-S205): every channel, so a page knows before it enrols.
      edition: this.runtime.edition,
    });
    return true;
  }

  /**
   * How this session came in, for the class it counts in. At the box's own address a visitor that isn't enrolled may
   * show the claim link from the box's screen in its hello: while nobody claimed the box, a right one gets a place kept
   * for such visitors. A wrong one is a try of the visitor's address at the link, as it is when a claim starts.
   */
  private way(claimLink: string | undefined): SessionWay {
    const transport = this.scope.transport;
    if (transport?.via !== 'direct') return { via: 'relay' };
    if (transport.network !== 'door') return { via: 'local' };
    const trust = this.runtime.trust;
    const peer = this.options.doorPeer ?? '';
    const shown =
      claimLink !== undefined && trust.ceremony.claimed === false
        ? (trust.ownAddress?.claimLink.check(claimLink, peer) ?? false)
        : false;
    return { via: 'door', peer, claimLink: shown };
  }

  /** An unenrolled session's request: it stays open another `UNENROLLED_IDLE_MS`. */
  private touchUnenrolled(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(
      () => this.runTask(this.closeIdle()),
      this.runtime.sessions.limits.unenrolledIdleMs,
    );
    this.idleTimer.unref?.();
  }

  private clearUnenrolledTimers(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.lifeTimer) clearTimeout(this.lifeTimer);
    this.idleTimer = null;
    this.lifeTimer = null;
  }

  /** An unenrolled session that didn't enroll in time closes (its place is for the next device). */
  private async closeIdle(): Promise<void> {
    if (this.closed || !this.principal || this.principal.endpoint) return;
    // Enrolled by its last request (or approved on another device) but quiet since: promote, don't close. A device
    // that became a screen reconnects to be one (`enroll.display.status` says so).
    const again = await this.runtime.trust.identify(this.principal.peerId, this.principal.publicKey);
    if (again.endpoint && !again.revoked && !isScreenSession(again)) {
      this.principal = { ...again, protocolMinor: this.minor };
      this.clearUnenrolledTimers();
      this.runtime.sessions.promote(this);
      return;
    }
    if (this.closed) return;
    await this.send(
      this.errorMessage(undefined, {
        code: 'unavailable',
        message: 'Closed after a while without enrolling this device. Reconnect to continue.',
      }),
    ).catch(() => {});
    await this.close('idle');
  }

  /**
   * Closes the session. Revocation first tells the client to clear what it cached (`revoked` for this endpoint,
   * `authz_changed` for the account's other sessions); shutdown and updates say `goaway`.
   */
  async close(reason: CloseReason, generation?: number): Promise<void> {
    if (this.closed) return;
    // A command of this very session may have changed its account's authorization (revoking another of its devices):
    // its answer goes out first, then the notice (bounded wait; the result is also in its receipt).
    if (reason === 'authz_changed') {
      const until = Date.now() + 2_000;
      while (this.inflight.size > 0 && Date.now() < until && !this.closed)
        await new Promise((resolve) => setTimeout(resolve, 10));
      if (this.closed) return;
    }
    const gen = generation ?? this.principal?.authzGeneration ?? 0;
    if (reason === 'endpoint_revoked')
      await this.send({ t: 'revoked', scope: 'endpoint', authzGeneration: gen, clearCache: true }).catch(
        () => {},
      );
    else if (reason === 'authz_changed')
      await this.send({ t: 'authz_changed', authzGeneration: gen, clearCache: true }).catch(() => {});
    else if (reason === 'shutdown' || reason === 'update' || reason === 'rekey')
      await this.send({ t: 'goaway', reason, retryAfterMs: reason === 'rekey' ? 0 : 5_000 }).catch(() => {});
    this.closed = true;
    this.scope.claimBegin = null;
    this.scope.claimProof = null;
    this.scope.localStart = null;
    this.scope.passkeyBegin = null;
    this.scope.screenBegin = null;
    this.scope.remoteHelpBegin = null;
    this.clearUnenrolledTimers();
    for (const control of this.inflight.values()) control.cancelled = true;
    for (const slot of this.subscriptions.values()) {
      slot.generation += 1;
      slot.close?.();
    }
    this.subscriptions.clear();
    for (const stream of this.streams.values()) stream.abort();
    this.streams.clear();
    this.budget.wakeAll();
    this.runtime.sessions.detach(this);
    this.scope.closed = true;
    if (this.scope.presenceKey) presenceFor(this.runtime.services).disconnectAll(this.scope.presenceKey);
    await this.sendChain.catch(() => {});
    await this.channel.close().catch(() => this.channel.abort());
    this.finish(reason);
  }

  /* CONTROL ------------------------------------------------------------------------------------ */

  /** A failed asynchronous session task ends this connection; durable commands recover through their receipts. */
  private runTask(task: Promise<void>): void {
    void task.catch(async (err) => {
      this.runtime.services.log.warn({ err: String(err) }, 'session task failed');
      await this.close('closed');
    });
  }

  private onControl(msg: ClientMessage): void {
    switch (msg.t) {
      case 'hello':
        void this.send(
          this.errorMessage(undefined, { code: 'protocol_error', message: 'hello was already sent.' }),
        );
        return;
      case 'ping':
        void this.send({ t: 'pong', n: msg.n });
        return;
      case 'pong':
        return;
      case 'request':
        this.runTask(this.onRequest(msg));
        return;
      case 'cancel': {
        // Effective only before the command is accepted (MR-06); after that the work continues.
        const control = this.inflight.get(msg.id);
        if (control) control.cancelled = true;
        return;
      }
      case 'status':
        this.runTask(this.onStatus(msg.id));
        return;
      case 'subscribe':
        this.runTask(this.onSubscribe(msg));
        return;
      case 'unsubscribe':
        this.dropSubscription(msg.sub);
        return;
      case 'open':
        this.runTask(this.onOpen(msg));
        return;
      case 'chunk': {
        const onChunk = this.uploadChunks.get(msg.stream);
        if (onChunk) onChunk(msg);
        else void this.sendFrame({ type: 'reset', streamId: msg.stream, code: STREAM_RESET.protocolError });
        return;
      }
    }
  }

  /** Re-checks the principal before a request: enrollment picked up, revocation and authz changes close. */
  private async refreshPrincipal(): Promise<SessionPrincipal | null> {
    const current = this.principal as SessionPrincipal;
    if (!current.endpoint) {
      const again = await this.runtime.trust.identify(current.peerId, current.publicKey);
      if (again.revoked) {
        await this.close('endpoint_revoked');
        return null;
      }
      if (again.endpoint && !isScreenSession(again)) {
        // Enrolled on this session (claim, invite, recovery) or by an approval: now an enrolled session.
        this.principal = { ...again, protocolMinor: this.minor };
        this.clearUnenrolledTimers();
        this.runtime.sessions.promote(this);
      } else {
        // A device the person just made a screen stays on the enrolment channel until it reconnects: it hears so from
        // `enroll.display.status`, and the screen channel starts with a session of its own.
        this.touchUnenrolled();
      }
      return this.principal;
    }
    const check = await this.runtime.trust.recheck(current);
    if (!check.ok) {
      await this.close(check.reason === 'revoked' ? 'endpoint_revoked' : 'authz_changed', check.generation);
      return null;
    }
    return this.principal;
  }

  private async onRequest(msg: Request): Promise<void> {
    if (this.inflight.has(msg.id)) {
      await this.send(
        this.errorMessage(msg.id, {
          code: 'protocol_error',
          message: 'That request id is already running on this session.',
        }),
      );
      return;
    }
    if (this.inflight.size >= SESSION_MAX_INFLIGHT_REQUESTS) {
      await this.send(this.errorMessage(msg.id, { code: 'too_many', message: 'Too many requests at once.' }));
      return;
    }
    const control = new RequestControl(
      new Date(this.runtime.services.clock().getTime() + msg.deadlineMs),
      this.scope,
    );
    this.inflight.set(msg.id, control);
    let answer: RequestAnswer | null = null;
    try {
      const principal = await this.refreshPrincipal();
      if (!principal || this.closed) return;
      await this.runtime.dispatcher.handle(
        principal,
        { id: msg.id, op: msg.op, input: msg.input },
        {
          accepted: (at) => void this.send({ t: 'accepted', id: msg.id, at: at.toISOString() }),
          result: (a) => {
            answer = a;
          },
        },
        control,
      );
    } finally {
      // The id is free again before the answer leaves (a client may reuse it right after the result).
      this.inflight.delete(msg.id);
    }
    if (answer) {
      const a = answer as RequestAnswer;
      // Diagnostics (MR-42): codes and allowlisted op names only.
      if (a.type === 'error')
        this.runtime.counters.error(
          a.code,
          appErrorCode(a.details),
          this.runtime.dispatcher.allowlist.has(msg.op) ? msg.op : null,
        );
      await this.answer(msg.id, a, msg.op);
    }
  }

  private async answer(id: string, answer: RequestAnswer, op?: string): Promise<void> {
    if (answer.type === 'redacted') {
      // Committed, its result not kept (CT-195; command-safety.md CS-05, CS-06): done, the client refetches its state.
      await this.send({ t: 'outcome', id, state: 'completed', redacted: true });
      return;
    }
    if (answer.type === 'error') {
      await this.send(this.errorMessage(id, answer));
      return;
    }
    await this.send({ t: 'result', id, kind: answer.kind, output: (answer.output ?? null) as never }, op);
  }

  private async onStatus(id: string): Promise<void> {
    const principal = await this.refreshPrincipal();
    if (!principal) return;
    const status = await this.runtime.dispatcher.status(principal, id);
    const outcome = status.outcome;
    await this.send({
      t: 'outcome',
      id,
      state: status.state,
      ...(status.digest ? { digest: status.digest } : {}),
      ...(outcome?.kind === 'result' && status.state === 'completed'
        ? outcome.redacted
          ? // A secret op: known to be done, its result not kept (CT-44).
            { redacted: true }
          : { result: { kind: outcome.resultKind, output: (outcome.output ?? null) as never } }
        : {}),
      ...(outcome?.kind === 'error' && status.state === 'rejected'
        ? { error: { code: outcome.code as SessionErrorCode, message: outcome.message.slice(0, 1000) } }
        : {}),
    });
  }

  /**
   * Ends a subscription id now (`unsubscribe`, BH-05): its registration closes — events already queued for it in the
   * event log aren't sent (`deliver` checks `closed`) — and a subscribe of it still being answered is superseded.
   */
  private dropSubscription(sub: string): void {
    const slot = this.subscriptions.get(sub);
    if (!slot) return;
    slot.generation += 1;
    slot.close?.();
    slot.close = null;
    this.subscriptions.delete(sub);
  }

  /**
   * `subscribe` (MR-07). Subscribes of one id are answered in order (BH-05): the newest one wins — one superseded by a
   * later subscribe or an `unsubscribe` of the id while it awaits closes what it registered and sends nothing — while
   * different ids go on concurrently. A lasting event that doesn't fit in a session message drops the subscription with
   * `snapshot_required{overflow}` at that event's cursor (BH-03): the client refetches the topics' snapshots and
   * subscribes again `after` it.
   */
  private async onSubscribe(msg: Extract<ClientMessage, { t: 'subscribe' }>): Promise<void> {
    let slot = this.subscriptions.get(msg.sub);
    if (!slot) {
      slot = { generation: 0, close: null };
      this.subscriptions.set(msg.sub, slot);
    }
    const mine = slot;
    const generation = ++mine.generation;
    const current = () =>
      !this.closed && this.subscriptions.get(msg.sub) === mine && mine.generation === generation;
    /** A slot this subscribe made and never answered: gone again when it ends without registering. */
    const forget = () => {
      if (current() && !mine.close) this.subscriptions.delete(msg.sub);
    };
    const principal = await this.refreshPrincipal();
    if (!principal || !current()) return;
    if (isScreenSession(principal)) {
      // A screen asks for its own state (`screen.state`); the person's topics are not for it.
      forget();
      await this.send(
        this.errorMessage(undefined, {
          code: 'forbidden',
          message: 'A screen asks for its state; it follows nothing.',
          details: { sub: msg.sub },
        }),
      );
      return;
    }
    if (!principal.account) {
      forget();
      await this.send(
        this.errorMessage(undefined, { code: 'enrollment_required', message: 'Enroll this device first.' }),
      );
      return;
    }
    const others = [...this.subscriptions.entries()].filter(([id, s]) => id !== msg.sub && s.close).length;
    if (others >= SESSION_MAX_SUBSCRIPTIONS && !mine.close) {
      forget();
      await this.send(
        this.errorMessage(undefined, {
          code: 'too_many',
          message: 'Too many subscriptions.',
          details: { sub: msg.sub },
        }),
      );
      return;
    }
    mine.close?.();
    mine.close = null;
    /**
     * `dropped`: the cursor of a lasting event that didn't fit (BH-03) — nothing more is sent for this registration;
     * `registered`: its close, once the subscribe was answered.
     */
    const reg: { dropped: string | null; registered: (() => void) | null } = {
      dropped: null,
      registered: null,
    };
    const tooLarge = (cursor: string) => {
      reg.dropped = cursor;
      // Answered already: the registration closes now and the client is told. Still replaying: once it returns.
      if (!reg.registered) return;
      reg.registered();
      mine.close = null;
      this.subscriptions.delete(msg.sub);
      void this.send({ t: 'snapshot_required', sub: msg.sub, reason: 'overflow', cursor });
    };
    const result = await this.runtime.events.subscribe(
      {
        accountId: principal.account.id,
        generation: principal.authzGeneration,
        send: (e) => {
          if (reg.dropped !== null || !current()) return;
          if (e.ephemeral || e.cursor === null) {
            this.sendEvent({
              t: 'event',
              ephemeral: true,
              sub: e.subscription,
              topic: e.topic,
              event: hostsEventFor(eventFor(e.event, this.minor), this.minor),
            });
            return;
          }
          const sent = this.sendEvent({
            t: 'event',
            ephemeral: false,
            sub: e.subscription,
            cursor: e.cursor,
            topic: e.topic,
            // An older app gets what its contracts read (`automations/older-apps.ts`, `hosts/older-apps.ts`).
            event: hostsEventFor(eventFor(e.event, this.minor), this.minor),
          });
          if (!sent) tooLarge(e.cursor);
        },
        overflow: (sub, cursor) => {
          if (reg.dropped !== null || !current()) return;
          mine.close = null;
          this.subscriptions.delete(sub);
          void this.send({ t: 'snapshot_required', sub, reason: 'overflow', cursor });
        },
      },
      { id: msg.sub, topics: msg.topics, after: msg.after ?? null },
    );
    if (!current()) {
      result.close();
      return;
    }
    if (result.snapshotRequired || reg.dropped !== null) {
      result.close();
      this.subscriptions.delete(msg.sub);
      // An expired cursor (rows swept while it replayed) needs the head; an event too large, its own cursor.
      await this.send(
        result.snapshotRequired
          ? { t: 'snapshot_required', sub: msg.sub, reason: result.snapshotRequired, cursor: result.cursor }
          : { t: 'snapshot_required', sub: msg.sub, reason: 'overflow', cursor: reg.dropped as string },
      );
      return;
    }
    reg.registered = result.close;
    mine.close = result.close;
    await this.send({ t: 'subscribed', sub: msg.sub, cursor: result.cursor, denied: result.denied });
    await this.followPresence(
      principal.account.id,
      msg.topics,
      result.denied.map((d) => d.topic),
    );
  }

  /**
   * A session that follows a burrow counts as the person's connection there (docs/decisions/essentials-conversations.md
   * EC-27): active until the client says otherwise, offline when the session closes.
   */
  private async followPresence(
    accountId: string,
    subscribed: readonly string[],
    denied: readonly string[],
  ): Promise<void> {
    const burrowIds = subscribed
      .filter((t) => !denied.includes(t))
      .map((t) => parseTopic(t))
      .flatMap((t) => (t?.kind === 'burrow' ? [t.id] : []));
    if (burrowIds.length === 0 || this.closed) return;
    const services = this.runtime.services;
    const people = await services.db
      .select({ id: principals.id, burrowId: principals.burrowId })
      .from(principals)
      .where(
        and(
          eq(principals.accountId, accountId),
          eq(principals.kind, 'person'),
          inArray(principals.burrowId, burrowIds),
        ),
      );
    if (this.closed) return;
    const presence = presenceFor(services);
    for (const p of people) presence.connect(`${this.scope.presenceKey}${p.burrowId}`, p.burrowId, p.id);
  }

  /* Streams ------------------------------------------------------------------------------------ */

  private async onOpen(msg: Extract<ClientMessage, { t: 'open' }>): Promise<void> {
    const refuse = (message: string, details?: unknown) =>
      this.send(
        this.errorMessage(
          undefined,
          { code: 'stream_refused', message, ...(details !== undefined ? { details } : {}) },
          msg.stream,
        ),
      );
    if (msg.stream % 2 !== 1 || this.streams.has(msg.stream)) {
      await refuse('Streams the client opens have a new odd id.');
      return;
    }
    if (this.streams.size >= SESSION_MAX_OPEN_STREAMS) {
      await refuse('Too many open streams.');
      return;
    }
    // Count pending opens and remember cancellation while permissions and resources are still being read.
    const stream = new SessionStream(
      msg.stream,
      (f) => this.sendFrame(f),
      { budget: this.budget },
      (id) => {
        if (this.streams.get(id) !== stream) return;
        this.streams.delete(id);
        this.uploadChunks.delete(id);
      },
    );
    this.streams.set(msg.stream, stream);
    let ready = false;
    try {
      const principal = await this.refreshPrincipal();
      if (!principal || this.closed || stream.closed) return;
      if (!principal.endpoint) {
        await refuse('Enroll this device first.');
        return;
      }
      // A screen opens nothing but a picture of its own too large for one message (`screen.image` as an export).
      if (
        isScreenSession(principal) &&
        !(
          msg.spec.kind === 'export' &&
          SESSION_EXPORT_READS.has(msg.spec.op) &&
          this.runtime.dispatcher.resolve(principal, msg.spec.op).ok
        )
      ) {
        await refuse('A screen opens no streams.', { code: 'not_allowed' });
        return;
      }
      const ctx: StreamContext = {
        services: this.runtime.services,
        principal,
        stream,
        send: (m) => this.send(m as ApplianceMessage),
        collabBudget: this.collabBudget,
      };
      let opened: OpenedStream;
      const spec = msg.spec;
      if (spec.kind === 'download') opened = await openDownload(ctx, spec);
      else if (spec.kind === 'upload') opened = await this.runtime.uploads.open(ctx, spec);
      else if (spec.kind === 'export') opened = await openExport(ctx, this.runtime.dispatcher, spec);
      else if (spec.kind === 'collab') opened = await openCollab(ctx, spec);
      else opened = await openConsole(ctx, spec);
      if (this.closed || stream.closed) return;
      if (opened.onChunk) this.uploadChunks.set(msg.stream, opened.onChunk);
      await this.send({ t: 'opened', stream: msg.stream, meta: opened.meta });
      ready = true;
      if (opened.run)
        void opened.run().catch(async (err) => {
          this.runtime.services.log.warn({ err: String(err), stream: msg.stream }, 'session stream failed');
          await stream.reset(STREAM_RESET.internal);
        });
    } catch (err) {
      if (this.closed || stream.closed) return;
      const e = errorAnswer(err, this.runtime.services);
      // `error.code` is `stream_refused`; the reason's app code (or the error code) is `details.code` (CT-21).
      const details = (e.details ?? {}) as Record<string, unknown>;
      await refuse(e.message, { ...details, code: typeof details.code === 'string' ? details.code : e.code });
    } finally {
      if (!ready) {
        stream.abort();
        if (this.streams.get(msg.stream) === stream) {
          this.streams.delete(msg.stream);
          this.uploadChunks.delete(msg.stream);
        }
      }
    }
  }

  private onStreamFrame(frame: Frame): void {
    const stream = this.streams.get(frame.streamId);
    if (!stream) {
      if (frame.type !== 'reset')
        void this.sendFrame({ type: 'reset', streamId: frame.streamId, code: STREAM_RESET.refused });
      return;
    }
    const error = stream.receive(frame);
    if (error !== null) void stream.reset(error);
  }
}
