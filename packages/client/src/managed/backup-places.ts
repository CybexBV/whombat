/**
 * Backup places as the web and the phone show them (Whombat backup-places.md BPL-04, BPL-06, BPL-09, BPL-10; app
 * backup-places.md AP-6700…): Settings → This Whombat → Backups' “On your network” list (each place's mark, name, one
 * line and its one action), the line naming the place that keeps the backups now, what a place keeps for this Whombat
 * on its server's or connection's page (“Backups kept here”), and the words of setting one up. Pure and shared, so both
 * apps say the same; the places come from `backup.places` (a box from before answers `unknown_op` and shows nothing).
 */
import {
  BACKUP_PLACE_TEXT,
  type BackupPlace,
  type BackupPlaceKind,
  type BackupPlaceLocation,
  parseBackupPlaceId,
} from '@whombat/core/domain';
import { formatBytes } from '@whombat/core/text';
import { type BackupPlacesList, OperationError } from '../session/managed-ops';
import { DeadlineExceededError, OutcomeUnknownError, SessionClosedError } from '../session/types';
import { backupErrorText } from './backup-setup';
import { ACCOUNTS_TEXT } from './status-copy';

const T = BACKUP_PLACE_TEXT;

/** The words beyond the contract's (`BACKUP_PLACE_TEXT`): progress, outcomes, the by-hand sheet, what a place keeps. */
export const BACKUP_PLACES_TEXT = {
  heading: T.heading,
  /** While `backup.usePlace` runs: installing the app on the NAS can take a while (BPL-05). */
  settingUp: (name: string) => `Setting up ${name}. This can take a minute or two.`,
  settingUpButton: 'Setting up…',
  done: (destination: string) => `Done. Backups go to ${destination} now.`,
  firstBackup: 'The first backup has started.',
  /** The deadline passed while the box was still at it: it carries on (no automatic retry). */
  slow: 'This is taking longer than usual. Whombat carries on; look again in a few minutes.',
  cancel: 'Cancel',
  close: 'Close',
  /** Where the old backups are when the box's refusal doesn't name the place (BPL-06). */
  fromUnknown: 'the place they go now',
  byHandTitle: (name: string) => `Set up ${name} by hand`,
  byHandLead: 'Whombat can’t install its backup app there itself. Paste it in, then check it.',
  byHandLoading: 'Getting it ready…',
  byHandFailed: 'Couldn’t get it ready. Try again.',
  compose: 'The app to paste',
  copy: 'Copy',
  copied: 'Copied',
  checking: 'Checking…',
  thisWhombat: 'This Whombat',
  used: (bytes: string) => `${bytes} used`,
  free: (bytes: string) => `${bytes} free`,
  lastCleared: (when: string) => `Last cleared ${when}`,
  cleanupFailed: (when: string) => `The last cleanup didn’t work, ${when}`,
  cleanupSoon: 'The first cleanup runs within a week',
  /** Where on a place (BPL-13): an Unraid share, a TrueNAS pool, a Synology's or QNAP's shared folder. */
  where: T.location.said,
  whereTitle: (place: string) => `Where on ${place}?`,
  whereLead: 'Choose where Whombat keeps its backups.',
  recommended: 'Recommended',
  inUse: 'In use',
  isNew: 'Whombat makes it',
  change: 'Change',
  /** Changing where on the place in use (BPL-14): Unraid and Linux move the backups, a NAS's API can't. */
  changeTitle: (name: string) => `Keep backups in ${name}?`,
  changeMoves: (name: string) => `Whombat moves your backups to ${name}. Backups keep their history.`,
  /** While they move: gigabytes can take up to an hour, and the box carries on without the page. */
  moving: (name: string) =>
    `Moving your backups to ${name}… This can take up to an hour. You can leave this page.`,
  movingButton: 'Moving…',
  moved: (where: string) => `Done. Your backups are in ${where} now.`,
} as const;

/** The one thing a place's row offers (BPL-04). */
export type BackupPlaceAction =
  | { kind: 'use'; label: string }
  | { kind: 'byHand'; label: string }
  /**
   * A NAS the scan found: its connect page (`catalogId`, with the address to start from), or Add a server for one
   * Whombat looks after as a server (Unraid, a plain Linux computer).
   */
  | { kind: 'connect'; label: string; catalogId: string; address: string | null; asServer: boolean }
  /** Connected or added with Look only: the server's System tab or the connection's Settings, where Manage is. */
  | { kind: 'manage'; label: string; thing: string; tab: 'system' | 'settings' }
  /** The place in use with more than one location: where on it, chosen again (BPL-13). */
  | { kind: 'change'; label: string };

