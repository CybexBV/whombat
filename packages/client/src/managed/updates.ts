/**
 * What the person is told about updates (AP-257, AP-258; updates.md UP-E4): This Whombat's UPDATES section —
 * an update waiting (for work to finish, a backup, the maintenance window, a hold, the owner's yes) and since when, one that failed and why (contracts' `describeUpdateFailure`) and that nothing changed, the last update and what it brought.
 * Pure and shared by the web and the phone. Plain, calm words; curly quotes and the middle dot as in the mocks.
 */
import { describeUpdateFailure } from '@whombat/control-contracts';
import type { ApplianceStatus } from '../session/managed-ops';
import { MANAGED_TEXT } from './status-copy';

/* Updates ------------------------------------------------------------------------------------------------- */

export type UpdateStatus = NonNullable<ApplianceStatus['update']>;
type Dot = 'ok' | 'warn' | 'bad' | 'mut';

export const UPDATE_TEXT = {
  forwardRepair: 'Updated · can’t go back to the previous version',
  forwardRepairMeta:
    'This update changed the database in a way the previous version can’t use, so your Whombat keeps running it and installs a fixed version as soon as there is one. Your data stays where it is.',
  stillOn: (release: string) => `Your Whombat is still on ${release}.`,
  nothingChanged: 'Nothing changed.',
  updatedTo: (release: string, day: string) => `Updated to ${release} on ${day}`,
  waitingFor: {
    boundary: 'It waits for work in progress to finish.',
    checkpoint: 'It needs a backup first: it changes the database in a way that can’t be undone.',
    checkpointNoDestination:
      'It needs a backup destination first: it changes the database in a way that can’t be undone. Set one up and it goes ahead.',
    window: 'It waits for your maintenance window.',
    hold: 'Whombat is holding it back for now. Nothing to do on your side.',
    lock: 'It waits for another update step to finish.',
    metadata: 'It waits to confirm the update’s signatures with Whombat’s servers.',
    owner: 'It waits for your yes before it installs.',
  } as Record<string, string>,
  waitingGeneric: 'It waits for the right moment to install.',
  since: (when: string) => `Waiting since ${when}`,
  blocker: (count: number, kind: string) => {
    const names: Record<string, [string, string]> = {
      run: ['run', 'runs'],
      turn: ['agent turn', 'agent turns'],
      task: ['task', 'tasks'],
      upload: ['upload', 'uploads'],
      export: ['export', 'exports'],
      backup: ['backup', 'backups'],
      session: ['session', 'sessions'],
    };
    const [one, many] = names[kind] ?? [kind.replace(/_/g, ' '), kind.replace(/_/g, ' ')];
    return `${count} ${count === 1 ? one : many} in progress`;
  },
  setUpBackups: 'Set up backups',
  breakingWait: 'Updates that change the database in a breaking way wait until a backup exists.',
  /* Ask before updating (Whombat ask-before-updating.md ABU-01, ABU-03). */
  install: 'Update now',
  failed: 'That didn’t work. Try again.',
  installing: 'Your Whombat installs it at the next quiet moment.',
  ask: 'Ask before updating',
  askOn: 'Each update waits for your yes.',
  askOff: 'Updates install by themselves.',
  askSwitched: (on: boolean) =>
    on ? 'Updates now wait for your yes.' : 'Updates install by themselves again.',
} as const;

/** States in which an update is on its way (the status is asked again every few seconds). */
const MOVING: ReadonlySet<string> = new Set([
  'Assigned',
  'Downloading',
  'Verified',
  'Staged',
  'Activating',
  'Verifying',
]);
/** States after an attempt that didn't go through. */
const NOT_THROUGH: ReadonlySet<string> = new Set(['Failed', 'RolledBack', 'Quarantined']);

/** How often This Whombat asks again: while an update moves, every 5 s; while one waits, every 15 s; else not. */
export function updatePollMs(update: UpdateStatus | null | undefined): number | null {
  if (!update) return null;
  if (MOVING.has(update.state)) return 5_000;
  if (update.state === 'WaitingForSafeBoundary' || update.waiting) return 15_000;
  return null;
}

/** “14:02” today, else “27 September”, in the device's time zone. */
export function sinceText(iso: string, now: Date = new Date(), timeZone?: string): string {
  const at = new Date(iso);
  const day = (d: Date) =>
    new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', ...(timeZone && { timeZone }) }).format(
      d,
    );
  if (day(at) === day(now))
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      ...(timeZone && { timeZone }),
    }).format(at);
  return day(at);
}

/** “29 September 2026”. */
function dayText(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    ...(timeZone && { timeZone }),
  }).format(new Date(iso));
}

export interface UpdateRow {
  dot?: Dot;
  title: string;
  meta?: string;
  /** The step that unblocks it: set up a backup destination, or the owner's yes to `release` (Update now). */
  action?: 'backup' | 'install';
  /** The release Update now approves. */
  release?: string;
  /** The last update's row: control's summary of what it brought goes in its meta (`summaryOf`). */
  lastUpdate?: true;
}

