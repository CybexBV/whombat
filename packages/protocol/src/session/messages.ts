/**
 * Session protocol v1 CONTROL messages (MA-08, MA-09): UTF-8 JSON on stream 0, discriminated by `t`.
 *
 * Handshake: the client's first message is `hello`; the appliance answers `welcome` (or `error` with
 * `unsupported_version`/`revoked` and closes). Nothing else may precede them.
 *
 * Requests: `request{id, op, input, deadlineMs}` → optional `accepted{id}` (mutations, after the commit) →
 * `result{id}` or `error{id}`. `cancel{id}` before acceptance ends it with `error{cancelled}`; after acceptance
 * the work continues. `status{id}` → `outcome{id, state}` for an ambiguous outcome.
 *
 * Events: `subscribe{sub, topics, after?}` → `subscribed{sub, cursor}` then `event{sub, cursor}`… or
 * `snapshot_required{sub, reason, cursor}` (refetch snapshots, then resume from `cursor`).
 *
 * Streams: `open{stream, spec}` → `opened{stream, meta}` or `error{stream, stream_refused}`; DATA/CREDIT/END/
 * RESET frames on the stream; uploads announce each chunk with `chunk` and get `chunk_ack`; a stream's
 * producer ends with `stream_done{stream, size, sha256}` before its END frame.
 */

import { ThingParam, Topic } from '@whombat/core/contracts';
import { JsonValue, ThingImageRef } from '@whombat/core/domain';
import {
  AccountId,
  AttachmentId,
  BackupFileId,
  BurrowId,
  CanvasId,
  PrincipalId,
  StagedBackupId,
} from '@whombat/core/ids';
import { ClientBuildNumber } from '@whombat/release';
import { z } from 'zod';
import { Edition } from '../edition.js';
import {
  SESSION_MAX_DEADLINE_MS,
  SESSION_MAX_PRINCIPALS,
  SESSION_MAX_STREAM_CREDIT,
  SESSION_MAX_TOPICS_PER_SUBSCRIPTION,
  SESSION_MIN_DEADLINE_MS,
  UPLOAD_MAX_CHUNK_BYTES,
  UPLOAD_MAX_FILE_BYTES,
  UPLOAD_MIN_CHUNK_BYTES,
} from '../limits.js';
import { OwnAddressClaimSecret } from '../own-address.js';
import { ReceiptState } from './commands.js';
import {
  AuthzGeneration,
  EndpointId,
  EventCursor,
  OpName,
  PeerIdString,
  RequestId,
  StreamId,
  SubscriptionId,
} from './common.js';
import { DirectAddresses } from './direct.js';
import { SessionErrorCode } from './errors.js';
import { Capabilities, ProtocolVersion } from './version.js';

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const ByteCount = z.number().int().min(0).max(UPLOAD_MAX_FILE_BYTES);
const Burrow = z.string().min(1).max(63);
const ShortText = z.string().max(200);

/* Handshake -------------------------------------------------------------------------------------- */

export const ClientInfo = z.object({
  /** App build for people and logs (`web 2026.09.25-3`, `android 1.4.0 (140)`). */
  build: z.string().min(1).max(64),
  platform: z.enum(['web', 'android', 'ios', 'desktop', 'cli']),
  /**
   * The platform's monotonic integer build number (CT-53: Android `versionCode`, the iOS build counter, the hosted
   * web UI's build counter), compared with the release's client security floor. Absent counts as 0, so a client
   * without it is refused wherever a floor is set.
   */
  buildNumber: ClientBuildNumber.optional(),
});
export type ClientInfo = z.infer<typeof ClientInfo>;

