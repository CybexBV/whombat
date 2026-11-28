/**
 * The copy somewhere else (Whombat docs/decisions/offsite-copy.md): a second place, an S3-compatible bucket the person
 * owns, where the box copies its backups after each one. A fire, theft or flood that takes the box and the NAS together
 * leaves that copy. The backup service's own document (`GET /v1/offsite`, `whombat.backup-offsite/1`) is defined in Go
 * (`appliance/backup/internal/offsite`) and mirrored here; the runtime parses it and answers `BackupOffsite`.
 */
import { Timestamp } from '@whombat/core/domain';
import { z } from 'zod';

// Not from `./backup.js`: the backup summary (`enrollment.ts`) imports this file, and `backup.ts` imports that.
const Rfc3339 = Timestamp;
const AsciiText = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[\x20-\x7e]*$/);

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** The storage the person chose: the app fills in its address; `s3` is any other S3-compatible storage. */
export const BackupOffsiteProvider = z.enum(['b2', 'r2', 'hetzner', 'aws', 's3']);
export type BackupOffsiteProvider = z.infer<typeof BackupOffsiteProvider>;

/**
 * What failed, setting the place up or copying to it: the app and the Inbox say it in the person's language. `reach`
 * nobody answered at the address; `bucket` no bucket of that name; `keys` the key or its secret was refused; `region`
 * the bucket is in another region; `write`, `read`, `delete` the key may not do that there; `repository` the folder holds
 * backups that aren't this Whombat's copy (it can't open them, or another repository replaced the copy); `same` it is
 * where the backups go already; `pair` the backups go to a bucket with another key; `main` the backups at their main
 * place couldn't be read; `copy` the copy itself stopped.
 */
export const BackupOffsiteStep = z.enum([
  'reach',
  'bucket',
  'keys',
  'region',
  'write',
  'read',
  'delete',
  'repository',
  'same',
  'pair',
  'main',
  'copy',
]);
export type BackupOffsiteStep = z.infer<typeof BackupOffsiteStep>;

/**
 * How the copy is doing: `first` the first copy hasn't finished yet; `copying` a copy runs now; `ok` the newest backup
 * is in the copy; `behind` newer backups wait for the next copy; `failing` the last try failed.
 */
export const BackupOffsiteState = z.enum(['first', 'copying', 'ok', 'behind', 'failing']);
export type BackupOffsiteState = z.infer<typeof BackupOffsiteState>;

/** The backup service's document (`GET /v1/offsite`); never a secret, never a raw error. */
export const BackupOffsiteServiceDoc = z.object({
  kind: z.literal('whombat.backup-offsite/1'),
  configured: z.boolean(),
  state: z.enum(['none', 'first', 'copying', 'ok', 'behind', 'failing']),
  provider: z.string().max(16).optional(),
  display: AsciiText(300).optional(),
  repository: AsciiText(500).optional(),
  s3Region: AsciiText(64).optional(),
  configuredAt: Rfc3339.optional(),
  running: z.boolean(),
  lastCopy: z
    .object({
      at: Rfc3339,
      checkpointId: AsciiText(64).optional(),
      checkpointAt: Rfc3339.optional(),
      count,
    })
    .optional(),
  lastFailure: z.object({ at: Rfc3339, step: z.string().max(32), reason: z.string().max(500) }).optional(),
  failedAttempts: count,
  nextTryAt: Rfc3339.optional(),
  newestBackupAt: Rfc3339.optional(),
  backupsInCopy: count,
  lastClearedAt: Rfc3339.optional(),
});
export type BackupOffsiteServiceDoc = z.infer<typeof BackupOffsiteServiceDoc>;

/**
 * The second place as the app shows it. `display` is the place for people (the storage's host, the bucket and the
 * folder); `endpoint`, `bucket`, `folder` and `region` fill the form when the person changes it (the key never comes
 * back). `newestInCopyAt` is when the newest backup in the copy was made, `newestBackupAt` the newest at the main place.
 */
export const BackupOffsite = z.object({
  provider: BackupOffsiteProvider,
  display: z.string().max(300),
  endpoint: z.string().max(300),
  bucket: z.string().max(63),
  folder: z.string().max(300),
  region: z.string().max(64).nullable(),
  state: BackupOffsiteState,
  configuredAt: Timestamp,
  lastCopyAt: Timestamp.nullable(),
  newestInCopyAt: Timestamp.nullable(),
  newestBackupAt: Timestamp.nullable(),
  backupsInCopy: count,
  failedAttempts: count,
  /** The last try that failed, while the copy is failing. */
  lastFailure: z.object({ at: Timestamp, step: BackupOffsiteStep }).nullable(),
  /** When a copy is tried again after a failure. */
  nextTryAt: Timestamp.nullable(),
  /** When old backups were last cleared in the copy (by the same keep windows as the main place). */
  lastClearedAt: Timestamp.nullable(),
});
export type BackupOffsite = z.infer<typeof BackupOffsite>;

/** `backup.offsite`: the second place, or null when there is none. */
export const BackupOffsiteInput = z.strictObject({});
export const BackupOffsiteOutput = z.object({ offsite: BackupOffsite.nullable() });
export type BackupOffsiteOutput = z.infer<typeof BackupOffsiteOutput>;

/** A bucket's name, as S3 storage takes it. */
const BucketName = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
/** A folder in the bucket: letters, digits, dots, dashes and underscores, with slashes between. */
const FolderName = z
  .string()
  .max(200)
  .regex(/^([A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*)?$/);

/**
 * `backup.setOffsite`: keep a copy in this bucket. The box checks it first (a small file written, read back and
 * deleted with the key) and says plainly which step failed (`offsite_failed` with the `step`). `endpoint` is the
 * storage's address (`s3.eu-central-003.backblazeb2.com`, `https://…`); Secret: never in a receipt.
 */
export const BackupSetOffsiteInput = z.strictObject({
  provider: BackupOffsiteProvider,
  endpoint: z.string().min(3).max(300),
  bucket: BucketName,
  folder: FolderName.optional(),
  accessKeyId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[\x21-\x7e]+$/),
  secretAccessKey: z
    .string()
    .min(1)
    .max(500)
    .regex(/^[\x21-\x7e]+$/),
  region: z
    .string()
    .max(64)
    .regex(/^([a-z0-9][a-z0-9-]*)?$/)
    .optional(),
});
export const BackupSetOffsiteOutput = BackupOffsiteOutput;

/** `backup.removeOffsite`: stop keeping a copy there (the copies already in the bucket stay: it is the person's). */
export const BackupRemoveOffsiteInput = z.strictObject({});
export const BackupRemoveOffsiteOutput = BackupOffsiteOutput;

/** `backup.copyOffsite`: copy the new backups there now. */
export const BackupCopyOffsiteInput = z.strictObject({});
export const BackupCopyOffsiteOutput = z.object({ queued: z.literal(true) });

/** The storage's name for people (brand names stay as they are in every language); null for any other S3 storage. */
export const OFFSITE_PROVIDER_NAMES: Readonly<Record<BackupOffsiteProvider, string | null>> = {
  b2: 'Backblaze B2',
  r2: 'Cloudflare R2',
  hetzner: 'Hetzner',
  aws: 'Amazon S3',
  s3: null,
};

/** Where the copy is, as people say it: the storage's name, or the bucket's for any other S3 storage. */
export function offsitePlaceName(offsite: Pick<BackupOffsite, 'provider' | 'bucket'>): string {
  return OFFSITE_PROVIDER_NAMES[offsite.provider] ?? offsite.bucket;
}
