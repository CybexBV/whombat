/**
 * The copy somewhere else as the web and the phone show it (Whombat docs/decisions/offsite-copy.md): the Backups card's
 * line for it, the section's rows, the form's storages with their example addresses, and what a failed check says.
 * Pure and shared, so both apps say the same; the copy comes from the backup summary's `offsite` (a box from before
 * doesn't name one, and nothing is shown).
 */

import { interpolate } from '@whombat/core/i18n';
import {
  type BackupOffsite,
  type BackupOffsiteProvider,
  BackupOffsiteStep,
  type BackupSetOffsiteInput,
  offsitePlaceName,
} from '@whombat/protocol/session';
import type { z } from 'zod';
import { clientTree } from '../i18n/catalog';
import { BACKUP_OFFSITE_WORDS } from '../i18n/messages/backupOffsite';
import { OperationError } from '../session/managed-ops';
import { DeadlineExceededError } from '../session/types';
import { backupErrorText } from './backup-setup';
import { ago } from './status-copy';

/** The section's words in a language. */
export function offsiteText(locale?: string | null) {
  return clientTree(locale, BACKUP_OFFSITE_WORDS);
}

/** Where the copy is, as people say it (“Backblaze B2”, or the bucket's name for any other S3 storage). */
export const offsitePlace = offsitePlaceName;

/** The copy's line on the Backups card, with its dot: green when it is up to date, amber while it fails. */
export interface OffsiteLine {
  text: string;
  dot: 'ok' | 'warn' | 'mut';
}

export function offsiteLine(offsite: BackupOffsite, locale?: string | null): OffsiteLine {
  const L = offsiteText(locale).line;
  const place = offsitePlace(offsite);
  const when = offsite.lastCopyAt ? ago(offsite.lastCopyAt, locale) : null;
  switch (offsite.state) {
    case 'failing':
      return { text: interpolate(L.failing, { place }), dot: 'warn' };
    case 'copying':
      return { text: interpolate(L.copying, { place }), dot: 'mut' };
    case 'first':
      return { text: interpolate(L.first, { place }), dot: 'mut' };
    case 'behind':
      return when
        ? { text: interpolate(L.behind, { place, when }), dot: 'ok' }
        : { text: interpolate(L.first, { place }), dot: 'mut' };
    default:
      return when
        ? { text: interpolate(L.ok, { place, when }), dot: 'ok' }
        : { text: interpolate(L.first, { place }), dot: 'mut' };
  }
}

/** “09:30”, local. */
function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** One row of the section: a label and its value. */
export interface OffsiteRow {
  label: string;
  value: string;
}

/** The section's view of a copy that is set up. */
export interface OffsiteView {
  line: OffsiteLine;
  /** The storage's name and the bucket (and folder) on it. */
  rows: OffsiteRow[];
  /** What went wrong, in plain words, and when Whombat tries again; null while it works. */
  problem: string | null;
  /** “Copy now” is offered (not while a copy runs). */
  canCopy: boolean;
}

export function offsiteView(offsite: BackupOffsite, locale?: string | null): OffsiteView {
  const T = offsiteText(locale);
  const where = [offsitePlace(offsite), [offsite.bucket, offsite.folder].filter(Boolean).join('/')]
    .filter((part, i, all) => part && all.indexOf(part) === i)
    .join(' · ');
  const rows: OffsiteRow[] = [
    { label: T.rows.where, value: where },
    { label: T.rows.lastCopy, value: offsite.lastCopyAt ? ago(offsite.lastCopyAt, locale) : T.notYet },
  ];
  if (offsite.newestInCopyAt) rows.push({ label: T.rows.newest, value: ago(offsite.newestInCopyAt, locale) });
  if (offsite.backupsInCopy > 0) rows.push({ label: T.rows.count, value: T.count(offsite.backupsInCopy) });
  const failing = offsite.state === 'failing' && offsite.lastFailure;
  const problem = failing
    ? [
        T.steps[offsite.lastFailure?.step ?? 'copy'],
        offsite.nextTryAt ? interpolate(T.nextTry, { time: clock(offsite.nextTryAt) }) : null,
      ]
        .filter(Boolean)
        .join(' ')
    : null;
  return { line: offsiteLine(offsite, locale), rows, problem, canCopy: offsite.state !== 'copying' };
}