export interface BackupPlaceRow {
  id: string;
  name: string;
  kind: BackupPlaceKind;
  /** The catalog mark the apps draw for it (`unraid`, `synology`, …), `server` for a plain Linux server. */
  mark: string;
  /** One line: the reason when there is one, else the state (“Ready · 3.1 TB free”). */
  line: string;
  action: BackupPlaceAction | null;
  /** It keeps this Whombat's backups now. */
  current: boolean;
}

/** The order places are listed in: the one in use, then what can be done now, then what needs something first. */
const ORDER: Record<BackupPlace['state'], number> = {
  in_use: 0,
  ready: 1,
  manage_first: 2,
  connect_first: 3,
  unsupported: 4,
};

/** The mark of a place's kind, as the apps draw a connection's or a found server's. */
export function backupPlaceMark(kind: BackupPlaceKind): string {
  return kind === 'linux' ? 'server' : kind;
}

function placeAction(place: BackupPlace): BackupPlaceAction | null {
  if (place.state === 'in_use')
    return place.locations.length > 1 ? { kind: 'change', label: BACKUP_PLACES_TEXT.change } : null;
  if (place.state === 'ready') return { kind: 'use', label: T.use };
  if (place.byHand) return { kind: 'byHand', label: T.byHand };
  const ref = parseBackupPlaceId(place.id);
  if (!ref) return null;
  if (place.state === 'connect_first') {
    const asServer = place.kind === 'unraid' || place.kind === 'linux';
    const address = ref.type === 'found' ? ref.host : place.address;
    return { kind: 'connect', label: T.state.connect_first, catalogId: place.kind, address, asServer };
  }
  if (place.state === 'manage_first' && ref.type !== 'found')
    return {
      kind: 'manage',
      label: T.state.manage_first,
      thing: `${ref.type}:${ref.id}`,
      tab: ref.type === 'server' ? 'system' : 'settings',
    };
  return null;
}

function placeLine(place: BackupPlace): string {
  if (place.reason) return place.reason;
  const where = place.state === 'in_use' ? placeWhere(place) : null;
  if (where) return `${T.state.in_use} · ${where}`;
  const free = place.state === 'ready' ? place.kept?.freeBytes : null;
  return free != null
    ? `${T.state[place.state]} · ${BACKUP_PLACES_TEXT.free(formatBytes(free))}`
    : T.state[place.state];
}

/** “On your network”'s rows, the place in use first; empty when there are none (the section then hides). */
export function backupPlaceRows(list: BackupPlacesList | null | undefined): BackupPlaceRow[] {
  if (!list) return [];
  return list.places
    .map((place, i) => ({ place, i }))
    .sort((a, b) => ORDER[a.place.state] - ORDER[b.place.state] || a.i - b.i)
    .map(({ place }) => ({
      id: place.id,
      name: place.name,
      kind: place.kind,
      mark: backupPlaceMark(place.kind),
      line: placeLine(place),
      action: placeAction(place),
      current: place.state === 'in_use' || place.id === list.currentPlaceId,
    }));
}

function cleanupWords(kept: NonNullable<BackupPlace['kept']>): string {
  return kept.cleanup.on ? T.cleanup(kept.cleanup.keepDays) : T.noCleanup;
}

/**
 * The place that keeps the backups now, for BACKUPS (BPL-10): “BlackBox · Unraid” over “Deleting is blocked · Backups
 * older than 90 days are cleared” (or that old backups aren't cleared there on their own); null when none does.
 */
export function currentPlaceLine(
  list: BackupPlacesList | null | undefined,
): { title: string; meta: string; mark: string } | null {
  if (!list?.currentPlaceId) return null;
  const place = list.places.find((p) => p.id === list.currentPlaceId);
  if (!place) return null;
  const where = placeWhere(place);
  return {
    title: [place.name, T.kind(place.kind), where].filter(Boolean).join(' · '),
    meta: [T.appendOnly, place.kept ? cleanupWords(place.kept) : null].filter(Boolean).join(' · '),
    mark: backupPlaceMark(place.kind),
  };
}

/** Where on the place the backups are kept now, as people read it (“the share whombat-backups”); null without a choice. */
export function placeWhere(place: Pick<BackupPlace, 'kind' | 'locations' | 'location'>): string | null {
  if (!place.location || place.locations.length < 2) return null;
  const name = place.locations.find((l) => l.id === place.location)?.name ?? place.location;
  return BACKUP_PLACES_TEXT.where(place.kind, name);
}

/** One location in “Where on BlackBox?”: its name, a line (free space, made new, its note) and its marks. */
export interface PlaceLocationRow {
  id: string;
  name: string;
  line: string | null;
  recommended: boolean;
  /** The backups are kept there now. */
  current: boolean;
}