export const Hello = z.object({
  t: z.literal('hello'),
  /**
   * The major the client speaks, at its minor (`SESSION_PROTOCOL`). A list, so a box reads any app's hello — an older or
   * a newer one — and refuses a major it doesn't speak in words (`unsupported_version`, `whoMustUpdate`).
   */
  versions: z.array(ProtocolVersion).min(1).max(4),
  capabilities: Capabilities,
  client: ClientInfo,
  /** The `authzGeneration` the client's cached content was fetched under, if any (drives cache clearing). */
  cachedAuthzGeneration: AuthzGeneration.optional(),
  /**
   * The account the cached content belongs to (I-3, CT-47): `welcome.clearCache` is also true when it isn't the
   * session's account. Clients key caches by `{appliance, accountId, endpointId, authzGeneration}`.
   */
  cachedAccountId: AccountId.optional(),
  /**
   * The claim link's secret (`https://<host>/c/<secret>`, on the box's screen), from a page at the box's own address
   * that was opened with it (minor 2; Whombat own-address.md). A box nobody claimed keeps a few places for the
   * sessions that show it, so a stranger at the address can't keep the setup out. It lets nothing in by itself: the
   * claim's start asks for it again. Left out everywhere else; a box from before ignores it.
   */
  claimLink: OwnAddressClaimSecret.optional(),
});
export type Hello = z.infer<typeof Hello>;

/** Who the session acts as. `null` for an unenrolled endpoint (enrollment channel only). */
/** One burrow membership of the account: its principal in that burrow. */
export const BurrowPrincipal = z.object({ burrowId: BurrowId, principalId: PrincipalId });
export type BurrowPrincipal = z.infer<typeof BurrowPrincipal>;

/**
 * Who the session acts as (MA-03): endpoints bind to the person's **account**, which has its principal in the burrow
 * (none right after a claim, before the burrow exists). Since 3.0 without `owner` (CT-1585): the account is the person's.
 */
export const PrincipalSummary = z.object({
  accountId: AccountId,
  name: z.string().min(1).max(120),
  principals: z.array(BurrowPrincipal).max(SESSION_MAX_PRINCIPALS).optional(),
});
export type PrincipalSummary = z.infer<typeof PrincipalSummary>;

export const Welcome = z.object({
  t: z.literal('welcome'),
  version: ProtocolVersion,
  /** Intersection of both sides' capabilities. */
  capabilities: Capabilities,
  /** The appliance's content PeerId (already pinned by the client during the handshake). */
  appliance: PeerIdString,
  /** `app`: enrolled endpoint; `enroll`: unenrolled, only enrollment/recovery operations. */
  channel: z.enum(['app', 'enroll']),
  principal: PrincipalSummary.nullable(),
  endpointId: EndpointId.nullable(),
  authzGeneration: AuthzGeneration,
  /** When the client's `cachedAuthzGeneration` differs, it must clear cached content before use. */
  clearCache: z.boolean(),
  limits: z.object({
    maxControlBytes: z.number().int().positive(),
    maxDataBytes: z.number().int().positive(),
    maxOpenStreams: z.number().int().positive(),
    maxInflightRequests: z.number().int().positive(),
    initialStreamCredit: z.number().int().positive().max(SESSION_MAX_STREAM_CREDIT),
  }),
  serverTime: z.iso.datetime({ offset: true }),
  /**
   * The box's direct ways in (HE-50, CT-1252): on the `app` channel, its local-network addresses and Tailscale name
   * with the routes to try before the relay next time (`directRoutesFor`); null on the `enroll` channel and when the box
   * takes no direct connections.
   */
  direct: DirectAddresses.nullable(),
  /**
   * The box's edition (HE-58, CT-1300), on every channel: a community box has no relay, control, remote help, licence or
   * phone push, and claims on its own page (`editionHas`). Absent: `commercial` (a box before contracts 1.1).
   */
  edition: Edition.optional(),
});
export type Welcome = z.infer<typeof Welcome>;

/* Requests --------------------------------------------------------------------------------------- */

export const RequestMessage = z.object({
  t: z.literal('request'),
  id: RequestId,
  op: OpName,
  /** Validated against the operation's input schema (`OperationSpec.input`). */
  input: JsonValue,
  deadlineMs: z.number().int().min(SESSION_MIN_DEADLINE_MS).max(SESSION_MAX_DEADLINE_MS),
});
export type RequestMessage = z.infer<typeof RequestMessage>;

/** The command committed durably (mutations only; reads go straight to `result`). */
export const Accepted = z.object({
  t: z.literal('accepted'),
  id: RequestId,
  at: z.iso.datetime({ offset: true }),
});
export type Accepted = z.infer<typeof Accepted>;

