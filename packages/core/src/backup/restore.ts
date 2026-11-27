/**
 * What a restore would do and what it did (contracts 0.79, CT-335; Whombat backup-file.md BF-04, BF-07, BF-08): the
 * preview `backups.inspect` answers (per category New / Already here / Different), the choice for “Different”, the
 * summary a finished restore keeps, and the words for each.
 *
 * A restore only adds or updates; it never deletes (BF-04). “Already here”: the target has the thing and it is the same.
 * “Different”: it has it and something differs; the restore keeps the target's (`keep`, the default) or takes the
 * file's (`replace`) for all of them at once.
 */
import { z } from 'zod';
import { Count, Timestamp } from '../domain/common.js';
import { coreWords, isEnglishLocale, tCore, tpCore } from '../i18n/catalog.js';
import { formatLocaleNumber } from '../i18n/format.js';
import { ConnectionId } from '../ids.js';
import { formatDate } from '../text/time.js';
import { BACKUP_CATEGORY_IDS, BackupCategoryId } from './categories.js';
import { BackupFileManifest } from './manifest.js';
import { BackupNote, backupNoteText, joinAnd } from './notes.js';

/** A count as the restore says it: English keeps its thousands commas, other languages their own separators. */
function num(v: number, locale?: string | null): string {
  return isEnglishLocale(locale) ? v.toLocaleString('en-US') : formatLocaleNumber(v, locale);
}

/** A formatter passed straight to `Array.map` receives an index as its locale; anything but a tag means English. */
const tagOf = (locale: unknown): string | null => (typeof locale === 'string' ? locale : null);

/** “When something is different”: keep what's here (default) or use the backup. */
export const BACKUP_ON_DIFFERENT = ['keep', 'replace'] as const;
export const BackupOnDifferent = z.enum(BACKUP_ON_DIFFERENT);
export type BackupOnDifferent = z.infer<typeof BackupOnDifferent>;
/** `BACKUP_ON_DIFFERENT_LABELS` in a locale. */
export function backupOnDifferentLabels(locale?: string | null): Readonly<Record<BackupOnDifferent, string>> {
  return coreWords(locale, 'restore.onDifferent', BACKUP_ON_DIFFERENT);
}

export const BACKUP_ON_DIFFERENT_LABELS: Readonly<Record<BackupOnDifferent, string>> =
  backupOnDifferentLabels('en');

/**
 * One category of the file in the restore preview. `count`: things in the file (`BACKUP_COUNTED_TYPES`); `new`, `here`
 * (already here, the same) and `different` add up to it.
 */
export const BackupRestoreCategoryPreview = z.object({
  id: BackupCategoryId,
  count: Count,
  new: Count,
  here: Count,
  different: Count,
  notes: z.array(BackupNote).max(20).default([]),
});
export type BackupRestoreCategoryPreview = z.infer<typeof BackupRestoreCategoryPreview>;
export type BackupRestoreCategoryPreviewInput = z.input<typeof BackupRestoreCategoryPreview>;

/** A chip under a category in the restore panel. `warn`: the “different” one (amber in the mock). */
export interface BackupRestoreChip {
  label: string;
  tone: 'neutral' | 'warn';
}

/**
 * The chips under a category: “130 new”, “12 already here”, “3 different” (zeros left out). Nothing at all: “Nothing to
 * bring back”.
 */
export function backupRestoreChips(
  p: BackupRestoreCategoryPreviewInput,
  locale?: string | null,
): BackupRestoreChip[] {
  const tag = tagOf(locale);
  const chips: BackupRestoreChip[] = [];
  if (p.new > 0)
    chips.push({ label: tCore(tag, 'restore.chip.new', { count: num(p.new, tag) }), tone: 'neutral' });
  if (p.here > 0)
    chips.push({ label: tCore(tag, 'restore.chip.here', { count: num(p.here, tag) }), tone: 'neutral' });
  if (p.different > 0)
    chips.push({
      label: tCore(tag, 'restore.chip.different', { count: num(p.different, tag) }),
      tone: 'warn',
    });
  if (chips.length === 0) chips.push({ label: tCore(tag, 'restore.chip.nothing'), tone: 'neutral' });
  return chips;
}

