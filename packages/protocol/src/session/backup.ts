/**
 * Backup (MA-13): the backup service's status document, its checkpoint API and the owner-only backup session ops
 * (CT-30). Cross-language pieces (status, checkpoint request/result) are re-exported by
 * `@whombat/control-contracts/local` and generated for Go.
 */
import { z } from 'zod';
import { BackupStatus } from './enrollment.js';

/** Printable-ASCII text (cross-language subset: equal lengths in Go and TypeScript; fold typographic quotes). */
export const AsciiText = (max: number, min = 1) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[\x20-\x7e]*$/);
/** Identifiers in local IPC documents. */
export const LocalIdent = (max = 64) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_.:-]+$/);
const ascii = AsciiText;
const ident = LocalIdent;

/**
 * A sentence for people from the backup service (a failure's or a refusal's reason): any script on one line, so its
 * curly quotes and accents survive, up to 500 code points. The desk's display text form (no control, format or
 * surrogate code point and no separator but U+0020), a Unicode pattern the cross-language subset admits by name, with
 * its length in the pattern (docs/contracts/cross-language.md).
 */
export const BACKUP_REASON_RE = /^(?:[^\p{Cc}\p{Cf}\p{Cs}\p{Z}]| ){0,500}$/u;
export const BackupReasonText = z.string().regex(BACKUP_REASON_RE);

/** RFC 3339 date-time (`2026-09-25T12:00:00Z`, fractional seconds and offsets allowed). */
export const Rfc3339 = z
  .string()
  .max(40)
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$/);

/* Backup service status (MA-13; feeds `/facts`) ----------------------------------------------------- */

export const BACKUP_STATUS_KIND = 'whombat.backup-status/1';

/**
 * What a backup made with a gap left out (appliance `state.Incomplete`): attachments that weren't on the box any
 * more, the servers that couldn't be backed up, and `reason`, one or two plain sentences that say so (the service folds
 * them to 500 characters).
 */
export const BackupIncomplete = z.object({
  attachments: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  servers: z.boolean().optional(),
  reason: BackupReasonText,
});
export type BackupIncomplete = z.infer<typeof BackupIncomplete>;

/**
 * Who clears old backups (appliance `state.Clearing`): `by` is `box` (this Whombat's key may delete there, so
 * the box applies the person's windows and limit after a backup, at most once a day) or `destination` (it refuses the
 * box's deletes: only the place's own cleanup can clear); another value is unknown. The box's last clearing: when,
 * whether it worked, why not, the repository's size after it, and `overLimit` (still over the space limit with only the
 * last 7 days left).
 */
export const BackupClearing = z.object({
  by: ident(32),
  at: Rfc3339.optional(),
  ok: z.boolean().optional(),
  error: BackupReasonText.optional(),
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  overLimit: z.boolean().optional(),
});
export type BackupClearing = z.infer<typeof BackupClearing>;

/**
 * The backup service's status document (`whombat.backup-status/1`; the appliance's backup `state/status.go`).
 * Client-safe: never credentials. Durations are integers (ms or seconds).
 */
export const BackupServiceStatus = z.object({
  kind: z.literal(BACKUP_STATUS_KIND),
  state: z.enum(['unprotected', 'pending', 'protected', 'stale', 'failing']),
  protected: z.boolean(),
  destination: z.object({
    configured: z.boolean(),
    kind: ident(32).optional(),
    /** Human display of the destination (host, bucket), no secrets. */
    display: ascii(200, 0).optional(),
    /** Whether the destination refuses deletes from the appliance's credential. */
    appendOnly: z.enum(['verified', 'not-enforced', 'unknown']).optional(),
    repositoryId: ident().optional(),
  }),
  lastSuccess: z
    .object({
      id: ident(),
      at: Rfc3339,
      ageSeconds: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      snapshotId: ident(),
      method: ident(32),
      quiesceHeldMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      durationMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      bytesAdded: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      totalBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      files: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      schemaVersion: z.number().int().min(0).max(1_000_000),
      /** Set when the backup was made with a gap and uploaded anyway: what it left out (absent from older services). */
      incomplete: BackupIncomplete.optional(),
    })
    .nullable(),
  lastFailure: z
    .object({
      id: ident(),
      at: Rfc3339,
      stage: z.enum(['preflight', 'quiesce', 'snapshot', 'dump', 'upload', 'verify']),
      /** One sentence for people (any script on one line; older services send printable ASCII). */
      reason: BackupReasonText,
    })
    .nullable(),
  lastAttemptOk: z.boolean().nullable(),
  /**
   * The attempts that failed since the last success (0 after one). `failing` is two in a row, or one while backups are
   * late. Absent from older services.
   */
  failedAttempts: z.number().int().min(0).max(1_000_000).optional(),
  coverage: z
    .array(
      z.object({
        id: ident(32),
        title: ascii(80),
        covered: z.boolean(),
        relogin: z.boolean().optional(),
      }),
    )
    .max(32),
  recoverability: z.object({
    lastDrill: z
      .object({
        at: Rfc3339,
        ok: z.boolean(),
        checkpointId: ident(),
        rtoSeconds: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        backupAgeSeconds: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        failed: z.array(ident(32)).max(32).optional(),
        skipped: z.array(ident(32)).max(32).optional(),
      })
      .nullable(),
  }),
  kitGeneration: z.number().int().min(0).max(1_000_000),
  running: z.object({ id: ident(), op: ident(32), stage: ident(32), since: Rfc3339 }).nullable(),
  /** Who clears old backups at the destination, and how the box's own clearing last went (absent from older services). */
  clearing: BackupClearing.optional(),
  updatedAt: Rfc3339,
});
export type BackupServiceStatus = z.infer<typeof BackupServiceStatus>;

