/**
 * Backup options, the list of backups and bringing a Whombat back (Whombat docs/decisions/backup-options.md). The
 * backup service's own shapes (`/v1/policy`, `/v1/checkpoints`, `/v1/quarantine`) are defined in Go
 * (`appliance/backup/internal/api`) and mirrored here; the runtime parses every answer with these.
 */
import { z } from 'zod';
import {
  AsciiText,
  BackupReasonText,
  BackupRecoveryMaterial,
  BackupServiceStatus,
  LocalIdent,
  Rfc3339,
} from './backup.js';
import { BackupPlacesOutput } from './backup-places.js';
import { BackupStatus } from './enrollment.js';

const ascii = AsciiText;
const ident = LocalIdent;
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/* The policy (the backup service's `GET`/`PUT /v1/policy`) ------------------------------------------------------- */

/** How often the box backs up: once a night in the quiet hours, every 6 hours (03, 09, 15, 21 local) or every hour. */
export const BackupFrequency = z.enum(['nightly', '6h', 'hourly']);
export type BackupFrequency = z.infer<typeof BackupFrequency>;

/**
 * Which backups are kept, as restic's `--keep-within*` windows (never counts, which a backup dated in the future could
 * push real ones out of): every backup of the last `allDays`, one a day for `dailyDays`, one a week for `weeklyWeeks`,
 * one a month for `monthlyMonths`. Zero leaves a rule out.
 */
export const BackupKeep = z.strictObject({
  allDays: z.number().int().min(1).max(3650),
  dailyDays: z.number().int().min(0).max(3650),
  weeklyWeeks: z.number().int().min(0).max(520),
  monthlyMonths: z.number().int().min(0).max(240),
});
export type BackupKeep = z.infer<typeof BackupKeep>;

/** “Up to a year” (recommended): all of 2 days, one a day for 2 weeks, one a week for 2 months, one a month for a year. */
export const BACKUP_KEEP_YEAR: BackupKeep = { allDays: 2, dailyDays: 14, weeklyWeeks: 8, monthlyMonths: 12 };
/** “Everything for 90 days”: what places kept before there were options. */
export const BACKUP_KEEP_90_DAYS: BackupKeep = {
  allDays: 90,
  dailyDays: 0,
  weeklyWeeks: 0,
  monthlyMonths: 0,
};

/** The smallest space limit (1 GB): below it not even a first backup fits. */
export const BACKUP_LIMIT_MIN_BYTES = 1_000_000_000;

export const BackupPolicy = z.strictObject({
  v: z.literal(1),
  frequency: BackupFrequency,
  /** The person's time zone (IANA): “night” and 03:00 are theirs, not the box's UTC. */
  timeZone: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_+./-]+$/),
  keep: BackupKeep,
  /** At most this much on the place; null: no limit. Old backups are thinned first, never the last 7 days. */
  limitBytes: z.number().int().min(BACKUP_LIMIT_MIN_BYTES).max(Number.MAX_SAFE_INTEGER).nullable(),
  /** Restore one backup on the side every week to prove it works (the drill). */
  weeklyCheck: z.boolean(),
});
export type BackupPolicy = z.infer<typeof BackupPolicy>;

/** What a box without a policy file does (the recommended options). */
export const BACKUP_POLICY_DEFAULT: BackupPolicy = {
  v: 1,
  frequency: '6h',
  timeZone: 'UTC',
  keep: BACKUP_KEEP_YEAR,
  limitBytes: null,
  weeklyCheck: true,
};

/* The list (the backup service's `GET /v1/checkpoints`) ------------------------------------------------------- */

/** Why a backup was made, from its signed manifest. */
export const BackupReason = z.enum(['scheduled', 'manual', 'pre-migration', 'test', 'unknown']);
export type BackupReason = z.infer<typeof BackupReason>;