/** The fixed line under a category in the restore panel (BF-06, BF-07), or null. */
export function backupRestoreHint(id: BackupCategoryId, locale?: string | null): string | null {
  if (id === 'automations') return tCore(tagOf(locale), 'restore.hint.automations');
  if (id === 'connections') return tCore(tagOf(locale), 'restore.hint.connections');
  return null;
}

/** Most connections the summary names (the rest are counted). */
export const BACKUP_SUMMARY_NAMES_MAX = 200;
/** Most servers the summary lists to point by hand. */
const BACKUP_SUMMARY_NAMES_MAX_SERVERS = 200;

/* Servers (0.117, CT-906…CT-908; Whombat backup-file.md BF-14, BF-15) ------------------------------------------ */

/**
 * Whether the file's servers can come back here (BF-14): `new` (another certificate authority, and this Whombat watches
 * no servers yet: the hosts service takes the file's backup and restarts), `here` (the same certificate authority:
 * nothing is imported, the choices per server follow keep/replace), `blocked` (another one, and this Whombat already
 * watches servers: `blockedBy` of them), `unavailable` (this Whombat has no hosts service).
 */
export const BACKUP_SERVERS_STATES = ['new', 'here', 'blocked', 'unavailable'] as const;
export const BackupServersState = z.enum(BACKUP_SERVERS_STATES);
export type BackupServersState = z.infer<typeof BackupServersState>;

/** An address as people read it (`10.100.1.160`, `whombat.lan:9443`; `hostsAgentAddress`). */
const DisplayAddress = z.string().min(1).max(300);

/**
 * The address question (BF-15): the address the file's servers look for their Whombat at (`from`) and this Whombat's
 * (`to`), when they differ.
 */
export const BackupServersAddress = z.object({ from: DisplayAddress, to: DisplayAddress });
export type BackupServersAddress = z.infer<typeof BackupServersAddress>;

/**
 * The servers of the file in the restore preview (BF-14, BF-15): `count` the servers in the file, `state`, `blockedBy`
 * the servers this Whombat watches (`blocked` only, else null), `address` the question (null when the addresses are the
 * same, or the servers can't come back).
 */
export const BackupServersPreview = z.object({
  state: BackupServersState,
  count: Count,
  blockedBy: Count.nullable().default(null),
  address: BackupServersAddress.nullable().default(null),
});
export type BackupServersPreview = z.infer<typeof BackupServersPreview>;
export type BackupServersPreviewInput = z.input<typeof BackupServersPreview>;

/** The servers row's label by state (the restore panel's chip). */
export function backupServersStateLabels(
  locale?: string | null,
): Readonly<Record<BackupServersState, string>> {
  return coreWords(locale, 'restore.servers.state', BACKUP_SERVERS_STATES);
}

export const BACKUP_SERVERS_STATE_LABELS: Readonly<Record<BackupServersState, string>> =
  backupServersStateLabels('en');

/**
 * The sentence under the servers row (BF-14), or null: “This Whombat already watches 3 servers, so the 5 in the file
 * stay with the Whombat they report to.”
 */
export function backupServersStateText(p: BackupServersPreviewInput, locale?: string | null): string | null {
  const tag = tagOf(locale);
  const stay = tpCore(tag, 'restore.servers.stay', p.count, { count: num(p.count, tag) });
  switch (p.state) {
    case 'new':
      return null;
    case 'here':
      return tpCore(tag, 'restore.servers.here', p.count);
    case 'blocked': {
      const n = p.blockedBy ?? 0;
      return tpCore(tag, 'restore.servers.blocked', n, { count: num(n, tag), stay });
    }
    case 'unavailable':
      return tCore(tag, 'restore.servers.unavailable', { stay });
  }
}

