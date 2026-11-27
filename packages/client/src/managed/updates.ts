/**
 * What the person is told about updates (AP-257, AP-258; updates.md UP-E4): This Whombat's UPDATES section —
 * an update waiting (for work to finish, a backup, the maintenance window, a hold, the owner's yes) and since when, one that failed and why (contracts' `describeUpdateFailure`) and that nothing changed, the last update and what it brought.
 * Pure and shared by the web and the phone. Plain, calm words; curly quotes and the middle dot as in the mocks.
 */

import { describeUpdateFailure } from '@whombat/control-contracts';
import { formatLocaleOf } from '@whombat/core/i18n';
import {
  type ApplianceUpdateCheckOutput,
  type ProtocolVersion,
  protocolAtLeast,
  UPDATE_CHECK_MINOR,
} from '@whombat/protocol/session';
import { clientTranslator, EN } from '../i18n/catalog';
import type { ApplianceStatus } from '../session/managed-ops';
import { MANAGED_TEXT } from './status-copy';

/* Updates ------------------------------------------------------------------------------------------------- */

export type UpdateStatus = NonNullable<ApplianceStatus['update']>;
type Dot = 'ok' | 'warn' | 'bad' | 'mut';

export const UPDATE_TEXT = {
  forwardRepair: EN['update.forwardRepair'],
  forwardRepairMeta: EN['update.forwardRepairMeta'],
  stillOn: (release: string) => `Your Whombat is still on ${release}.`,
  nothingChanged: EN['update.nothingChanged'],
  updatedTo: (release: string, day: string) => `Updated to ${release} on ${day}`,
  waitingFor: {
    boundary: EN['update.waitingFor.boundary'],
    checkpoint: EN['update.waitingFor.checkpoint'],
    checkpointNoDestination: EN['update.waitingFor.checkpointNoDestination'],
    window: EN['update.waitingFor.window'],
    hold: EN['update.waitingFor.hold'],
    lock: EN['update.waitingFor.lock'],
    metadata: EN['update.waitingFor.metadata'],
    owner: EN['update.waitingFor.owner'],
  } as Record<string, string>,
  waitingGeneric: EN['update.waitingGeneric'],
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
  setUpBackups: EN['update.setUpBackups'],
  breakingWait: EN['update.breakingWait'],
  /* Ask before updating (Whombat ask-before-updating.md ABU-01, ABU-03). */
  install: EN['update.install'],
  failed: EN['update.failed'],
  installing: EN['update.installing'],
  ask: EN['update.ask'],
  askOn: EN['update.askOn'],
  askOff: EN['update.askOff'],
  askSwitched: (on: boolean) =>
    on ? 'Updates now wait for your yes.' : 'Updates install by themselves again.',
  paused: EN['update.paused'],
  /* Check for updates (Whombat check-for-updates.md). */
  check: EN['update.check'],
  checking: EN['update.checking'],
  checked: {
    found: EN['update.checked.found'],
    foundAsk: EN['update.checked.foundAsk'],
    upToDate: EN['update.checked.upToDate'],
    nothingNewer: EN['update.checked.nothingNewer'],
    refused: EN['update.checked.refused'],
  },
} as const;

function hasUpdateBlockerKey(key: string): key is Extract<keyof typeof EN, `update.blockers.${string}`> {
  return Object.hasOwn(EN, key);
}

