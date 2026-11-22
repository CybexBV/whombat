/**
 * `createFakeAppliance` — an in-memory appliance speaking session protocol v1 (`@whombat/protocol`), for unit
 * tests, Storybook and the managed-mode e2e suite (AP-15). Every message goes through the protocol's own codec
 * and schemas in both directions, and frames through its length-prefixed encoder and `FrameDecoder`, so the
 * client is exercised against the real wire format. It implements the appliance-side semantics the client
 * depends on — receipts bound to `receiptDigest` (a `secret` op's result not kept, CT-44), `accepted` before
 * `result`, `status` → `outcome`, cursor-resumed subscriptions with bounded retention and `snapshot_required` (which
 * drops the subscription, as the runtime does: the client subscribes again after its cursor, AP-1097), credit
 * flow control, downloads with `stream_done`, chunked resumable uploads (`chunk`/`chunk_ack`), collaboration streams,
 * console streams (contracts 0.80.1),
 * `revoked` / `authz_changed` / `goaway` — plus faults to drive every client state (AP-573).
 *
 * It is a reference for the client's expectations, not the appliance: the real one lives in Whombat
 * (`WHOMBAT_MODE=managed`) and is tested there.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { AnyEndpoint } from '@whombat/core/contracts';
import { VOICE_TYPING_MAX_BYTES } from '@whombat/core/domain';
import {
  SESSION_INITIAL_STREAM_CREDIT,
  SESSION_MAX_CONTROL_BYTES,
  SESSION_MAX_DATA_BYTES,
} from '@whombat/protocol';
import { CollabMessageDecoder, collabDataPayloads, encodeCollabMessages } from '@whombat/protocol/collab';
import { ConsoleMessageDecoder, consoleDataPayloads, encodeConsoleMessages } from '@whombat/protocol/console';
import { encodeFrame, type Frame, FrameDecoder, STREAM_RESET } from '@whombat/protocol/frame';
import type { DirectAddresses, Edition } from '@whombat/protocol/session';
import {
  API_OPERATIONS,
  type ApplianceMessage,
  type ClientMessage,
  decodeClientMessage,
  encodeSessionMessage,
  negotiateVersion,
  receiptDigest,
  requestDigest,
  SESSION_OPERATIONS,
  SESSION_PROTOCOL,
} from '@whombat/protocol/session';
import { API_ENDPOINT_BY_OP } from './op-names';
import type { DisconnectReason, ResourceMeta, ResourceRef } from './types';
import { ConnectError, type SessionConnector, type WireConnection } from './wire';

export interface FakeRequestContext {
  accountId: string | null;
  requestId: string;
  endpointId: string;
  channel: 'app' | 'enroll';
}

/** Who is connecting: the endpoint key (its id) and the channel it asked for. */
export interface FakeEndpoint {
  endpointId: string;
  channel: 'app' | 'enroll';
}

/** Answers in HTTP terms (like the REST server): the fake converts them to `result` / `error`. */
export type FakeHandler = (
  op: string,
  input: unknown,
  context: FakeRequestContext,
) => Promise<{
  status: number;
  body: unknown;
  /** The protocol error code to answer with (a newer runtime's, for skew tests; needs `sendsNewer`). */
  protocolCode?: string;
}>;

export interface FakeCollabPeer {
  receive(message: Uint8Array): void;
  close(): void;
}

/** A console behind a `console` stream (contracts 0.80.1): its messages in, and when the person leaves. */
export interface FakeConsolePeer {
  receive(message: Uint8Array): void;
  close(): void;
}

/** What a fake console may do: send the service's messages, and end it (after what was sent). */
export interface FakeConsoleIo {
  send(message: Uint8Array): void;
  end(): void;
}

export interface FakeAccount {
  /** `acc_…` */
  id: string;
  principals?: { burrowId: string; principalId: string }[];
  name: string;
}

export interface FakeApplianceOptions {
  handle: FakeHandler;
  /** Operations beyond `@whombat/core`'s `api` and the protocol's session operations (provisional ones). */
  endpoints?: readonly AnyEndpoint[];
  /** The appliance's content identity (a PeerId in production). */
  applianceId?: string;
  account?: FakeAccount | null;
  capabilities?: readonly string[];
  majors?: readonly number[];
  /** The running release's client security floor (CT-53): builds below it are refused at `hello`. */
  clientFloor?: Partial<Record<'web' | 'android' | 'ios' | 'desktop' | 'cli', number>>;
  /** Largest DATA payload (default 16 KiB, so tests cross frame boundaries). */
  maxDataBytes?: number;
  /** Events kept for resuming (older cursors get `snapshot_required`). Default 500. */
  retention?: number;
  resources?: (ref: ResourceRef) => Promise<{ meta: ResourceMeta; bytes: Uint8Array } | null>;
  /** Export streams (`open{spec: {kind: 'export'}}`, e.g. `diagnostics.download`): the bytes, or null (not found). */
  exports?: (
    op: string,
    input: unknown,
    who: FakeEndpoint,
  ) => Promise<{ contentType: string; name?: string; bytes: Uint8Array } | null>;
  /**
   * Completes an upload whose bytes arrived intact; the answer becomes `stream_done.output`. Throwing a
   * `FakeUploadRefusal` answers the stream's `error` with its code and details instead (a `dictation` recording the box
   * couldn't turn into text).
   */
  completeUpload?: (upload: {
    burrow: string;
    /** The attachment id, the staged id of a `backup-file` target, or the stream's own for a `dictation` recording. */
    attachmentId: string;
    bytes: Uint8Array;
    target: OpenSpec<'upload'>['target'];
  }) => Promise<unknown>;
  collab?: (
    document: { burrow: string; canvasId: string },
    send: (message: Uint8Array) => void,
  ) => FakeCollabPeer | null;
  /**
   * Console streams (`open{spec: {kind: 'console'}}`, contracts 0.80.1): the console's peer and its protocol, or why it
   * is refused (`details.code`, e.g. `console_refused`). Absent: refused as not supported.
   */
  console?: (
    target: { burrow: string; sessionId: string; token: string },
    io: FakeConsoleIo,
  ) => { peer: FakeConsolePeer; protocol: string } | { refused: string; message: string };
  /**
   * Admission per endpoint (default: everyone is `account`). An unenrolled endpoint is welcomed on the
   * enrollment channel; a revoked one gets `error{revoked}`.
   */
  admit?: (who: FakeEndpoint) => { account: FakeAccount } | 'not_enrolled' | 'revoked';
  /** Frame delivery delay, ms (default 0 = next microtask). */
  latencyMs?: number;
  /** The box's direct ways in, as `welcome.direct` says on the app channel (CT-1252). Default: none (null). */
  direct?: DirectAddresses | null;
  /** What `welcome.edition` says (CT-1300); absent says none, as a 1.0 box (read as `commercial`). */
  edition?: Edition;
  /**
   * A runtime newer than these contracts (skew tests, AP-255): a message its schemas refuse (an error code or enum
   * member only a newer runtime has) goes out as it is instead of throwing.
   */
  sendsNewer?: boolean;
}

/** An upload the box refuses after its bytes arrived: `error{stream, code, message, details}`. */
export class FakeUploadRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** A syntactically valid Ed25519 PeerId for fakes (`12D3KooW` + 44 base58 characters). */
export const FAKE_PEER_ID = `12D3KooWFakeWhombat${'A'.repeat(33)}`;