/** The address question (BF-15): “Your servers look for your Whombat at 10.100.1.160. This Whombat is at 10.100.1.158.” */
export function backupServersAddressText(a: BackupServersAddress, locale?: string | null): string {
  return tCore(tagOf(locale), 'restore.servers.address', { from: a.from, to: a.to });
}

/** The restore body's answer to the address question (BF-15). Absent: point them here when there is a question. */
export const BackupServersChoice = z.strictObject({ pointHere: z.boolean() });
export type BackupServersChoice = z.infer<typeof BackupServersChoice>;

/** A server the restore couldn't point here (no Vault SSH key for it, or the sign-in failed): Add a server, filled in. */
export const BackupServerToPoint = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  address: z.string().min(1).max(300).nullable().default(null),
});
export type BackupServerToPoint = z.infer<typeof BackupServerToPoint>;

/**
 * What a restore did with the servers (BF-14, BF-15): `back` servers brought back, `pointed` of them pointed here, the
 * others still looking for the old address (`toPoint`; “Point it here” opens Add a server filled in).
 */
export const BackupServersSummary = z.object({
  back: Count,
  pointed: Count.default(0),
  toPoint: z.array(BackupServerToPoint).max(BACKUP_SUMMARY_NAMES_MAX_SERVERS).default([]),
});
export type BackupServersSummary = z.infer<typeof BackupServersSummary>;
export type BackupServersSummaryInput = z.input<typeof BackupServersSummary>;

/** The servers' lines of a finished restore: “Pointed 3 servers here.”, “blackbox still looks for your old Whombat. …” */
export function backupServersSummaryLines(s: BackupServersSummaryInput, locale?: string | null): string[] {
  const tag = tagOf(locale);
  const lines: string[] = [];
  const pointed = s.pointed ?? 0;
  if (pointed > 0) lines.push(tpCore(tag, 'restore.servers.pointed', pointed, { count: num(pointed, tag) }));
  const left = s.toPoint ?? [];
  if (left.length === 1) lines.push(tCore(tag, 'restore.servers.leftOne', { name: `${left[0]?.name}` }));
  else if (left.length > 1 && left.length <= 3)
    lines.push(
      tCore(tag, 'restore.servers.leftFew', {
        names: joinAnd(
          left.map((x) => x.name),
          tag,
        ),
      }),
    );
  else if (left.length > 3)
    lines.push(tCore(tag, 'restore.servers.leftMany', { count: num(left.length, tag) }));
  return lines;
}

/**
 * What `backups.inspect` answers for a staged file and its password: the file's manifest (the maker's own words about
 * it; the restore card's “Made 11 Oct 2026 on Lumio BV · Whombat 0.83” is `backupMadeText(manifest)`), each category in
 * the file, in order, and notes about the whole file (the manifest's own notes among them). `sameBurrow`: it was made
 * from this burrow. `servers` (0.117): the file's servers, when it holds the category (null otherwise, and from older
 * servers).
 */
export const BackupRestorePreview = z.object({
  fileName: z.string().min(1).max(255),
  size: Count,
  manifest: BackupFileManifest,
  sameBurrow: z.boolean(),
  categories: z.array(BackupRestoreCategoryPreview).max(BACKUP_CATEGORY_IDS.length),
  notes: z.array(BackupNote).max(20).default([]),
  servers: BackupServersPreview.nullable().default(null),
});
export type BackupRestorePreview = z.infer<typeof BackupRestorePreview>;

/**
 * What one category of a finished restore did: `added` (new), `updated` (different, and the backup was used),
 * `unchanged` (already here), `kept` (different, and what's here was kept), `skipped` (couldn't be restored; see the
 * notes).
 */
export const BackupRestoreCategoryResult = z.object({
  id: BackupCategoryId,
  added: Count,
  updated: Count,
  unchanged: Count,
  kept: Count,
  skipped: Count,
});
export type BackupRestoreCategoryResult = z.infer<typeof BackupRestoreCategoryResult>;

/**
 * A finished restore (BF-08): what came back per category and what needs a person — connections whose check failed
 * (Settings → Connections → Needs you, “Sign in again”), automations switched off, schedules paused, servers to point
 * here by hand.
 */