export function updateText(locale?: string | null) {
  const tr = clientTranslator(locale);
  if (tr.language === 'en') return UPDATE_TEXT;
  return {
    forwardRepair: tr.t('update.forwardRepair'),
    forwardRepairMeta: tr.t('update.forwardRepairMeta'),
    stillOn: (release: string) => tr.t('update.stillOn', { release }),
    nothingChanged: tr.t('update.nothingChanged'),
    updatedTo: (release: string, day: string) => tr.t('update.updatedTo', { release, day }),
    waitingFor: {
      boundary: tr.t('update.waitingFor.boundary'),
      checkpoint: tr.t('update.waitingFor.checkpoint'),
      checkpointNoDestination: tr.t('update.waitingFor.checkpointNoDestination'),
      window: tr.t('update.waitingFor.window'),
      hold: tr.t('update.waitingFor.hold'),
      lock: tr.t('update.waitingFor.lock'),
      metadata: tr.t('update.waitingFor.metadata'),
      owner: tr.t('update.waitingFor.owner'),
    },
    waitingGeneric: tr.t('update.waitingGeneric'),
    since: (when: string) => tr.t('update.since', { when }),
    blocker: (count: number, kind: string) => {
      const key = `update.blockers.${kind}`;
      return hasUpdateBlockerKey(key)
        ? tr.tp(key, count)
        : tr.t('update.blocker', { count, name: kind.replace(/_/g, ' ') });
    },
    setUpBackups: tr.t('update.setUpBackups'),
    breakingWait: tr.t('update.breakingWait'),
    install: tr.t('update.install'),
    failed: tr.t('update.failed'),
    installing: tr.t('update.installing'),
    ask: tr.t('update.ask'),
    askOn: tr.t('update.askOn'),
    askOff: tr.t('update.askOff'),
    askSwitched: (on: boolean) => tr.t(on ? 'update.askEnabled' : 'update.askDisabled'),
    paused: tr.t('update.paused'),
    check: tr.t('update.check'),
    checking: tr.t('update.checking'),
    checked: {
      found: tr.t('update.checked.found'),
      foundAsk: tr.t('update.checked.foundAsk'),
      upToDate: tr.t('update.checked.upToDate'),
      nothingNewer: tr.t('update.checked.nothingNewer'),
      refused: tr.t('update.checked.refused'),
    },
  };
}

/** Whether this Whombat checks for updates when asked (`appliance.update.check`; an older one looks only each hour). */
export function hasUpdateCheck(protocol: ProtocolVersion | null | undefined): boolean {
  return protocolAtLeast(protocol, UPDATE_CHECK_MINOR);
}

/** What the person is told after “Check for updates”: a version found waits for their yes where they asked for that. */
export function updateCheckNotice(
  outcome: ApplianceUpdateCheckOutput['outcome'],
  askFirst: boolean | undefined,
  locale?: string | null,
): string {
  const words = updateText(locale);
  if (outcome === 'found') return askFirst ? words.checked.foundAsk : words.checked.found;
  return words.checked[outcome];
}

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
  if (update.paused && update.state !== 'Activating' && update.state !== 'Verifying') return null;
  if (MOVING.has(update.state)) return 5_000;
  if (update.state === 'WaitingForSafeBoundary' || update.waiting) return 15_000;
  return null;
}

/** “14:02” today, else “27 September”, in the device's time zone. */
export function sinceText(
  iso: string,
  now: Date = new Date(),
  timeZone?: string,
  locale?: string | null,
): string {
  const at = new Date(iso);
  const day = (d: Date) =>
    new Intl.DateTimeFormat(formatLocaleOf(locale), {
      day: 'numeric',
      month: 'long',
      ...(timeZone && { timeZone }),
    }).format(d);
  if (day(at) === day(now))
    return new Intl.DateTimeFormat(formatLocaleOf(locale), {
      hour: '2-digit',
      minute: '2-digit',
      ...(timeZone && { timeZone }),
    }).format(at);
  return day(at);
}