/** What the form fills in for each storage: an example address and whether it asks for a region. */
export interface OffsitePreset {
  provider: BackupOffsiteProvider;
  /** The example in the address field (the person's own is on their storage's page). */
  endpoint: string;
  /** The example in the region field; null when the storage doesn't ask for one. */
  region: string | null;
}

/** The storages in the form, in its order: the three the brief names first, then any S3 storage. */
export const OFFSITE_PRESETS: readonly OffsitePreset[] = [
  { provider: 'b2', endpoint: 's3.eu-central-003.backblazeb2.com', region: null },
  { provider: 'r2', endpoint: '<account-id>.eu.r2.cloudflarestorage.com', region: null },
  { provider: 'hetzner', endpoint: 'fsn1.your-objectstorage.com', region: null },
  { provider: 'aws', endpoint: 's3.eu-central-1.amazonaws.com', region: 'eu-central-1' },
  { provider: 's3', endpoint: 's3.example.com', region: 'us-east-1' },
];

export function offsitePreset(provider: BackupOffsiteProvider): OffsitePreset {
  return OFFSITE_PRESETS.find((p) => p.provider === provider) ?? (OFFSITE_PRESETS.at(-1) as OffsitePreset);
}

/** The form as the person typed it. */
export interface OffsiteForm {
  provider: BackupOffsiteProvider;
  endpoint: string;
  bucket: string;
  folder: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

/** The form for a new copy, or for changing the one there is (its key is typed again: it never comes back). */
export function offsiteFormFrom(offsite: BackupOffsite | null | undefined): OffsiteForm {
  return {
    provider: offsite?.provider ?? 'b2',
    endpoint: offsite?.endpoint ?? '',
    bucket: offsite?.bucket ?? '',
    folder: offsite?.folder ?? '',
    accessKeyId: '',
    secretAccessKey: '',
    region: offsite?.region ?? '',
  };
}

/**
 * The op's input from the form, or null while something it needs is empty. A bucket's address pasted whole
 * (`https://host/bucket/folder`) is split into its parts, the way the storages' pages show it.
 */
export function offsiteInput(form: OffsiteForm): z.input<typeof BackupSetOffsiteInput> | null {
  let endpoint = form.endpoint.trim();
  let bucket = form.bucket.trim();
  let folder = form.folder.trim().replace(/^\/+|\/+$/g, '');
  const pasted = /^(https?:\/\/)?([^/\s]+)\/([^/\s]+)(\/(\S*))?$/i.exec(endpoint);
  if (pasted && !bucket) {
    endpoint = `${pasted[1] ?? ''}${pasted[2]}`;
    bucket = pasted[3] ?? '';
    if (!folder) folder = (pasted[5] ?? '').replace(/\/+$/, '');
  }
  endpoint = endpoint.replace(/\/+$/, '');
  const accessKeyId = form.accessKeyId.trim();
  const secretAccessKey = form.secretAccessKey.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  const region = form.region.trim().toLowerCase();
  return {
    provider: form.provider,
    endpoint,
    bucket: bucket.toLowerCase(),
    ...(folder ? { folder } : {}),
    accessKeyId,
    secretAccessKey,
    ...(region ? { region } : {}),
  };
}

/** What a failed check or change says: the step that failed in the person's language, else the app's words. */
export function offsiteErrorText(error: unknown, locale?: string | null): string {
  const T = offsiteText(locale);
  if (error instanceof DeadlineExceededError) return T.steps.reach;
  if (error instanceof OperationError) {
    const step = BackupOffsiteStep.safeParse((error.details as { step?: unknown } | null | undefined)?.step);
    if (step.success) return T.steps[step.data];
    if (error.code === 'validation_failed') return T.form.missing;
    const sentence = error.message.trim();
    if ((error.code === 'conflict' || error.code === 'bad_request') && sentence && sentence !== 'Failed.')
      return sentence;
  }
  return backupErrorText(error, locale) || T.form.failed;
}