/**
 * A `result` (or `outcome`) whose encoding exceeds 64 KiB is not sent; the appliance answers
 * `error{code: 'too_large', details: {code: 'use_export_stream'}}` and the client reads the op through an
 * export stream (reads only; a mutation's result is small by contract).
 */
export const ResultMessage = z.object({
  t: z.literal('result'),
  id: RequestId,
  /**
   * `ok`: `output` matches the operation's output schema. `approval_required`: the keys engine asked a person
   * (`output` is core's `ApprovalRequiredBody`; the command is durably recorded).
   */
  kind: z.enum(['ok', 'approval_required']),
  output: JsonValue,
});
export type ResultMessage = z.infer<typeof ResultMessage>;

export const ErrorMessage = z.object({
  t: z.literal('error'),
  /** The request this answers; absent for session-level errors (the session then closes). */
  id: RequestId.optional(),
  /** The stream this answers (open refused, upload chunk rejected). */
  stream: StreamId.optional(),
  code: SessionErrorCode,
  message: z.string().max(1_000),
  retryable: z.boolean(),
  /** Field errors for `validation_failed` (path → messages). */
  fields: z.record(z.string().max(200), z.array(z.string().max(300)).max(10)).optional(),
  /** Code-specific details (e.g. `blocked`: `{keyNeeded, eventId}`). */
  details: JsonValue.optional(),
});
export type ErrorMessage = z.infer<typeof ErrorMessage>;

export const Cancel = z.object({ t: z.literal('cancel'), id: RequestId });
export type Cancel = z.infer<typeof Cancel>;

export const StatusMessage = z.object({ t: z.literal('status'), id: RequestId });
export type StatusMessage = z.infer<typeof StatusMessage>;

export const Outcome = z.object({
  t: z.literal('outcome'),
  id: RequestId,
  state: ReceiptState,
  /** Digest the id is bound to (so the client can tell whether it was its request). */
  digest: Sha256Hex.optional(),
  /** Present for `completed` (as `result` would carry it, while retained). */
  result: z.object({ kind: z.enum(['ok', 'approval_required']), output: JsonValue }).optional(),
  /**
   * Present for `rejected`. `code: unknown_outcome` is not a refusal: the command acted outside its commit before its
   * answer was lost and may have happened (CT-196) — an unknown outcome, never resent by a client on its own.
   */
  error: z.object({ code: SessionErrorCode, message: z.string().max(1_000) }).optional(),
  /**
   * The outcome is known but its result isn't kept (CT-44, CT-195): with `completed` it went through, and the client
   * fetches the current state instead of expecting the answer. A `secret` op's result is never kept; a runtime also
   * says so for a command committed by a process that died before storing its result, and for one whose handler failed
   * after its commit while reading its result back. Never with `rejected`, whose `error` is always kept.
   */
  redacted: z.boolean().optional(),
});
export type Outcome = z.infer<typeof Outcome>;

/* Events ----------------------------------------------------------------------------------------- */

export const Subscribe = z.object({
  t: z.literal('subscribe'),
  sub: SubscriptionId,
  topics: z.array(Topic).min(1).max(SESSION_MAX_TOPICS_PER_SUBSCRIPTION),
  /** Resume after this cursor; absent = from now (the client fetches snapshots first). */
  after: EventCursor.optional(),
});
export type Subscribe = z.infer<typeof Subscribe>;

export const Unsubscribe = z.object({ t: z.literal('unsubscribe'), sub: SubscriptionId });
export type Unsubscribe = z.infer<typeof Unsubscribe>;

/** Why a topic of a `subscribe` was left out (the rest of the subscription stands). */
export const TopicDenialReason = z.enum([
  /** The account has no principal in the topic's burrow. */
  'not_member',
  /** The principal may not read the topic (private conversation, other person's `me:`). */
  'forbidden',
  /** The topic's object doesn't exist. */
  'not_found',
]);
export const Subscribed = z.object({
  t: z.literal('subscribed'),
  sub: SubscriptionId,
  /** Head cursor when the subscription started (events after it follow). */
  cursor: EventCursor,
  /** Topics that were not subscribed, with the reason. */
  denied: z
    .array(z.object({ topic: Topic, reason: TopicDenialReason }))
    .max(SESSION_MAX_TOPICS_PER_SUBSCRIPTION),
});
export type Subscribed = z.infer<typeof Subscribed>;