/** “29 September 2026”. */
function dayText(iso: string, timeZone?: string, locale?: string | null): string {
  return new Intl.DateTimeFormat(formatLocaleOf(locale), {
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
  options: { now?: Date; timeZone?: string; locale?: string | null } = {},
): UpdateView {
  const u = status.update;
  const rows: UpdateRow[] = [];
  const noDestination = status.backup.state === 'unprotected';
  if (!u) return { rows, summaryOf: null, pollMs: null };
  const words = updateText(options.locale);
  const tr = clientTranslator(options.locale);
  const versionText = (release: string) => tr.t('managed.status.version', { v: release });
  const stateText = (state: string) => {
    const key = `managed.status.update.${state}` as Extract<
      keyof typeof EN,
      `managed.status.update.${string}`
    >;
    return Object.hasOwn(EN, key) ? tr.t(key) : state;
  };
  const waitingFor: Readonly<Record<string, string>> = words.waitingFor;
  const now = options.now ?? new Date();
  const version = versionText(u.current);

  if (u.state === 'ForwardRepairRequired') {
    rows.push({
      dot: 'warn',
      title: words.forwardRepair,
      meta: [
        version,
        u.failureDetail ? describeUpdateFailure(u.failureDetail) : words.forwardRepairMeta,
      ].join(' · '),
    });
    if (u.paused) rows.push({ dot: 'mut', title: words.paused });
  } else if (NOT_THROUGH.has(u.state)) {
    const why = u.failureDetail ? describeUpdateFailure(u.failureDetail) : null;
    const settled = why && /Nothing was changed\.|went back to the release it ran before\./.test(why);
    rows.push({
      dot: 'bad',
      title: stateText(u.state),
      meta: [why, words.stillOn(u.current), settled ? null : words.nothingChanged].filter(Boolean).join(' '),
    });
    if (u.paused) rows.push({ dot: 'mut', title: words.paused });
  } else if (u.paused && u.state !== 'Activating' && u.state !== 'Verifying') {
    // A paused channel stops offering and holding back updates before activation without changing anything else.
    rows.push({
      dot: 'mut',
      title: words.paused,
      meta: version,
    });
  } else {
    const waiting = u.waiting ?? null;
    const reason =
      waiting?.reason === 'checkpoint' &&
      (noDestination || waiting.blockers.some((b) => b.kind === 'no_destination'))
        ? words.waitingFor.checkpointNoDestination
        : waiting
          ? (waitingFor[waiting.reason] ?? words.waitingGeneric)
          : null;
    const blockers = (waiting?.blockers ?? [])
      .filter((b) => b.count > 0 && b.kind !== 'no_destination')
      .map((b) => words.blocker(b.count, b.kind));
    // Waiting for the owner's yes is the update being ready, whatever step the manager is at.
    const forOwner = waiting?.reason === 'owner' && u.candidate ? u.candidate : null;
    rows.push({
      dot: u.state === 'Healthy' && !waiting ? 'ok' : waiting ? 'warn' : 'mut',
      title: stateText(forOwner ? 'Staged' : u.state),
      meta: [version, !waiting && u.deferredReason ? (MANAGED_TEXT.deferred[u.deferredReason] ?? null) : null]
        .filter(Boolean)
        .join(' · '),
    });
    if (waiting && reason)
      rows.push({
        dot: 'warn',
        title: reason,
        meta: [
          ...(forOwner ? [versionText(forOwner)] : []),
          ...blockers,
          words.since(sinceText(waiting.since, now, options.timeZone, options.locale)),
        ].join(' · '),
        ...(waiting.reason === 'checkpoint' && noDestination ? { action: 'backup' as const } : {}),
        ...(forOwner ? { action: 'install' as const, release: forOwner } : {}),
      });
  }

  // What it brought is control's to say (`releaseSummary`): the screen puts it under this row.
  if (u.lastUpdate && u.state !== 'ForwardRepairRequired')
    rows.push({
      dot: 'ok',
      title: words.updatedTo(
        u.lastUpdate.release,
        dayText(u.lastUpdate.at, options.timeZone, options.locale),
      ),
      lastUpdate: true,
    });

  return {
    rows,
    summaryOf: u.lastUpdate?.release ?? null,
    pollMs: updatePollMs(u),
  };
}

/**
 * Whether an update waits for the owner's yes (“Ask before updating” is on and a release is ready), the release it
 * would install, else null: the account menu's and the phone's Settings line say “Update ready” then.
 */
export function updateReady(status: Pick<ApplianceStatus, 'update'> | null | undefined): string | null {
  const u = status?.update;
  if (!u || u.paused) return null;
  return u.waiting?.reason === 'owner' && u.candidate ? u.candidate : null;
}

/** The short words for whether this Whombat is up to date, beside its version. */
export const UPDATE_STATE_WORDS = {
  upToDate: EN['update.state.upToDate'],
  ready: EN['update.state.ready'],
} as const;

export function updateStateWords(locale?: string | null) {
  const tr = clientTranslator(locale);
  if (tr.language === 'en') return UPDATE_STATE_WORDS;
  return {
    upToDate: tr.t('update.state.upToDate'),
    ready: tr.t('update.state.ready'),
  };
}

/** The “Ask before updating” switch (ABU-01): null where the box's manager can't hold updates for the owner. */
export function askFirstView(
  status: Pick<ApplianceStatus, 'update'>,
  locale?: string | null,
): { on: boolean; title: string; meta: string } | null {
  const on = status.update?.askFirst;
  if (on === undefined) return null;
  const words = updateText(locale);
  return { on, title: words.ask, meta: on ? words.askOn : words.askOff };
}

/** Until a backup destination exists: what that blocks (This Whombat, BACKUPS). */
export function backupBlocksText(
  status: Pick<ApplianceStatus, 'backup'>,
  locale?: string | null,
): string | null {
  return status.backup.state === 'unprotected' ? updateText(locale).breakingWait : null;
}

/* What's new ---------------------------------------------------------------------------------------------- */

/**
 * The web app's “What’s new” page: `docs/changelog.md` in plain words, served by the app itself. On the hosted app it
 * opens without signing in, so the phone opens it in the browser.
 */
export const WHATS_NEW_PATH = '/settings/whats-new';

export const WHATS_NEW_TEXT = {
  link: EN['whatsNew.link'],
  linkMeta: EN['whatsNew.linkMeta'],
  open: EN['whatsNew.open'],
  notice: EN['whatsNew.notice'],
  see: EN['whatsNew.see'],
  dismiss: EN['whatsNew.dismiss'],
} as const;

export function whatsNewText(locale?: string | null) {
  const tr = clientTranslator(locale);
  if (tr.language === 'en') return WHATS_NEW_TEXT;
  return {
    link: tr.t('whatsNew.link'),
    linkMeta: tr.t('whatsNew.linkMeta'),
    open: tr.t('whatsNew.open'),
    notice: tr.t('whatsNew.notice'),
    see: tr.t('whatsNew.see'),
    dismiss: tr.t('whatsNew.dismiss'),
  };
}

/**
 * What a device remembers before this Whombat's first update: it has looked, and there was no update yet. The first
 * update after it then gets the notice, as any later one does.
 */
export const WHATS_NEW_NO_UPDATE = 'none';

/** The release the last update installed, null when there is none to tell about (none yet, or one that went wrong). */
export function lastUpdatedRelease(
  status: Pick<ApplianceStatus, 'update'> | null | undefined,
): string | null {
  const u = status?.update;
  if (!u?.lastUpdate || u.state === 'ForwardRepairRequired') return null;
  return u.lastUpdate.release;
}

/**
 * What a device keeps as seen: the release and when it was installed (null before the first update), and `told: false`
 * while the notice for it was kept but not shown yet (the phone keeps it before it shows, and may be closed between).
 */
interface SeenRelease {
  release: string;
  at: string | null;
  told?: false;
}

/** What is kept, read back; a bare release (kept without its time) still counts, as told. */
function readSeenRelease(seen: string): SeenRelease {
  try {
    const v = JSON.parse(seen) as Partial<SeenRelease> | null;
    if (v && typeof v.release === 'string')
      return {
        release: v.release,
        at: typeof v.at === 'string' ? v.at : null,
        ...(v.told === false && { told: false as const }),
      };
  } catch {
    // A bare release.
  }
  return { release: seen, at: null };
}

/** What to keep once the notice for `release` has shown, or null when what is kept says nothing is waiting for it. */
export function whatsNewTold(seen: string | null, release: string): string | null {
  if (seen === null) return null;
  const kept = readSeenRelease(seen);
  if (kept.release !== release || kept.told !== false) return null;
  return JSON.stringify({ release: kept.release, at: kept.at } satisfies SeenRelease);
}

/**
 * The one-time “Whombat updated · See what’s new” notice, from the Whombat's status and what this device saw last
 * (`seen`, as `value` was kept; null when it never looked): `show` once the last update is another release installed
 * after the one seen; `remember` (quietly keep `value`) the first time a device looks, since it has nothing to compare
 * with; else `none`, also for an answer older than what is kept (a page that hasn't asked again yet), so nothing goes
 * back to an older release. Each app keeps `value` as soon as it shows the notice, so it shows once even when nobody
 * taps it; one that keeps the release before it shows keeps `untold`, then `whatsNewTold`'s value once it showed.
 */
export function whatsNewNotice(
  status: Pick<ApplianceStatus, 'update'> | null | undefined,
  seen: string | null,
): { action: 'show' | 'remember' | 'none'; release: string; value: string; untold: string } {
  const release = lastUpdatedRelease(status) ?? WHATS_NEW_NO_UPDATE;
  const at = release === WHATS_NEW_NO_UPDATE ? null : (status?.update?.lastUpdate?.at ?? null);
  const value = JSON.stringify({ release, at } satisfies SeenRelease);
  const untold = JSON.stringify({ release, at, told: false } satisfies SeenRelease);
  // A status without update facts (an unmanaged box, or none read yet) says nothing either way.
  if (!status?.update) return { action: 'none', release, value, untold };
  if (seen === null) {
    // While a repair is needed there is nothing to tell, but the last update is still the one to compare with later:
    // remembered as `none`, the repair starting would bring back the notice for that old release.
    const last = status.update.lastUpdate;
    if (release === WHATS_NEW_NO_UPDATE && last) {
      const known = { release: last.release, at: last.at ?? null } satisfies SeenRelease;
      return { action: 'remember', release: known.release, value: JSON.stringify(known), untold };
    }
    return { action: 'remember', release, value, untold };
  }
  const kept = readSeenRelease(seen);
  if (release === WHATS_NEW_NO_UPDATE) return { action: 'none', release, value, untold };
  // Kept before it could be shown: it still shows, until it is marked told.
  if (release === kept.release)
    return { action: kept.told === false ? 'show' : 'none', release, value, untold };
  if (kept.at && at && Date.parse(at) <= Date.parse(kept.at))
    return { action: 'none', release, value, untold };
  return { action: 'show', release, value, untold };
}

/** How long after the box's session opens again a status without update facts is asked for again. */
export const WHATS_NEW_BACK_MS = 60_000;

/**
 * How often the notice asks for the status again: every 5 s while an update is being installed (its last update
 * changes once it is done, after the box is back), as About does, through its last checks even while updates are
 * paused; and for a short while after the box is back (`justBack`) while it hasn't said how its updates stand yet or
 * a read failed (`failed`). Never while an update waits (for the owner's yes, a backup, the maintenance window: that can take days).
 */
export function whatsNewPollMs(
  status: Pick<ApplianceStatus, 'update'> | null | undefined,
  { justBack = false, failed = false }: { justBack?: boolean; failed?: boolean } = {},
): number | false {
  // A read that failed just after the box is back (it may still be starting): ask again soon.
  if (justBack && failed) return 5_000;
  if (!status) return false;
  const u = status.update;
  if (!u) return justBack ? 5_000 : false;
  if (u.waiting) return false;
  if (u.paused && u.state !== 'Activating' && u.state !== 'Verifying') return false;
  return MOVING.has(u.state) ? 5_000 : false;
}

/**
 * The notice's `refetchInterval` for a status query: `whatsNewPollMs` with the box just back (`backAt`, when the
 * session last opened again) and whether the last read failed.
 */
export function whatsNewRefetchInterval(
  backAt: () => number,
  now: () => number = Date.now,
): (query: { state: { data?: Pick<ApplianceStatus, 'update'> | null; status: string } }) => number | false {
  return (query) =>
    whatsNewPollMs(query.state.data, {
      justBack: now() - backAt() < WHATS_NEW_BACK_MS,
      failed: query.state.status === 'error',
    });
}

/** What `onSessionReopen` needs of the box's session. */
interface SessionStates {
  state(): { status: string };
  onState(listener: (state: { status: string }) => void): () => void;
}

/**
 * Runs `run` each time the box's session opens again after a drop (an update restarts the box), never for the session
 * already open. Returns the way to stop.
 */
export function onSessionReopen(session: SessionStates, run: () => void): () => void {
  let wasOpen = session.state().status === 'open';
  return session.onState((s) => {
    const open = s.status === 'open';
    if (open && !wasOpen) run();
    wasOpen = open;
  });
}

/** Where a device keeps what it saw, one per Whombat (letters a phone's secure store takes). */
export function whatsNewSeenKey(whombat: string): string {
  return `whombat.whatsNew.seen.${whombat.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}