export interface UpdateView {
  rows: UpdateRow[];
  /** The release whose summary to show under “Updated to …” (control's `releases/:release/summary`). */
  summaryOf: string | null;
  pollMs: number | null;
}

/**
 * This Whombat's UPDATES section from `appliance.status` (`update`, and `backup` for what a missing destination
 * blocks). Runtimes before contracts 0.22 have no `waiting`, `failureDetail` or `lastUpdate`: the section then reads
 * as it did (state, version, `deferredReason`).
 */
export function updateView(
  status: Pick<ApplianceStatus, 'update' | 'backup'>,
  options: { now?: Date; timeZone?: string } = {},
): UpdateView {
  const u = status.update;
  const rows: UpdateRow[] = [];
  const noDestination = status.backup.state === 'unprotected';
  if (!u) return { rows, summaryOf: null, pollMs: null };
  const now = options.now ?? new Date();
  const version = MANAGED_TEXT.version(u.current);

  if (u.state === 'ForwardRepairRequired') {
    rows.push({
      dot: 'warn',
      title: UPDATE_TEXT.forwardRepair,
      meta: [
        version,
        u.failureDetail ? describeUpdateFailure(u.failureDetail) : UPDATE_TEXT.forwardRepairMeta,
      ].join(' · '),
    });
  } else if (NOT_THROUGH.has(u.state)) {
    const why = u.failureDetail ? describeUpdateFailure(u.failureDetail) : null;
    const settled = why && /Nothing was changed\.|went back to the release it ran before\./.test(why);
    rows.push({
      dot: 'bad',
      title: MANAGED_TEXT.update[u.state] ?? u.state,
      meta: [why, UPDATE_TEXT.stillOn(u.current), settled ? null : UPDATE_TEXT.nothingChanged]
        .filter(Boolean)
        .join(' '),
    });
  } else {
    const waiting = u.waiting ?? null;
    const reason =
      waiting?.reason === 'checkpoint' &&
      (noDestination || waiting.blockers.some((b) => b.kind === 'no_destination'))
        ? UPDATE_TEXT.waitingFor.checkpointNoDestination
        : waiting
          ? (UPDATE_TEXT.waitingFor[waiting.reason] ?? UPDATE_TEXT.waitingGeneric)
          : null;
    const blockers = (waiting?.blockers ?? [])
      .filter((b) => b.count > 0 && b.kind !== 'no_destination')
      .map((b) => UPDATE_TEXT.blocker(b.count, b.kind));
    // Waiting for the owner's yes is the update being ready, whatever step the manager is at.
    const forOwner = waiting?.reason === 'owner' && u.candidate ? u.candidate : null;
    rows.push({
      dot: u.state === 'Healthy' && !waiting ? 'ok' : waiting ? 'warn' : 'mut',
      title: forOwner ? (MANAGED_TEXT.update.Staged ?? u.state) : (MANAGED_TEXT.update[u.state] ?? u.state),
      meta: [version, !waiting && u.deferredReason ? (MANAGED_TEXT.deferred[u.deferredReason] ?? null) : null]
        .filter(Boolean)
        .join(' · '),
    });
    if (waiting && reason)
      rows.push({
        dot: 'warn',
        title: reason,
        meta: [
          ...(forOwner ? [MANAGED_TEXT.version(forOwner)] : []),
          ...blockers,
          UPDATE_TEXT.since(sinceText(waiting.since, now, options.timeZone)),
        ].join(' · '),
        ...(waiting.reason === 'checkpoint' && noDestination ? { action: 'backup' as const } : {}),
        ...(forOwner ? { action: 'install' as const, release: forOwner } : {}),
      });
  }

  // What it brought is control's to say (`releaseSummary`): the screen puts it under this row.
  if (u.lastUpdate && u.state !== 'ForwardRepairRequired')
    rows.push({
      dot: 'ok',
      title: UPDATE_TEXT.updatedTo(u.lastUpdate.release, dayText(u.lastUpdate.at, options.timeZone)),
      lastUpdate: true,
    });

  return {
    rows,
    summaryOf: u.lastUpdate?.release ?? null,
    pollMs: updatePollMs(u),
  };
}

/** The “Ask before updating” switch (ABU-01): null where the box's manager can't hold updates for the owner. */
export function askFirstView(
  status: Pick<ApplianceStatus, 'update'>,
): { on: boolean; title: string; meta: string } | null {
  const on = status.update?.askFirst;
  if (on === undefined) return null;
  return { on, title: UPDATE_TEXT.ask, meta: on ? UPDATE_TEXT.askOn : UPDATE_TEXT.askOff };
}

/** Until a backup destination exists: what that blocks (This Whombat, BACKUPS). */
export function backupBlocksText(status: Pick<ApplianceStatus, 'backup'>): string | null {
  return status.backup.state === 'unprotected' ? UPDATE_TEXT.breakingWait : null;
}