/** Another one per name, for worlds with several appliances. */
export function fakePeerId(name: string): string {
  const base58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let body = '';
  for (let i = 0; body.length < 44; i++) body += base58[(name.charCodeAt(i % name.length) * (i + 7)) % 58];
  return `12D3KooW${body}`;
}

const ALL_CAPABILITIES = [
  'events',
  'stream.download',
  'stream.upload',
  'stream.export',
  'stream.collab',
  'stream.console',
  'enroll',
  'recovery',
];

/**
 * API operations by the name the runtime's allowlist uses (the key path, `API_OPERATIONS`), not `ep.id`: a client
 * sending an endpoint's id where it differs (`packs.agent` for `packs.agentPacks`) is refused with `unknown_op`,
 * as the appliance does (parity G-02). Handlers still receive the endpoint's id.
 */
const API_ENDPOINTS = API_ENDPOINT_BY_OP;
/** A result above this (as JSON) is refused like the runtime refuses one larger than a CONTROL message. */
const MAX_RESULT_JSON = 60_000;

interface Receipt {
  /** Newest wins when `status` (which names no op) finds several for one id. */
  seq: number;
  digest: string;
  state: 'accepted' | 'executing' | 'completed' | 'rejected';
  /** What a retry is answered with: for a `secret` op an error keeps only its code and message (CT-44). */
  reply: ApplianceMessage | null;
  waiters: ((m: ApplianceMessage) => void)[];
  /** Retries joining it while it runs, told `accepted` once it commits. */
  onAccepted: (() => void)[];
  /** A `secret` op (CT-44). */
  secret: boolean;
  /** Its result isn't kept (a secret op's, or lost after the commit, CT-195): `status` says `redacted`. */
  redacted: boolean;
  /** Committed, then its process died before storing the result: `accepted` for ever (runtimes before 0.29.1). */
  orphaned: boolean;
}

interface FakeUpload {
  burrow: string;
  attachmentId: string;
  size: number;
  /** Absent: a backup file sent without it (the fake hashes what arrived). */
  sha256: string | undefined;
  chunkSize: number;
  chunks: Uint8Array[];
  received: number;
}

type OpenSpec<K extends string> = Extract<Extract<ClientMessage, { t: 'open' }>['spec'], { kind: K }>;

/** The library's byte stream (structural), for serving over a real secure channel in tests. */
export interface FakeByteStream {
  read(): Promise<Uint8Array | null>;
  write(chunk: Uint8Array): boolean;
  close(): Promise<void>;
}

export interface FakeAppliance {
  connector: SessionConnector;
  /**
   * Serve one session over a plaintext byte stream (e.g. `secureByteStream` of a real Noise responder): the
   * appliance side of an end-to-end test through actual cryptography.
   */
  serve(stream: FakeByteStream, who: FakeEndpoint): void;
  /** A connector for one endpoint key and channel (enrollment journeys). */
  connectorFor(who: FakeEndpoint): SessionConnector;
  /** End the sessions of one endpoint (after revoking it): `revoked`, then close. */
  dropEndpoint(endpointId: string, reason?: DisconnectReason): void;
  /** Publish a realtime event on a topic (every matching subscription gets it with a new cursor). */
  publish(topic: string, event: { type: string; [k: string]: unknown }): void;
  /** Publish a live-only event (the agent's thinking line): no cursor, never replayed. */
  publishLive(topic: string, event: { type: string; [k: string]: unknown }): void;
  faults: {
    offline(value: boolean): void;
    failConnects(reason: DisconnectReason, n?: number, retryAfterMs?: number): void;
    dropAll(reason?: DisconnectReason): void;
    /** Commit the next `n` mutations but drop the connection instead of answering. */
    loseResults(n?: number): void;
    /**
     * The next `n` mutations act (their handler runs: `executed` counts it) but the connection drops before they
     * commit: the runtime then cancels the commit, so the receipt reads `not_found` — what an op with effects outside
     * its receipt's transaction (a GitHub merge, git on disk) leaves behind (CT-194). No `accepted` is sent. A runtime
     * that knows it acted (`'unknown_outcome'`, Whombat CS-01…CS-08, CT-196) answers `status` with `rejected` +
     * `unknown_outcome` instead, and a retry with `error{unknown_outcome}`.
     */
    loseBeforeCommit(n?: number, runtime?: 'not_found' | 'unknown_outcome'): void;
    /**
     * Forget every finished receipt, as the runtime's retention sweep does after `WHOMBAT_COMMAND_RECEIPT_HOURS`: `status`
     * then answers `not_found` for a request that did run (AP-574).
     */
    expireReceipts(): void;
    /**
     * The next `n` mutations commit (`accepted` goes out), then the process that ran them dies before storing their
     * result, and the connection drops. A runtime before contracts 0.29.1 (`'accepted'`) then answers `accepted` for
     * ever, to `status` and to a retry; 0.29.1 (`'redacted'`, the default, CT-195) answers `completed` + `redacted`.
     */
    loseAfterCommit(n?: number, runtime?: 'accepted' | 'redacted'): void;
    /** Work after the commit: each mutation's result follows its `accepted` this much later. */
    slowAccept(ms: number): void;
    /** The next `n` requests are lost on the way in (the connection drops, nothing is committed). */
    swallowRequests(n?: number): void;
    /** Drop the connection once an upload has received this many more bytes. */
    dropUploadAfter(bytes: number): void;
    /** Revoke every endpoint: `revoked`, close, and refuse further connects as revoked. */
    revoke(): void;
    /** Permissions change: `authz_changed`, then every subscription gets `snapshot_required{authz_changed}` and is dropped. */
    bumpAuthz(): void;
    /**
     * The runtime restarts: a new cursor epoch, so every earlier cursor gets `snapshot_required{restart}` (events may have
     * been lost between a commit and the log), and every connection drops.
     */
    restart(): void;
    /**
     * Every subscription falls too far behind (the runtime's `MAX_PENDING_PER_SUBSCRIPTION`): `snapshot_required{overflow}`
     * at the newest cursor, and it is dropped.
     */
    overflow(): void;
    /**
     * A runtime that keeps refusing: the next `n` subscribes are answered with `snapshot_required{overflow}` whatever
     * their cursor (the client must not ask again in a tight loop).
     */
    repeatSnapshot(n?: number): void;
    majors(list: readonly number[]): void;
    /** The running release's client floor changes (a new release): refused at the next `hello`. */
    clientFloor(floor: FakeApplianceOptions['clientFloor'] | null): void;
    /** What the next `welcome` says about the box's direct ways in (`welcome.direct`). */
    direct(value: DirectAddresses | null): void;
    /** What the next `welcome` says about the box's edition (`welcome.edition`; undefined: says none). */
    edition(value: Edition | undefined): void;
    expireEvents(keep?: number): void;
    goaway(reason: 'rekey' | 'update' | 'shutdown' | 'overload', retryAfterMs?: number): void;
    /**
     * Every open connection stops carrying anything, both ways, without closing: what a bad network path does to a
     * connection (open-speed.md AP-4401). New connections work.
     */
    stall(): void;
    /** The next `n` connects never finish until they are given up (aborted): a dial stuck on a bad path (AP-4400). */
    hangConnects(n?: number): void;
    /** Pings get no pong while on: the newest bytes stuck on a bad path while older answers still trickle in (AP-4409). */
    mutePongs(on?: boolean): void;
    /** Pongs go out this long after their ping (0: at once): a slow link working through a backlog. */
    delayPongs(ms: number): void;
  };
  stats(): {
    connects: number;
    /** `ping`s that arrived, on every connection. */
    pings: number;
    /** Connects that hung (`hangConnects`) and were then given up. */
    abandoned: number;
    open: number;
    executed: Map<string, number>;
    requestsSeen: string[];
    /** Every `request` that arrived, also those lost on the way in (`swallowRequests`), with its receipt digest. */
    attempts: { id: string; op: string; digest: string }[];
    /** Request ids asked about with `status`, in order. */
    statusAsked: string[];
    lastHello: ClientMessage | null;
    /** Every `subscribe` that arrived, in order, with when. */
    subscribes: { sub: string; topics: string[]; after: string | null; at: number }[];
  };
  applianceId: string;
}

