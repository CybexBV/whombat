/**
 * `createSecureSession` — the managed transport (MA-05…MA-09, AP-10…AP-14) on session protocol v1
 * (`@whombat/protocol/session`). Connections come from an injected `SessionConnector` (control ticket → relay
 * WebSocket → Noise session pinned to the appliance → length-prefixed frames); this module is everything above:
 *
 * - hello/welcome: version and capability negotiation, the account, `authzGeneration`, `clearCache`;
 * - requests with idempotency ids, deadlines, cancellation and the durable-command phases (sent → accepted →
 *   result/error); after a lost connection an ambiguous mutation is resolved with `status` → `outcome`, never
 *   blindly resent; only an op the contract classifies as receipt-deduplicated and not destructive, and never
 *   acknowledged, is resent (same id, same input) once `status` says it never committed — the rest surface as
 *   `OutcomeUnknownError` (MA-09, CT-194, `retryPolicy`, AP-574);
 * - subscriptions resumed from appliance cursors, `snapshot_required` when that's impossible: the appliance has
 *   dropped the subscription, so after the refetch signal it is subscribed again after the given cursor (AP-1097);
 * - streams with credit flow control: downloads (sha256 checked against `stream_done`), chunked resumable
 *   uploads (`chunk` / `chunk_ack`), collaboration channels, consoles (`console` streams, WebSocket-shaped); bulk
 *   transfers on their own connection;
 * - reconnect with jittered exponential backoff and a fresh handshake every time; `goaway` and the secure
 *   channel's rekey limit are planned reconnects; heartbeat (`ping`/`pong`); `revoked` / `authz_changed`.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { type AnyEndpoint, TYPING_TTL_MS } from '@whombat/core/contracts';
import {
  CONSOLE_MAX_MESSAGE_BYTES,
  SESSION_INITIAL_STREAM_CREDIT,
  SESSION_MAX_DATA_BYTES,
  SESSION_MAX_DEADLINE_MS,
  SESSION_MIN_DEADLINE_MS,
} from '@whombat/protocol';
import { CollabMessageDecoder, collabDataPayloads, encodeCollabMessages } from '@whombat/protocol/collab';
import { ConsoleMessageDecoder, consoleDataPayloads, encodeConsoleMessages } from '@whombat/protocol/console';
import { type Frame, STREAM_RESET } from '@whombat/protocol/frame';
import {
  API_OPERATIONS,
  type ApplianceMessage,
  appErrorCode,
  type ClientMessage,
  EXPORT_READ_OPS,
  editionOf,
  encodeSessionMessage,
  type OperationRetry,
  operationSafety,
  resendAfterNotFound,
  SECRET_API_OPS,
  SESSION_EXCLUDED_API_OPS,
  SESSION_OPERATIONS,
  SESSION_PROTOCOL,
  UnsupportedVersionDetails,
  whoMustUpdate,
} from '@whombat/protocol/session';
import { type BackoffOptions, backoffDelay } from '../realtime/realtime';
import {
  CONSOLE_CLOSE,
  ConsoleSocket,
  type ConsoleTarget,
  consoleCloseCodeOf,
  consoleRefusalCodeOf,
} from './console';
import { decodeControl } from './control-decode';
import { newRequestId } from './ids';
import { guardListeners, type ListenerErrorHook } from './listeners';
import { apiOpName } from './op-names';
import { readExportFile } from './resources';
import {
  type ApplianceSession,
  CAPABILITIES,
  type CallOptions,
  type ChunkSource,
  type CollabChannel,
  type CommandStatus,
  ConnectionLostError,
  type ConnectionState,
  DeadlineExceededError,
  type DisconnectReason,
  NotDeliveredError,
  type OperationInput,
  type OperationResponse,
  OutcomeRedactedError,
  OutcomeUnknownError,
  type ResourceMeta,
  type ResourceRef,
  type ResourceStream,
  type RunningHash,
  SessionClosedError,
  type SessionInfo,
  type SessionNotice,
  type SessionSubscription,
  StreamError,
  type SubscriptionHandlers,
  TERMINAL_REASONS,
  type UploadStreamOptions,
  type UploadTarget,
} from './types';
import { CLIENT_PROTOCOL, ConnectError, type SessionConnector, type WireConnection } from './wire';

export interface SecureSessionOptions {
  connector: SessionConnector;
  /**
   * `hello.client`: `buildNumber` is the platform's integer build (Android `versionCode`, the web build counter),
   * compared with the appliance's client security floor (CT-53); absent counts as 0.
   */
  client?: { build: string; platform: 'web' | 'android' | 'ios' | 'desktop' | 'cli'; buildNumber?: number };
  /**
   * `app` (default): a session for an enrolled endpoint; the enrollment channel ends it as `not_enrolled`.
   * `any`: also accept the enrollment channel (claim, pairing, recovery journeys).
   */
  expect?: 'app' | 'any';
  /**
   * The account and `authzGeneration` what this client has cached was fetched under (`hello.cachedAccountId` +
   * `hello.cachedAuthzGeneration`, always together; CT-47). Default: the previous connection's welcome, so a
   * reconnect tells the appliance what it holds; nothing on a first connection.
   */
  cached?: () => { accountId: string; authzGeneration: number } | undefined;
  /**
   * `hello.claimLink`: the claim link's secret, on a page at a box's own address that was opened with it. A box nobody
   * claimed keeps a few places for the sessions that show it. Left out everywhere else.
   */
  claimLink?: string | null;
  backoff?: BackoffOptions;
  /** Default deadline for delivering and accepting a request. Default 30 s. */
  deadlineMs?: number;
  /** Waiting for `welcome` after the connection is up. Default 15 s. */
  handshakeTimeoutMs?: number;
  /**
   * First interval of `status` checks while a command is accepted but not finished (after a reconnect); it doubles
   * while nothing changes, up to `statusPollMaxMs`. Default 2 s.
   */
  statusPollMs?: number;
  /** Longest interval between those checks. Default 30 s. */
  statusPollMaxMs?: number;
  /**
   * How long accepted work may go without progress (the appliance keeps answering the same `accepted` / `executing`)
   * before the session stops asking and reports `OutcomeUnknownError`, acknowledged: never resent, checked again by a
   * person (AP-578). A runtime before contracts 0.29.1 answers `accepted` for ever when the process that ran the
   * command died after its commit. Default 10 min.
   */
  acceptedWaitMs?: number;
  heartbeatMs?: number;
  /** What a listener of this session threw (`listeners.ts`): the session goes on. Default: the console. */
  onListenerError?: ListenerErrorHook;
  /**
   * A connection attempt that hasn't opened after this long gets a second one beside it; the first to open is used and
   * the other closed (open-speed.md AP-4400). A bad network path can hold one connection up for tens of seconds while a
   * new one almost always takes another path. Default 3 s; 0 turns it off.
   */
  raceAfterMs?: number;
  /**
   * An open connection that has work outstanding (a request, a download or upload) and has heard nothing for this long
   * is sent a `ping`; no `pong` within the same time again and it is stuck: it is closed and the session reconnects,
   * asking reads again (AP-4401). Doubles after a stuck connection, up to 20 s, while they keep coming within two
   * minutes, so a slow network doesn't reconnect over and over. Default 2.5 s; 0 turns it off.
   */
  stallMs?: number;
  /** Upload chunk size (64 KiB…4 MiB, UPLOAD_*_CHUNK_BYTES). Default 256 KiB. */
  uploadChunkBytes?: number;
  /**
   * More operations to treat as destructive (MA-09, CT-194): their ambiguous outcome is never resent automatically,
   * a person decides. Stricter only: it adds to the contract's classification (`OperationSpec.destructive`), never
   * removes from it.
   */
  isDestructive?: (op: string, method: string) => boolean;
  random?: () => number;
  now?: () => number;
  /** Upload attempts across reconnects before giving up. Default 6. */
  uploadAttempts?: number;
  /**
   * Waiting before subscribing again when the appliance answers that very subscribe with `snapshot_required` once
   * more (within `SNAPSHOT_REPEAT_MS`): grows with each repeat, so a runtime that keeps refusing is never asked in a
   * tight loop (AP-1097). The first `snapshot_required` is followed at once. Default 1 s doubling to 30 s.
   */
  snapshotBackoff?: BackoffOptions;
  /**
   * Download/upload streams open at once on the bulk connection. Each may have the initial credit (256 KiB)
   * outstanding; browsers and React Native can't pause a WebSocket and fail above 8 MiB buffered, so the
   * default 6 keeps a connection at ≤ 1.5 MiB (AP-13).
   */
  maxBulkStreams?: number;
  /**
   * A new running SHA-256 for each download and upload (its bytes go in as they pass, the digest is read once). Default
   * the pure-JS one; the phone hands in its system's when that matched the pure-JS hash, since hashing every frame in
   * JavaScript is a large part of a download's cost there.
   */
  sha256?: () => RunningHash;
}

/** How many reads that were too large for one message the session remembers (so they go straight to a stream). */
const TOO_LARGE_REMEMBERED = 64;

/** What an API answer read through an export stream may weigh (the audit CSV, a pack archive, a large read). */
const EXPORT_CALL_MAX_BYTES = 64 * 1024 * 1024;
/** The least time a read that outgrew one message gets through its export stream. */
const TOO_LARGE_READ_MS = 60_000;

/**
 * Whether `op` is destructive (CT-194): the contract's classification (`OperationSpec.destructive`, from
 * `OPERATION_SAFETY`); an op it doesn't know is destructive when it is a DELETE. Replaces the op-name heuristic.
 */
export function defaultIsDestructive(op: string, method: string): boolean {
  return operationSafety(op)?.destructive ?? method === 'DELETE';
}

/** What the session may do on its own with a request whose answer it never got (CT-194, AP-570). */
export interface RetryPolicy {
  /** The contract's class (`OperationRetry`); `never` for an op this build doesn't know. */
  retry: OperationRetry;
  /** Contract or caller (`isDestructive`) says so; only meaningful for mutations. */
  destructive: boolean;
  /** Asked again as it is (the same id) after a reconnect: a read, nothing durable happens. */
  reask: boolean;
  /**
   * Sent again (same id, exact input) once `status` answered `not_found`: a `receipt` op that isn't destructive, and
   * only while the appliance never acknowledged the request (AP-574: afterwards `not_found` means its receipt expired).
   * The appliance's receipt then runs it at most once. Everything else is `OutcomeUnknownError`, and a person decides.
   */
  resend: boolean;
}

/**
 * How the session treats `op` after an ambiguous delivery (CT-194, AP-570): the contract's `retry` and `destructive`
 * (`OPERATION_SAFETY` in `@whombat/protocol/session`), made stricter by `isDestructive`. An op this build doesn't know
 * (a newer runtime's, an `invoke` of any other name) is never asked or sent again by itself, whatever `method` says.
 * Advice for this client only: the appliance authorizes every request and its receipts are what dedupe a resend.
 */
export function retryPolicy(
  op: string,
  method: string,
  isDestructive?: (op: string, method: string) => boolean,
): RetryPolicy {
  const retry = operationSafety(op)?.retry ?? 'never';
  const destructive =
    retry !== 'safe' && (defaultIsDestructive(op, method) || isDestructive?.(op, method) === true);
  return { retry, destructive, reask: retry === 'safe', resend: resendAfterNotFound(op) && !destructive };
}

