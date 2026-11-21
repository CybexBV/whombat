/**
 * `ApplianceSession` — the one interface every client (web, Android, iOS) uses to talk to a Whombat
 * (docs/decisions/app-managed.md AP-10), implemented once by `createSecureSession`: a Noise session pinned to the
 * appliance identity, over a connection a `SessionConnector` gives it — through the relay (a control-issued ticket
 * admits the WebSocket) or straight to the box on its local network or Tailscale (hermes-engine-app.md AP-5302) — and
 * session protocol v1 inside, carrying typed requests, subscriptions, streams and collaboration (MA-05…MA-09).
 *
 * Everything that crosses to the appliance goes through here: API calls (`call`), realtime (`subscribe`), resources
 * (`openResource`), uploads (`upload`), collaboration (`openCollab`), consoles (`openConsole`). Nothing builds server
 * URLs.
 */
import type { AnyEndpoint } from '@whombat/core/contracts';
import type { DirectAddresses, Edition } from '@whombat/protocol/session';
import type { ConsoleSocket, ConsoleTarget } from './console';

/* Connection ----------------------------------------------------------------------------------------- */

/** Why a connection is not (or no longer) open. Distinct reasons, because the UI says different things. */
export type DisconnectReason =
  /** Network down or the relay could not be reached at all. */
  | 'offline'
  /** The relay answered but the appliance is not connected to it (MA-05 4404 / 4504). */
  | 'appliance_offline'
  /** The relay worker is draining or rate limiting us; retry after the hint. */
  | 'busy'
  /** A healthy connection ended (idle, slow consumer, transport error); plain reconnect. */
  | 'lost'
  /** Planned: fresh keys before nonce/byte/time limits (MA-07). Invisible to people. */
  | 'rekey'
  /** Control refused a ticket (signed out of the cloud account, org suspended, not a member). */
  | 'ticket_denied'
  /** The appliance's identity is not the one on the claim card / enrollment. Never retried automatically. */
  | 'identity_mismatch'
  /** The appliance speaks only protocol majors this client doesn't (this app is too old). */
  | 'client_too_old'
  /**
   * This build is below the running release's client security floor (CT-53): the app must be updated before it may
   * connect again, whatever protocol it speaks.
   */
  | 'client_below_floor'
  /** This client speaks only majors the appliance doesn't (the appliance needs an update). */
  | 'appliance_too_old'
  /** This device's key was revoked on the appliance, or never enrolled. */
  | 'revoked'
  | 'not_enrolled'
  /**
   * Control admits no connection to this Whombat and the directory lists it retired (AP-693): it can never be opened
   * again (stolen, repaired, destroyed, replaced by a new appliance).
   */
  | 'appliance_retired'
  /**
   * Control admits no connection to this Whombat and the directory doesn't list it as retired (AP-693): it isn't this
   * organization's yet (a claim the appliance hasn't reported) or any more (released, the organization deleted).
   * Retried: the network is fine, so never “offline”.
   */
  | 'appliance_unlisted'
  /** `appliance_unlisted` for longer than an unreported claim can take (AP-693): not this organization's any more. */
  | 'appliance_gone'
  /** Closed on purpose (sign-out, switching appliance). */
  | 'closed';

/** Reasons after which the session does not reconnect by itself. */
export const TERMINAL_REASONS: ReadonlySet<DisconnectReason> = new Set([
  'ticket_denied',
  'identity_mismatch',
  'client_too_old',
  'client_below_floor',
  'appliance_too_old',
  'revoked',
  'not_enrolled',
  'appliance_retired',
  'appliance_gone',
  'closed',
]);

export type ConnectionState =
  | { status: 'idle' }
  | { status: 'connecting'; attempt: number }
  | { status: 'open'; info: SessionInfo }
  | {
      status: 'reconnecting';
      attempt: number;
      reason: DisconnectReason;
      /** Epoch ms of the next attempt. */
      retryAt: number;
    }
  | { status: 'closed'; reason: DisconnectReason; detail?: string };

export type ConnectionStatus = ConnectionState['status'];