const EventPayload = z.looseObject({ type: z.string().min(1).max(64) });

/**
 * An application event. `event` is a core `RealtimeEvent`; unknown `type`s (newer minors) are skipped.
 * Durable events (`ephemeral: false`) come from the appliance's event log and carry the cursor to resume after;
 * ephemeral ones (`ephemeral: true`: the agent's thinking line) are live only and have no cursor.
 */
export const EventMessage = z.discriminatedUnion('ephemeral', [
  z.object({
    t: z.literal('event'),
    ephemeral: z.literal(false),
    sub: SubscriptionId,
    cursor: EventCursor,
    topic: Topic,
    event: EventPayload,
  }),
  z.object({
    t: z.literal('event'),
    ephemeral: z.literal(true),
    sub: SubscriptionId,
    topic: Topic,
    event: EventPayload,
  }),
]);
export type EventMessage = z.infer<typeof EventMessage>;

export const SnapshotReason = z.enum([
  /** `after` is older than the retained event log. */
  'cursor_expired',
  /** The appliance restarted with a new event log epoch. */
  'restart',
  /** The account's `authzGeneration` changed. */
  'authz_changed',
  /** The client fell too far behind (bounded per-session event queue). */
  'overflow',
]);
export const SnapshotRequired = z.object({
  t: z.literal('snapshot_required'),
  sub: SubscriptionId,
  reason: SnapshotReason,
  /** Refetch authorized snapshots, then subscribe again with `after: cursor`. */
  cursor: EventCursor,
});
export type SnapshotRequired = z.infer<typeof SnapshotRequired>;

/* Streams ---------------------------------------------------------------------------------------- */

export const ByteRange = z.object({
  start: ByteCount,
  /** Exclusive; absent = to the end. */
  end: ByteCount.optional(),
});

/** Resources a download stream can fetch. */
export const DownloadResource = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('attachment'),
    burrow: Burrow,
    attachmentId: AttachmentId,
    /**
     * `preview`: a real derived preview (e.g. a downscaled image). When the appliance can't derive one it refuses
     * the stream (`error{stream_refused, details.code: 'variant_unavailable'}`); it never sends the original instead.
     */
    variant: z.enum(['original', 'preview']).default('original'),
  }),
  /**
   * A backup file the caller made (0.79, CT-335; `backup-file.ts`): resumable with `range`. Refused with
   * `details.code: backup_file.expired` once it is gone or past its 24 hours.
   */
  z.object({ type: z.literal('backup-file'), burrow: Burrow, backupFileId: BackupFileId }),
  /**
   * A picture on a thing's page (0.121, CT-1000; `THING_IMAGE_TRANSFER`): the page's `ThingImage.ref` as it came, for
   * a person who may see the thing. `opened.meta` carries its type (`image/jpeg`, `image/png`, `image/webp`) and size.
   * Anything wrong is `stream_refused` without saying why.
   */
  z.object({ type: z.literal('thing-image'), burrow: Burrow, thing: ThingParam, ref: ThingImageRef }),
]);
export type DownloadResource = z.infer<typeof DownloadResource>;

/**
 * Where an upload's bytes go, reserved first with an operation (except a voice typing recording, 3.1):
 * `uploads.create` for an attachment, `backups.stage` for a backup file to restore (0.79, CT-335; `stream_done.output` is `BackupFileStagedUploadOutput`). The `skill-archive`
 * target (`skills.stage`, 0.113–1.1) went with Add skills from an archive (2.0, CT-1430; Whombat HSK-08).
 */
export const UploadTarget = z.discriminatedUnion('type', [
  z.object({ type: z.literal('attachment'), burrow: Burrow, attachmentId: AttachmentId }),
  z.object({ type: z.literal('backup-file'), burrow: Burrow, stagedBackupId: StagedBackupId }),
  /**
   * A voice typing recording (3.1; `voice.ts`): no reservation, kept in memory, never resumed; `stream_done.output` is
   * core's `DictationOutput`.
   */
  z.object({ type: z.literal('dictation'), burrow: Burrow }),
]);
export type UploadTarget = z.infer<typeof UploadTarget>;