export const BackupCheckpoint = z.object({
  id: ident(),
  seq: count,
  snapshotId: ident(),
  createdAt: Rfc3339,
  reason: BackupReason,
  /** The release a pre-migration backup was made for (“Before the update to 0.198”). */
  releaseId: ascii(80).optional(),
  /** The runtime's version then, when the manifest names it. */
  version: ascii(80).optional(),
  schemaVersion: z.number().int().min(0).max(1_000_000),
  /** What it holds (database dump and files), from the manifest. */
  bytes: count,
  /** What it added to the repository; null when restic didn't record it. */
  bytesAdded: count.nullable(),
  /** The box that made it; `own` false for an earlier Whombat's (after a restore, or one being brought back). */
  applianceId: ident(),
  own: z.boolean(),
  /** The last restore check of this backup, if any. */
  check: z.object({ at: Rfc3339, ok: z.boolean() }).nullable(),
  /**
   * What it holds, from its signed manifest (Whombat backup-options.md CT-1698): the coverage classes this backup covers
   * (`BackupScope` ids; one a newer service adds is left for the app to skip), for “What’s in it”. Ids only, so a page
   * stays one session message. Absent from a backup service that doesn't list it yet.
   */
  covered: z.array(ident(32)).max(32).optional(),
  /**
   * Set for a backup made with a gap and uploaded anyway: the attachments that weren't on the box any more, whether the
   * servers are missing (appliance `listing.Incomplete`). Absent when it is whole, and from older services.
   */
  incomplete: z
    .object({
      attachments: count.optional(),
      servers: z.boolean().optional(),
    })
    .optional(),
});
export type BackupCheckpoint = z.infer<typeof BackupCheckpoint>;

/** Backups still in the box's own `local` repository while the destination is elsewhere (made before a place). */
export const BackupLocalLeftover = z.object({
  count,
  bytes: count,
  oldest: Rfc3339.nullable(),
  newest: Rfc3339.nullable(),
});
export type BackupLocalLeftover = z.infer<typeof BackupLocalLeftover>;

export const BackupCheckpointList = z.object({
  /** Newest first. */
  checkpoints: z.array(BackupCheckpoint).max(5000),
  /** Snapshots whose manifest didn't verify; never listed, only counted. */
  unauthentic: count,
  local: BackupLocalLeftover.nullable(),
});
export type BackupCheckpointList = z.infer<typeof BackupCheckpointList>;

/* Bringing a Whombat back (the backup service's `/v1/adopt` and `/v1/quarantine`) ------------------------------- */

/** The person's three answers and the rest of the restore's checklist (appliance BK-13). */
export const BackupRestoreItem = z.object({
  id: ident(),
  required: z.boolean(),
  resolution: ident().nullable(),
});

/**
 * Where a restore is: `none` (no restore on this box), `restoring` (the backup is being checked and put back; the
 * runtime is stopped for most of it), `checking` (back, waiting for the person's answers; nothing runs on its own),
 * `failed` (it was refused, or stopped part-way and this Whombat was put back as it was; the backup is untouched, and
 * it can be tried again), `released` (done).
 */
export const BackupRestorePhase = z.enum(['none', 'restoring', 'checking', 'failed', 'released']);
export type BackupRestorePhase = z.infer<typeof BackupRestorePhase>;

/**
 * Why a restore failed (the backup service's `restore-result.json` `reason`): refused before anything moved
 * (`no_place`, `unreachable`, `not_found`, `newer`, `no_space`, `busy`), or stopped and put back (`interrupted`: the box
 * restarted before it finished, a power cut; `migration`; `failed`). An open set: apps show `error`, never a reason's
 * name, and never the service's technical `detail`, which stays on the box.
 */
export const BackupRestoreReason = ident(32);
export const BACKUP_RESTORE_INTERRUPTED = 'interrupted';

export const BackupRestoreState = z.object({
  phase: BackupRestorePhase,
  /** While restoring: the step (`prepare`, `check`, `restore`, `database`, `release`, `start`). */
  stage: ident(32).nullable(),
  since: Rfc3339.nullable(),
  /** One sentence when it failed (any script on one line, CT-1696). */
  error: BackupReasonText.nullable(),
  /** Why it failed, when the service says (absent from older services and Whombats). */
  reason: BackupRestoreReason.nullable().optional(),
  restored: z
    .object({
      checkpointId: ident(),
      createdAt: Rfc3339,
      schemaVersion: z.number().int().min(0).max(1_000_000),
    })
    .nullable(),
  /** The Whombat it came from. */
  oldApplianceId: ident().nullable(),
  /** The sign-ins that may need signing in again (`<account>/<provider>`). */
  relogin: z.array(ascii(200)).max(200),
  /** Whether the servers come back with it. */
  servers: z.enum(['staged', 'no-hosts-service']).nullable(),
  items: z.array(BackupRestoreItem).max(32),
  /**
   * Who can give the backups a new password if the old Whombat was lost or stolen: `whombat` on a place it set
   * up, `you` on one set up by hand or typed in (a disk, a bucket, a REST server: Whombat can't change that password),
   * with the place's name. Null when there are no backups to protect; absent from older Whombats.
   */
  newPassword: z
    .object({ by: z.enum(['whombat', 'you']), place: z.string().max(200).nullable() })
    .nullable()
    .optional(),
});
export type BackupRestoreState = z.infer<typeof BackupRestoreState>;