/** What the appliance said about this session in `welcome` (`@whombat/protocol` `Welcome`). */
export interface SessionInfo {
  /** Negotiated session protocol version. */
  protocol: { major: number; minor: number };
  capabilities: readonly string[];
  /** The appliance's content identity (PeerId); its display name comes from control's directory. */
  appliance: { id: string; name: string | null };
  /**
   * The local account this session acts as (caches are keyed by it). Null on the enrollment channel (an
   * unenrolled endpoint). Account-based since contracts 0.3 (CT-16).
   */
  account: {
    id: string;
    name: string;
    /** The account's principal in each burrow it belongs to. */
    principals: readonly { burrowId: string; principalId: string }[];
  } | null;
  /** This endpoint key's local id on the appliance (null when not enrolled). */
  endpointId: string | null;
  /** Bumped by the appliance on revocations and permission changes; part of every cache key. */
  authzGeneration: number;
  /** The appliance asks compliant clients to drop cached content (e.g. after a revocation). */
  clearCache: boolean;
  /** `app`: normal session; `enroll`: only claim, pairing and recovery operations are allowed. */
  channel: 'app' | 'enroll';
  /**
   * The box's direct ways in (`welcome.direct`, CT-1252; HE-50): its local-network addresses and Tailscale name, which
   * the next connection tries before the relay (`directRoutesFor`). Null on the enrollment channel.
   */
  direct: DirectAddresses | null;
  /**
   * The box's edition (`welcome.edition`, CT-1300; HE-58), `commercial` when it says none: a `community` box has no
   * relay, control, remote help, licence or phone push, so the apps leave those out (`editionHas`; AP-5400).
   */
  edition: Edition;
}

/** Capabilities of session protocol 1.0 (`@whombat/protocol` `CAPABILITIES`). */
export const CAPABILITIES = {
  events: 'events',
  download: 'stream.download',
  upload: 'stream.upload',
  export: 'stream.export',
  collab: 'stream.collab',
  /** Consoles through the session (contracts 0.80.1, CT-350). */
  console: 'stream.console',
  enroll: 'enroll',
  recovery: 'recovery',
} as const;

/* Requests ------------------------------------------------------------------------------------------- */

/** The parsed parts of an endpoint call (`params`, `query`, `body` after the contract's own parsing). */
export interface OperationInput {
  params: Record<string, unknown>;
  query: Record<string, unknown>;
  body: unknown;
}

export interface CallOptions {
  /**
   * Idempotency key (MA-09). Retries of the same logical request must reuse it; the appliance binds it to a
   * digest of `{op, input}` and refuses a reuse with different input. Generated when omitted.
   */
  requestId?: string;
  /** Give up waiting after this long (the appliance also stops work it has not accepted yet). */
  deadlineMs?: number;
  signal?: AbortSignal;
  /** Progress of a durable command (accepted → executing). */
  onProgress?: (state: 'accepted' | 'executing') => void;
  /**
   * Keeps this call on the connection its tie names: see `ConnectionTie`. The secure transport only; another one sends
   * the call as it would any.
   */
  tie?: ConnectionTie;
}

/**
 * Ties the calls of one exchange to one connection. The first call made with it is sent on the connection open then
 * (or the first to open, while none is), which the tie then names; every later call with the same tie is sent on that
 * connection only. Once it is gone, such a call is refused unsent (`ConnectionLostError`) and one already sent isn't
 * sent again on another: what the box kept for the exchange went with the connection, and what the exchange proved
 * about the other end was proved on it.
 */
export interface ConnectionTie {
  /** The session's connection the exchange runs on, once its first call was sent. */
  connection?: number;
}

/**
 * The answer to a call, in HTTP terms: the status and the parsed body. The body shapes are the contract bodies
 * (`ApiErrorBody`, `ApprovalRequiredBody`, `BlockedBody`, the endpoint response), which the typed client decodes.
 */
export interface OperationResponse {
  status: number;
  body: unknown;
  requestId: string;
}

/* Realtime ------------------------------------------------------------------------------------------- */

/** One realtime frame from a subscription. */
export interface SessionEvent {
  topic: string;
  event: unknown;
  at: string;
  /** Appliance-owned cursor (MA-09); null for ephemeral events (the agent's thinking line). */
  cursor: string | null;
}