export const StreamSpec = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('download'),
    resource: DownloadResource,
    range: ByteRange.optional(),
  }),
  z.object({
    kind: z.literal('upload'),
    /** Reopening the same target resumes after the last acknowledged chunk. */
    target: UploadTarget,
    size: ByteCount,
    /**
     * sha256 of the whole file; checked after the last chunk. Required for an attachment and a recording; a backup
     * file's upload may leave it out at session minor 7 and later (Whombat backup-options.md CT-1695): its chunks are
     * checked one by one and the box hashes the whole file when it is all there, so the app needn't read it twice.
     */
    sha256: Sha256Hex.optional(),
    chunkSize: z.number().int().min(UPLOAD_MIN_CHUNK_BYTES).max(UPLOAD_MAX_CHUNK_BYTES),
  }),
  z.object({
    kind: z.literal('export'),
    /**
     * An allowlisted operation with `exportable` (any non-mutating op, or an `exportOp` such as `diagnostics.download`);
     * its output is streamed as bytes (JSON output as UTF-8 JSON).
     */
    op: OpName,
    input: JsonValue,
  }),
  z.object({
    kind: z.literal('collab'),
    burrow: Burrow,
    canvasId: CanvasId,
  }),
  /**
   * A server's or a guest's console through the session (0.80.1, CT-350; `@whombat/protocol/console`): the session id
   * and single-use token `hosts.createConsole` answered. Capability `stream.console`.
   */
  z.object({
    kind: z.literal('console'),
    burrow: Burrow,
    sessionId: z.string().min(1).max(200),
    token: z.string().min(1).max(500),
  }),
]);
export type StreamSpec = z.infer<typeof StreamSpec>;
export type StreamKind = StreamSpec['kind'];

export const Open = z.object({
  t: z.literal('open'),
  /** Odd for streams the client opens. */
  stream: StreamId,
  spec: StreamSpec,
});
export type Open = z.infer<typeof Open>;

export const StreamMeta = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('download'),
    /** Total size of the resource and the range that follows. */
    size: ByteCount,
    range: z.object({ start: ByteCount, end: ByteCount }),
    contentType: z.string().max(255),
    name: z.string().max(1_000).optional(),
    sha256: Sha256Hex.optional(),
  }),
  z.object({
    kind: z.literal('upload'),
    /** Bytes already durably received (a multiple of `chunkSize`); continue with chunk `received / chunkSize`. */
    received: ByteCount,
    chunkSize: z.number().int().min(UPLOAD_MIN_CHUNK_BYTES).max(UPLOAD_MAX_CHUNK_BYTES),
  }),
  z.object({
    kind: z.literal('export'),
    contentType: z.string().max(255),
    name: z.string().max(1_000).optional(),
    /** Known size, when the export is materialized before streaming. */
    size: ByteCount.optional(),
  }),
  z.object({
    kind: z.literal('collab'),
    /**
     * DATA carries y-protocols messages (varuint type 0 sync / 1 awareness + body), each framed `[u32 len][bytes]`
     * and free to span frames (`@whombat/protocol/collab`, ≤ 16 MiB per message).
     */
    documentName: z.string().min(1).max(200),
    readOnly: z.boolean(),
  }),
  z.object({
    kind: z.literal('console'),
    /**
     * The hosts service's console is connected. DATA carries its messages (`kind | channel (u16 BE) | payload`), each
     * framed `[u32 len][bytes]` and free to span frames (`@whombat/protocol/console`, ≤ 2 MiB per message).
     */
    protocol: z.string().min(1).max(32),
  }),
]);
export type StreamMeta = z.infer<typeof StreamMeta>;

export const Opened = z.object({
  t: z.literal('opened'),
  stream: StreamId,
  meta: StreamMeta,
});
export type Opened = z.infer<typeof Opened>;

/**
 * Upload: announces a chunk; its bytes follow as DATA frames on the stream. Pipelining (CT-36): announcements may
 * run ahead of `chunk_ack`s (bounded by credit; the appliance queues at most 256), but each must start exactly
 * where the previous one ended (`offset` = previous offset + size, `index` + 1) — a gap or an overlap is
 * `RESET protocolError`. DATA may span chunk boundaries; the appliance processes and acknowledges chunks in order.
 */