/**
 * Where on a place the person is asked (BPL-13): its locations, the recommended one first; null when there is no
 * choice (none or one), and the app calls without asking. `selected` is preselected: the one in use, else the
 * recommended one.
 */
export function placeLocations(
  place: Pick<BackupPlace, 'locations' | 'location'> | null | undefined,
): { rows: PlaceLocationRow[]; selected: string } | null {
  if (!place || place.locations.length < 2) return null;
  const W = BACKUP_PLACES_TEXT;
  const line = (l: BackupPlaceLocation) =>
    [l.freeBytes != null ? W.free(formatBytes(l.freeBytes)) : null, l.isNew ? W.isNew : null, l.note]
      .filter(Boolean)
      .join(' · ') || null;
  const rows = place.locations
    .map((l, i) => ({ l, i }))
    .sort((a, b) => Number(b.l.recommended) - Number(a.l.recommended) || a.i - b.i)
    .map(({ l }) => ({
      id: l.id,
      name: l.name,
      line: line(l),
      recommended: l.recommended,
      current: l.id === place.location,
    }));
  const selected = rows.find((r) => r.current) ?? rows.find((r) => r.recommended) ?? rows[0];
  return { rows, selected: selected?.id ?? '' };
}

/**
 * Changing where on the place in use (BPL-14), as its confirm says it: Unraid and a Linux server move the backups with
 * their history (up to an hour); through a NAS's API (Synology, TrueNAS, QNAP) the new location starts afresh and the
 * old backups stay, so the call says `move` (the box refuses it without, `move_needed`). Null when `to` is where they
 * are now or not one of its locations.
 */
export function placeLocationChange(
  place: Pick<BackupPlace, 'kind' | 'locations' | 'location'>,
  to: string,
): { title: string; body: string; button: string; move: boolean; name: string; where: string } | null {
  const target = place.locations.find((l) => l.id === to);
  if (!target || to === place.location) return null;
  const W = BACKUP_PLACES_TEXT;
  const moves = place.kind === 'unraid' || place.kind === 'linux';
  const old = place.locations.find((l) => l.id === place.location)?.name ?? place.location ?? '';
  return {
    title: W.changeTitle(target.name),
    body: moves ? W.changeMoves(target.name) : T.location.newBackups(old),
    button: W.change,
    move: !moves,
    name: target.name,
    where: BACKUP_PLACES_TEXT.where(place.kind, target.name),
  };
}

/** “3 days ago”, from an ISO time and now (ms). */
export function placeAgo(iso: string, now: number): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s) || s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 129_600) return `${Math.round(s / 3600)} hours ago`;
  const d = Math.round(s / 86_400);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

export interface KeptHereRow {
  title: string;
  meta: string | null;
  dot: 'ok' | 'warn' | 'mut' | null;
}

/**
 * “Backups kept here” on a server's or a NAS connection's page (BPL-10): which Whombat with the space it uses and the
 * free space, then the cleanup (on, with when it last ran and whether that worked, or that there is none). Null when
 * the place keeps nothing for this Whombat. `thing` is the page's thing id: `server:<id>` or `connection:<id>`.
 */
export function keptHere(
  list: BackupPlacesList | null | undefined,
  thing: string,
  options: { whombat?: string | null; now: number },
): KeptHereRow[] | null {
  const place = list?.places.find((p) => p.id === thing && p.kept);
  const kept = place?.kept;
  if (!kept) return null;
  const W = BACKUP_PLACES_TEXT;
  const space = [
    kept.usedBytes != null ? W.used(formatBytes(kept.usedBytes)) : null,
    kept.freeBytes != null ? W.free(formatBytes(kept.freeBytes)) : null,
  ].filter(Boolean);
  const c = kept.cleanup;
  const failed = c.on && c.ok === false;
  return [
    { title: options.whombat?.trim() || W.thisWhombat, meta: space.join(' · ') || null, dot: null },
    {
      title: cleanupWords(kept),
      meta: !c.on
        ? null
        : c.lastAt
          ? failed
            ? W.cleanupFailed(placeAgo(c.lastAt, options.now))
            : W.lastCleared(placeAgo(c.lastAt, options.now))
          : W.cleanupSoon,
      dot: !c.on ? 'mut' : failed ? 'warn' : 'ok',
    },
  ];
}

/**
 * Moving backups that go to another place is the person's choice (BPL-06): the name of the place they go to now when
 * it isn't `placeId`, so the app asks first; null when nothing needs asking up front.
 */
export function moveFromPlace(list: BackupPlacesList | null | undefined, placeId: string): string | null {
  if (!list?.currentPlaceId || list.currentPlaceId === placeId) return null;
  return list.places.find((p) => p.id === list.currentPlaceId)?.name ?? BACKUP_PLACES_TEXT.fromUnknown;
}