export interface SubscriptionHandlers {
  onEvent(event: SessionEvent): void;
  /**
   * The appliance can't resume from our cursor (retention expired, restart, changed access, fell behind, an event too
   * large to send): refetch authorized snapshots of these topics. The session subscribes again after the cursor the
   * appliance gave by itself, so live events continue (AP-1097); `onReady` follows with `resumed: true`.
   */
  onSnapshotRequired(info: { topics: string[]; reason: string }): void;
  /** The subscription was (re)established; `resumed` false means events may have been missed. */
  onReady?(info: { resumed: boolean; denied: readonly { topic: string; reason: string }[] }): void;
}

export interface SessionSubscription {
  /** Change the topic set (sends the difference). */
  setTopics(topics: readonly string[]): void;
  close(): void;
}

/* Streams -------------------------------------------------------------------------------------------- */

/**
 * A resource on the appliance, named by what it is — never a URL (the appliance dispatches an allowlist,
 * not a proxy; MA-08). `resourceFromUrl` maps the contract's relative API paths (`Attachment.url`) to these.
 */
export type ResourceRef =
  | {
      kind: 'attachment';
      burrow: string;
      attachmentId: string;
      download?: boolean;
      variant?: 'original' | 'preview';
    }
  | { kind: 'export'; op: string; input: unknown }
  /**
   * A backup file the viewer made (contracts 0.79, CT-335; backup-file.md): a `download` stream of `DownloadResource
   * {type: 'backup-file'}`, resumed by `range`.
   */
  | { kind: 'backup-file'; burrow: string; backupFileId: string }
  /**
   * A picture on a thing's page (contracts 0.121, CT-1000; app service-dashboards.md AP-4537): the page's
   * `ThingImage.ref` as it came, a `download` stream of `DownloadResource {type: 'thing-image'}`.
   */
  | { kind: 'thing-image'; burrow: string; thing: string; ref: string };

export interface ResourceMeta {
  contentType: string;
  size: number | null;
  name: string | null;
  /** Server-side sha256 when known. */
  sha256: string | null;
}

export interface ResourceStream {
  meta: ResourceMeta;
  /** Chunks in order; the iterator ends at END and throws on RESET/abort. Credit is granted as it's read. */
  chunks: AsyncIterable<Uint8Array>;
  cancel(): void;
  /**
   * The appliance's `stream_done` (size and sha256 of every byte it sent), once the chunks ended; null before. The
   * chunks already failed with `integrity` when it didn't match.
   */
  summary(): { size: number; sha256: string } | null;
}

export interface OpenResourceOptions {
  /** Byte range, inclusive start, exclusive end. */
  range?: { start: number; end?: number };
  signal?: AbortSignal;
}