/* Session ops ------------------------------------------------------------------------------------------------- */

/**
 * How many backups one page holds unless the caller asks for fewer or more: about 25 KB, so a page (and the overview
 * around its first page) stays one session message.
 */
export const BACKUP_PAGE_DEFAULT = 50;
export const BACKUP_PAGE_MAX = 500;
/** The page an app reads the rest of a list in: the most that still fits one session message (64 KiB). */
export const BACKUP_LIST_PAGE = 150;

/** Where a page ends: an opaque cursor the next call passes back (the last backup's time and id). */
export const BackupCursor = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_.:+-]+$/);

/**
 * One page of the list, newest first (CT-1690): a repository nobody clears can hold thousands of backups, more than
 * one answer should carry to a phone. Without `cursor` the first page; `limit` up to `BACKUP_PAGE_MAX`.
 */
export const BackupCheckpointsInput = z.strictObject({
  cursor: BackupCursor.optional(),
  limit: z.number().int().min(1).max(BACKUP_PAGE_MAX).optional(),
});
export type BackupCheckpointsInput = z.infer<typeof BackupCheckpointsInput>;
export const BackupCheckpointsOutput = BackupCheckpointList.extend({
  /** This page, newest first. */
  checkpoints: z.array(BackupCheckpoint).max(BACKUP_PAGE_MAX),
  /** Space on the place in use, when it reports it (a backup place). */
  space: z.object({ usedBytes: count.nullable(), freeBytes: count.nullable() }).nullable(),
  /** Every backup in the list (absent from a Whombat from before pages: then the page is the whole list). */
  total: count.optional(),
  /** The next page's cursor; null or absent on the last page (absent from a Whombat from before pages). */
  nextCursor: BackupCursor.nullable().optional(),
});
export type BackupCheckpointsOutput = z.infer<typeof BackupCheckpointsOutput>;

export const BackupPolicyInput = z.strictObject({});
export const BackupPolicyOutput = z.object({
  policy: BackupPolicy,
  /**
   * Who clears old backups: `place` (the backup place's cleanup), `box` (the box, for a destination its key may delete
   * from), `none` (an append-only destination nobody clears; the person's own storage keeps them).
   */
  clearedBy: z.enum(['place', 'box', 'none']),
});
export type BackupPolicyOutput = z.infer<typeof BackupPolicyOutput>;

/** Sets every option at once (the dialog's Save); the time zone is the box's own when absent. */
export const BackupSetPolicyInput = z.strictObject({
  frequency: BackupFrequency,
  keep: BackupKeep,
  limitBytes: z.number().int().min(BACKUP_LIMIT_MIN_BYTES).max(Number.MAX_SAFE_INTEGER).nullable(),
  weeklyCheck: z.boolean(),
});
export type BackupSetPolicyInput = z.infer<typeof BackupSetPolicyInput>;
export const BackupSetPolicyOutput = BackupPolicyOutput;

/** “Check this backup now”: restores it on the side; the result shows on the backup and in the status. */
export const BackupCheckInput = z.strictObject({ checkpointId: ident() });
export const BackupCheckOutput = z.object({ queued: z.literal(true) });

/** Copies the backups left on the box's own disk to the place in use, then removes them from the box. */
export const BackupMoveLocalInput = z.strictObject({});
export const BackupMoveLocalOutput = z.object({ copied: count });
/** Removes the backups left on the box's own disk without copying them. */
export const BackupRemoveLocalInput = z.strictObject({});
export const BackupRemoveLocalOutput = z.object({ ok: z.literal(true) });

/**
 * On a new Whombat: join an earlier one's backups with its recovery kit. `kit` is the kit as saved (the text file, or
 * its backup section's JSON line). Secret: never in a receipt.
 */
