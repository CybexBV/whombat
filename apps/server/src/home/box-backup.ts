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
import { BACKUP_PLACE_TEXT, type BackupPlace, bestBackupPlace, type NeedsYouItem } from '@whombat/core';
import { BACKUP_RESTORE_INTERRUPTED, type BackupRestoreState } from '@whombat/protocol/session';
import { and, eq, gt, isNotNull } from 'drizzle-orm';
import { loadBoxBackupNotes } from '../backup-places/notes';
import { placesNow } from '../backup-places/places';
import { applianceEvents } from '../db/schema/index';
import { backupFailingSince, boxBackupOf, boxBackupStatus } from '../managed/box-backup';
import { readRestoreState } from '../managed/restore-state';
import { loadPrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { checkStartsOn, registerChecks } from '../things/quiet/defaults';
import { registerNeedsYouSource, type SourceCtx } from './registry';

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

const ONLY_HERE = 'Right now everything on it is only here: your chats, settings and connections.';
const OWN_DISK =
  'A broken disk or a reinstall would take them with it. Backups made so far stay where they are.';

/** “the Synology at 192.168.1.40”: a NAS the scan found, as the proposal says it. */
function foundSaid(place: NonNullable<ProposedPlace>): string {
  return `the ${place.name}${place.address ? ` at ${place.address}` : ''}`;
}

/** The words of the proposal (pure). `ownDisk`: backups go only to this Whombat's own disk now. */
export function backupProposal(
  place: ProposedPlace,
  ownDisk = false,
): { title: string; body: string; yes: string } {
  if (place && place.state !== 'connect_first') {
    const name = place.name;
    return {
      title: ownDisk ? BACKUP_PLACE_TEXT.ownDisk(name) : `Back up this Whombat to ${name}?`,
      body: `${ownDisk ? OWN_DISK : ONLY_HERE} Say yes and I’ll set it up on ${name}, start the first backup right away and tell you when it’s done.`,
      yes: `Yes, back up this Whombat to ${name}.`,
    };
  }
  if (place) {
    const said = foundSaid(place);
    return {
      title: ownDisk ? BACKUP_PLACE_TEXT.ownDisk(said) : `Back up this Whombat to ${said}?`,
      body: `${ownDisk ? OWN_DISK : ONLY_HERE} Say yes and I’ll set it up there; I may need you to connect it first.`,
      yes: `Yes, back up this Whombat to ${said}.`,
    };
  }
  return {
    title: ownDisk ? BACKUP_PLACE_TEXT.ownDisk('a USB disk') : 'Back up this Whombat to a USB disk?',
    body: `${ownDisk ? OWN_DISK : ONLY_HERE} Name a USB disk WHOMBAT-BACKUP, plug it into your Whombat and say yes.`,
    yes: 'Yes, back up this Whombat to the disk named WHOMBAT-BACKUP I plugged in.',
  };
}

/** The one item (pure): the proposal, Yes, do it, See other places (Ignore is the list's own). */
export function backupProposalItem(place: ProposedPlace, at: string, ownDisk = false): NeedsYouItem {
  const words = backupProposal(place, ownDisk);
  return {
    id: `${BACKUP_REF.kind}:${BACKUP_REF.id}`,
    ref: { ...BACKUP_REF },
    kind: 'backup',
    severity: 'warn',
    title: words.title.slice(0, 200),
    body: words.body,
    at,
    actions: [
      { id: 'yes', label: 'Yes, do it', style: 'primary', kind: 'ask', text: words.yes.slice(0, 500) },
      { id: 'places', label: 'See other places', style: 'secondary', kind: 'open', href: BACKUPS_HREF },
    ],
    href: BACKUPS_HREF,
  };
}

/* Failing or late ------------------------------------------------------------------------------------------------- */

/** How long backups fail before the Inbox says so: the service tries again after 15 minutes. */
export const FAILING_FOR_MS = 45 * 60_000;

export const LATE_TEXT = {
  failingTitle: 'This Whombat’s backups aren’t working',
  failingBody: (reason: string | null) =>
    `${reason ? `${reason.replace(/[.\s]+$/, '')}.` : 'The last backups didn’t finish.'} The backups made before are still there.`,
  lateTitle: 'This Whombat hasn’t backed up for a while',
  lateBody: 'No backup has finished for longer than it should. The backups made before are still there.',
  see: 'See backups',
} as const;

/**
 * The failing-or-late item (pure): `failing` once the service has said so for `FAILING_FOR_MS` (`failingSince`, when it
 * was first seen in this episode), `stale` at once; null otherwise. An episode is everything since the last backup that
 * worked, so the item's id changes with it and an Ignore lasts the episode.
 */
export function lateBackupItem(
  status: Pick<BackupServiceStatus, 'state' | 'destination' | 'lastSuccess' | 'lastFailure' | 'updatedAt'>,
  failingSince: number | null,
  now: Date,
): NeedsYouItem | null {
  if (!status.destination.configured || status.destination.kind === 'local') return null;
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
    title: failing ? LATE_TEXT.failingTitle : LATE_TEXT.lateTitle,
    body: (failing
      ? LATE_TEXT.failingBody(status.lastFailure?.reason?.trim() || null)
      : LATE_TEXT.lateBody
    ).slice(0, 600),
    at: new Date(status.lastFailure?.at ?? status.updatedAt).toISOString(),
    actions: [{ id: 'backups', label: LATE_TEXT.see, style: 'secondary', kind: 'open', href: BACKUPS_HREF }],
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
  const person = await loadPrincipalRow(ctx.db, ctx.personId);
  if (person?.kind !== 'person') return [];
  const nothing = !status.destination.configured && status.state === 'unprotected';
  const ownDisk = status.destination.configured && status.destination.kind === 'local';
  if (!nothing && !ownDisk && checkStartsOn('box.backup_late')) {
    const late = lateBackupItem(status, backupFailingSince(services), ctx.now);
    if (late) return [late];
  }
  const stopped = await restoreStoppedNeedsYou(ctx);
  if (stopped.length) return stopped;
  if (nothing || ownDisk) {
    // The person said yes at the claim: the assistant sets it up once it can, and the Inbox asks only if that failed.
    if ((await loadBoxBackupNotes(ctx.db)).consent?.state === 'waiting') return [];
    const now = await placesNow(services).catch(() => null);
    const place = bestBackupPlace(now?.places ?? []);
    return [backupProposalItem(place, new Date(status.updatedAt).toISOString(), ownDisk)];
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

export const CHANGE_PASSWORD_TEXT = {
  title: (place: string | null) =>
    `Change the backup password on ${place ?? 'the place your backups are on'}`,
  /** A place set up by hand: setting it up by hand again gives it a new password. */
  byHand: (place: string | null) =>
    `Your old Whombat still has the password, so it could keep adding backups there. In Backups, set ${place ?? 'it'} up by hand again: that gives it a new one.`,
  /** A destination typed in (a REST server, a disk, a bucket): changed there, then typed in Backups. */
  typed: (place: string | null) =>
    `Your old Whombat still has the password, so it could keep adding backups there. Change it on ${place ?? 'that place'}, then give Whombat the new one in Backups.`,
  open: 'Open Backups',
} as const;

/** The item (pure): a lost or stolen Whombat's backups are on a place only the person can give a new password. */
export function changePasswordItem(note: {
  since: string;
  place: string | null;
  byHand: boolean;
}): NeedsYouItem {
  const T = CHANGE_PASSWORD_TEXT;
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
  return set ? [] : [changePasswordItem(note)];
}

export const RESTORE_WAITING_TEXT = {
  title: 'Finish bringing your Whombat back',
  body: 'One question is left: is the old Whombat gone, or was it lost or stolen? Until you answer, nothing runs on its own.',
  finish: 'Finish',
} as const;

/** The restore's item (pure): while it waits for the person's answer. */
export function restoreWaitingItem(state: Pick<BackupRestoreState, 'phase' | 'since'>): NeedsYouItem | null {
  if (state.phase !== 'checking') return null;
  const since = state.since ?? 'now';
  return {
    id: `backup:restore:${since}`.slice(0, 200),
    ref: { kind: 'backup', id: `restore:${since}`.slice(0, 200) },
    kind: 'backup',
    severity: 'warn',
    nature: 'you',
    title: RESTORE_WAITING_TEXT.title,
    body: RESTORE_WAITING_TEXT.body,
    at: new Date(state.since ?? Date.now()).toISOString(),
    actions: [
      {
        id: 'finish',
        label: RESTORE_WAITING_TEXT.finish,
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
  const item = state ? restoreWaitingItem(state) : null;
  return item ? [item] : [];
}

export const RESTORE_STOPPED_TEXT = {
  title: 'Bringing your Whombat back stopped',
  body: 'It restarted before it finished, so it was put back as it was. Your backups are fine. Try again when you like.',
  again: 'Try again',
} as const;

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
): NeedsYouItem | null {
  if (state.phase !== 'failed' || state.reason !== BACKUP_RESTORE_INTERRUPTED) return null;
  const at = state.since ? Date.parse(state.since) : Number.NaN;
  if (!Number.isFinite(at) || now.getTime() - at > RESTORE_STOPPED_FOR_MS) return null;
  return {
    id: `backup:restore-stopped:${state.since}`.slice(0, 200),
    ref: { kind: 'backup', id: `restore-stopped:${state.since}`.slice(0, 200) },
    kind: 'backup',
    severity: 'warn',
    nature: 'you',
    title: RESTORE_STOPPED_TEXT.title,
    body: (state.error?.trim() || RESTORE_STOPPED_TEXT.body).slice(0, 600),
    at: new Date(at).toISOString(),
    actions: [
      {
        id: 'again',
        label: RESTORE_STOPPED_TEXT.again,
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
  const item = seen.state ? restoreStoppedItem(seen.state, ctx.now) : null;
  return item ? [item] : [];
}

/** Registers the sources with Home (idempotent): the managed runtime does at its start. */
export function registerBoxBackupSource(): void {
  registerNeedsYouSource('box-backup', boxBackupNeedsYou);
}