/** Bytes of a local file, read by offset. The whole file is never held in memory. */
export interface ChunkSource {
  name: string;
  /** Declared type, may be empty. */
  type: string;
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/**
 * Where an upload's bytes go: an attachment reserved with `uploads.create`, a backup file staged with `backups.stage`
 * (the staged skill archive went with Add skills' imports, contracts 2.0 CT-1430), or a voice typing recording.
 */
export type UploadTarget =
  | {
      type?: 'attachment';
      burrow: string;
      /** The reservation from `uploads.create`. */
      attachmentId: string;
    }
  | {
      /**
       * A backup file to restore, staged with `backups.stage` (contracts 0.79, CT-335): a `backup-file` upload stream
       * (`stream_done.output` is `BackupFileStagedUploadOutput`).
       */
      type: 'backup-file';
      burrow: string;
      stagedBackupId: string;
    }
  | {
      /**
       * A voice typing recording (contracts 3.1; docs/decisions/dictation.md): no reservation, kept in the box's memory
       * and never resumed; `stream_done.output` is `DictationOutput`, a refusal carries `details.code`.
       */
      type: 'dictation';
      burrow: string;
    };

export interface UploadProgress {
  sent: number;
  total: number;
}

export interface UploadStreamOptions {
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
}

/** A bidirectional message stream for one collaborative document (y-protocols sync/awareness messages). */
export interface CollabChannel {
  /** False when the message is above the collaboration message bound (16 MiB). */
  send(message: Uint8Array): boolean;
  /** The appliance opened the document read-only for this person. */
  readOnly(): boolean;
  onMessage(listener: (message: Uint8Array) => void): () => void;
  /** `open` after (re)attaching, `closed` when it dropped (the session may reattach), `denied` for good. */
  onStatus(listener: (status: 'open' | 'closed' | 'denied') => void): () => void;
  close(): void;
}

/* Notices -------------------------------------------------------------------------------------------- */

export type SessionNotice =
  /** This endpoint's (or account's) access was revoked: clear local content (MA-04 §6). */
  | { kind: 'revoked'; scope: 'endpoint' | 'account' }
  /** Permissions changed; caches keyed by the old generation must go (`clearCache`: drop content too). */
  | { kind: 'authz_changed'; authzGeneration: number; clearCache: boolean }
  /** The appliance is updating or restarting; `retryAfterMs` hints when to expect it back. */
  | { kind: 'maintenance'; retryAfterMs: number | null };

/* The session ---------------------------------------------------------------------------------------- */

/** A running hash, as `@noble/hashes`' `sha256.create()` has it. */
export interface RunningHash {
  update(data: Uint8Array): unknown;
  digest(): Uint8Array;
}

export interface ApplianceSession {
  state(): ConnectionState;
  onState(listener: (state: ConnectionState) => void): () => void;
  onNotice(listener: (notice: SessionNotice) => void): () => void;
  /** Start connecting (no-op when open or connecting). */
  connect(): void;
  /** Skip the backoff wait (network came back, tab visible, app foregrounded). */
  reconnectNow(): void;
  /** Close for good: rejects pending calls with `SessionClosedError`. */
  close(reason?: DisconnectReason): void;
  /**
   * Let go of the connections while nothing is under way (the phone app in the background, AP-924). Not an ending: the
   * state goes back to `idle`, subscriptions stay (resumed from their cursors on the next connection), and `connect()` or
   * the next call dials again. False, with nothing changed, while a request, a status question, a stream or a connection
   * attempt is under way, or once the session is closed. The secure transport only; nobody else needs it.
   */
  suspend?(): boolean;
  /**
   * Dial the bulk connection now, beside the interactive one, so the first photo doesn't wait for a second handshake
   * after the screen asked for it (AP-4406). Once, while connecting or open; a download that finds it failed waits for
   * the interactive connection as before. The secure transport only.
   */
  warmBulk?(): void;
  /**
   * A new running SHA-256, the one the session hashes its downloads with (the phone's own when it has one), for a caller
   * that hashes a whole file across several streams. Absent: the pure-JS one.
   */
  sha256?(): RunningHash;
  supports(capability: string): boolean;

  /** One API operation (`op` = the endpoint id, `area.action`). */
  call(endpoint: AnyEndpoint, input: OperationInput, options?: CallOptions): Promise<OperationResponse>;
  /**
   * A session-native operation (`enroll.*`, `recovery.*`, `endpoints.*`, `@whombat/protocol`
   * `SESSION_OPERATIONS`) with its own input shape. What happens after a lost answer follows the op's classification
   * (`OPERATION_SAFETY`, CT-194); an op missing from it is never asked or sent again by itself.
   */
  invoke(
    op: string,
    input: unknown,
    options?: CallOptions & { mutating?: boolean },
  ): Promise<OperationResponse>;
  /** Outcome of an earlier call whose answer was lost (`OutcomeUnknownError`). */
  status(requestId: string, endpoint: AnyEndpoint): Promise<CommandStatus>;
  subscribe(topics: readonly string[], handlers: SubscriptionHandlers): SessionSubscription;