export function createFakeAppliance(options: FakeApplianceOptions): FakeAppliance {
  const retention = options.retention ?? 500;
  const maxDataBytes = Math.min(options.maxDataBytes ?? 16 * 1024, SESSION_MAX_DATA_BYTES);
  const applianceId = options.applianceId ?? FAKE_PEER_ID;
  const extra = new Map<string, AnyEndpoint>((options.endpoints ?? []).map((ep) => [ep.id, ep]));
  let majors = options.majors ?? [SESSION_PROTOCOL.major];
  let floor = options.clientFloor ?? null;
  let direct = options.direct ?? null;
  let edition = options.edition;
  let offline = false;
  let revokedAll = false;
  let failing: { reason: DisconnectReason; n: number; retryAfterMs?: number } | null = null;
  let loseResults = 0;
  let loseBeforeCommit = 0;
  let beforeCommitAnswer: 'not_found' | 'unknown_outcome' = 'not_found';
  let loseAfterCommit: { n: number; runtime: 'accepted' | 'redacted' } = { n: 0, runtime: 'redacted' };
  let receiptSeq = 0;
  let slowAcceptMs = 0;
  let swallow = 0;
  let dropUploadAt: number | null = null;
  let authzGeneration = 1;
  let cursor = 0;
  /** Cursors are `<epoch>.<n>`; the epoch is new per instance and per `restart()`, like the runtime's per start. */
  let epoch = newEpoch();
  const cursorOf = (n: number) => `${epoch}.${n}`;
  let repeatSnapshots = 0;
  let connects = 0;
  let hanging = 0;
  let pongless = false;
  let pongDelayMs = 0;
  let pings = 0;
  let abandoned = 0;
  /** Each live connection's `stall` switch. */
  const stallers = new Set<() => void>();
  let lastHello: ClientMessage | null = null;
  const events: { cursor: number; topic: string; event: { type: string } }[] = [];
  const receipts = new Map<string, Receipt>();
  const executed = new Map<string, number>();
  const requestsSeen: string[] = [];
  const attempts: { id: string; op: string; digest: string }[] = [];
  const statusAsked: string[] = [];
  const subscribes: { sub: string; topics: string[]; after: string | null; at: number }[] = [];
  const uploads = new Map<string, FakeUpload>();
  /** Each dictation recording's own id (they have none on the wire). */
  let dictations = 0;
  const completed = new Set<string>();
  const sessions = new Set<ApplianceEnd>();

  const defaultAccount: FakeAccount | null =
    options.account === undefined ? { id: 'acc_fake', name: 'Mara' } : options.account;

  /** `receiptDigest` for known ops (over the op alone for `secret` ones, CT-44); `requestDigest` for provisional ones. */
  function digestOf(op: string, input: unknown): string {
    const spec = API_OPERATIONS.get(op) ?? SESSION_OPERATIONS.get(op);
    return spec ? receiptDigest(spec, input) : requestDigest(op, input);
  }

  function isSecret(op: string): boolean {
    return (API_OPERATIONS.get(op) ?? SESSION_OPERATIONS.get(op))?.secret === true;
  }

  function isMutating(op: string): boolean {
    const session = SESSION_OPERATIONS.get(op);
    if (session) return session.mutating;
    const ep = API_ENDPOINTS.get(op) ?? extra.get(op);
    return ep ? ep.method !== 'GET' : false;
  }

  /** What handlers are keyed by: an API operation's endpoint id, otherwise the op itself. */
  function handlerOp(op: string): string {
    return API_ENDPOINTS.get(op)?.id ?? op;
  }

  function known(op: string): boolean {
    return SESSION_OPERATIONS.has(op) || API_ENDPOINTS.has(op) || extra.has(op);
  }

  /** An HTTP-shaped answer → the protocol's `result` / `error` for request `id`. */
  function reply(id: string, r: { status: number; body: unknown; protocolCode?: string }): ApplianceMessage {
    // An answer too large for one message: the runtime tells the client to read it through an export stream.
    if (r.status < 300 && JSON.stringify(r.body ?? null).length > MAX_RESULT_JSON)
      return {
        t: 'error',
        id,
        code: 'too_large',
        message: 'The answer is larger than a session message; open an export stream for it.',
        retryable: false,
        details: { code: 'use_export_stream' } as never,
      };
    const body = r.body as
      | {
          approvalRequired?: boolean;
          blocked?: boolean;
          keyNeeded?: unknown;
          eventId?: string;
          error?: {
            code?: string;
            message?: string;
            fields?: Record<string, string[]>;
            details?: Record<string, unknown>;
          };
        }
      | undefined;
    if (r.status === 202 && body?.approvalRequired)
      return { t: 'result', id, kind: 'approval_required', output: body as never };
    if (r.status >= 200 && r.status < 300)
      return { t: 'result', id, kind: 'ok', output: (r.body ?? null) as never };
    if (r.status === 403 && body?.blocked)
      return {
        t: 'error',
        id,
        code: 'blocked',
        message: body.error?.message ?? 'Blocked.',
        retryable: false,
        details: { keyNeeded: body.keyNeeded, eventId: body.eventId } as never,
      };
    const code =
      (r.protocolCode as 'internal' | undefined) ??
      (r.status === 400
        ? 'bad_request'
        : r.status === 422
          ? 'validation_failed'
          : r.status === 401
            ? 'unauthorized'
            : r.status === 403
              ? 'forbidden'
              : r.status === 404
                ? 'not_found'
                : r.status === 410
                  ? 'expired'
                  : r.status === 409
                    ? 'conflict'
                    : r.status === 413
                      ? 'too_large'
                      : r.status === 429
                        ? 'rate_limited'
                        : r.status === 503
                          ? 'unavailable'
                          : 'internal');
    return {
      t: 'error',
      id,
      code,
      message: body?.error?.message ?? 'Failed.',
      retryable: r.status >= 500,
      ...(body?.error?.fields && { fields: body.error.fields }),
      // The application's own code (e.g. `claim_used`) travels in details (AP-19); details that name their own code
      // (`backup_file.wrong_password`) keep it, as the runtime's do.
      details: { code: body?.error?.code ?? code, ...body?.error?.details } as never,
    };
  }

  /** One accepted connection, appliance side. */
  class ApplianceEnd {
    who: FakeEndpoint = { endpointId: 'default', channel: 'app' };
    account: FakeAccount | null = null;
    subs = new Map<string, Set<string>>();
    streams = new Map<number, (frame: Frame) => void>();
    controls = new Map<number, (m: ClientMessage) => void>();
    /** Credit the client granted us per stream (bytes of DATA we may still send). */
    credit = new Map<number, number>();
    outbox = new Map<number, Uint8Array[]>();
    afterDrain = new Map<number, () => void>();
    closed = false;
    welcomed = false;
    onClose: (() => void)[] = [];
    constructor(
      readonly deliver: (frame: Frame) => void,
      readonly drop: (reason: DisconnectReason) => void,
    ) {}

    /** Whom receipts belong to: the account, or the unenrolled endpoint key (the runtime's `peer:<peerId>`). */
    principal(): string {
      return this.account?.id ?? `peer:${this.who.endpointId}`;
    }

    send(message: ApplianceMessage) {
      if (this.closed) return;
      let payload: Uint8Array;
      try {
        payload = encodeSessionMessage(message);
      } catch (error) {
        // A newer runtime's message (`sendsNewer`): as it is.
        if (!options.sendsNewer) throw error;
        payload = new TextEncoder().encode(JSON.stringify(message));
      }
      this.deliver({ type: 'control', streamId: 0, payload });
    }

    /** DATA within the client's credit; the rest waits for CREDIT. */
    sendData(stream: number, payload: Uint8Array) {
      const box = this.outbox.get(stream) ?? [];
      box.push(payload);
      this.outbox.set(stream, box);
      this.pump(stream);
    }

    pump(stream: number) {
      const box = this.outbox.get(stream);
      if (!box) return;
      let credit = this.credit.get(stream) ?? SESSION_INITIAL_STREAM_CREDIT;
      while (box.length && (box[0]?.byteLength ?? 0) <= credit && !this.closed) {
        const p = box.shift() as Uint8Array;
        credit -= p.byteLength;
        this.deliver({ type: 'data', streamId: stream, payload: p });
      }
      this.credit.set(stream, credit);
      if (!box.length) {
        this.outbox.delete(stream);
        this.afterDrain.get(stream)?.();
      }
    }

    receive(frame: Frame) {
      if (this.closed) return;
      if (frame.type !== 'control') {
        if (frame.type === 'credit') {
          this.credit.set(
            frame.streamId,
            (this.credit.get(frame.streamId) ?? SESSION_INITIAL_STREAM_CREDIT) + frame.credit,
          );
          this.pump(frame.streamId);
        }
        this.streams.get(frame.streamId)?.(frame);
        return;
      }
      const decoded = decodeClientMessage(frame.payload);
      if (!decoded.ok) {
        if (decoded.kind === 'unknown_type') return;
        this.send({ t: 'error', code: 'invalid_message', message: decoded.error, retryable: false });
        this.drop('lost');
        return;
      }
      const m = decoded.message;
      if (!this.welcomed) {
        this.hello(m);
        return;
      }
      void this.control(m);
    }

    hello(m: ClientMessage) {
      if (m.t !== 'hello') {
        this.drop('lost');
        return;
      }
      lastHello = m;
      // The box speaks one major (its newest); a client that doesn't is refused (CT-1260).
      const version = negotiateVersion(m.versions, {
        major: Math.max(...majors),
        minor: SESSION_PROTOCOL.minor,
      });
      if (!version) {
        this.send({
          t: 'error',
          code: 'unsupported_version',
          message: 'No common protocol version.',
          retryable: false,
          details: {
            supported: { min: Math.min(...majors), max: Math.max(...majors) },
            appliance: { major: Math.max(...majors), minor: 0 },
          } as never,
        });
        this.drop('closed');
        return;
      }
      const minBuild = floor?.[m.client.platform];
      if (minBuild && (m.client.buildNumber ?? 0) < minBuild) {
        this.send({
          t: 'error',
          code: 'unsupported_version',
          message: 'This app build is below the appliance’s security floor.',
          retryable: false,
          details: {
            supported: { min: Math.min(...majors), max: Math.max(...majors) },
            appliance: { major: Math.max(...majors), minor: 0 },
            code: 'client_below_security_floor',
            floor: { platform: m.client.platform, minBuild },
          } as never,
        });
        this.drop('closed');
        return;
      }
      if (revokedAll) {
        this.send({ t: 'error', code: 'revoked', message: 'This device was removed.', retryable: false });
        this.drop('revoked');
        return;
      }
      let channel: 'app' | 'enroll' = 'enroll';
      this.account = null;
      if (this.who.channel === 'app') {
        const verdict = options.admit
          ? options.admit(this.who)
          : defaultAccount
            ? { account: defaultAccount }
            : 'not_enrolled';
        if (verdict === 'revoked') {
          this.send({ t: 'error', code: 'revoked', message: 'This device was removed.', retryable: false });
          this.drop('revoked');
          return;
        }
        if (verdict !== 'not_enrolled') {
          this.account = verdict.account;
          channel = 'app';
        }
      }
      this.welcomed = true;
      this.send({
        t: 'welcome',
        version,
        capabilities: [...(options.capabilities ?? ALL_CAPABILITIES)],
        appliance: applianceId,
        channel,
        principal: this.account
          ? {
              accountId: this.account.id,
              name: this.account.name,
              ...(this.account.principals && { principals: this.account.principals }),
            }
          : null,
        endpointId: this.account ? `end_${this.who.endpointId.replace(/\W/g, '').slice(0, 12) || 'x'}` : null,
        authzGeneration,
        // CT-47: what the client cached belongs to another account → drop it.
        clearCache: !!(this.account && m.cachedAccountId && m.cachedAccountId !== this.account.id),
        limits: {
          maxControlBytes: 65536,
          maxDataBytes,
          maxOpenStreams: 32,
          maxInflightRequests: 64,
          initialStreamCredit: SESSION_INITIAL_STREAM_CREDIT,
        },
        serverTime: new Date().toISOString(),
        direct: channel === 'app' ? direct : null,
        ...(edition && { edition }),
      });
    }

    async control(m: ClientMessage) {
      switch (m.t) {
        case 'request':
          return this.request(m);
        case 'status': {
          statusAsked.push(m.id);
          // `status` names no op: the principal's newest receipt of that id answers (as the runtime).
          let r: Receipt | undefined;
          const prefix = `${this.principal()}|`;
          for (const [k, receipt] of receipts)
            if (k.startsWith(prefix) && k.endsWith(`|${m.id}`) && (!r || receipt.seq > r.seq)) r = receipt;
          if (!r) return this.send({ t: 'outcome', id: m.id, state: 'not_found' });
          const done = r.reply;
          return this.send({
            t: 'outcome',
            id: m.id,
            state: r.state,
            digest: r.digest,
            // A result that isn't kept (CT-44, CT-195): known to be done, nothing to give back.
            ...(done?.t === 'result' &&
              (r.redacted ? { redacted: true } : { result: { kind: done.kind, output: done.output } })),
            ...(done?.t === 'error' && { error: { code: done.code, message: done.message } }),
          });
        }
        case 'subscribe':
          return this.subscribe(m);
        case 'unsubscribe':
          this.subs.delete(m.sub);
          return;
        case 'ping':
          pings += 1;
          if (pongless) return;
          if (pongDelayMs) {
            setTimeout(() => this.send({ t: 'pong', n: m.n }), pongDelayMs);
            return;
          }
          return this.send({ t: 'pong', n: m.n });
        case 'open':
          if (m.spec.kind === 'download') return this.openDownload(m.stream, m.spec);
          if (m.spec.kind === 'upload') return this.openUpload(m.stream, m.spec);
          if (m.spec.kind === 'collab') return this.openCollab(m.stream, m.spec);
          if (m.spec.kind === 'export') return this.openExport(m.stream, m.spec);
          if (m.spec.kind === 'console') return this.openConsole(m.stream, m.spec);
          return this.refuse(m.stream, 'not_supported');
        case 'chunk':
          this.controls.get(m.stream)?.(m);
          return;
        default:
          return;
      }
    }

    refuse(stream: number, reason: string) {
      this.send({
        t: 'error',
        stream,
        code: 'stream_refused',
        message: 'Refused.',
        retryable: false,
        details: { reason } as never,
      });
    }

    async request(m: Extract<ClientMessage, { t: 'request' }>) {
      attempts.push({ id: m.id, op: m.op, digest: digestOf(m.op, m.input) });
      if (swallow > 0) {
        swallow -= 1;
        this.drop('lost');
        return;
      }
      requestsSeen.push(m.id);
      if (!known(m.op))
        return this.send({
          t: 'error',
          id: m.id,
          code: 'unknown_op',
          message: `Unknown ${m.op}`,
          retryable: false,
        });
      const enrollOp = m.op.startsWith('enroll.') || m.op === 'recovery.enroll';
      if (!this.account && !enrollOp)
        return this.send({
          t: 'error',
          id: m.id,
          code: 'enrollment_required',
          message: 'Enroll first.',
          retryable: false,
        });
      const context = {
        accountId: this.account?.id ?? null,
        requestId: m.id,
        endpointId: this.who.endpointId,
        channel: (this.account ? 'app' : 'enroll') as 'app' | 'enroll',
      };
      // A file output is only read through an export stream (the runtime refuses it as a request).
      if (API_OPERATIONS.get(m.op)?.transfer === 'export')
        return this.send({
          t: 'error',
          id: m.id,
          code: 'bad_request',
          message: `Open an export stream for ${m.op}; its output is a file.`,
          retryable: false,
        });
      // Reads, and ephemeral session ops (`enroll.claim.begin`: no accepted, no receipt, CT-61).
      if (!isMutating(m.op) || SESSION_OPERATIONS.get(m.op)?.ephemeral) {
        const r = await options.handle(handlerOp(m.op), m.input, context);
        return this.send(reply(m.id, r));
      }
      // Receipts are keyed by (principal, op, request id) and bound to the digest (MA-09), as the runtime's; a secret
      // op's digest covers the op alone and its result isn't kept: a retry of a finished one gets `unknown_outcome`
      // (CT-44).
      const k = `${this.principal()}|${m.op}|${m.id}`;
      const digest = digestOf(m.op, m.input);
      const secret = isSecret(m.op);
      const existing = receipts.get(k);
      if (existing) {
        if (existing.digest !== digest)
          return this.send({
            t: 'error',
            id: m.id,
            code: 'idempotency_mismatch',
            message: 'Different payload.',
            retryable: false,
          });
        if (existing.reply?.t === 'result' && existing.redacted)
          return this.send({
            t: 'error',
            id: m.id,
            code: 'unknown_outcome',
            message: 'This was already done, and its answer isn’t kept.',
            retryable: false,
          });
        if (existing.reply) return this.send(existing.reply);
        // Committed by a process that died before storing the result (a runtime before 0.29.1).
        if (existing.orphaned) return this.send({ t: 'outcome', id: m.id, state: 'accepted' });
        // Still running: join it, told `accepted` once it commits.
        const accepted = () => this.send({ t: 'accepted', id: m.id, at: new Date().toISOString() });
        if (existing.state === 'accepted') accepted();
        else existing.onAccepted.push(accepted);
        existing.waiters.push((r) => this.send(r));
        return;
      }
      const crash = loseBeforeCommit > 0;
      if (crash) loseBeforeCommit -= 1;
      const orphan = !crash && loseAfterCommit.n > 0 ? loseAfterCommit.runtime : null;
      if (orphan) loseAfterCommit.n -= 1;
      // Received and running, not committed yet: the receipt reads `executing` (the runtime's live `received`).
      const receipt: Receipt = {
        seq: ++receiptSeq,
        digest,
        state: 'executing',
        reply: null,
        waiters: [],
        onAccepted: [],
        secret,
        redacted: secret,
        orphaned: false,
      };
      receipts.set(k, receipt);
      // The handler is the command's work up to its commit.
      const r = await options.handle(handlerOp(m.op), m.input, context);
      executed.set(m.op, (executed.get(m.op) ?? 0) + 1);
      if (crash) {
        // It acted, but its commit was cancelled with the session. Runtimes before CS-01 keep no receipt (`not_found`);
        // later ones know it acted outside its commit and answer `rejected` + `unknown_outcome` (CT-196), also to a
        // retry.
        if (beforeCommitAnswer === 'not_found') receipts.delete(k);
        else {
          receipt.state = 'rejected';
          receipt.reply = {
            t: 'error',
            id: m.id,
            code: 'unknown_outcome',
            message: 'This may have happened: it acted before its answer was lost.',
            retryable: false,
          };
        }
        this.drop('lost');
        return;
      }
      const answer = reply(m.id, r);
      const committed = answer.t === 'result' || (answer.t === 'error' && answer.code === 'blocked');
      if (committed) {
        // `accepted` follows the commit, as the runtime sends it; a refusal commits nothing and gets none.
        receipt.state = 'accepted';
        this.send({ t: 'accepted', id: m.id, at: new Date().toISOString() });
        for (const f of receipt.onAccepted.splice(0)) f();
        if (orphan) {
          // Its process dies before storing the result.
          receipt.waiters.length = 0;
          if (orphan === 'redacted') {
            receipt.state = 'completed';
            receipt.reply = answer;
            receipt.redacted = true;
          } else receipt.orphaned = true;
          this.drop('lost');
          return;
        }
        if (slowAcceptMs) await delay(slowAcceptMs);
      }
      receipt.state = committed ? 'completed' : 'rejected';
      // What a retry gets: a secret op's error without details or fields (the runtime's `storedOutcome`).
      receipt.reply =
        secret && answer.t === 'error'
          ? {
              t: 'error',
              id: answer.id,
              code: answer.code,
              message: answer.message,
              retryable: answer.retryable,
            }
          : answer;
      for (const w of receipt.waiters.splice(0)) w(answer);
      if (loseResults > 0) {
        loseResults -= 1;
        // Committed, but the answer never arrives.
        this.drop('lost');
        return;
      }
      this.send(answer);
    }

    subscribe(m: Extract<ClientMessage, { t: 'subscribe' }>) {
      subscribes.push({ sub: m.sub, topics: [...m.topics], after: m.after ?? null, at: Date.now() });
      const topics = new Set(m.topics);
      // Subscribing again replaces it; until it is answered `subscribed`, nothing is subscribed.
      this.subs.delete(m.sub);
      if (repeatSnapshots > 0) {
        repeatSnapshots -= 1;
        return this.snapshot(m.sub, 'overflow', cursor);
      }
      if (m.after !== undefined) {
        const after = parseFakeCursor(m.after);
        const oldest = events[0]?.cursor ?? cursor + 1;
        if (!after || (after.epoch === epoch && after.n < oldest - 1))
          return this.snapshot(m.sub, 'cursor_expired', cursor);
        if (after.epoch !== epoch) return this.snapshot(m.sub, 'restart', cursor);
        for (const e of events)
          if (e.cursor > after.n && topics.has(e.topic) && !this.sendEvent(m.sub, e)) return;
      }
      this.subs.set(m.sub, topics);
      this.send({ t: 'subscribed', sub: m.sub, cursor: cursorOf(cursor), denied: [] });
    }

    /** `snapshot_required` at cursor `at`; the subscription is dropped, as the runtime does (nothing is subscribed meanwhile). */
    snapshot(sub: string, reason: 'cursor_expired' | 'restart' | 'authz_changed' | 'overflow', at: number) {
      this.subs.delete(sub);
      this.send({ t: 'snapshot_required', sub, reason, cursor: cursorOf(at) });
    }

    /**
     * A durable event; one too large for a CONTROL message is answered with `snapshot_required{overflow}` at its own
     * cursor instead (the runtime's way), which drops the subscription: false then.
     */
    sendEvent(sub: string, e: { cursor: number; topic: string; event: { type: string } }): boolean {
      const message: ApplianceMessage = {
        t: 'event',
        ephemeral: false,
        sub,
        cursor: cursorOf(e.cursor),
        topic: e.topic,
        event: e.event as never,
      };
      if (new TextEncoder().encode(JSON.stringify(message)).byteLength > SESSION_MAX_CONTROL_BYTES) {
        this.snapshot(sub, 'overflow', e.cursor);
        return false;
      }
      this.send(message);
      return true;
    }

    publish(cur: number, topic: string, event: { type: string }) {
      for (const [sub, topics] of [...this.subs])
        if (topics.has(topic)) this.sendEvent(sub, { cursor: cur, topic, event });
    }

    publishLive(topic: string, event: { type: string }) {
      for (const [sub, topics] of [...this.subs])
        if (topics.has(topic)) this.send({ t: 'event', ephemeral: true, sub, topic, event: event as never });
    }

    async openDownload(stream: number, spec: OpenSpec<'download'>) {
      const r = spec.resource;
      const ref: ResourceRef =
        r.type === 'backup-file'
          ? { kind: 'backup-file', burrow: r.burrow, backupFileId: r.backupFileId }
          : r.type === 'thing-image'
            ? { kind: 'thing-image', burrow: r.burrow, thing: r.thing, ref: r.ref }
            : {
                kind: 'attachment',
                burrow: r.burrow,
                attachmentId: r.attachmentId,
                // A thumbnail is asked for as the file's `preview` (CT-298): the world may answer it apart.
                ...(r.variant === 'preview' && { variant: 'preview' as const }),
              };
      const found = options.resources ? await options.resources(ref) : null;
      if (!found) return this.refuse(stream, 'not_found');
      const start = Math.min(spec.range?.start ?? 0, found.bytes.byteLength);
      const end = Math.min(spec.range?.end ?? found.bytes.byteLength, found.bytes.byteLength);
      const bytes = found.bytes.subarray(start, end);
      this.streams.set(stream, (frame) => {
        if (frame.type === 'reset') {
          this.outbox.delete(stream);
          this.afterDrain.delete(stream);
          this.streams.delete(stream);
        }
      });
      this.send({
        t: 'opened',
        stream,
        meta: {
          kind: 'download',
          size: found.bytes.byteLength,
          range: { start, end },
          contentType: found.meta.contentType,
          ...(found.meta.name && { name: found.meta.name }),
        },
      });
      this.afterDrain.set(stream, () => {
        this.afterDrain.delete(stream);
        this.send({ t: 'stream_done', stream, size: bytes.byteLength, sha256: bytesToHex(sha256(bytes)) });
        this.deliver({ type: 'end', streamId: stream });
        this.streams.delete(stream);
      });
      if (bytes.byteLength === 0) {
        this.afterDrain.get(stream)?.();
        return;
      }
      const box: Uint8Array[] = [];
      for (let at = 0; at < bytes.byteLength; at += maxDataBytes)
        box.push(bytes.slice(at, at + maxDataBytes));
      this.outbox.set(stream, box);
      this.pump(stream);
    }

    async openExport(stream: number, spec: OpenSpec<'export'>) {
      if (!this.account) return this.refuse(stream, 'forbidden');
      let found = options.exports ? await options.exports(spec.op, spec.input, this.who) : null;
      // Any exportable operation: its output as bytes (JSON as UTF-8 JSON, text as text).
      const exportable = API_OPERATIONS.get(spec.op) ?? SESSION_OPERATIONS.get(spec.op);
      if (!found && exportable?.exportable) {
        const r = await options.handle(handlerOp(spec.op), spec.input, {
          accountId: this.account.id,
          requestId: `exp_${stream}`,
          endpointId: this.who.endpointId,
          channel: 'app',
        });
        if (r.status >= 200 && r.status < 300) {
          const ep = API_ENDPOINTS.get(spec.op);
          const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? null);
          found = {
            contentType: ep?.contentType ?? 'application/json',
            bytes: new TextEncoder().encode(text),
          };
        } else {
          // Refused as the runtime refuses it (CT-21): `stream_refused` with the op's words, its reason's code in
          // `details.code` (the application's, else the error's own).
          const e = (r.body as { error?: { code?: string; message?: string; details?: unknown } } | null)
            ?.error;
          const details = (e?.details ?? {}) as Record<string, unknown>;
          this.send({
            t: 'error',
            stream,
            code: 'stream_refused',
            message: e?.message ?? 'Refused.',
            retryable: false,
            details: {
              ...details,
              code: typeof details.code === 'string' ? details.code : (e?.code ?? 'failed'),
            } as never,
          });
          return;
        }
      }
      if (!found) return this.refuse(stream, 'not_found');
      const bytes = found.bytes;
      this.streams.set(stream, (frame) => {
        if (frame.type === 'reset') {
          this.outbox.delete(stream);
          this.afterDrain.delete(stream);
          this.streams.delete(stream);
        }
      });
      this.send({
        t: 'opened',
        stream,
        meta: {
          kind: 'export',
          contentType: found.contentType,
          size: bytes.byteLength,
          ...(found.name && { name: found.name }),
        },
      });
      this.afterDrain.set(stream, () => {
        this.afterDrain.delete(stream);
        this.send({ t: 'stream_done', stream, size: bytes.byteLength, sha256: bytesToHex(sha256(bytes)) });
        this.deliver({ type: 'end', streamId: stream });
        this.streams.delete(stream);
      });
      const box: Uint8Array[] = [];
      for (let at = 0; at < bytes.byteLength; at += maxDataBytes)
        box.push(bytes.slice(at, at + maxDataBytes));
      this.outbox.set(stream, box);
      if (box.length === 0) this.afterDrain.get(stream)?.();
      else this.pump(stream);
    }

    openUpload(stream: number, spec: OpenSpec<'upload'>) {
      const { burrow } = spec.target;
      // Attachments and staged backup files (CT-55, CT-335) share the machinery; the id names either. A dictation
      // recording has none: it is the stream's own, so it is never resumed.
      const attachmentId =
        spec.target.type === 'backup-file'
          ? spec.target.stagedBackupId
          : spec.target.type === 'dictation'
            ? `dictation:${++dictations}`
            : spec.target.attachmentId;
      const target = spec.target;
      if (completed.has(attachmentId)) return this.refuse(stream, 'forbidden');
      // A recording over five minutes is refused before its bytes come.
      if (target.type === 'dictation' && spec.size > VOICE_TYPING_MAX_BYTES)
        return this.send({
          t: 'error',
          stream,
          code: 'stream_refused',
          message: 'That recording is too long.',
          retryable: false,
          details: { reason: 'too_long', code: 'too_long' },
        });
      let u = uploads.get(attachmentId);
      if (!u || u.sha256 !== spec.sha256 || u.size !== spec.size || u.chunkSize !== spec.chunkSize) {
        u = {
          burrow,
          attachmentId,
          size: spec.size,
          sha256: spec.sha256,
          chunkSize: spec.chunkSize,
          chunks: [],
          received: 0,
        };
        uploads.set(attachmentId, u);
      }
      const up = u;
      let current: { index: number; size: number; sha256: string; parts: Uint8Array[]; got: number } | null =
        null;
      const reset = (code: number) => {
        this.streams.delete(stream);
        this.controls.delete(stream);
        this.deliver({ type: 'reset', streamId: stream, code });
      };
      this.controls.set(stream, (m) => {
        if (m.t !== 'chunk') return;
        if (m.offset !== up.received) {
          reset(STREAM_RESET.protocolError);
          return;
        }
        current = { index: m.index, size: m.size, sha256: m.sha256, parts: [], got: 0 };
      });
      this.streams.set(stream, (frame) => {
        if (frame.type === 'data') {
          const c = current;
          if (!c) return reset(STREAM_RESET.protocolError);
          c.parts.push(frame.payload.slice());
          c.got += frame.payload.byteLength;
          // Keep the client's window open as we store what arrived.
          this.deliver({ type: 'credit', streamId: stream, credit: frame.payload.byteLength });
          if (dropUploadAt !== null) {
            dropUploadAt -= frame.payload.byteLength;
            if (dropUploadAt <= 0) {
              dropUploadAt = null;
              this.drop('lost');
              return;
            }
          }
          if (c.got > c.size) return reset(STREAM_RESET.tooLarge);
          if (c.got === c.size) {
            const chunk = concat(c.parts);
            if (bytesToHex(sha256(chunk)) !== c.sha256) return reset(STREAM_RESET.integrity);
            up.chunks.push(chunk);
            up.received += chunk.byteLength;
            current = null;
            this.send({ t: 'chunk_ack', stream, index: c.index, received: up.received });
          }
        } else if (frame.type === 'end') {
          const bytes = concat(up.chunks);
          if (bytes.byteLength !== up.size || (up.sha256 && bytesToHex(sha256(bytes)) !== up.sha256)) {
            uploads.delete(up.attachmentId);
            return reset(STREAM_RESET.integrity);
          }
          completed.add(up.attachmentId);
          uploads.delete(up.attachmentId);
          void (async () => {
            let output: unknown;
            try {
              output = options.completeUpload
                ? await options.completeUpload({
                    burrow: up.burrow,
                    attachmentId: up.attachmentId,
                    bytes,
                    target,
                  })
                : { attachmentId: up.attachmentId };
            } catch (error) {
              if (!(error instanceof FakeUploadRefusal)) throw error;
              this.send({
                t: 'error',
                stream,
                code: error.code as never,
                message: error.message,
                retryable: false,
                ...(error.details === undefined ? {} : { details: error.details as never }),
              });
              this.deliver({ type: 'end', streamId: stream });
              this.streams.delete(stream);
              return;
            }
            this.send({
              t: 'stream_done',
              stream,
              size: bytes.byteLength,
              sha256: up.sha256 ?? bytesToHex(sha256(bytes)),
              output: output as never,
            });
            this.deliver({ type: 'end', streamId: stream });
            this.streams.delete(stream);
          })();
        } else if (frame.type === 'reset') {
          this.streams.delete(stream);
          this.controls.delete(stream);
        }
      });
      this.send({
        t: 'opened',
        stream,
        meta: { kind: 'upload', received: up.received, chunkSize: up.chunkSize },
      });
    }

    openConsole(stream: number, spec: OpenSpec<'console'>) {
      let open = true;
      // What the console sends before `opened` went out waits for it, as on the appliance.
      let early: Uint8Array[] | null = [];
      const io: FakeConsoleIo = {
        send: (message) => {
          if (this.closed || !open) return;
          if (early) {
            early.push(message);
            return;
          }
          for (const part of consoleDataPayloads(encodeConsoleMessages([message]), maxDataBytes))
            this.sendData(stream, part.slice());
        },
        end: () => {
          if (this.closed || !open) return;
          open = false;
          const done = () => {
            this.afterDrain.delete(stream);
            this.deliver({ type: 'end', streamId: stream });
          };
          if (this.outbox.get(stream)?.length) this.afterDrain.set(stream, done);
          else done();
        },
      };
      const made = options.console?.(
        { burrow: spec.burrow, sessionId: spec.sessionId, token: spec.token },
        io,
      ) ?? { refused: 'not_supported', message: 'Refused.' };
      if ('refused' in made) {
        this.send({
          t: 'error',
          stream,
          code: 'stream_refused',
          message: made.message,
          retryable: false,
          details: { code: made.refused, reason: made.refused } as never,
        });
        return;
      }
      const decoder = new ConsoleMessageDecoder();
      this.streams.set(stream, (frame) => {
        if (frame.type === 'data') {
          this.deliver({ type: 'credit', streamId: stream, credit: frame.payload.byteLength });
          for (const m of decoder.push(frame.payload)) made.peer.receive(m);
        } else if (frame.type === 'reset' || frame.type === 'end') {
          open = false;
          this.streams.delete(stream);
          this.outbox.delete(stream);
          this.afterDrain.delete(stream);
          made.peer.close();
        }
      });
      this.onClose.push(() => made.peer.close());
      this.send({ t: 'opened', stream, meta: { kind: 'console', protocol: made.protocol } });
      const waiting = early;
      early = null;
      for (const m of waiting) io.send(m);
    }

    openCollab(stream: number, spec: OpenSpec<'collab'>) {
      const peer = options.collab?.({ burrow: spec.burrow, canvasId: spec.canvasId }, (message) => {
        if (this.closed) return;
        for (const part of collabDataPayloads(encodeCollabMessages([message]), maxDataBytes))
          this.sendData(stream, part.slice());
      });
      if (!peer) return this.refuse(stream, 'forbidden');
      const decoder = new CollabMessageDecoder();
      this.streams.set(stream, (frame) => {
        if (frame.type === 'data') {
          this.deliver({ type: 'credit', streamId: stream, credit: frame.payload.byteLength });
          for (const m of decoder.push(frame.payload)) peer.receive(m);
        } else if (frame.type === 'reset' || frame.type === 'end') {
          this.streams.delete(stream);
          peer.close();
        }
      });
      this.onClose.push(() => peer.close());
      this.send({
        t: 'opened',
        stream,
        meta: { kind: 'collab', documentName: `canvas:${spec.canvasId}`, readOnly: false },
      });
    }
  }

  const connectorFor = (who: FakeEndpoint): SessionConnector => ({
    async connect({ signal }) {
      connects += 1;
      if (hanging > 0) {
        hanging -= 1;
        await new Promise<never>((_, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              abandoned += 1;
              reject(new ConnectError('closed'));
            },
            { once: true },
          ),
        );
      }
      await delay(options.latencyMs ?? 0);
      if (signal.aborted) throw new ConnectError('closed');
      if (offline) throw new ConnectError('appliance_offline', 'The appliance is not connected.');
      if (failing && failing.n > 0) {
        failing.n -= 1;
        const f = failing;
        if (failing.n === 0) failing = null;
        throw new ConnectError(f.reason, undefined, f.retryAfterMs);
      }
      return pair(who);
    },
  });

  /** A connected client/appliance pair; frames cross as length-prefixed bytes and are re-framed on arrival. */
  function pair(who: FakeEndpoint): WireConnection {
    const frameListeners: ((f: Frame) => void)[] = [];
    const closeListeners: ((i: {
      reason: DisconnectReason;
      detail?: string;
      retryAfterMs?: number;
    }) => void)[] = [];
    let closed = false;
    let clientClosed = false;
    let stalled = false;
    const stall = () => {
      stalled = true;
    };
    stallers.add(stall);
    let sent = 0;
    const latency = options.latencyMs ?? 0;
    const later = (fn: () => void) => (latency ? setTimeout(fn, latency) : queueMicrotask(fn));
    const toClient = new FrameDecoder();
    const toAppliance = new FrameDecoder();
    const end: ApplianceEnd = new ApplianceEnd(
      (frame) => {
        // Frames the appliance sent before it closed still arrive, in order, before the close.
        if (closed || stalled) return;
        const bytes = encodeFrame(frame);
        later(() => {
          if (clientClosed) return;
          for (const f of toClient.push(bytes)) for (const l of frameListeners) l(f);
        });
      },
      (reason) => shutdown(reason),
    );
    end.who = who;
    sessions.add(end);
    function shutdown(reason: DisconnectReason) {
      if (closed) return;
      closed = true;
      end.closed = true;
      sessions.delete(end);
      stallers.delete(stall);
      for (const c of end.onClose) c();
      later(() => {
        if (clientClosed) return;
        for (const l of closeListeners) l({ reason });
      });
    }
    return {
      send(frame) {
        if (closed) throw new Error('closed');
        const bytes = encodeFrame(frame);
        sent += bytes.byteLength;
        if (stalled) return;
        later(() => {
          if (!closed) for (const f of toAppliance.push(bytes)) end.receive(f);
        });
      },
      onFrame(listener) {
        frameListeners.push(listener);
      },
      onClose(listener) {
        closeListeners.push(listener);
      },
      close() {
        clientClosed = true;
        if (closed) return;
        closed = true;
        end.closed = true;
        sessions.delete(end);
        stallers.delete(stall);
        for (const c of end.onClose) c();
      },
      bytesSent: () => sent,
      congested: () => false,
      drained: () => Promise.resolve(),
    };
  }

  function serve(stream: FakeByteStream, who: FakeEndpoint) {
    const decoder = new FrameDecoder();
    const end: ApplianceEnd = new ApplianceEnd(
      (frame) => {
        if (!end.closed) stream.write(encodeFrame(frame));
      },
      () => {
        end.closed = true;
        sessions.delete(end);
        for (const c of end.onClose) c();
        void stream.close();
      },
    );
    end.who = who;
    sessions.add(end);
    void (async () => {
      try {
        for (;;) {
          const chunk = await stream.read();
          if (chunk === null) break;
          for (const f of decoder.push(chunk)) end.receive(f);
        }
      } catch {
        // transport failed
      }
      end.closed = true;
      sessions.delete(end);
    })();
  }

  return {
    connector: connectorFor({ endpointId: 'default', channel: 'app' }),
    connectorFor,
    serve,
    applianceId,
    dropEndpoint(endpointId, reason = 'revoked') {
      for (const s of [...sessions])
        if (s.who.endpointId === endpointId) {
          if (reason === 'revoked')
            s.send({ t: 'revoked', scope: 'endpoint', authzGeneration: ++authzGeneration, clearCache: true });
          s.drop(reason);
        }
    },
    publish(topic, event) {
      cursor += 1;
      events.push({ cursor, topic, event });
      while (events.length > retention) events.shift();
      for (const s of sessions) s.publish(cursor, topic, event);
    },
    publishLive(topic, event) {
      for (const s of sessions) s.publishLive(topic, event);
    },
    faults: {
      offline(value) {
        offline = value;
        if (value) for (const s of [...sessions]) s.drop('appliance_offline');
      },
      failConnects(reason, n = 1, retryAfterMs) {
        failing = { reason, n, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
      },
      dropAll(reason = 'lost') {
        for (const s of [...sessions]) s.drop(reason);
      },
      loseResults(n = 1) {
        loseResults = n;
      },
      loseBeforeCommit(n = 1, runtime = 'not_found') {
        loseBeforeCommit = n;
        beforeCommitAnswer = runtime;
      },
      loseAfterCommit(n = 1, runtime = 'redacted') {
        loseAfterCommit = { n, runtime };
      },
      expireReceipts() {
        for (const [k, r] of receipts)
          if (r.state === 'completed' || r.state === 'rejected') receipts.delete(k);
      },
      slowAccept(ms) {
        slowAcceptMs = ms;
      },
      swallowRequests(n = 1) {
        swallow = n;
      },
      dropUploadAfter(bytes) {
        dropUploadAt = bytes;
      },
      revoke() {
        revokedAll = true;
        authzGeneration += 1;
        for (const s of [...sessions]) {
          s.send({ t: 'revoked', scope: 'endpoint', authzGeneration, clearCache: true });
          s.drop('revoked');
        }
      },
      bumpAuthz() {
        authzGeneration += 1;
        for (const s of sessions) {
          s.send({ t: 'authz_changed', authzGeneration, clearCache: false });
          for (const sub of [...s.subs.keys()]) s.snapshot(sub, 'authz_changed', cursor);
        }
      },
      restart() {
        epoch = newEpoch();
        for (const s of [...sessions]) s.drop('lost');
      },
      overflow() {
        for (const s of sessions) for (const sub of [...s.subs.keys()]) s.snapshot(sub, 'overflow', cursor);
      },
      repeatSnapshot(n = 1) {
        repeatSnapshots = n;
      },
      majors(list) {
        majors = list;
      },
      clientFloor(value) {
        floor = value ?? null;
      },
      direct(value) {
        direct = value;
      },
      edition(value) {
        edition = value;
      },
      expireEvents(keep = 0) {
        while (events.length > keep) events.shift();
      },
      goaway(reason, retryAfterMs = 0) {
        for (const s of [...sessions]) {
          s.send({ t: 'goaway', reason, retryAfterMs });
          setTimeout(() => s.drop(reason === 'rekey' ? 'rekey' : 'busy'), 20);
        }
      },
      stall() {
        for (const s of [...stallers]) s();
        stallers.clear();
      },
      hangConnects(n = 1) {
        hanging = n;
      },
      mutePongs(on = true) {
        pongless = on;
      },
      delayPongs(ms) {
        pongDelayMs = ms;
      },
    },
    stats: () => ({
      connects,
      pings,
      abandoned,
      open: sessions.size,
      executed,
      requestsSeen,
      attempts,
      statusAsked,
      lastHello,
      subscribes,
    }),
  };
}

function newEpoch(): string {
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}

function parseFakeCursor(raw: string): { epoch: string; n: number } | null {
  const m = /^([a-z0-9]+)\.(\d+)$/.exec(raw);
  return m?.[1] && m[2] ? { epoch: m[1], n: Number(m[2]) } : null;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}