/**
 * The box refused because backups go somewhere else already and the person hasn't said to move them (`move` missing):
 * where they go now, for the confirm; null for any other error. The refusal is `conflict` with `details.code`
 * `move_needed` (and `details.from`, the place's name, when the box knows it).
 */
export function moveNeeded(error: unknown): { from: string } | null {
  if (!(error instanceof OperationError)) return null;
  const details = (error.details ?? {}) as { code?: unknown; from?: unknown };
  if (error.code !== 'move_needed' && details.code !== 'move_needed') return null;
  return {
    from: typeof details.from === 'string' && details.from ? details.from : BACKUP_PLACES_TEXT.fromUnknown,
  };
}

/** What a set place is followed by: where backups go now (and where on it), whether deleting is refused, the first backup. */
export function placeSetNotes(result: {
  destination: string;
  /** Where on it (“the share whombat-backups”), when the place has a choice. */
  locationName?: string | null;
  appendOnly: 'verified' | 'not-enforced' | 'unknown';
  firstBackup: boolean;
}): string {
  const where = result.locationName ? `${result.locationName} on ${result.destination}` : result.destination;
  return [
    BACKUP_PLACES_TEXT.done(where),
    result.appendOnly === 'verified' ? null : ACCOUNTS_TEXT.appendOnly[result.appendOnly],
    result.firstBackup ? BACKUP_PLACES_TEXT.firstBackup : null,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Codes whose message is the box's own sentence about the place (a step that failed says which, BPL-05). */
const PLACE_REFUSALS: ReadonlySet<string> = new Set([
  'conflict',
  'unavailable',
  'backup_destination_failed',
  'destination_failed',
  'bad_request',
  'not_allowed',
]);

/** What a failed set-up or check says: the box's sentence for a step that failed, else the app's words. */
export function placeErrorText(error: unknown): string {
  if (error instanceof OperationError) {
    if (error.code === 'deadline_exceeded') return BACKUP_PLACES_TEXT.slow;
    const sentence = error.message.trim();
    if (PLACE_REFUSALS.has(error.code) && sentence && sentence !== 'Failed.') return sentence;
  }
  return backupErrorText(error);
}

/**
 * How long the apps wait for `backup.usePlace` and `backup.placeCheck`: the NAS pulls the backup app's image and starts
 * it (the hosts hub waits up to five minutes), then the first backup is started.
 */
export const BACKUP_PLACE_DEADLINE_MS = 6 * 60_000;

/**
 * Whether a move to another location on the place in use (BPL-14) may still be running after its call ended without an
 * answer: the box runs an accepted `backup.usePlace` to its end whatever the client does, and the session client stops
 * waiting on an accepted request after ten minutes without progress (an unknown outcome), or the session closed. Then
 * the app reads `backup.places` until the place is there (`waitForPlaceLocation`) rather than reporting a failure.
 */
export function placeMoveMayRun(error: unknown): boolean {
  return (
    error instanceof OutcomeUnknownError ||
    error instanceof DeadlineExceededError ||
    error instanceof SessionClosedError ||
    (error instanceof OperationError && error.code === 'deadline_exceeded')
  );
}

/** The place keeps its backups in `location` now. */
export function placeIsAt(
  list: BackupPlacesList | null | undefined,
  placeId: string,
  location: string,
): boolean {
  return list?.places.find((p) => p.id === placeId)?.location === location;
}

/** How often and how long the apps read `backup.places` after a move's call ended without an answer. */
export const PLACE_MOVE_POLL_MS = 15_000;
export const PLACE_MOVE_WAIT_MS = 65 * 60_000;

/**
 * Reads the places (`read`, `backup.places`) every `everyMs` until the place keeps its backups in `location` (true),
 * `forMs` passed or `signal` aborted (false). A read that fails is tried again at the next turn.
 */
export async function waitForPlaceLocation(
  read: () => Promise<BackupPlacesList>,
  placeId: string,
  location: string,
  options: { everyMs?: number; forMs?: number; signal?: AbortSignal; now?: () => number } = {},
): Promise<boolean> {
  const now = options.now ?? Date.now;
  const until = now() + (options.forMs ?? PLACE_MOVE_WAIT_MS);
  const every = options.everyMs ?? PLACE_MOVE_POLL_MS;
  while (!options.signal?.aborted) {
    try {
      if (placeIsAt(await read(), placeId, location)) return true;
    } catch {
      // Read again at the next turn.
    }
    if (now() + every > until) return false;
    await new Promise<void>((done) => {
      const timer = setTimeout(done, every);
      options.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          done();
        },
        { once: true },
      );
    });
  }
  return false;
}