  openResource(ref: ResourceRef, options?: OpenResourceOptions): Promise<ResourceStream>;
  /** Sends the bytes of a reserved upload; resolves to the server's completion body. */
  upload(target: UploadTarget, source: ChunkSource, options?: UploadStreamOptions): Promise<unknown>;
  /** Null when the appliance has no session collaboration (`stream.collab`). */
  openCollab(document: { burrow: string; canvasId: string }): CollabChannel | null;
  /**
   * A server's or a guest's console through the session (contracts 0.80.1, CT-350), WebSocket-shaped (`ConsoleSocket`):
   * `hosts.createConsole`'s session id and token. Null when the appliance has none (`stream.console`).
   */
  openConsole(target: ConsoleTarget): ConsoleSocket | null;
}

export type CommandStatus =
  /**
   * No receipt: it never committed (`outcome{not_found}`). `acknowledged`: the
   * appliance has it but can't tell whether it took effect (`outcome{rejected, unknown_outcome}`, CT-196) — never send
   * it again by itself.
   */
  | { state: 'unknown'; acknowledged?: true }
  | { state: 'accepted' | 'executing' }
  /** `redacted`: it went through, but the appliance keeps no result for it (CT-195); `response` has no body. */
  | { state: 'completed'; response: OperationResponse; redacted?: true }
  | { state: 'rejected'; response: OperationResponse };

/* Errors --------------------------------------------------------------------------------------------- */

/**
 * The answer was lost and the appliance keeps no result for it (`outcome{redacted}`, CT-44, CT-195): a `secret` op's
 * never is, and a runtime since contracts 0.29.1 also says so for a command whose process died before storing its
 * result, or whose handler failed after its commit. `completed`: it went through (`wentThrough`) — treat it as done and
 * fetch the current state. After `unknown_outcome` (a secret op asked again) the state is null. Never sent again by
 * itself.
 */
export class OutcomeRedactedError extends Error {
  override name = 'OutcomeRedactedError';
  constructor(
    readonly endpointId: string,
    readonly requestId: string,
    /** `completed` or `rejected` when the appliance said so; null after `unknown_outcome`. */
    readonly state: 'completed' | 'rejected' | null,
  ) {
    super(
      state === 'completed'
        ? `${endpointId} (${requestId}) went through, but its answer isn't kept.`
        : `No answer for ${endpointId} (${requestId}), and the appliance keeps none for it.`,
    );
  }
}

/**
 * The call went through, but its answer isn't kept (`OutcomeRedactedError` with state `completed`, CT-195): done, with
 * nothing to show but the current state, which the caller fetches again.
 */
export function wentThrough(error: unknown): boolean {
  return error instanceof OutcomeRedactedError && error.state === 'completed';
}

/**
 * The request was sent but its answer was lost: it may or may not have been applied. The session resolves what it can
 * with `status` first; this is what is left when the op may not be resent by itself (CT-194: destructive, effects
 * outside its receipt, secret, unknown to this build) or the session closed with it in flight (`cause`). Ask again with
 * `status` (the command tracker's `check`), or look at the current state; never send it again with a new id blindly.
 */
export class OutcomeUnknownError extends Error {
  override name = 'OutcomeUnknownError';
  /**
   * The appliance had acknowledged it (`accepted`, or `status` saying accepted/executing, AP-574): it ran or is
   * running, and it is never sent again — not even after `status` finds no receipt.
   */
  readonly acknowledged: boolean;
  constructor(
    readonly endpointId: string,
    readonly requestId: string,
    options?: { cause?: unknown; acknowledged?: boolean },
  ) {
    super(
      `No answer for ${endpointId} (${requestId}); it may have been applied.`,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.acknowledged = options?.acknowledged === true;
  }
}

/** The session was closed (sign-out, revocation, terminal failure) while the call was pending. */
export class SessionClosedError extends Error {
  override name = 'SessionClosedError';
  constructor(
    readonly reason: DisconnectReason,
    message = `The session is closed (${reason}).`,
  ) {
    super(message);
  }
}

/**
 * The request never left this client (not connected before its deadline, or not sendable): nothing was applied. Safe
 * to send again, with the same request id.
 */
export class NotDeliveredError extends Error {
  override name = 'NotDeliveredError';
  constructor(
    readonly endpointId: string,
    readonly requestId: string,
  ) {
    super(`${endpointId} could not be delivered.`);
  }
}

/**
 * A call tied to a connection (`CallOptions.tie`) found it gone: it was not sent, and nothing was applied. The exchange
 * it belonged to starts again from its first step.
 */
export class ConnectionLostError extends NotDeliveredError {
  override name = 'ConnectionLostError';
}

export class DeadlineExceededError extends Error {
  override name = 'DeadlineExceededError';
  constructor(
    readonly endpointId: string,
    readonly requestId: string,
  ) {
    super(`${endpointId} timed out.`);
  }
}

/**
 * A stream (resource, upload, collaboration) failed. `code` is the appliance's reset code name. A refused `open` keeps
 * the refusal's `details` (the runtime puts the reason's application code in `details.code`, CT-21).
 */
export class StreamError extends Error {
  override name = 'StreamError';
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