/** Error codes of `@whombat/protocol` → the HTTP status the typed client decodes (AP-12). */
const STATUS_OF: Record<string, number> = {
  bad_request: 400,
  validation_failed: 400,
  invalid_code: 400,
  invalid_message: 400,
  unauthorized: 401,
  sign_in_required: 401,
  forbidden: 403,
  not_allowed: 403,
  blocked: 403,
  revoked: 403,
  enrollment_required: 403,
  not_found: 404,
  unknown_op: 404,
  conflict: 409,
  slug_taken: 409,
  idempotency_mismatch: 409,
  expired: 410,
  too_large: 413,
  rate_limited: 429,
  too_many: 429,
  not_implemented: 501,
  unavailable: 503,
  internal: 500,
};

/**
 * The error code of an application code a refused export read carries alone (`details.code` without the error's own,
 * AP-5521): its status follows. Any other application code reads as a `conflict`.
 */
const REFUSAL_CODE_OF: Readonly<Record<string, string>> = {
  skill_hub_unavailable: 'unavailable',
  skill_blocked: 'not_allowed',
  skill_exists: 'conflict',
};

/** A request's `error` as an HTTP-shaped response (the body is core's `ApiErrorBody` / `BlockedBody`). */
export function errorResponse(
  requestId: string,
  e: { code: string; message: string; fields?: Record<string, string[]>; details?: unknown },
): OperationResponse {
  const details = (e.details ?? undefined) as Record<string, unknown> | undefined;
  if (e.code === 'approval_required') return { status: 202, body: details, requestId };
  // The application's own code (`claim_used`, `invalid_code`…) rides in `details.code` when it isn't one of the
  // protocol's codes (AP-19).
  const code = appErrorCode(details) ?? e.code;
  const error = {
    code,
    message: e.message,
    ...(e.fields && { fields: e.fields }),
    ...(details && { details }),
  };
  if (e.code === 'blocked')
    return {
      status: 403,
      body: { error, blocked: true, keyNeeded: details?.keyNeeded, eventId: details?.eventId },
      requestId,
    };
  return { status: STATUS_OF[e.code] ?? 500, body: { error }, requestId };
}

type Phase = 'queued' | 'sent' | 'accepted' | 'executing' | 'checking';

interface Pending {
  id: string;
  op: string;
  /** Exactly what every attempt sends (the appliance binds the id to its digest). */
  input: unknown;
  /** Presence/typing: never queued, never resent, no receipt (contracts 0.4). */
  ephemeral: boolean;
  /** What may happen after an ambiguous delivery (CT-194). */
  policy: RetryPolicy;
  phase: Phase;
  /**
   * The appliance said `accepted` (or `status` said `accepted`/`executing`), on any connection so far. From then on a
   * `not_found` means its receipt is gone (retention, `WHOMBAT_COMMAND_RECEIPT_HOURS`), never that it didn't run: it is
   * never resent (AP-574, as `nextCommandState` keeps `accepted` on `not_found`).
   */
  acknowledged: boolean;
  /** The receipt state last seen (`accepted` / `executing`), when it last changed, and the next status interval. */
  seen: 'accepted' | 'executing' | null;
  progressAt: number;
  pollDelay: number;
  /** Connection generation the request was last sent on. */
  sentOn: number;
  deadlineAt: number;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  pollTimer: ReturnType<typeof setTimeout> | null;
  options: CallOptions;
  resolve(r: OperationResponse): void;
  reject(e: unknown): void;
  cleanup(): void;
}

interface Sub {
  id: string;
  topics: readonly string[];
  cursor: string | null;
  handlers: SubscriptionHandlers;
  /** `subscribe` messages sent for it, on any path: tells whether a handler already subscribed it again. */
  sent: number;
  /** When it was last subscribed again after a `snapshot_required`, for the loop guard; null before that. */
  resubscribedAt: number | null;
  /** `snapshot_required` answers in a row, each within `SNAPSHOT_REPEAT_MS` of subscribing again (0: the first). */
  repeats: number;
  /** Subscribing again later, after a repeated `snapshot_required` (AP-1097). */
  retry: ReturnType<typeof setTimeout> | null;
}

/**
 * A `snapshot_required` this soon after subscribing again counts as the appliance refusing once more: the next
 * attempt waits (`snapshotBackoff`). A well-behaved appliance never does, since we resume from the cursor it gave.
 */
const SNAPSHOT_REPEAT_MS = 10_000;

/** The longest the stall check waits (AP-4401), and how long stuck connections count as one spell. */
const MAX_STALL_MS = 20_000;
/** A `probe()`'s wait when the stall check is turned off. */
const DEFAULT_CHECK_MS = 2500;
const STUCK_SPELL_MS = 120_000;

interface StreamHandler {
  onFrame(frame: Frame): void;
  onControl(message: ApplianceMessage): void;
  /** The connection carrying the stream ended. */
  onLost(reason: DisconnectReason): void;
  /** A canvas's collaboration: open for as long as the canvas is, so never work under way (`suspend`, AP-924). */
  collab?: true;
  /** May go quiet for as long as it likes (a console with nothing to print): never waiting for an answer (AP-4401). */
  quiet?: true;
}

interface Conn {
  gen: number;
  wire: WireConnection;
  class: 'interactive' | 'bulk';
  info: SessionInfo;
  maxDataBytes: number;
  initialCredit: number;
  lastInbound: number;
  heartbeat: ReturnType<typeof setInterval> | null;
  /** When the heartbeat's oldest `ping` still without anything heard after it went out (0: none yet). */
  beatAt: number;
  /** When the stall check's `ping` went out, while it waits for anything to come back (AP-4401). */
  probeAt: number | null;
  /** That `ping`'s number, and the highest `pong` heard (AP-4409). */
  probeN: number;
  pongN: number;
  /** The next stall check, armed while something is sent. */
  watch: ReturnType<typeof setTimeout> | null;
  /** The `probe()` waiting for its `pong`: its timer, its ping's number, when it is due (`now()`), and whether it
   * already had its one more wait after firing late. */
  check: ReturnType<typeof setTimeout> | null;
  checkN: number;
  checkDue: number;
  checkLate: boolean;
  /**
   * Until when the appliance owes this connection another frame: an agent's thinking line is refreshed every few
   * seconds while its turn runs, so silence before then is a dead path, checked at once like an unanswered request.
   */
  liveUntil: number;
  draining: boolean;
  streams: Map<number, StreamHandler>;
  nextStream: number;
  closed: boolean;
}

type Outcome = Extract<ApplianceMessage, { t: 'outcome' }>;

/** One `status()` caller: answered by the `outcome`, or failed when the session closes first. */
interface StatusWaiter {
  answer(m: Outcome): void;
  fail(error: Error): void;
}

/** `secret` ops (CT-44): session-native ones from their spec, `api` ones from `SECRET_API_OPS`. */
export function isSecretOp(op: string): boolean {
  return SESSION_OPERATIONS.get(op)?.secret === true || SECRET_API_OPS.includes(op);
}

/**
 * `outcome{rejected, error.code: unknown_outcome}` (CT-196): the appliance has the request but can't tell whether it
 * took effect — it acted outside its commit before its answer was lost. Unknown, not a refusal.
 */
function mayHaveHappened(m: Outcome): boolean {
  return m.state === 'rejected' && m.error?.code === 'unknown_outcome';
}

function outcomeResponse(requestId: string, m: Outcome): OperationResponse {
  if (m.error) return errorResponse(requestId, m.error);
  return { status: m.result?.kind === 'approval_required' ? 202 : 200, body: m.result?.output, requestId };
}

