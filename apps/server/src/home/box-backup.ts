/**
 * This Whombat's own backups in the Inbox (Whombat first-day.md FDY-21, backup-places.md BPL-07, backup-options.md),
 * one item at a time (`boxBackupNeedsYou` says which comes first):
 *
 * - **Not backed up well.** While nothing backs it up, or only its own disk does, ONE item holds the assistant's
 *   proposal of where — the best backup place — instead of a settings sentence: “Back up this Whombat to BlackBox?”
 *   with *Yes, do it* (the person's yes goes to the assistant, which sets it up with `whombat_backup`), *See other
 *   places* (This Whombat's backups) and Ignore. Held back while the claim's “Let {assistant} set it up” waits for the
 *   assistant: it asks only when that didn't work.
 *   - **Where.** A place that is ready (a NAS or a server named like storage first, then the one with most free
 *     space), then a NAS the network scan found that isn't connected yet; nothing: a USB disk named WHOMBAT-BACKUP.
 *     Never the server this Whombat runs on.
 *   - **When.** Only on a box with a backup service whose status says no destination is set, or that it backs up only
 *     to its own disk (an unknown status asks nothing), for its people; gone as soon as one is set elsewhere.
 * - **Failing or late.** Backups that keep failing (for 45 minutes: the service tries again after 15, so one blip never
 *   shows) or that are late: a problem only the person decides about, which the assistant can look into (*Ask
 *   {assistant} to fix it*). It starts on — a backup not happening is in the calm rule's very important list — and
 *   settles by itself once a backup works again; a new episode is a new item.
 * - **A restore waiting for its answer.** After a bring back the box waits, quarantined, for the person's one answer;
 *   an app closed meanwhile finds it here (*Finish*).
 * - **A bring back that stopped.** The box restarted before a restore finished and was put back as it was: *Try again*.
 * - **A password only the person can change.** After a “lost or stolen” bring back onto a place Whombat can't give a
 *   new password (set up by hand, or typed in), the old box could keep adding backups: *Change the backup password on
 *   BlackBox*, until the person sets a destination again.
 * - **The passkey's ask** (backup-passkey.md), added by its part, last.
 */