/* Checkpoint API (backup service `POST /v1/checkpoints`, BK-17) ----------------------------------------------- */

export const BACKUP_PATHS = {
  status: '/v1/status',
  checkpoints: '/v1/checkpoints',
  /** `PUT`: the body is `BackupConfigureDestinationInput` as the owner sent it; the answer its output (CT-142). */
  destination: '/v1/destination',
  recoveryMaterial: '/v1/recovery-material',
  /** `GET` (runtime): `BackupSshPublicKey`, the key made on the first call (CT-142). */
  sshPublicKey: '/v1/ssh-public-key',
} as const;

/**
 * Take a checkpoint now (synchronous). `manual`/`scheduled`: runtime or manager. `migration`: the manager only,
 * inside its own drain (scope `all`), with the release and migrations and its drain `requestId` as `underDrain`;
 * the checkpoint is verified from the destination. Answers `CheckpointResult`, or `LocalError` with 409 `busy`,
 * 412 `unprotected` (no destination), 403 `forbidden`, 502 `checkpoint_failed` (`stage`).
 */
export const CheckpointRequest = z.strictObject({
  reason: z.enum(['manual', 'scheduled', 'migration']),
  releaseId: ident(80).optional(),
  migrations: z.array(ident(128)).max(256).optional(),
  /** The manager's drain request id (only with `migration`). */
  underDrain: ident().optional(),
});
export type CheckpointRequest = z.infer<typeof CheckpointRequest>;

export const CheckpointResult = z.object({
  ok: z.literal(true),
  /** Checkpoint id to pass to `whombat migrate --checkpoint`. */
  ref: ident(),
  /** Re-read and checked from the destination (always for `migration`). */
  verified: z.boolean(),
  id: ident(),
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  snapshotId: ident(),
  manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: Rfc3339,
  schemaVersion: z.number().int().min(0).max(1_000_000),
});
export type CheckpointResult = z.infer<typeof CheckpointResult>;

/* Owner backup ops (session, MR-19) ---------------------------------------------------------------------------- */

export const BackupStatusInput = z.strictObject({});
export const BackupStatusOutput = z.object({
  /** The service's document (null: no backup service); drill status is `status.recoverability.lastDrill`. */
  status: BackupServiceStatus.nullable(),
  summary: BackupStatus,
});

/** The kinds of destination (CT-142), from the repository's prefix. */
export const BackupDestinationKind = z.enum(['rest', 's3', 'sftp', 'disk', 'local']);
export type BackupDestinationKind = z.infer<typeof BackupDestinationKind>;

/**
 * Configure or adopt the destination. Holds secrets (`secret` op: no input digest in the receipt). The runtime passes
 * it unchanged as the backup service's `PUT /v1/destination` body. `repository` is a restic repository without
 * credentials (never an `@`); the kinds (CT-142):
 * - `rest:https://backup.example.com/appliance/` — a restic REST server (the append-only one qualifies);
 *   `restUser`/`restPassword`, `caCert` for a private CA;
 * - `s3:https://s3.example.com/bucket/path` — an S3-compatible bucket; `s3AccessKeyId`, `s3SecretAccessKey`,
 *   `s3Region` (when the service needs one), `caCert` for a private CA;
 * - `sftp:host:/path`, or with a port `sftp://host:port//path` (restic's two forms; there is no
 *   `sftp:host:port:/path`) — SFTP/NAS; the user always in `sftpUser`, never in the repository; the key is the box's own (`backup.sshPublicKey`: the owner adds it to the server), `sftpHostKey` pins the server's host key
 *   (an OpenSSH known_hosts-style line); without it the first connection is trusted and its fingerprint answered;
 * - `disk:` exactly — the disk labelled `WHOMBAT-BACKUP` attached to the box (the service maps it).
 */