export const BackupRestoreSummary = z.object({
  categories: z.array(BackupRestoreCategoryResult).max(BACKUP_CATEGORY_IDS.length),
  connectionsToSignIn: z
    .array(z.object({ id: ConnectionId, label: z.string().min(1).max(200) }))
    .max(BACKUP_SUMMARY_NAMES_MAX)
    .default([]),
  automationsOff: Count.default(0),
  schedulesPaused: Count.default(0),
  notes: z.array(BackupNote).max(40).default([]),
  /** The servers (0.117, CT-908): null when the restore had none to bring back, and in older summaries. */
  servers: BackupServersSummary.nullable().default(null),
  finishedAt: Timestamp,
});
export type BackupRestoreSummary = z.infer<typeof BackupRestoreSummary>;
export type BackupRestoreSummaryInput = z.input<typeof BackupRestoreSummary>;

/** “9 automations”, “1 Vault entry”. English by default: the signed restore event uses it too. */
export function backupCountText(id: BackupCategoryId, n: number, locale?: string | null): string {
  const tag = tagOf(locale);
  return tpCore(tag, `restore.count.${id}`, n, { count: num(n, tag) });
}

function cameBack(summary: Pick<BackupRestoreSummaryInput, 'categories'>) {
  return summary.categories
    .map((c) => ({ id: c.id, n: c.added + c.updated }))
    .filter((c) => c.n > 0)
    .sort((a, b) => BACKUP_CATEGORY_IDS.indexOf(a.id) - BACKUP_CATEGORY_IDS.indexOf(b.id));
}

/**
 * The finished restore in a few plain lines (the restore panel and the restorer's notice): what came back, then what
 * needs them.
 */
export function backupRestoreSummaryLines(
  summary: BackupRestoreSummaryInput,
  locale?: string | null,
): string[] {
  const tag = tagOf(locale);
  const lines: string[] = [];
  const back = cameBack(summary);
  lines.push(
    back.length === 0
      ? tCore(tag, 'restore.summary.allHere')
      : tCore(tag, 'restore.summary.back', {
          items: joinAnd(
            back.map((c) => backupCountText(c.id, c.n, tag)),
            tag,
          ),
        }),
  );
  const signIn = summary.connectionsToSignIn ?? [];
  if (signIn.length === 1)
    lines.push(tCore(tag, 'restore.summary.signInOne', { name: `${signIn[0]?.label}` }));
  else if (signIn.length > 1)
    lines.push(tCore(tag, 'restore.summary.signInMany', { count: num(signIn.length, tag) }));
  const off = summary.automationsOff ?? 0;
  if (off > 0) lines.push(tpCore(tag, 'restore.summary.automationsOff', off, { count: num(off, tag) }));
  const paused = summary.schedulesPaused ?? 0;
  if (paused > 0)
    lines.push(tpCore(tag, 'restore.summary.schedulesPaused', paused, { count: num(paused, tag) }));
  if (summary.servers) lines.push(...backupServersSummaryLines(summary.servers, tag));
  for (const note of summary.notes ?? []) lines.push(backupNoteText(note, tag));
  return lines;
}

/**
 * The restore's signed event text (BF-03): “Restored 9 automations from a backup made on 11 Oct”, up to three
 * categories and “and more”. The date is in the file's time zone (the year when it isn't `now`'s).
 */
export function backupRestoredText(
  summary: Pick<BackupRestoreSummaryInput, 'categories'>,
  manifest: Pick<BackupFileManifest, 'createdAt' | 'timeZone'>,
  now: string | Date,
): string {
  const back = cameBack(summary);
  const made = formatDate(manifest.createdAt, manifest.timeZone, { year: 'auto', now });
  if (back.length === 0) return `Restored a backup made on ${made}; everything was already here`;
  const parts = back.slice(0, 3).map((c) => backupCountText(c.id, c.n));
  const what = back.length > 3 ? `${parts.join(', ')} and more` : joinAnd(parts);
  return `Restored ${what} from a backup made on ${made}`;
}