import type { BackupServiceStatus } from '@whombat/control-contracts/local';
import { type BackupPlace, bestBackupPlace, type NeedsYouItem } from '@whombat/core';
import { BACKUP_RESTORE_INTERRUPTED, type BackupRestoreState } from '@whombat/protocol/session';
import { and, eq, gt, isNotNull } from 'drizzle-orm';
import { loadBoxBackupNotes } from '../backup-places/notes';
import { placesNow } from '../backup-places/places';
import { applianceEvents } from '../db/schema/index';
import { isEnglish, type ServerMessageKey, tServer } from '../i18n/catalog';
import { localizePhrase } from '../i18n/phrases';
import { backupFailingSince, boxBackupOf, boxBackupStatus } from '../managed/box-backup';
import { readRestoreState } from '../managed/restore-state';
import { loadPrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { checkStartsOn, registerChecks } from '../things/quiet/defaults';
import { registerNeedsYouSource, type SourceCtx, sourceLocale } from './registry';

export const BACKUP_REF = { kind: 'backup', id: 'this-whombat' } as const;
/** This Whombat's backups, where other places are set up by hand. */
export const BACKUPS_HREF = '/settings?tab=appliance&section=backups';
/** Where the app finishes bringing a Whombat back (the Backups page, which opens the last question). */
export const FINISH_RESTORE_HREF = '/settings?tab=appliance&section=backups&finish=restore';

/**
 * The checks behind the items (watch-defaults.md WD-01, WD-04). Both start on: a backup not happening is data at risk
 * that Whombat can look into, and a restore waiting is the box held back until the person answers.
 */
export const BOX_BACKUP_CHECKS = [
  { check: 'box.backup_late', startsOn: true },
  { check: 'box.restore_waiting', startsOn: true },
] as const;
registerChecks(BOX_BACKUP_CHECKS);

/** What the proposal names: a backup place, or a USB disk when there is none. */
export type ProposedPlace = Pick<BackupPlace, 'id' | 'name' | 'state' | 'address'> | null;

/** “the Synology at 192.168.1.40”: a NAS the scan found, as the proposal says it. */
function foundSaid(place: NonNullable<ProposedPlace>, locale?: string | null): string {
  return place.address
    ? tServer(locale, 'home.backup.foundAt', { name: place.name, address: place.address })
    : tServer(locale, 'home.backup.found', { name: place.name });
}

/** The words of the proposal (pure). `ownDisk`: backups go only to this Whombat's own disk now. */
export function backupProposal(
  place: ProposedPlace,
  ownDisk = false,
  locale?: string | null,
): { title: string; body: string; yes: string } {
  const t = (key: ServerMessageKey, vars?: Record<string, string>) => tServer(locale, key, vars);
  const intro = t(ownDisk ? 'home.backup.ownDisk' : 'home.backup.onlyHere');
  const title = (where: string) =>
    ownDisk ? t('home.backup.ownDiskTitle', { place: where }) : t('home.backup.toTitle', { place: where });
  if (place && place.state !== 'connect_first') {
    const name = place.name;
    return {
      title: title(name),
      body: t('home.backup.setUpOn', { intro, place: name }),
      yes: t('home.backup.yesTo', { place: name }),
    };
  }
  if (place) {
    const said = foundSaid(place, locale);
    return {
      title: title(said),
      body: t('home.backup.setUpThere', { intro }),
      yes: t('home.backup.yesTo', { place: said }),
    };
  }
  return {
    title: title(t('home.backup.usbDisk')),
    body: t('home.backup.usbBody', { intro }),
    yes: t('home.backup.yesUsb'),
  };
}

/** The one item (pure): the proposal, Yes, do it, See other places (Ignore is the list's own). */
export function backupProposalItem(
  place: ProposedPlace,
  at: string,
  ownDisk = false,
  locale?: string | null,
): NeedsYouItem {
  const words = backupProposal(place, ownDisk, locale);
  return {
    id: `${BACKUP_REF.kind}:${BACKUP_REF.id}`,
    ref: { ...BACKUP_REF },
    kind: 'backup',
    severity: 'warn',
    title: words.title.slice(0, 200),
    body: words.body,
    at,
    actions: [
      {
        id: 'yes',
        label: tServer(locale, 'home.action.yesDoIt'),
        style: 'primary',
        kind: 'ask',
        text: words.yes.slice(0, 500),
      },
      {
        id: 'places',
        label: tServer(locale, 'home.action.seeOtherPlaces'),
        style: 'secondary',
        kind: 'open',
        href: BACKUPS_HREF,
      },
    ],
    href: BACKUPS_HREF,
  };
}

/* Failing or late ------------------------------------------------------------------------------------------------- */

/** How long backups fail before the Inbox says so: the service tries again after 15 minutes. */
export const FAILING_FOR_MS = 45 * 60_000;

/** The failing-or-late item's words in a locale. */
export function lateText(locale?: string | null) {
  return {
    failingTitle: tServer(locale, 'home.backup.failingTitle'),
    failingBody: (reason: string | null) => {
      // The backup service says why in English: another language says it only when the phrasebook knows it.
      const said = reason && !isEnglish(locale) ? localizePhrase(reason, locale) : reason;
      const why =
        said && (isEnglish(locale) || said !== reason)
          ? `${said.replace(/[.\s]+$/, '')}.`
          : tServer(locale, 'home.backup.failingNone');
      return `${why} ${tServer(locale, 'home.backup.madeBefore')}`;
    },
    lateTitle: tServer(locale, 'home.backup.lateTitle'),
    lateBody: tServer(locale, 'home.backup.lateBody'),
    see: tServer(locale, 'home.action.seeBackups'),
  };
}

export const LATE_TEXT = lateText(null);

/**
 * The failing-or-late item (pure): `failing` once the service has said so for `FAILING_FOR_MS` (`failingSince`, when it
 * was first seen in this episode), `stale` at once; null otherwise. An episode is everything since the last backup that
 * worked, so the item's id changes with it and an Ignore lasts the episode.
 */
export function lateBackupItem(
  status: Pick<BackupServiceStatus, 'state' | 'destination' | 'lastSuccess' | 'lastFailure' | 'updatedAt'>,
  failingSince: number | null,
  now: Date,
  locale?: string | null,
): NeedsYouItem | null {
  if (!status.destination.configured || status.destination.kind === 'local') return null;
  const words = lateText(locale);
  const failing =
    status.state === 'failing' && failingSince !== null && now.getTime() - failingSince >= FAILING_FOR_MS;
  const late = status.state === 'stale';
  if (!failing && !late) return null;
  const episode = status.lastSuccess?.at ?? 'never';
  return {
    id: `backup:late:${episode}`.slice(0, 200),
    ref: { kind: 'backup', id: `late:${episode}`.slice(0, 200) },
    kind: 'alert',
    severity: failing ? 'bad' : 'warn',
    nature: 'you',
    fixable: true,
    title: failing ? words.failingTitle : words.lateTitle,
    body: (failing ? words.failingBody(status.lastFailure?.reason?.trim() || null) : words.lateBody).slice(
      0,
      600,
    ),
    at: new Date(status.lastFailure?.at ?? status.updatedAt).toISOString(),
    actions: [{ id: 'backups', label: words.see, style: 'secondary', kind: 'open', href: BACKUPS_HREF }],
    href: BACKUPS_HREF,
  };
}

/* The sources ------------------------------------------------------------------------------------------------------ */

/** Asks other parts of the server add after the box's own items (the passkey's, backup-passkey.md), by name. */
const laterAsks = new Map<string, (ctx: SourceCtx) => Promise<NeedsYouItem[]>>();

/** Adds (or replaces) an ask that shows only while no other backup item does. */
export function addBackupAsk(name: string, ask: (ctx: SourceCtx) => Promise<NeedsYouItem[]>): void {
  laterAsks.set(name, ask);
}

/**
 * The Inbox source of this Whombat's backups, for the box's people: ONE item at a time, the first that applies of
 * - a restore waiting for its answer (while quarantined, nothing else);
 * - backups failing or late (the place is set);
 * - a bring back that stopped (it can be tried again);
 * - the proposal of a place, while nothing backs the box up or only its own disk does (held back while the claim's
 *   “Let {assistant} set it up” waits for the assistant);
 * - the asks other parts add (the passkey's touch), only while the backups themselves are fine.
 */
export async function boxBackupNeedsYou(ctx: SourceCtx): Promise<NeedsYouItem[]> {
  const services = ctx.services;
  if (!services) return [];
  if (services.maintenance.quarantined) return boxRestoreNeedsYou(ctx);
  const status = await boxBackupStatus(services);
  if (!status) return [];
  const locale = await sourceLocale(ctx);
  const person = await loadPrincipalRow(ctx.db, ctx.personId);
  if (person?.kind !== 'person') return [];
  const nothing = !status.destination.configured && status.state === 'unprotected';
  const ownDisk = status.destination.configured && status.destination.kind === 'local';
  if (!nothing && !ownDisk && checkStartsOn('box.backup_late')) {
    const late = lateBackupItem(status, backupFailingSince(services), ctx.now, locale);
    if (late) return [late];
  }
  const stopped = await restoreStoppedNeedsYou(ctx);
  if (stopped.length) return stopped;
  if (nothing || ownDisk) {
    // The person said yes at the claim: the assistant sets it up once it can, and the Inbox asks only if that failed.
    if ((await loadBoxBackupNotes(ctx.db)).consent?.state === 'waiting') return [];
    const now = await placesNow(services).catch(() => null);
    const place = bestBackupPlace(now?.places ?? []);
    return [backupProposalItem(place, new Date(status.updatedAt).toISOString(), ownDisk, locale)];
  }
  if (status.state === 'failing' || status.state === 'stale') return [];
  const password = await changePasswordNeedsYou(ctx);
  if (password.length) return password;
  for (const ask of laterAsks.values()) {
    const items = await ask(ctx).catch(() => []);
    if (items.length) return items.slice(0, 1);
  }
  return [];
}

/** The check behind the password's item: a security opening only the person can close, so it starts on. */
export const BACKUP_PASSWORD_CHECK = 'box.backup_password';
registerChecks([{ check: BACKUP_PASSWORD_CHECK, startsOn: true }]);

/** The password item's words in a locale. */
export function changePasswordText(locale?: string | null) {
  const t = (key: ServerMessageKey, vars?: Record<string, string>) => tServer(locale, key, vars);
  return {
    title: (place: string | null) =>
      t('home.password.title', { place: place ?? t('home.password.placeUnknown') }),
    /** A place set up by hand: setting it up by hand again gives it a new password. */
    byHand: (place: string | null) =>
      t('home.password.byHand', { place: place ?? t('home.password.byHandIt') }),
    /** A destination typed in (a REST server, a disk, a bucket): changed there, then typed in Backups. */
    typed: (place: string | null) =>
      t('home.password.typed', { place: place ?? t('home.password.typedPlace') }),
    open: t('home.action.openBackups'),
  };
}

export const CHANGE_PASSWORD_TEXT = changePasswordText(null);

/** The item (pure): a lost or stolen Whombat's backups are on a place only the person can give a new password. */
export function changePasswordItem(
  note: {
    since: string;
    place: string | null;
    byHand: boolean;
  },
  locale?: string | null,
): NeedsYouItem {
  const T = changePasswordText(locale);
  return {
    id: `backup:password:${note.since}`.slice(0, 200),
    ref: { kind: 'backup', id: `password:${note.since}`.slice(0, 200) },
    kind: 'backup',
    severity: 'info',
    nature: 'you',
    title: T.title(note.place),
    body: note.byHand ? T.byHand(note.place) : T.typed(note.place),
    at: new Date(note.since).toISOString(),
    actions: [{ id: 'open', label: T.open, style: 'primary', kind: 'open', href: BACKUPS_HREF }],
    href: BACKUPS_HREF,
  };
}

/** Asked until the person sets a destination again (their new password, or another place) after the note. */
async function changePasswordNeedsYou(ctx: SourceCtx): Promise<NeedsYouItem[]> {
  if (!checkStartsOn(BACKUP_PASSWORD_CHECK)) return [];
  const note = (await loadBoxBackupNotes(ctx.db)).changePassword;
  if (!note) return [];
  const [set] = await ctx.db
    .select({ seq: applianceEvents.seq })
    .from(applianceEvents)
    .where(
      and(
        eq(applianceEvents.type, 'backup.destination_set'),
        isNotNull(applianceEvents.actorAccountId),
        gt(applianceEvents.createdAt, new Date(note.since)),
      ),
    )
    .limit(1);
  return set ? [] : [changePasswordItem(note, await sourceLocale(ctx))];
}

/** The waiting restore's words in a locale. */
export function restoreWaitingText(locale?: string | null) {
  return {
    title: tServer(locale, 'home.restore.waitingTitle'),
    body: tServer(locale, 'home.restore.waitingBody'),
    finish: tServer(locale, 'home.action.finish'),
  };
}

export const RESTORE_WAITING_TEXT = restoreWaitingText(null);

/** The restore's item (pure): while it waits for the person's answer. */
export function restoreWaitingItem(
  state: Pick<BackupRestoreState, 'phase' | 'since'>,
  locale?: string | null,
): NeedsYouItem | null {
  if (state.phase !== 'checking') return null;
  const words = restoreWaitingText(locale);
  const since = state.since ?? 'now';
  return {
    id: `backup:restore:${since}`.slice(0, 200),
    ref: { kind: 'backup', id: `restore:${since}`.slice(0, 200) },
    kind: 'backup',
    severity: 'warn',
    nature: 'you',
    title: words.title,
    body: words.body,
    at: new Date(state.since ?? Date.now()).toISOString(),
    actions: [
      {
        id: 'finish',
        label: words.finish,
        style: 'primary',
        kind: 'open',
        href: FINISH_RESTORE_HREF,
      },
    ],
    href: FINISH_RESTORE_HREF,
  };
}

/** A restore waiting for the person (read only while the box is quarantined). */
export async function boxRestoreNeedsYou(ctx: SourceCtx): Promise<NeedsYouItem[]> {
  const services = ctx.services;
  const box = services ? boxBackupOf(services) : null;
  if (!services || !box || !services.maintenance.quarantined) return [];
  if (!checkStartsOn('box.restore_waiting')) return [];
  const person = await loadPrincipalRow(ctx.db, ctx.personId);
  if (person?.kind !== 'person') return [];
  const state = await readRestoreState(box.port);
  const item = state ? restoreWaitingItem(state, await sourceLocale(ctx)) : null;
  return item ? [item] : [];
}

/** The stopped restore's words in a locale. */
export function restoreStoppedText(locale?: string | null) {
  return {
    title: tServer(locale, 'home.restore.stoppedTitle'),
    body: tServer(locale, 'home.restore.stoppedBody'),
    again: tServer(locale, 'home.action.tryAgain'),
  };
}

export const RESTORE_STOPPED_TEXT = restoreStoppedText(null);

/** Where the app brings a Whombat back again (the Backups page, which opens the bring back). */
export const RESTORE_AGAIN_HREF = '/settings?tab=appliance&section=backups&restore=again';
/** How long a stopped bring back stays in the Inbox. */
export const RESTORE_STOPPED_FOR_MS = 24 * 60 * 60_000;

/**
 * A bring back that stopped (pure): the box restarted before it finished (a power cut) and was put back as it was, so
 * it can be tried again. Only for a day, and only for that reason: a refusal up front was shown where the person asked.
 * The service's own sentence is the body when it gave one.
 */
export function restoreStoppedItem(
  state: Pick<BackupRestoreState, 'phase' | 'since' | 'reason' | 'error'>,
  now: Date,
  locale?: string | null,
): NeedsYouItem | null {
  if (state.phase !== 'failed' || state.reason !== BACKUP_RESTORE_INTERRUPTED) return null;
  const words = restoreStoppedText(locale);
  const at = state.since ? Date.parse(state.since) : Number.NaN;
  if (!Number.isFinite(at) || now.getTime() - at > RESTORE_STOPPED_FOR_MS) return null;
  return {
    id: `backup:restore-stopped:${state.since}`.slice(0, 200),
    ref: { kind: 'backup', id: `restore-stopped:${state.since}`.slice(0, 200) },
    kind: 'backup',
    severity: 'warn',
    nature: 'you',
    title: words.title,
    body: ((isEnglish(locale) ? state.error?.trim() : null) || words.body).slice(0, 600),
    at: new Date(at).toISOString(),
    actions: [
      {
        id: 'again',
        label: words.again,
        style: 'primary',
        kind: 'open',
        href: RESTORE_AGAIN_HREF,
      },
    ],
    href: RESTORE_AGAIN_HREF,
  };
}

/** The restore state as the Inbox last read it outside a restore (kept a minute: every Inbox read would ask). */
const restoreSeen = new WeakMap<Services, { at: number; state: BackupRestoreState | null }>();
const RESTORE_SEEN_FOR_MS = 60_000;

/** A bring back that stopped, for the person (outside quarantine). */
export async function restoreStoppedNeedsYou(ctx: SourceCtx): Promise<NeedsYouItem[]> {
  const services = ctx.services;
  const box = services ? boxBackupOf(services) : null;
  if (!services || !box || !checkStartsOn('box.restore_waiting')) return [];
  const now = ctx.now.getTime();
  let seen = restoreSeen.get(services);
  if (!seen || now - seen.at >= RESTORE_SEEN_FOR_MS) {
    seen = { at: now, state: await readRestoreState(box.port) };
    restoreSeen.set(services, seen);
  }
  const item = seen.state ? restoreStoppedItem(seen.state, ctx.now, await sourceLocale(ctx)) : null;
  return item ? [item] : [];
}

/** Registers the sources with Home (idempotent): the managed runtime does at its start. */
export function registerBoxBackupSource(): void {
  registerNeedsYouSource('box-backup', boxBackupNeedsYou);
}