export const BackupAdoptInput = z.strictObject({
  kit: z.string().min(1).max(65_536),
  /**
   * The person confirmed that this Whombat's own backups give way to the earlier one's (CT-1693): bringing a Whombat
   * back later, on a box that backed itself up already. Without it such a box answers `backup_has_own`.
   */
  replace: z.boolean().optional(),
});
export const BackupAdoptOutput = z.object({
  oldApplianceId: ident(),
  /**
   * Where the backups were found: the kit's main place, or its second place (the copy somewhere else, Whombat
   * offsite-copy.md) when the main place didn't answer. Absent from an older Whombat (the main place).
   */
  from: z.enum(['main', 'offsite']).optional(),
  /** The first page of the earlier Whombat's backups (CT-1690); `backup.checkpoints` with `nextCursor` reads on. */
  checkpoints: z.array(BackupCheckpoint).max(5000),
  total: count.optional(),
  nextCursor: BackupCursor.nullable().optional(),
});
export type BackupAdoptOutput = z.infer<typeof BackupAdoptOutput>;

/** Bring the chosen backup back on this Whombat (what this one holds now is set aside, not deleted). */
export const BackupRestoreInput = z.strictObject({ checkpointId: ident() });
export const BackupRestoreOutput = z.object({ started: z.literal(true) });

export const BackupRestoreStateInput = z.strictObject({});
export const BackupRestoreStateOutput = BackupRestoreState;

/**
 * The person's one answer after a restore (CT-1692): the old Whombat is `gone` (broken or wiped) or `lost` (lost or
 * stolen: Whombat gives the place a new password, so the old box can't add backups any more). The rest of the
 * checklist resolves itself: sign-ins that need it become the usual “sign in again” items, devices are on the Devices
 * page. Doing it again carries on where it stopped (a restart that didn't happen is asked for again).
 * `signInsChecked` and `devicesReviewed` are what apps before it sent; accepted and ignored until the next major.
 */
export const BackupFinishRestoreInput = z.strictObject({
  oldWhombat: z.enum(['gone', 'lost']),
  signInsChecked: z.literal(true).optional(),
  devicesReviewed: z.literal(true).optional(),
});
export const BackupFinishRestoreOutput = BackupRestoreState;

/**
 * “Let {assistant} set it up” on the claim's Protect step is the person's yes to backups (CT-1694): Whombat keeps it,
 * and once the AI is connected the assistant sets up the place the person saw (or the best one then) and says so in
 * one sentence; the Inbox asks only when that didn't work. `placeId`: the place on the step, when one was shown.
 */
export const BackupLetAssistantSetUpInput = z.strictObject({
  placeId: z.string().min(3).max(300).optional(),
});
export const BackupLetAssistantSetUpOutput = z.object({ ok: z.literal(true) });

/**
 * The Backups page in one answer (CT-1691): the service's status and summary, the places, the first page of backups
 * with the space on the place, and the options. A part that couldn't be read is null and `notice` says why in plain
 * words (the backup service isn't answering); the rest still shows.
 */
export const BackupOverviewInput = z.strictObject({});
export const BackupOverviewOutput = z.object({
  /** The service's document; null when it didn't answer. */
  status: BackupServiceStatus.nullable(),
  summary: BackupStatus,
  places: BackupPlacesOutput.nullable(),
  checkpoints: BackupCheckpointsOutput.nullable(),
  policy: BackupPolicyOutput.nullable(),
  /** One plain sentence when part of it couldn't be read (“The backup service isn’t answering right now…”). */
  notice: z.string().max(300).nullable(),
  /**
   * The places that kept this Whombat's backups before the one they go to now: the backups made there stay there and
   * aren't in the list, newest place first. Empty when there are none, or when Whombat can't tell where backups go now.
   * Within minor 7: a box that doesn't say it answers as if there were none.
   */
  earlierPlaces: z
    .array(z.object({ placeId: z.string().min(3).max(300), name: z.string().min(1).max(200) }))
    .max(20)
    .default([]),
});
export type BackupOverviewOutput = z.infer<typeof BackupOverviewOutput>;
export type BackupEarlierPlace = BackupOverviewOutput['earlierPlaces'][number];

/** The kit's backup section, from a kit file's text or the bare JSON line (the client and the server both read it). */
export function kitMaterialOf(kit: string): z.infer<typeof BackupRecoveryMaterial> | null {
  const lines = kit.split(/\r?\n/).map((l) => l.trim());
  for (const line of lines) {
    if (!line.startsWith('{') || !line.includes('"repositoryPassword"')) continue;
    try {
      const parsed = BackupRecoveryMaterial.safeParse(JSON.parse(line));
      if (parsed.success) return parsed.data;
    } catch {
      // not this line
    }
  }
  return null;
}