export function createSecureSession(options: SecureSessionOptions): ApplianceSession {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const deadlineMs = options.deadlineMs ?? 30_000;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 15_000;
  const statusPollMs = options.statusPollMs ?? 2000;
  const statusPollMaxMs = Math.max(statusPollMs, options.statusPollMaxMs ?? 30_000);
  const acceptedWaitMs = options.acceptedWaitMs ?? 10 * 60_000;
  const heartbeatMs = options.heartbeatMs ?? 20_000;
  const raceAfterMs = options.raceAfterMs ?? 3000;
  const baseStallMs = options.stallMs ?? 2500;
  const client = options.client ?? { build: 'dev', platform: 'web' as const };
  const expect = options.expect ?? 'app';
  const snapshotBackoff = options.snapshotBackoff ?? { initialMs: 1000, maxMs: 30_000 };
  // The reads last answered `use_export_stream`, oldest first.
  const tooLarge = new Set<string>();
  const newHash: () => RunningHash = options.sha256 ?? (() => sha256.create());
  const sha256Hex = (bytes: Uint8Array) => {
    const h = newHash();
    h.update(bytes);
    return bytesToHex(h.digest());
  };

  let state: ConnectionState = { status: 'idle' };
  let wanted = false;
  let attempt = 0;
  let generation = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let connecting: AbortController | null = null;
  let conn: Conn | null = null;
  let bulk: Promise<Conn> | null = null;
  let bulkConn: Conn | null = null;
  /** The bulk connection being dialed: given up when the session ends or lets go. */
  let bulkDial: AbortController | null = null;
  /** `bulk` is the dial `warmBulk` made beside the interactive connection's (AP-4406). */
  let bulkEarly = false;
  let lastInfo: SessionInfo | null = null;
  let nextSub = 1;
  let pingN = 0;
  /** Stuck connections in the current spell (AP-4401): each one doubles the stall check's wait. */
  let stuck = 0;
  let lastStuckAt = 0;

  const maxBulkStreams = options.maxBulkStreams ?? 6;
  let bulkOpen = 0;
  const bulkWaiters = new Set<() => void>();
  const wakeBulkWaiter = () => bulkWaiters.values().next().value?.();
  /** A slot on the bulk connection; the returned function frees it. */
  async function bulkSlot(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortError();
    while (bulkOpen >= maxBulkStreams) {
      if (signal?.aborted) throw abortError();
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          bulkWaiters.delete(ready);
          signal?.removeEventListener('abort', onAbort);
        };
        const ready = () => {
          cleanup();
          resolve();
        };
        const onAbort = () => {
          cleanup();
          reject(abortError());
          if (bulkOpen < maxBulkStreams) wakeBulkWaiter();
        };
        bulkWaiters.add(ready);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (signal?.aborted) {
      // A slot can become free just before its waiting caller is cancelled.
      wakeBulkWaiter();
      throw abortError();
    }
    bulkOpen += 1;
    let freed = false;
    return () => {
      if (freed) return;
      freed = true;
      bulkOpen -= 1;
      wakeBulkWaiter();
    };
  }

  const pending = new Map<string, Pending>();
  /** `status()` callers waiting for an `outcome`, each with its own hook (several may ask about one id). */
  const statusHooks = new Map<string, Set<StatusWaiter>>();
  const subs = new Map<string, Sub>();
  const collabs = new Set<CollabHandle>();
  const stateListeners = new Set<(s: ConnectionState) => void>();
  const noticeListeners = new Set<(n: SessionNotice) => void>();

  const tell = guardListeners(options.onListenerError);

  function setState(next: ConnectionState) {
    state = next;
    for (const l of [...stateListeners]) tell('state', l, next);
  }

  function notify(notice: SessionNotice) {
    for (const l of [...noticeListeners]) tell('notice', l, notice);
  }

  function capabilities(): ReadonlySet<string> {
    return new Set(conn?.info.capabilities ?? lastInfo?.capabilities ?? []);
  }

  /* Connections ---------------------------------------------------------------------------------------- */

  function sendRaw(wire: WireConnection, message: ClientMessage) {
    wire.send({ type: 'control', streamId: 0, payload: encodeSessionMessage(message) });
  }

  /** Opens one connection and runs hello/welcome on it. */
  async function open(cls: 'interactive' | 'bulk', signal: AbortSignal): Promise<Conn> {
    const wire = await options.connector.connect({ class: cls, signal });
    if (signal.aborted) {
      // Given up while it connected (the other attempt of a race won): never start a session on it.
      wire.close('closed');
      throw new ConnectError('closed');
    }
    const gen = ++generation;
    return new Promise<Conn>((resolve, reject) => {
      let settled = false;
      const fail = (error: ConnectError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        wire.close(error.reason);
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new ConnectError('lost', 'The appliance did not answer the handshake.')),
        handshakeTimeoutMs,
      );
      signal.addEventListener('abort', () => fail(new ConnectError('closed')), { once: true });
      let c: Conn | null = null;
      wire.onClose((info) => {
        if (!settled) {
          fail(new ConnectError(info.reason, info.detail, info.retryAfterMs));
          return;
        }
        if (c) connectionEnded(c, info.reason, info.retryAfterMs);
      });
      wire.onFrame((frame) => {
        if (c) {
          c.lastInbound = now();
          handleFrame(c, frame);
          return;
        }
        if (frame.type !== 'control') {
          fail(new ConnectError('lost', 'Data before welcome.'));
          return;
        }
        const decoded = decodeControl(frame.payload);
        if (!decoded.ok) {
          if (decoded.kind === 'unknown_type') return;
          fail(new ConnectError('lost', 'Malformed welcome.'));
          return;
        }
        const m = decoded.message;
        if (m.t === 'error') {
          if (m.code === 'unsupported_version') fail(new ConnectError(versionVerdict(m.details)));
          else if (m.code === 'revoked') fail(new ConnectError('revoked'));
          else if (m.code === 'enrollment_required') fail(new ConnectError('not_enrolled'));
          else fail(new ConnectError(m.retryable ? 'busy' : 'lost', m.message));
          return;
        }
        if (m.t !== 'welcome') {
          fail(new ConnectError('lost', `Unexpected ${m.t} before welcome.`));
          return;
        }
        if (!CLIENT_PROTOCOL.majors.includes(m.version.major)) {
          fail(
            new ConnectError(
              m.version.major > Math.max(...CLIENT_PROTOCOL.majors) ? 'client_too_old' : 'appliance_too_old',
            ),
          );
          return;
        }
        if (m.channel === 'enroll' && expect === 'app' && cls === 'interactive') {
          fail(new ConnectError('not_enrolled'));
          return;
        }
        settled = true;
        clearTimeout(timer);
        const principal = m.principal;
        c = {
          gen,
          wire,
          class: cls,
          info: {
            protocol: m.version,
            capabilities: m.capabilities,
            appliance: { id: m.appliance, name: null },
            account: principal
              ? {
                  id: principal.accountId,
                  name: principal.name,
                  principals: principal.principals ?? [],
                }
              : null,
            endpointId: m.endpointId,
            authzGeneration: m.authzGeneration,
            clearCache: m.clearCache,
            channel: m.channel,
            direct: m.direct ?? null,
            edition: editionOf(m.edition),
          },
          maxDataBytes: Math.min(m.limits.maxDataBytes, SESSION_MAX_DATA_BYTES),
          initialCredit: m.limits.initialStreamCredit ?? SESSION_INITIAL_STREAM_CREDIT,
          lastInbound: now(),
          heartbeat: null,
          beatAt: 0,
          probeAt: null,
          probeN: 0,
          pongN: 0,
          watch: null,
          check: null,
          checkN: 0,
          checkDue: 0,
          checkLate: false,
          liveUntil: 0,
          draining: false,
          streams: new Map(),
          nextStream: 1,
          closed: false,
        };
        const live = c;
        live.heartbeat = setInterval(() => {
          const at = now();
          const answered = live.lastInbound >= live.beatAt;
          // Lost when a ping goes unanswered, counted from that ping rather than from the last thing heard: a hidden
          // browser tab runs this timer only about once a minute, so there the last answer is always a minute old
          // although the connection is fine. Counted from it, such a tab reconnected every few minutes, and each new
          // connection held the person's phone notifications back for a minute.
          if (!answered && at - live.beatAt > heartbeatMs * 1.5) {
            live.wire.close('lost');
            connectionEnded(live, 'lost');
            return;
          }
          if (answered) live.beatAt = at;
          send(live, { t: 'ping', n: ++pingN });
        }, heartbeatMs);
        resolve(live);
      });
      const cached = options.cached
        ? options.cached()
        : lastInfo?.account
          ? { accountId: lastInfo.account.id, authzGeneration: lastInfo.authzGeneration }
          : undefined;
      sendRaw(wire, {
        t: 'hello',
        versions: [{ ...SESSION_PROTOCOL }],
        capabilities: Object.values(CAPABILITIES),
        client,
        ...(cached && {
          cachedAuthzGeneration: cached.authzGeneration,
          cachedAccountId: cached.accountId,
        }),
        ...(options.claimLink && { claimLink: options.claimLink }),
      });
    });
  }

  /**
   * Sends a control message; false when the connection is gone. A message that fails the protocol's own
   * validation throws `SessionEncodeError` (a bug or invalid input: never silently dropped).
   */
  function send(c: Conn, message: ClientMessage): boolean {
    if (c.closed) return false;
    const payload = encodeSessionMessage(message);
    try {
      c.wire.send({ type: 'control', streamId: 0, payload });
      watch(c);
      return true;
    } catch {
      return false;
    }
  }

  /** Sends a stream frame; false when the connection is gone (the stream then fails as `lost`). */
  function sendFrame(c: Conn, frame: Frame): boolean {
    if (c.closed) return false;
    try {
      c.wire.send(frame);
      watch(c);
      return true;
    } catch {
      return false;
    }
  }

  /* Stuck connections (open-speed.md AP-4400…AP-4402) -------------------------------------------------- */

  /**
   * `open`, raced: when the attempt hasn't opened after `raceAfterMs`, a second one starts beside it and the first to
   * open wins; the other is aborted, or closed if it opens too. A failure ends the race only once every attempt
   * started has failed, so a refusal (the appliance offline) still goes through the session's backoff.
   */
  function openRaced(cls: 'interactive' | 'bulk', signal: AbortSignal): Promise<Conn> {
    if (!raceAfterMs) return open(cls, signal);
    return new Promise<Conn>((resolve, reject) => {
      const tries: AbortController[] = [];
      let failed = 0;
      let settled = false;
      let lastError: unknown = null;
      const settle = (done: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        done();
      };
      const onAbort = () =>
        settle(() => {
          for (const t of tries) t.abort();
          reject(new ConnectError('closed'));
        });
      const start = () => {
        const attempt = new AbortController();
        tries.push(attempt);
        open(cls, attempt.signal).then(
          (c) => {
            if (settled) {
              closeConn(c, 'closed');
              return;
            }
            settle(() => {
              for (const t of tries) if (t !== attempt) t.abort();
              resolve(c);
            });
          },
          (error: unknown) => {
            if (settled) return;
            failed += 1;
            if (!lastError || !(error instanceof ConnectError && error.reason === 'closed'))
              lastError = error;
            const terminal = error instanceof ConnectError && TERMINAL_REASONS.has(error.reason);
            if (terminal || failed === tries.length)
              settle(() => {
                for (const t of tries) t.abort();
                reject(lastError);
              });
          },
        );
      };
      const timer = setTimeout(() => {
        if (!settled && tries.length === 1) start();
      }, raceAfterMs);
      signal.addEventListener('abort', onAbort, { once: true });
      start();
    });
  }

  /** Whether `c` waits for an answer: a request sent on it, or a download or upload under way (AP-4401). */
  function awaiting(c: Conn): boolean {
    if (c.liveUntil > now()) return true;
    for (const s of c.streams.values()) if (!s.collab && !s.quiet) return true;
    for (const p of pending.values())
      if (p.sentOn === c.gen && (p.phase === 'sent' || p.phase === 'checking')) return true;
    return false;
  }

  /**
   * The stall check's wait: `stallMs`, doubled for each stuck connection in a row (no more than two minutes apart), up
   * to 20 s, so a slow network isn't taken for a bad path over and over.
   */
  function stallWait(): number {
    if (!stuck || now() - lastStuckAt > STUCK_SPELL_MS) return baseStallMs;
    return Math.min(MAX_STALL_MS, baseStallMs * 2 ** stuck);
  }

  /** Arms `c`'s stall check (a no-op while it is armed, or turned off). */
  function watch(c: Conn) {
    if (!baseStallMs || c.closed || c.watch) return;
    c.watch = setTimeout(() => stallCheck(c), stallWait());
  }

  /**
   * Nothing heard for `stallMs` while something is outstanding: `ping`. No `pong` for `stallMs` after that `ping` (on the
   * bulk connection: nothing heard at all): the connection is stuck (a bad network path loses its packets for as long
   * as it lives), so it ends as `lost` and the session reconnects on a fresh one. A slow answer is fine: the `pong`
   * comes back meanwhile.
   */
  function stallCheck(c: Conn) {
    c.watch = null;
    if (c.closed) return;
    const at = now();
    const wait = stallWait();
    if (c.probeAt !== null) {
      // On the interactive connection only the pong answers the probe: an older answer trickling in after the ping (a
      // path whose newest bytes are stuck behind lost ones) doesn't (AP-4409). A download may hold the pong up behind
      // its bytes, so on the bulk connection anything arriving does.
      const answered = c.class === 'interactive' ? c.pongN >= c.probeN : c.lastInbound >= c.probeAt;
      if (answered) c.probeAt = null;
      else if (at - c.probeAt >= wait) {
        stalled(c);
        return;
      } else {
        c.watch = setTimeout(() => stallCheck(c), c.probeAt + wait - at);
        return;
      }
    }
    // Nothing outstanding: the heartbeat looks after an idle connection.
    if (!awaiting(c)) return;
    const quiet = at - c.lastInbound;
    if (quiet < wait) {
      c.watch = setTimeout(() => stallCheck(c), wait - quiet);
      return;
    }
    c.probeAt = at;
    c.probeN = ++pingN;
    send(c, { t: 'ping', n: c.probeN });
    if (!c.watch) c.watch = setTimeout(() => stallCheck(c), wait);
  }

  function stalled(c: Conn) {
    const at = now();
    stuck = stuck && at - lastStuckAt <= STUCK_SPELL_MS ? stuck + 1 : 1;
    lastStuckAt = at;
    connectionEnded(c, 'lost');
  }

  /**
   * `probe()`: one `ping`; no `pong` within the stall check's wait and the connection is lost, dialed again at once. A
   * check already out is replaced by a fresh ping: what asked again (another network) may have left the first one's
   * answer on the old path. Not a stuck spell (the stall check's wait isn't doubled after it): a socket that died while
   * the app was away says nothing about the network now.
   */
  function probe(c: Conn, onlyIfChecking: boolean) {
    if (c.closed || c.draining) return;
    if (onlyIfChecking && !c.check) return;
    if (c.check) clearTimeout(c.check);
    c.check = null;
    c.checkLate = false;
    checkPing(c);
  }

  function checkPing(c: Conn) {
    c.checkN = ++pingN;
    if (!send(c, { t: 'ping', n: c.checkN })) {
      checkFailed(c);
      return;
    }
    const wait = stallWait() || DEFAULT_CHECK_MS;
    c.checkDue = now() + wait;
    c.check = setTimeout(() => checkEnded(c, wait), wait);
  }

  function checkEnded(c: Conn, wait: number) {
    c.check = null;
    if (c.closed || conn !== c || c.pongN >= c.checkN) return;
    // Fired far later than it was set for: the app's JavaScript was frozen (in the background), and the answer may be
    // waiting behind the timer. One more short wait, on a fresh ping, before giving up on it.
    if (!c.checkLate && now() - c.checkDue > wait) {
      c.checkLate = true;
      checkPing(c);
      return;
    }
    checkFailed(c);
  }

  /** The check went unanswered, or its ping couldn't be sent: lost, and dialed again without the backoff. */
  function checkFailed(c: Conn) {
    if (conn !== c) return;
    connectionEnded(c, 'lost');
    dialNow();
  }

  /** Dial now instead of waiting out the backoff (a no-op while open or dialing). */
  function dialNow() {
    if (!wanted || conn || connecting) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    void attemptConnect();
  }

  async function attemptConnect() {
    if (!wanted || conn || connecting) return;
    const controller = new AbortController();
    connecting = controller;
    if (state.status !== 'reconnecting') setState({ status: 'connecting', attempt });
    try {
      const c = await openRaced('interactive', controller.signal);
      connecting = null;
      if (!wanted || controller.signal.aborted) {
        closeConn(c, 'closed');
        return;
      }
      if (c.closed) {
        // It ended after its welcome but before becoming current (e.g. a relay-replayed record right behind
        // the welcome): its close was ignored as not the current connection's. Never install it.
        scheduleRetry('lost');
        return;
      }
      conn = c;
      attempt = 0;
      const previous = lastInfo;
      lastInfo = c.info;
      if (
        c.info.clearCache ||
        (previous &&
          (previous.authzGeneration !== c.info.authzGeneration ||
            previous.account?.id !== c.info.account?.id))
      )
        notify({
          kind: 'authz_changed',
          authzGeneration: c.info.authzGeneration,
          clearCache: c.info.clearCache,
        });
      setState({ status: 'open', info: c.info });
      onOpen(c);
    } catch (error) {
      connecting = null;
      if (!wanted) return;
      const e = error instanceof ConnectError ? error : new ConnectError('offline', String(error));
      if (TERMINAL_REASONS.has(e.reason)) {
        terminate(e.reason, e.detail);
        return;
      }
      scheduleRetry(e.reason, e.retryAfterMs);
    }
  }

  function scheduleRetry(reason: DisconnectReason, retryAfterMs?: number) {
    if (retryTimer) clearTimeout(retryTimer);
    const delay =
      reason === 'rekey' ? 0 : Math.max(backoffDelay(attempt, options.backoff, random), retryAfterMs ?? 0);
    attempt += 1;
    setState({ status: 'reconnecting', attempt, reason, retryAt: now() + delay });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void attemptConnect();
    }, delay);
  }

  function closeConn(c: Conn, reason: DisconnectReason) {
    if (c.closed) return;
    c.closed = true;
    if (c.heartbeat) clearInterval(c.heartbeat);
    if (c.watch) clearTimeout(c.watch);
    c.watch = null;
    if (c.check) clearTimeout(c.check);
    c.check = null;
    try {
      c.wire.close(reason);
    } catch {
      // already gone
    }
    for (const s of [...c.streams.values()]) s.onLost(reason);
    c.streams.clear();
  }

  /** A connection ended (remote close, heartbeat, rekey, goaway). */
  function connectionEnded(c: Conn, reason: DisconnectReason, retryAfterMs?: number) {
    const wasClosed = c.closed;
    closeConn(c, reason);
    if (c.class === 'bulk') {
      if (bulkConn === c) {
        bulkConn = null;
        bulk = null;
      }
      return;
    }
    if (conn !== c || wasClosed) return;
    conn = null;
    for (const p of pending.values()) {
      if (p.pollTimer) clearTimeout(p.pollTimer);
      p.pollTimer = null;
    }
    for (const h of collabs) h.lost();
    if (!wanted) return;
    if (TERMINAL_REASONS.has(reason)) {
      terminate(reason);
      return;
    }
    scheduleRetry(reason, retryAfterMs);
  }

  /** Planned reconnect (`goaway`): wait (bounded) for requests in flight, then swap. */
  function drain(c: Conn, reason: DisconnectReason, retryAfterMs: number) {
    if (c.draining || c.closed) return;
    c.draining = true;
    if (c.class === 'bulk') {
      if (bulkConn === c) {
        bulkConn = null;
        bulk = null;
      }
      const done = () => {
        if (c.streams.size === 0 || c.closed) closeConn(c, reason);
        else setTimeout(done, 250);
      };
      done();
      return;
    }
    const until = now() + 10_000;
    const done = () => {
      const busy = [...pending.values()].some((p) => p.sentOn === c.gen && p.phase === 'sent');
      if (busy && now() < until && !c.closed) {
        setTimeout(done, 100);
        return;
      }
      connectionEnded(c, reason, retryAfterMs);
    };
    done();
  }

  function terminate(reason: DisconnectReason, detail?: string) {
    wanted = false;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    connecting?.abort();
    connecting = null;
    const c = conn;
    conn = null;
    if (c) closeConn(c, reason);
    bulkDial?.abort();
    bulkDial = null;
    if (bulkConn) closeConn(bulkConn, reason);
    bulkConn = null;
    bulk = null;
    for (const p of [...pending.values()])
      finish(p, () => p.reject(givenUp(p, new SessionClosedError(reason))));
    // `status()` callers: no answer will come; their timers go too.
    const waiting = [...statusHooks.values()].flatMap((hooks) => [...hooks]);
    statusHooks.clear();
    for (const w of waiting) w.fail(new SessionClosedError(reason));
    for (const sub of subs.values()) {
      if (sub.retry) clearTimeout(sub.retry);
      sub.retry = null;
    }
    for (const h of [...collabs]) h.terminate(reason === 'revoked' || reason === 'not_enrolled');
    setState({ status: 'closed', reason, ...(detail ? { detail } : {}) });
  }

  /** A fresh interactive connection: flush, resume, re-attach. */
  function onOpen(c: Conn) {
    for (const p of [...pending.values()]) {
      if (p.sentOn === c.gen) continue;
      // Never sent (AP-575): send it now, ephemeral or not; its deadline still applies (`NotDeliveredError`).
      if (p.phase === 'queued') {
        sendRequest(c, p);
        continue;
      }
      if (p.ephemeral) {
        // An ephemeral session op (`enroll.claim.begin`) sent on a lost connection is never resent: its state lived
        // there, so the caller starts over.
        finish(p, () => p.reject(unknownOutcome(p)));
        continue;
      }
      // Sent on an earlier connection and no answer: reads are asked again; anything else is checked with `status`
      // first, so a stored outcome is replayed rather than the request resubmitted.
      if (p.policy.reask) sendRequest(c, p);
      else checkStatus(c, p);
    }
    for (const sub of subs.values()) sendSubscribe(c, sub);
    for (const h of collabs) h.attach(c);
  }

  /* Frames --------------------------------------------------------------------------------------------- */

  function handleFrame(c: Conn, frame: Frame) {
    if (frame.type !== 'control') {
      c.streams.get(frame.streamId)?.onFrame(frame);
      return;
    }
    const decoded = decodeControl(frame.payload);
    if (!decoded.ok) {
      // A newer minor's message: skip. A malformed one breaks the session (a known one carrying a code or member only
      // a newer runtime sends is decoded tolerantly first, `decodeControl`).
      if (decoded.kind === 'invalid') connectionEnded(c, 'lost');
      return;
    }
    const m = decoded.message;
    switch (m.t) {
      case 'accepted': {
        const p = pending.get(m.id);
        if (!p) return;
        p.phase = 'accepted';
        progressed(p, 'accepted');
        // Accepted work is durable: the delivery deadline no longer applies.
        if (p.deadlineTimer) clearTimeout(p.deadlineTimer);
        p.deadlineTimer = null;
        p.options.onProgress?.('accepted');
        return;
      }
      case 'result': {
        const p = pending.get(m.id);
        if (!p) return;
        const status = m.kind === 'approval_required' ? 202 : 200;
        finish(p, () => p.resolve({ status, body: m.output, requestId: p.id }));
        return;
      }
      case 'error': {
        if (m.stream !== undefined) {
          c.streams.get(m.stream)?.onControl(m);
          return;
        }
        if (m.id === undefined) {
          // A session-level error: the appliance closes the connection after it.
          if (m.code === 'revoked') connectionEnded(c, 'revoked');
          return;
        }
        const p = pending.get(m.id);
        if (!p) return;
        if (m.code === 'deadline_exceeded') finish(p, () => p.reject(new DeadlineExceededError(p.op, p.id)));
        // Cancelled by the appliance: a read or a request never sent just ends; anything else may have run (AP-576).
        else if (m.code === 'cancelled') finish(p, () => p.reject(givenUp(p, abortError())));
        // Asked again after a lost answer, the appliance can't say: a secret op's answer isn't kept (CT-44), or the op
        // acted outside its commit and may have happened (CT-196). Either way it has the id: never resent (AP-582).
        else if (m.code === 'unknown_outcome') {
          p.acknowledged = true;
          finish(p, () =>
            p.reject(isSecretOp(p.op) ? new OutcomeRedactedError(p.op, p.id, null) : unknownOutcome(p)),
          );
        } else finish(p, () => p.resolve(errorResponse(p.id, m)));
        return;
      }
      case 'outcome': {
        const hooks = statusHooks.get(m.id);
        if (hooks) {
          statusHooks.delete(m.id);
          for (const w of hooks) w.answer(m);
          return;
        }
        const p = pending.get(m.id);
        if (p) onOutcome(c, p, m);
        return;
      }
      case 'subscribed': {
        const sub = subs.get(m.sub);
        if (!sub) return;
        const resumed = sub.cursor !== null;
        sub.cursor = m.cursor;
        tell('subscription', sub.handlers.onReady, { resumed, denied: m.denied });
        return;
      }
      case 'event': {
        const sub = subs.get(m.sub);
        if (!sub) return;
        const at = new Date(now()).toISOString();
        if (m.ephemeral) {
          // The agent's thinking line: live only, no cursor (CT-17). While it shows, its refreshes keep coming, so a
          // connection that goes quiet meanwhile is checked within seconds, not left silent until the heartbeat.
          if (m.event.type === 'typing' && m.event.active) {
            c.liveUntil = now() + TYPING_TTL_MS;
            watch(c);
          }
          tell('event', sub.handlers.onEvent, { topic: m.topic, event: m.event, at, cursor: null });
          return;
        }
        if (sub.cursor === m.cursor) return;
        sub.cursor = m.cursor;
        tell('event', sub.handlers.onEvent, { topic: m.topic, event: m.event, at, cursor: m.cursor });
        return;
      }
      case 'snapshot_required': {
        const sub = subs.get(m.sub);
        // Closed meanwhile: the appliance dropped it as well, nothing to ask again.
        if (!sub) return;
        // From a connection that is no longer ours: the current one subscribed it again from our cursor itself.
        if (c !== conn) return;
        // The appliance dropped the subscription (nothing is subscribed meanwhile, `SnapshotRequired`): refetch what
        // these topics feed, then subscribe again after its cursor, so live events resume (AP-1097).
        sub.cursor = m.cursor;
        const at = now();
        sub.repeats =
          sub.resubscribedAt !== null && at - sub.resubscribedAt < SNAPSHOT_REPEAT_MS ? sub.repeats + 1 : 0;
        const sent = sub.sent;
        tell('subscription', sub.handlers.onSnapshotRequired, { topics: [...sub.topics], reason: m.reason });
        // The handler closed it, or subscribed it again itself (its topics changed).
        if (subs.get(sub.id) !== sub || sub.sent !== sent) return;
        resubscribe(sub);
        return;
      }
      case 'revoked':
        notify({ kind: 'revoked', scope: m.scope });
        terminate('revoked');
        return;
      case 'authz_changed':
        if (conn) {
          conn.info = { ...conn.info, authzGeneration: m.authzGeneration, clearCache: m.clearCache };
          lastInfo = conn.info;
          setState({ status: 'open', info: conn.info });
        }
        notify({ kind: 'authz_changed', authzGeneration: m.authzGeneration, clearCache: m.clearCache });
        return;
      case 'goaway':
        if (m.reason === 'update' || m.reason === 'shutdown')
          notify({ kind: 'maintenance', retryAfterMs: m.retryAfterMs });
        drain(c, m.reason === 'rekey' ? 'rekey' : 'busy', m.retryAfterMs);
        return;
      case 'opened':
      case 'chunk_ack':
      case 'stream_done':
        c.streams.get(m.stream)?.onControl(m);
        return;
      case 'ping':
        send(c, { t: 'pong', n: m.n });
        return;
      case 'pong':
        c.pongN = Math.max(c.pongN, m.n);
        // The check's own answer ends it: the next network change gets a check of its own.
        if (c.check && c.pongN >= c.checkN) {
          clearTimeout(c.check);
          c.check = null;
        }
        return;
      case 'welcome':
        return;
    }
  }

  /* Requests ------------------------------------------------------------------------------------------- */

  /**
   * Why a request ends without an answer (the session closed, the caller aborted, the appliance cancelled it), as the
   * caller should see it (AP-571, AP-576): a read or a request never sent just ends with `reason`; anything else that
   * was sent may have been applied, so it is `OutcomeUnknownError` with `reason` as its cause.
   */
  function givenUp(p: Pending, reason: Error): Error {
    return p.phase === 'queued' || p.policy.reask ? reason : unknownOutcome(p, reason);
  }

  /** `OutcomeUnknownError` for `p`, saying whether the appliance had acknowledged it (AP-574). */
  function unknownOutcome(p: Pending, cause?: Error): OutcomeUnknownError {
    return new OutcomeUnknownError(p.op, p.id, { ...(cause && { cause }), acknowledged: p.acknowledged });
  }

  /** The appliance acknowledged `p` in `state`: a new state is progress, and the status interval starts over. */
  function progressed(p: Pending, state: 'accepted' | 'executing'): boolean {
    p.acknowledged = true;
    if (p.seen === state) return false;
    p.seen = state;
    p.progressAt = now();
    p.pollDelay = statusPollMs;
    return true;
  }

  function finish(p: Pending, settle: () => void) {
    if (!pending.has(p.id)) return;
    pending.delete(p.id);
    if (p.deadlineTimer) clearTimeout(p.deadlineTimer);
    if (p.pollTimer) clearTimeout(p.pollTimer);
    p.cleanup();
    settle();
  }

  /** Whether `p` belongs to an exchange that runs on another connection than `c` (`CallOptions.tie`). */
  function tiedElsewhere(p: Pending, c: Conn): boolean {
    const tied = p.options.tie?.connection;
    return tied !== undefined && tied !== c.gen;
  }

  function sendRequest(c: Conn, p: Pending) {
    // A tied call is never sent on another connection than its exchange's: not when it waited for one, and not again
    // after `status` found no receipt (asking `status` itself sends nothing of the call).
    if (tiedElsewhere(p, c)) {
      finish(p, () =>
        p.reject(p.phase === 'queued' ? new ConnectionLostError(p.op, p.id) : unknownOutcome(p)),
      );
      return;
    }
    const remaining = Math.min(
      SESSION_MAX_DEADLINE_MS,
      Math.max(SESSION_MIN_DEADLINE_MS, p.deadlineAt - now()),
    );
    try {
      if (send(c, { t: 'request', id: p.id, op: p.op, input: p.input as never, deadlineMs: remaining })) {
        p.phase = 'sent';
        p.sentOn = c.gen;
        // The first call of a tied exchange names its connection.
        if (p.options.tie && p.options.tie.connection === undefined) p.options.tie.connection = c.gen;
      }
    } catch (error) {
      // Not a valid request (id, op or input outside the protocol's bounds): nothing was sent.
      finish(p, () => p.reject(error));
    }
  }

  function checkStatus(c: Conn, p: Pending) {
    p.phase = p.phase === 'accepted' || p.phase === 'executing' ? p.phase : 'checking';
    p.sentOn = c.gen;
    send(c, { t: 'status', id: p.id });
  }

  function onOutcome(c: Conn, p: Pending, m: Outcome) {
    switch (m.state) {
      case 'completed':
      case 'rejected': {
        if (m.redacted && m.state === 'completed') {
          finish(p, () => p.reject(new OutcomeRedactedError(p.op, p.id, 'completed')));
          return;
        }
        // Not a refusal: it acted outside its commit and may have happened (CT-196). Known to the appliance, so
        // acknowledged — never resent (AP-582).
        if (mayHaveHappened(m)) {
          p.acknowledged = true;
          finish(p, () => p.reject(unknownOutcome(p)));
          return;
        }
        const response = outcomeResponse(p.id, m);
        finish(p, () => p.resolve(response));
        return;
      }
      case 'accepted':
      case 'executing': {
        p.phase = m.state;
        // A runtime's `executing` may still precede its commit (A4); counting it is the safe side (AP-574).
        const changed = progressed(p, m.state);
        if (p.deadlineTimer) clearTimeout(p.deadlineTimer);
        p.deadlineTimer = null;
        if (changed) p.options.onProgress?.(m.state);
        // Nothing has changed for too long: an orphaned receipt (a runtime before 0.29.1 answers `accepted` for ever)
        // or stuck work. Stop asking; a person checks again (AP-578).
        if (now() - p.progressAt >= acceptedWaitMs) {
          finish(p, () => p.reject(unknownOutcome(p)));
          return;
        }
        const wait = p.pollDelay;
        p.pollDelay = Math.min(statusPollMaxMs, p.pollDelay * 2);
        p.pollTimer = setTimeout(() => {
          p.pollTimer = null;
          if (conn === c && pending.has(p.id)) checkStatus(c, p);
        }, wait);
        return;
      }
      case 'not_found':
        // No receipt. For a `receipt` op never acknowledged, within the receipt retention, that means it never committed:
        // resend the same request (id and input), which the appliance runs at most once. Once acknowledged, the receipt
        // expired (AP-574). Destructive ops (MA-09), secret ones (CT-44), ops with effects outside the receipt's
        // transaction and ops this build doesn't know wait for a person (CT-194).
        if (p.policy.resend && !p.acknowledged) sendRequest(c, p);
        else finish(p, () => p.reject(unknownOutcome(p)));
        return;
    }
  }

  function onDeadline(p: Pending) {
    p.deadlineTimer = null;
    if (!pending.has(p.id)) return;
    if (p.phase === 'accepted' || p.phase === 'executing') return;
    if (p.phase === 'queued') {
      finish(p, () => p.reject(new NotDeliveredError(p.op, p.id)));
      return;
    }
    if (conn) send(conn, { t: 'cancel', id: p.id });
    // Reads can simply be asked again; anything else that was sent may have been applied.
    finish(p, () => p.reject(p.policy.reask ? new DeadlineExceededError(p.op, p.id) : unknownOutcome(p)));
  }

  function start(
    op: string,
    input: unknown,
    method: string,
    callOptions: CallOptions,
    ephemeral = false,
  ): Promise<OperationResponse> {
    if (state.status === 'closed') return Promise.reject(new SessionClosedError(state.reason));
    const signal = callOptions.signal;
    if (signal?.aborted) return Promise.reject(abortError());
    const id = callOptions.requestId ?? newRequestId();
    if (pending.has(id)) return Promise.reject(new Error(`request ${id} is already in flight`));
    // A later call of a tied exchange goes on its connection or not at all: it is never kept for the next one.
    const tied = callOptions.tie?.connection;
    if (tied !== undefined && (!conn || conn.gen !== tied || conn.draining))
      return Promise.reject(new ConnectionLostError(op, id));
    return new Promise<OperationResponse>((resolve, reject) => {
      const onAbort = () => {
        const p = pending.get(id);
        if (!p) return;
        // `cancel` stops it only before it is accepted, and only if it arrives in time (AP-576).
        if (p.phase !== 'queued' && conn) send(conn, { t: 'cancel', id });
        finish(p, () => p.reject(givenUp(p, abortError())));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const p: Pending = {
        id,
        op,
        input,
        ephemeral,
        policy: retryPolicy(op, method, options.isDestructive),
        phase: 'queued',
        acknowledged: false,
        seen: null,
        progressAt: now(),
        pollDelay: statusPollMs,
        sentOn: 0,
        deadlineAt: now() + (callOptions.deadlineMs ?? deadlineMs),
        deadlineTimer: null,
        pollTimer: null,
        options: callOptions,
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      };
      p.deadlineTimer = setTimeout(() => onDeadline(p), p.deadlineAt - now());
      pending.set(id, p);
      if (conn && !conn.draining) sendRequest(conn, p);
      else if (!wanted) connectNow();
    });
  }

  /**
   * An API call. A file output (`transfer: 'export'`, e.g. the audit CSV) and an export op (`exportOp`, answered as an
   * `ExportFile`, AP-45) are only ever read through an export stream; so are the reads whose answer can outgrow one
   * message (`EXPORT_READ_OPS`: Settings → Skills' library, a skill, a file, a hub search and preview; contracts 2.0
   * CT-1418, app AP-5521), from the start, a refusal answered as the op's own error. Any other exportable answer too
   * large for one message (`too_large`, `details.code: use_export_stream`) is read again through one, transparently
   * (parity G-03).
   */
  async function call(
    ep: AnyEndpoint,
    input: OperationInput,
    callOptions: CallOptions = {},
  ): Promise<OperationResponse> {
    const op = apiOpName(ep);
    // Not over a session (`SESSION_EXCLUDED_API_OPS`, CT-1263): the box's own Web Push keys; managed push goes through
    // control, content-free. Answered here, never sent.
    if (SESSION_EXCLUDED_API_OPS.includes(op))
      return {
        status: 404,
        body: { error: { code: 'not_available', message: 'This isn’t available through this connection.' } },
        requestId: callOptions.requestId ?? newRequestId(),
      };
    const spec = API_OPERATIONS.get(op);
    const body = input.body === undefined ? {} : { body: toJson(input.body) };
    const wire = { params: toJson(input.params), query: toJson(input.query), ...body };
    if (spec?.transfer === 'export' || spec?.exportOp) return exportCall(op, wire, callOptions);
    if (spec?.exportable && EXPORT_READ_OPS.includes(op)) return exportRead(op, wire, callOptions);
    // A read that was too large for one message last time goes straight to the stream: asking it as a request first
    // makes the box build the whole answer just to refuse it.
    const tooLargeKey = spec?.exportable ? `${op}\n${JSON.stringify(wire)}` : null;
    if (tooLargeKey !== null && tooLarge.has(tooLargeKey)) {
      tooLarge.delete(tooLargeKey);
      tooLarge.add(tooLargeKey);
      return readTooLarge(op, wire, callOptions);
    }
    const res = await start(op, wire, ep.method, callOptions);
    const code = (res.body as { error?: { code?: string } } | undefined)?.error?.code;
    if (tooLargeKey !== null && res.status === 413 && code === 'use_export_stream') {
      tooLarge.add(tooLargeKey);
      if (tooLarge.size > TOO_LARGE_REMEMBERED) tooLarge.delete(tooLarge.values().next().value as string);
      return readTooLarge(op, wire, callOptions);
    }
    return res;
  }

  /**
   * A read whose answer outgrew one message, through an export stream, within a deadline like the request's (at least
   * `TOO_LARGE_READ_MS`): a stream that never ends (a bulk slot that never frees, an answer that stops coming) would
   * leave the read waiting for ever, and the screen showing what it had before.
   */
  async function readTooLarge(
    op: string,
    input: unknown,
    callOptions: CallOptions,
  ): Promise<OperationResponse> {
    const outer = callOptions.signal;
    const controller = new AbortController();
    const stop = () => controller.abort();
    if (outer?.aborted) stop();
    else outer?.addEventListener('abort', stop, { once: true });
    let late = false;
    const timer = setTimeout(
      () => {
        late = true;
        stop();
      },
      Math.max(callOptions.deadlineMs ?? deadlineMs, TOO_LARGE_READ_MS),
    );
    try {
      return await exportCall(op, input, { ...callOptions, signal: controller.signal });
    } catch (error) {
      if (late) throw new DeadlineExceededError(op, callOptions.requestId ?? newRequestId());
      throw error;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', stop);
    }
  }

  /**
   * An operation's output read through an export stream, answered like a request: JSON parsed, text as text. A file
   * (an export op such as `packs.export`, or any stream that is neither JSON nor text) is answered as an `ExportFile`
   * — its raw bytes checked against `stream_done.sha256` — never decoded as text or rebuilt into a JSON body (AP-45).
   */
  async function exportCall(
    op: string,
    input: unknown,
    callOptions: CallOptions,
  ): Promise<OperationResponse> {
    const stream = await openResource(
      { kind: 'export', op, input },
      callOptions.signal ? { signal: callOptions.signal } : {},
    );
    const type = stream.meta.contentType.toLowerCase();
    const json = /[/+]json\b/.test(type);
    const text = !json && type.startsWith('text/') && !API_OPERATIONS.get(op)?.exportOp;
    const file = await readExportFile(stream, EXPORT_CALL_MAX_BYTES);
    if (!json && !text) return { status: 200, body: file, requestId: newRequestId() };
    const decoded = new TextDecoder().decode(file.bytes);
    return {
      status: 200,
      body: json ? (decoded ? JSON.parse(decoded) : undefined) : decoded,
      requestId: newRequestId(),
    };
  }

  /**
   * A read through an export stream from the start (`EXPORT_READ_OPS`, AP-5521). The runtime refuses it as it would
   * have answered the request (CT-21): `stream_refused` with the op's words and its reason's code in `details.code`
   * (the application's, such as `skill_hub_unavailable`, else the error's own). That refusal is answered as the op's
   * error, so a caller reads `not_found` or `skill_hub_unavailable` as it would from the request; a stream that broke
   * (lost, damaged, too large, cancelled) throws as it did.
   */
  async function exportRead(
    op: string,
    input: unknown,
    callOptions: CallOptions,
  ): Promise<OperationResponse> {
    try {
      return await exportCall(op, input, callOptions);
    } catch (error) {
      const details = (error instanceof StreamError ? error.details : undefined) as
        | Record<string, unknown>
        | undefined;
      const reason = typeof details?.code === 'string' ? details.code : details?.reason;
      if (!(error instanceof StreamError) || typeof reason !== 'string') throw error;
      const requestId = callOptions.requestId ?? newRequestId();
      const known = Object.hasOwn(STATUS_OF, reason);
      const code = known ? reason : (REFUSAL_CODE_OF[reason] ?? 'conflict');
      return errorResponse(requestId, {
        code,
        message: error.message,
        details: { ...details, code: reason },
      });
    }
  }

  function invoke(
    op: string,
    input: unknown,
    callOptions: CallOptions & { mutating?: boolean } = {},
  ): Promise<OperationResponse> {
    // Ephemeral session ops (`enroll.claim.begin`, CT-61): no receipt, never resent.
    const ephemeral = SESSION_OPERATIONS.get(op)?.ephemeral === true;
    return start(op, input, callOptions.mutating === false ? 'GET' : 'POST', callOptions, ephemeral);
  }

  async function status(requestId: string, ep: AnyEndpoint): Promise<CommandStatus> {
    const c = conn;
    if (!c) throw new NotDeliveredError(ep.id, requestId);
    if (pending.has(requestId)) throw new Error(`request ${requestId} is still in flight`);
    return new Promise<CommandStatus>((resolve, reject) => {
      const hooks = statusHooks.get(requestId) ?? new Set<StatusWaiter>();
      statusHooks.set(requestId, hooks);
      const answer = (m: Outcome) => {
        clearTimeout(timer);
        if (mayHaveHappened(m)) resolve({ state: 'unknown', acknowledged: true });
        else if (m.state === 'completed' || m.state === 'rejected')
          resolve({
            state: m.state,
            response: outcomeResponse(requestId, m),
            ...(m.redacted && m.state === 'completed' && { redacted: true as const }),
          });
        else if (m.state === 'not_found') resolve({ state: 'unknown' });
        else resolve({ state: m.state });
      };
      const waiter: StatusWaiter = {
        answer,
        fail: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      // Only this caller's hook: an earlier one timing out never takes a later one with it.
      const timer = setTimeout(() => {
        hooks.delete(waiter);
        if (hooks.size === 0 && statusHooks.get(requestId) === hooks) statusHooks.delete(requestId);
        reject(new DeadlineExceededError(ep.id, requestId));
      }, deadlineMs);
      hooks.add(waiter);
      send(c, { t: 'status', id: requestId });
    });
  }

  /* Subscriptions -------------------------------------------------------------------------------------- */

  /** `subscribe` with its current topics, resuming after its cursor when it has one; replaces a later retry. */
  function sendSubscribe(c: Conn, sub: Sub) {
    if (sub.retry) clearTimeout(sub.retry);
    sub.retry = null;
    sub.sent += 1;
    send(c, {
      t: 'subscribe',
      sub: sub.id,
      topics: [...sub.topics],
      ...(sub.cursor !== null && { after: sub.cursor }),
    });
  }

  /**
   * Subscribes again after a `snapshot_required`: at once the first time, after a growing wait when the appliance
   * answered the last one with `snapshot_required` again (AP-1097). Without a usable connection the next one's
   * `onOpen` subscribes it from the cursor anyway.
   */
  function resubscribe(sub: Sub) {
    const go = () => {
      sub.retry = null;
      if (subs.get(sub.id) !== sub || !conn || conn.draining) return;
      sub.resubscribedAt = now();
      sendSubscribe(conn, sub);
    };
    if (sub.retry) clearTimeout(sub.retry);
    sub.retry = null;
    if (sub.repeats === 0) go();
    else sub.retry = setTimeout(go, backoffDelay(sub.repeats - 1, snapshotBackoff, random));
  }

  function subscribe(topics: readonly string[], handlers: SubscriptionHandlers): SessionSubscription {
    const sub: Sub = {
      id: `s${nextSub++}`,
      topics: [...new Set(topics)],
      cursor: null,
      handlers,
      sent: 0,
      resubscribedAt: null,
      repeats: 0,
      retry: null,
    };
    subs.set(sub.id, sub);
    if (conn) sendSubscribe(conn, sub);
    return {
      setTopics(next) {
        if (subs.get(sub.id) !== sub) return;
        const list = [...new Set(next)];
        if (list.length === sub.topics.length && list.every((t) => sub.topics.includes(t))) return;
        sub.topics = list;
        // Also ends a wait to subscribe again after `snapshot_required`: the newest topics go now, from its cursor.
        if (conn) sendSubscribe(conn, sub);
      },
      close() {
        if (subs.get(sub.id) !== sub) return;
        subs.delete(sub.id);
        if (sub.retry) clearTimeout(sub.retry);
        sub.retry = null;
        if (conn) send(conn, { t: 'unsubscribe', sub: sub.id });
      },
    };
  }

  /* Streams -------------------------------------------------------------------------------------------- */

  function bulkConnection(signal?: AbortSignal): Promise<Conn> {
    if (signal?.aborted) return Promise.reject(abortError());
    // A warm dial that fails doesn't fail the download: it waits for the interactive connection, as without one.
    const connection =
      bulkConn && !bulkConn.closed && !bulkConn.draining
        ? Promise.resolve(bulkConn)
        : bulk && bulkEarly
          ? bulk.catch((error: unknown) => (wanted ? bulkConnection() : Promise.reject(error)))
          : (bulk ?? dialBulk(false));
    if (!signal) return connection;
    // A caller may stop waiting without cancelling the session's dial for everyone else.
    return new Promise<Conn>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      connection.then(
        (c) => {
          signal.removeEventListener('abort', onAbort);
          resolve(c);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  function dialBulk(early: boolean): Promise<Conn> {
    const controller = new AbortController();
    const dialing = (async () => {
      // Bulk follows the interactive connection: no point dialing while the appliance is unreachable. The warm dial
      // goes beside it instead (`warmBulk`).
      if (!early) await waitOpen(controller.signal);
      // A bulk connection that already ended after its welcome is never installed; dial once more.
      for (let tries = 0; ; tries++) {
        const c = await openRaced('bulk', controller.signal);
        if (!c.closed) {
          bulkConn = c;
          return c;
        }
        if (tries >= 1) throw new ConnectError('lost', 'The bulk connection ended right after it opened.');
      }
    })();
    bulk = dialing;
    bulkEarly = early;
    bulkDial = controller;
    const settled = () => {
      if (bulkDial === controller) bulkDial = null;
    };
    dialing.then(settled, () => {
      settled();
      if (bulk === dialing) bulk = null;
    });
    return dialing;
  }

  function waitOpen(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (conn) return Promise.resolve();
    if (!wanted) connectNow();
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        off();
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(abortError());
      };
      const off = onStateChange((s) => {
        if (s.status === 'open') {
          cleanup();
          resolve();
        } else if (s.status === 'closed') {
          cleanup();
          reject(new SessionClosedError(s.reason));
        }
      });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function onStateChange(listener: (s: ConnectionState) => void) {
    stateListeners.add(listener);
    return () => stateListeners.delete(listener);
  }

  /** `error{stream}` → a stream error (`stream_refused` carries the reason in `details`). */
  function refused(m: ApplianceMessage): StreamError | null {
    if (m.t !== 'error') return null;
    const reason = (m.details as { reason?: string } | undefined)?.reason;
    return new StreamError(
      m.code === 'stream_refused' ? (reason ?? 'refused') : m.code,
      m.message,
      m.details,
    );
  }

  async function openResource(
    ref: ResourceRef,
    openOptions: { range?: { start: number; end?: number }; signal?: AbortSignal } = {},
  ): Promise<ResourceStream> {
    const release = await bulkSlot(openOptions.signal);
    let c: Conn;
    try {
      c = await bulkConnection(openOptions.signal);
      if (openOptions.signal?.aborted) throw abortError();
    } catch (error) {
      release();
      throw error;
    }
    const stream = c.nextStream;
    c.nextStream += 2;
    const queue: Uint8Array[] = [];
    const hasher = newHash();
    let received = 0;
    let summary: { size: number; sha256: string } | null = null;
    let ended = false;
    let failure: Error | null = null;
    let wake: (() => void) | null = null;
    let opened: ((meta: ResourceMeta) => void) | null = null;
    let openFailed: ((e: Error) => void) | null = null;
    const signalWake = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const cleanup = () => {
      c.streams.delete(stream);
      release();
      openOptions.signal?.removeEventListener('abort', cancel);
    };
    const fail = (e: Error) => {
      failure = e;
      cleanup();
      openFailed?.(e);
      signalWake();
    };
    c.streams.set(stream, {
      onControl(m) {
        const r = refused(m);
        if (r) {
          fail(r);
          return;
        }
        if (m.t === 'opened' && m.meta.kind === 'download')
          opened?.({
            contentType: m.meta.contentType,
            size: m.meta.range.end - m.meta.range.start,
            name: m.meta.name ?? null,
            sha256: m.meta.sha256 ?? null,
          });
        else if (m.t === 'opened' && m.meta.kind === 'export')
          opened?.({
            contentType: m.meta.contentType,
            size: m.meta.size ?? null,
            name: m.meta.name ?? null,
            sha256: null,
          });
        else if (m.t === 'stream_done') summary = { size: m.size, sha256: m.sha256 };
      },
      onFrame(frame) {
        if (frame.type === 'data') {
          queue.push(frame.payload);
          received += frame.payload.byteLength;
          hasher.update(frame.payload);
        } else if (frame.type === 'end') {
          ended = true;
          // END closes one direction; finish ours too so the appliance can release this stream.
          sendFrame(c, { type: 'end', streamId: stream });
          cleanup();
          const s = summary as { size: number; sha256: string } | null;
          if (s && (s.size !== received || s.sha256 !== bytesToHex(hasher.digest())))
            failure = new StreamError('integrity', 'The download was damaged in transit.');
        } else if (frame.type === 'reset') {
          const name = resetName(frame.code);
          fail(new StreamError(name === 'notFound' ? 'not_found' : name, `Download failed (${name}).`));
        }
        signalWake();
      },
      onLost(reason) {
        fail(new StreamError('lost', `The connection dropped (${reason}).`));
      },
    });
    const cancel = () => {
      if (!c.streams.has(stream)) return;
      fail(abortError());
      sendFrame(c, { type: 'reset', streamId: stream, code: STREAM_RESET.cancelled });
    };
    const range = openOptions.range && { range: openOptions.range };
    const spec =
      ref.kind === 'attachment'
        ? {
            kind: 'download' as const,
            resource: {
              type: 'attachment' as const,
              burrow: ref.burrow,
              attachmentId: ref.attachmentId,
              variant: ref.variant ?? ('original' as const),
            },
            ...range,
          }
        : ref.kind === 'backup-file'
          ? {
              kind: 'download' as const,
              resource: { type: 'backup-file' as const, burrow: ref.burrow, backupFileId: ref.backupFileId },
              ...range,
            }
          : ref.kind === 'thing-image'
            ? {
                kind: 'download' as const,
                // A picture on a thing's page (contracts 0.121, CT-1000; app service-dashboards.md AP-4537).
                resource: {
                  type: 'thing-image' as const,
                  burrow: ref.burrow,
                  thing: ref.thing,
                  ref: ref.ref,
                },
              }
            : { kind: 'export' as const, op: ref.op, input: ref.input as never };
    let meta: ResourceMeta;
    try {
      meta = await new Promise<ResourceMeta>((resolve, reject) => {
        opened = resolve;
        openFailed = reject;
        openOptions.signal?.addEventListener('abort', cancel, { once: true });
        if (openOptions.signal?.aborted) cancel();
        else if (!send(c, { t: 'open', stream, spec }))
          fail(new StreamError('lost', 'The connection dropped.'));
      });
    } catch (error) {
      cleanup();
      throw error;
    } finally {
      opened = null;
      openFailed = null;
    }
    async function* chunks(): AsyncIterable<Uint8Array> {
      try {
        for (;;) {
          const next = queue.shift();
          if (next) {
            // Grant what was consumed: at most the initial window is ever buffered here.
            if (c.streams.has(stream))
              sendFrame(c, { type: 'credit', streamId: stream, credit: next.byteLength });
            yield next;
            continue;
          }
          if (failure) throw failure;
          if (ended) return;
          await new Promise<void>((r) => {
            wake = r;
          });
        }
      } finally {
        // A failed file sink or a consumer that stops early must release the peer and the bulk slot.
        cancel();
      }
    }
    return {
      meta,
      chunks: chunks(),
      cancel,
      summary: () => (ended && !failure ? (summary as { size: number; sha256: string } | null) : null),
    };
  }

  async function upload(
    target: UploadTarget,
    source: ChunkSource,
    up: UploadStreamOptions = {},
  ): Promise<unknown> {
    const { signal } = up;
    const attempts = options.uploadAttempts ?? 6;
    const chunkSize = options.uploadChunkBytes ?? 256 * 1024;
    // A box at minor 7 or later takes a backup file without its whole sha256 (CT-1695): each chunk is checked as it
    // arrives and the box hashes the file once it is all there, so the file isn't read twice here.
    // Every box of session major 5 takes a backup file without its sha256 up front (it was minor 7 of major 4).
    const unhashed = target.type === 'backup-file';
    let whole: string | null = null;
    if (!unhashed) {
      // Pass 1: the whole-file hash, one chunk in memory at a time.
      const hasher = newHash();
      for (let offset = 0; offset < source.size; offset += chunkSize) {
        if (signal?.aborted) throw abortError();
        hasher.update(await source.read(offset, Math.min(chunkSize, source.size - offset)));
      }
      whole = bytesToHex(hasher.digest());
    }
    let lastError: unknown = null;
    for (let i = 0; i < attempts; i++) {
      if (signal?.aborted) throw abortError();
      const release = await bulkSlot(signal);
      try {
        return await uploadOnce(target, source, whole, chunkSize, up);
      } catch (error) {
        release();
        if (!(error instanceof StreamError) || error.code !== 'lost') throw error;
        lastError = error;
        // Resume on the next bulk connection from what the appliance reports it holds.
        await waitOpen(signal);
      } finally {
        release();
      }
    }
    throw lastError;
  }

  async function uploadOnce(
    target: UploadTarget,
    source: ChunkSource,
    whole: string | null,
    chunkSize: number,
    up: UploadStreamOptions,
  ): Promise<unknown> {
    const c = await bulkConnection(up.signal);
    if (up.signal?.aborted) throw abortError();
    const stream = c.nextStream;
    c.nextStream += 2;
    let credit = c.initialCredit;
    let meta: { received: number; chunkSize: number } | null = null;
    let output: { value: unknown } | null = null;
    let failure: Error | null = null;
    let wake: (() => void) | null = null;
    const signalWake = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const wait = () =>
      new Promise<void>((r) => {
        wake = r;
      });
    c.streams.set(stream, {
      onControl(m) {
        const r = refused(m);
        if (r) failure = r;
        else if (m.t === 'opened' && m.meta.kind === 'upload')
          meta = { received: m.meta.received, chunkSize: m.meta.chunkSize };
        // Progress counts what the appliance durably stored.
        else if (m.t === 'chunk_ack') up.onProgress?.({ sent: m.received, total: source.size });
        else if (m.t === 'stream_done') output = { value: m.output };
        signalWake();
      },
      onFrame(frame) {
        if (frame.type === 'credit') credit += frame.credit;
        else if (frame.type === 'reset') {
          const name = resetName(frame.code);
          failure = new StreamError(
            name,
            name === 'integrity' ? 'The upload was corrupted in transit.' : `Upload failed (${name}).`,
          );
          c.streams.delete(stream);
        }
        signalWake();
      },
      onLost(reason) {
        failure = new StreamError('lost', `The connection dropped (${reason}).`);
        signalWake();
      },
    });
    const onAbort = () => {
      if (c.streams.delete(stream))
        sendFrame(c, { type: 'reset', streamId: stream, code: STREAM_RESET.cancelled });
      failure = abortError();
      signalWake();
    };
    up.signal?.addEventListener('abort', onAbort, { once: true });
    const lost = () => failure ?? new StreamError('lost', 'The connection dropped.');
    try {
      send(c, {
        t: 'open',
        stream,
        spec: {
          kind: 'upload',
          target:
            target.type === 'backup-file'
              ? { type: 'backup-file', burrow: target.burrow, stagedBackupId: target.stagedBackupId }
              : target.type === 'dictation'
                ? { type: 'dictation', burrow: target.burrow }
                : { type: 'attachment', burrow: target.burrow, attachmentId: target.attachmentId },
          size: source.size,
          ...(whole ? { sha256: whole } : {}),
          chunkSize,
        },
      });
      while (!meta && !failure) await wait();
      if (failure) throw failure;
      const agreed = (meta as unknown as { chunkSize: number }).chunkSize || chunkSize;
      let offset = (meta as unknown as { received: number }).received;
      up.onProgress?.({ sent: offset, total: source.size });
      let index = Math.floor(offset / agreed);
      while (offset < source.size) {
        if (failure) throw failure;
        const size = Math.min(agreed, source.size - offset);
        const bytes = await source.read(offset, size);
        if (failure) throw failure;
        if (bytes.byteLength !== size)
          throw new StreamError('integrity', 'The file changed while uploading.');
        if (!send(c, { t: 'chunk', stream, index, offset, size, sha256: sha256Hex(bytes) })) throw lost();
        for (let at = 0; at < size; ) {
          while (credit <= 0 && !failure) await wait();
          if (failure) throw failure;
          const part = bytes.subarray(at, at + Math.min(c.maxDataBytes, size - at, credit));
          if (!sendFrame(c, { type: 'data', streamId: stream, payload: part })) throw lost();
          credit -= part.byteLength;
          at += part.byteLength;
          if (c.wire.congested()) await c.wire.drained();
        }
        offset += size;
        index += 1;
      }
      if (failure) throw failure;
      if (!sendFrame(c, { type: 'end', streamId: stream })) throw lost();
      while (!output && !failure) await wait();
      if (failure) throw failure;
      return (output as unknown as { value: unknown }).value;
    } finally {
      up.signal?.removeEventListener('abort', onAbort);
      // A local read or callback can fail without the peer knowing the upload has stopped.
      if (c.streams.delete(stream) && !output)
        sendFrame(c, { type: 'reset', streamId: stream, code: STREAM_RESET.cancelled });
    }
  }

  /* Collaboration -------------------------------------------------------------------------------------- */

  interface CollabHandle {
    attach(c: Conn): void;
    lost(): void;
    terminate(denied: boolean): void;
  }

  function openCollab(document: { burrow: string; canvasId: string }): CollabChannel | null {
    const messageListeners = new Set<(m: Uint8Array) => void>();
    const statusListeners = new Set<(s: 'open' | 'closed' | 'denied') => void>();
    let current: {
      c: Conn;
      stream: number;
      credit: number;
      outbox: Uint8Array[];
      decoder: CollabMessageDecoder;
    } | null = null;
    let closed = false;
    let readOnly = false;
    const emitStatus = (s: 'open' | 'closed' | 'denied') => {
      for (const l of [...statusListeners]) tell('collab', l, s);
    };
    const flush = () => {
      const t = current;
      if (!t) return;
      while (t.outbox.length && (t.outbox[0]?.byteLength ?? 0) <= t.credit) {
        const m = t.outbox.shift() as Uint8Array;
        if (!sendFrame(t.c, { type: 'data', streamId: t.stream, payload: m })) return;
        t.credit -= m.byteLength;
      }
    };
    const handle: CollabHandle = {
      attach(c) {
        if (closed) return;
        const stream = c.nextStream;
        c.nextStream += 2;
        const target = {
          c,
          stream,
          credit: c.initialCredit,
          outbox: [] as Uint8Array[],
          decoder: new CollabMessageDecoder(),
        };
        current = target;
        c.streams.set(stream, {
          collab: true,
          onControl(m) {
            if (m.t === 'opened' && m.meta.kind === 'collab') {
              readOnly = m.meta.readOnly;
              emitStatus('open');
              return;
            }
            if (refused(m)) {
              c.streams.delete(stream);
              current = null;
              handle.terminate(true);
            }
          },
          onFrame(frame) {
            if (frame.type === 'data') {
              sendFrame(c, { type: 'credit', streamId: stream, credit: frame.payload.byteLength });
              let messages: Uint8Array[];
              try {
                messages = target.decoder.push(frame.payload);
              } catch {
                // A message above the bound: the stream is unusable.
                sendFrame(c, { type: 'reset', streamId: stream, code: STREAM_RESET.tooLarge });
                c.streams.delete(stream);
                current = null;
                emitStatus('closed');
                return;
              }
              for (const m of messages) for (const l of [...messageListeners]) tell('collab', l, m);
            } else if (frame.type === 'credit') {
              target.credit += frame.credit;
              flush();
            } else if (frame.type === 'reset') {
              c.streams.delete(stream);
              current = null;
              const name = resetName(frame.code);
              if (name === 'forbidden' || name === 'notFound') handle.terminate(true);
              else emitStatus('closed');
            }
          },
          onLost() {
            handle.lost();
          },
        });
        try {
          send(c, {
            t: 'open',
            stream,
            spec: { kind: 'collab', burrow: document.burrow, canvasId: document.canvasId },
          });
        } catch {
          c.streams.delete(stream);
          current = null;
          handle.terminate(true);
        }
      },
      lost() {
        if (closed || !current) return;
        current = null;
        emitStatus('closed');
      },
      terminate(denied) {
        if (closed) return;
        closed = true;
        current = null;
        collabs.delete(handle);
        emitStatus(denied ? 'denied' : 'closed');
      },
    };
    collabs.add(handle);
    if (conn) handle.attach(conn);
    else if (!wanted) connectNow();
    return {
      send(message) {
        const t = current;
        if (!t || t.c.closed) return true;
        if (message.byteLength > COLLAB_MAX_MESSAGE_BYTES) return false;
        // `[u32 len][bytes]`, split into DATA payloads within credit (`@whombat/protocol/collab`).
        for (const part of collabDataPayloads(encodeCollabMessages([message]), t.c.maxDataBytes))
          t.outbox.push(part);
        flush();
        return true;
      },
      readOnly: () => readOnly,
      onMessage(listener) {
        messageListeners.add(listener);
        return () => messageListeners.delete(listener);
      },
      onStatus(listener) {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
      },
      close() {
        if (closed) return;
        const t = current;
        closed = true;
        current = null;
        collabs.delete(handle);
        if (t && !t.c.closed) {
          t.c.streams.delete(t.stream);
          sendFrame(t.c, { type: 'reset', streamId: t.stream, code: STREAM_RESET.cancelled });
        }
      },
    };
  }

  /* Consoles (contracts 0.80.1, CT-350) ---------------------------------------------------------------- */

  /**
   * A console stream on the interactive connection, WebSocket-shaped (`ConsoleSocket`). The token works once, so a
   * console never re-attaches after a drop: it closes (1006) and the person opens it again. Credit is the back-pressure
   * both ways: messages wait in the outbox for the appliance's credit (`bufferedAmount`), and the appliance's DATA is
   * credited back as it reaches the console, with a window of `CONSOLE_WINDOW` so a screen update comes in one go.
   */
  function openConsole(target: ConsoleTarget): ConsoleSocket | null {
    if (!capabilities().has(CAPABILITIES.console)) return null;
    const socket = new ConsoleSocket(`session:console/${target.sessionId}`);
    let current: { c: Conn; stream: number; credit: number; outbox: Uint8Array[]; queued: number } | null =
      null;
    let left = false;
    const flush = () => {
      const t = current;
      if (!t) return;
      while (t.outbox.length && (t.outbox[0]?.byteLength ?? 0) <= t.credit) {
        const part = t.outbox.shift() as Uint8Array;
        if (!sendFrame(t.c, { type: 'data', streamId: t.stream, payload: part })) return;
        t.credit -= part.byteLength;
        t.queued -= part.byteLength;
      }
    };
    socket._bind({
      send(message) {
        const t = current;
        if (!t || t.c.closed || message.byteLength === 0 || message.byteLength > CONSOLE_MAX_MESSAGE_BYTES)
          return false;
        for (const part of consoleDataPayloads(encodeConsoleMessages([message]), t.c.maxDataBytes)) {
          t.outbox.push(part);
          t.queued += part.byteLength;
        }
        flush();
        return true;
      },
      buffered: () => current?.queued ?? 0,
      close() {
        left = true;
        const t = current;
        current = null;
        if (t && !t.c.closed && t.c.streams.has(t.stream)) {
          t.c.streams.delete(t.stream);
          sendFrame(t.c, { type: 'reset', streamId: t.stream, code: STREAM_RESET.cancelled });
        }
      },
    });
    const lost = (detail: string) =>
      socket._fail(CONSOLE_CLOSE.lost, 'lost', {
        code: 'lost',
        message: `The connection dropped (${detail}).`,
      });
    const attach = (c: Conn) => {
      if (left) return;
      const stream = c.nextStream;
      c.nextStream += 2;
      const t = { c, stream, credit: c.initialCredit, outbox: [] as Uint8Array[], queued: 0 };
      current = t;
      const decoder = new ConsoleMessageDecoder();
      const ended = () => {
        c.streams.delete(stream);
        if (current === t) current = null;
      };
      c.streams.set(stream, {
        quiet: true,
        onControl(m) {
          if (m.t === 'opened' && m.meta.kind === 'console') {
            if (CONSOLE_WINDOW > c.initialCredit)
              sendFrame(c, { type: 'credit', streamId: stream, credit: CONSOLE_WINDOW - c.initialCredit });
            socket._open(m.meta.protocol);
            return;
          }
          if (m.t === 'error') {
            // Refused (the token was used or is old, not an owner, the service is down): the reason in its words.
            ended();
            const details = (m.details ?? {}) as { code?: unknown };
            const code = typeof details.code === 'string' ? details.code : m.code;
            socket._fail(consoleRefusalCodeOf(code), m.message, { code, message: m.message });
          }
        },
        onFrame(frame) {
          if (frame.type === 'data') {
            let messages: Uint8Array[];
            try {
              messages = decoder.push(frame.payload);
            } catch {
              sendFrame(c, { type: 'reset', streamId: stream, code: STREAM_RESET.tooLarge });
              ended();
              socket._fail(CONSOLE_CLOSE.tooBig, 'message too large');
              return;
            }
            sendFrame(c, { type: 'credit', streamId: stream, credit: frame.payload.byteLength });
            for (const m of messages) socket._message(m);
          } else if (frame.type === 'credit') {
            t.credit += frame.credit;
            flush();
          } else if (frame.type === 'end') {
            // The service ended the console (its reason came first in a `closed` control): our half ends too.
            sendFrame(c, { type: 'end', streamId: stream });
            ended();
            socket._end();
          } else if (frame.type === 'reset') {
            ended();
            const name = resetName(frame.code);
            socket._fail(consoleCloseCodeOf(name), name, {
              code: name,
              message: `The console stopped (${name}).`,
            });
          }
        },
        onLost(reason) {
          ended();
          lost(reason);
        },
      });
      if (!send(c, { t: 'open', stream, spec: { kind: 'console', ...target } })) {
        ended();
        lost('closed');
      }
    };
    if (conn) attach(conn);
    else
      waitOpen().then(
        () => (conn ? attach(conn) : lost('closed')),
        (err: unknown) => lost(err instanceof SessionClosedError ? err.reason : 'closed'),
      );
    return socket;
  }

  /* Lifecycle ------------------------------------------------------------------------------------------ */

  function connectNow() {
    if (state.status === 'closed' && TERMINAL_REASONS.has(state.reason) && state.reason !== 'closed') return;
    wanted = true;
    void attemptConnect();
  }

  return {
    state: () => state,
    onState: onStateChange,
    onNotice(listener) {
      noticeListeners.add(listener);
      return () => noticeListeners.delete(listener);
    },
    connect() {
      if (wanted && state.status !== 'closed') return;
      attempt = 0;
      connectNow();
    },
    reconnectNow: dialNow,
    probe(options) {
      if (conn && state.status === 'open') probe(conn, options?.onlyIfChecking === true);
    },
    close(reason = 'closed') {
      terminate(reason);
    },
    suspend() {
      if (state.status === 'closed') return false;
      if (!wanted) return true;
      // Work under way keeps the connection: answers, status questions, downloads and uploads (a slot or a stream), and
      // a connection being opened (asked again between attempts).
      const streaming = (c: Conn | null) => !!c && [...c.streams.values()].some((s) => !s.collab);
      const busy =
        connecting !== null ||
        pending.size > 0 ||
        statusHooks.size > 0 ||
        bulkOpen > 0 ||
        streaming(conn) ||
        streaming(bulkConn);
      if (busy) return false;
      wanted = false;
      attempt = 0;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      const c = conn;
      conn = null;
      if (c) closeConn(c, 'closed');
      bulkDial?.abort();
      bulkDial = null;
      if (bulkConn) closeConn(bulkConn, 'closed');
      bulkConn = null;
      bulk = null;
      // A canvas open meanwhile re-attaches on the next connection, as after a drop.
      for (const h of collabs) h.lost();
      setState({ status: 'idle' });
      return true;
    },
    warmBulk() {
      if (!wanted || bulk || (bulkConn && !bulkConn.closed)) return;
      dialBulk(true).catch(() => undefined);
    },
    sha256: newHash,
    supports: (capability) => capabilities().has(capability),
    call,
    invoke,
    status,
    subscribe,
    openResource,
    upload,
    openCollab,
    openConsole,
  };
}

/** How far the appliance may run ahead on a console stream (a VNC screen update, ≤ 1 MiB, in one go). */
export const CONSOLE_WINDOW = 1024 * 1024;

/** Largest collaboration message (`@whombat/protocol/collab`: 16 MiB). */
export const COLLAB_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** `STREAM_RESET` code → name. */
export function resetName(code: number): string {
  const entry = Object.entries(STREAM_RESET).find(([, v]) => v === code);
  return entry ? entry[0] : 'internal';
}

/**
 * `unsupported_version` details → which side must update (`whoMustUpdate`, contracts 0.4): below the appliance's
 * security floor (CT-53, `details.code`) is its own reason, since only a newer build of this app helps.
 */
export function versionVerdict(details: unknown): DisconnectReason {
  if ((details as { code?: unknown } | null | undefined)?.code === 'client_below_security_floor')
    return 'client_below_floor';
  const parsed = UnsupportedVersionDetails.safeParse(details);
  if (!parsed.success) return 'appliance_too_old';
  return whoMustUpdate(CLIENT_PROTOCOL.majors, parsed.data) === 'client'
    ? 'client_too_old'
    : 'appliance_too_old';
}

/**
 * The JSON the request carries, as HTTP would send it: `undefined` members dropped, dates as ISO strings. The
 * protocol validates inputs as JSON values, and a parsed query often holds `undefined` for absent parameters.
 */
export function toJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function abortError(): Error {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}