export const Chunk = z.object({
  t: z.literal('chunk'),
  stream: StreamId,
  index: z.number().int().min(0).max(1_000_000),
  offset: ByteCount,
  size: z.number().int().min(1).max(UPLOAD_MAX_CHUNK_BYTES),
  sha256: Sha256Hex,
});
export type Chunk = z.infer<typeof Chunk>;

/** Upload: the chunk matched its sha256 and is durably stored. */
export const ChunkAck = z.object({
  t: z.literal('chunk_ack'),
  stream: StreamId,
  index: z.number().int().min(0).max(1_000_000),
  received: ByteCount,
});
export type ChunkAck = z.infer<typeof ChunkAck>;

/** The producer's summary before its END frame (downloads/exports: the appliance; uploads: the appliance
 * after verifying the whole file, with the operation's output). */
export const StreamDone = z.object({
  t: z.literal('stream_done'),
  stream: StreamId,
  size: ByteCount,
  sha256: Sha256Hex,
  output: JsonValue.optional(),
});
export type StreamDone = z.infer<typeof StreamDone>;

/* Session control -------------------------------------------------------------------------------- */

/** The account or this endpoint was revoked: clear cached content; the appliance closes the session. */
export const Revoked = z.object({
  t: z.literal('revoked'),
  scope: z.enum(['endpoint', 'account']),
  authzGeneration: AuthzGeneration,
  clearCache: z.literal(true),
  reason: ShortText.optional(),
});
export type Revoked = z.infer<typeof Revoked>;

/** Permissions changed (role, grants): subscriptions get `snapshot_required{authz_changed}`; refetch. */
export const AuthzChanged = z.object({
  t: z.literal('authz_changed'),
  authzGeneration: AuthzGeneration,
  clearCache: z.boolean(),
});
export type AuthzChanged = z.infer<typeof AuthzChanged>;

/** The appliance wants the client to reconnect (rekey, update, shutdown); accepted work is unaffected. */
export const GoAway = z.object({
  t: z.literal('goaway'),
  reason: z.enum(['rekey', 'update', 'shutdown', 'overload']),
  retryAfterMs: z.number().int().min(0).max(3_600_000),
});
export type GoAway = z.infer<typeof GoAway>;

export const Ping = z.object({ t: z.literal('ping'), n: z.number().int().min(0).max(0xffff_ffff) });
export const Pong = z.object({ t: z.literal('pong'), n: z.number().int().min(0).max(0xffff_ffff) });

/* Unions ----------------------------------------------------------------------------------------- */

/** Messages the client sends. */
export const ClientMessage = z.discriminatedUnion('t', [
  Hello,
  RequestMessage,
  Cancel,
  StatusMessage,
  Subscribe,
  Unsubscribe,
  Open,
  Chunk,
  Ping,
  Pong,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** Messages the appliance sends. */
export const ApplianceMessage = z.discriminatedUnion('t', [
  Welcome,
  Accepted,
  ResultMessage,
  ErrorMessage,
  Outcome,
  Subscribed,
  EventMessage,
  SnapshotRequired,
  Opened,
  ChunkAck,
  StreamDone,
  Revoked,
  AuthzChanged,
  GoAway,
  Ping,
  Pong,
]);
export type ApplianceMessage = z.infer<typeof ApplianceMessage>;

/** Every session CONTROL message. `stream_done` is sent by the appliance only (uploads end with END). */
export type SessionMessage = ClientMessage | ApplianceMessage;
export type SessionMessageType = SessionMessage['t'];

type Option = { shape: { t: { value: string } } } | { options: readonly Option[] };
const typesOf = (options: readonly Option[]): string[] =>
  options.flatMap((o) => ('shape' in o ? [o.shape.t.value] : typesOf(o.options)));

export const CLIENT_MESSAGE_TYPES: ReadonlySet<string> = new Set(
  typesOf(ClientMessage.options as readonly Option[]),
);
export const APPLIANCE_MESSAGE_TYPES: ReadonlySet<string> = new Set(
  typesOf(ApplianceMessage.options as unknown as readonly Option[]),
);