export const BackupConfigureDestinationInput = z.strictObject({
  repository: ascii(500)
    .min(1)
    .regex(/^[^@]*$/, 'no credentials in the repository URL'),
  restUser: ascii(200).optional(),
  restPassword: ascii(500).optional(),
  /** PEM CA certificate of a private destination. */
  caCert: z.string().max(16_384).optional(),
  /** Joining an existing repository (a replacement): the kit's repository password. */
  adoptPassword: ascii(500).optional(),
  allowInit: z.boolean().optional(),
  s3AccessKeyId: ascii(200).optional(),
  s3SecretAccessKey: ascii(500).optional(),
  s3Region: ascii(64).optional(),
  sftpUser: ascii(64).optional(),
  /** The server's host key to pin, one known_hosts-style line (`ssh-ed25519 AAAA…`); absent: trust on first use. */
  sftpHostKey: ascii(2000).optional(),
});
export const BackupConfigureDestinationOutput = z.object({
  repositoryId: ident(),
  appendOnly: z.enum(['verified', 'not-enforced', 'unknown']),
  generation: z.number().int().min(0),
  /** The destination's kind (CT-142). */
  kind: BackupDestinationKind.optional(),
  /** SFTP: the fingerprint of the host key now pinned (`SHA256:…`), to show the owner. */
  hostKeyFingerprint: ascii(200).optional(),
});

/**
 * `backup.sshPublicKey`: the key the box uses for SFTP destinations, made on the first call. The owner adds
 * `publicKey` to the server's `authorized_keys`.
 */
export const BackupSshPublicKeyInput = z.strictObject({});
export const BackupSshPublicKey = z.object({
  /** One authorized_keys line: `ssh-ed25519 AAAA… whombat-backup@<applianceId>`. */
  publicKey: ascii(1000),
  /** `SHA256:<base64>`, as `ssh-keygen -l` prints it. */
  fingerprint: ascii(200),
});
export type BackupSshPublicKey = z.infer<typeof BackupSshPublicKey>;

export const BACKUP_RECOVERY_MATERIAL_KIND = 'whombat.backup-recovery-material/1';

/** The kit's backup section (secrets; shown to an owner for the recovery kit, never stored in a receipt). */
export const BackupRecoveryMaterial = z.object({
  kind: z.literal(BACKUP_RECOVERY_MATERIAL_KIND),
  applianceId: ident(),
  /** Bumped when the password, destination or manifest key change. */
  generation: z.number().int().min(0),
  createdAt: Rfc3339,
  repository: ascii(500),
  restUser: ascii(200).optional(),
  restPassword: ascii(500).optional(),
  /** What reaching an S3 or SFTP repository from another machine takes (CT-142). */
  s3AccessKeyId: ascii(200).optional(),
  s3SecretAccessKey: ascii(500).optional(),
  s3Region: ascii(64).optional(),
  sftpUser: ascii(64).optional(),
  /** The box's SFTP private key (OpenSSH PEM). */
  sftpPrivateKey: z.string().max(8000).optional(),
  sftpHostKey: ascii(2000).optional(),
  repositoryPassword: ascii(500),
  repositoryId: ident(),
  /** `ed25519:<base64>`: authenticates checkpoint manifests as this appliance's. */
  manifestKey: ascii(200),
  /**
   * The newest checkpoint the appliance knows when the material was read (CT-145): its sequence number, the sha256 of
   * its manifest and when it was made. A restore from the kit alone can then tell a destination that withholds the
   * newest checkpoints (appliance backup security review I-2); restores work without it (older kits, older services).
   */
  head: z
    .object({
      seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
      at: Rfc3339,
    })
    .optional(),
  /**
   * The earlier Whombats this one brought back, newest first: each one's manifest key and the newest of its backups
   * this one trusts it for. A later bring back from this kit then opens their backups too, and none an earlier
   * Whombat made after it was replaced.
   */
  adopted: z
    .array(
      z.object({
        applianceId: ident().optional(),
        manifestKey: ascii(200),
        until: z.object({
          checkpointId: ident(),
          seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
          manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
          known: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(128),
        }),
      }),
    )
    .max(4)
    .optional(),
  /**
   * The second place, where the box keeps a copy of its backups (Whombat offsite-copy.md): a restic repository of its
   * own with the same password, in a bucket the person owns, and the newest backup in it. Bringing the box back uses it
   * when the main place is gone. Absent when there is none, and to an app below `OFFSITE_MINOR` (it reads the material
   * strictly).
   */
  offsite: z
    .object({
      provider: z.string().regex(/^[a-z0-9]{1,16}$/),
      repository: ascii(500),
      s3AccessKeyId: ascii(200).optional(),
      s3SecretAccessKey: ascii(500).optional(),
      s3Region: ascii(64).optional(),
      repositoryId: ident(),
      head: z
        .object({
          seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
          manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
          at: Rfc3339,
        })
        .optional(),
    })
    .optional(),
});
export const BackupRecoveryMaterialInput = z.strictObject({});
export const BackupRunNowInput = z.strictObject({});
/** `backup.runNow` is accepted when its audit event commits, before the checkpoint runs; it can't be cancelled. */
export const BackupRunNowOutput = CheckpointResult;
