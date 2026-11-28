/**
 * Docker Compose app updates on the web and the phone (Whombat app-updates.md): the line under an app in a server's
 * apps list (“Update available: 2.4”, “Updating…”, how its last update went), whether it shows Update, why the card
 * will ask, and the list's one note (the server's helper is older; containers `docker run` started are watch-only).
 * Update itself asks through the approval card: `hosts.manage` op `app.update` answers the card's number. Pure.
 */
import {
  type AppUpdateState,
  agentReportsApps,
  appUpdateRisk,
  appUpdateState,
  type HostGuest,
  versionWords,
} from '@whombat/core/domain';
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from '../i18n/catalog';
import { HOSTS_APP_UPDATES_WORDS } from '../i18n/messages/connectionsHosts/appUpdates';
import { formatAgoIso } from './format';

/** The words of app updates, in a locale (English when none is given). */
export function appUpdateWords(locale?: string | null) {
  return clientTree(locale, HOSTS_APP_UPDATES_WORDS);
}

/** One app in a list: its line and whether Update shows. */
export interface AppUpdateRow {
  state: AppUpdateState;
  /** The line under its name, or null when there is nothing to say. */
  line: string | null;
  /** `note`: an update waits (amber, as a change waiting); `bad`: the last one didn't work; `plain`: news. */
  tone: 'note' | 'bad' | 'plain';
  /** Update shows (it asks through the approval card). */
  update: boolean;
  /** Why the card will ask first, in one short line, or null. */
  asks: string | null;
}

const NOTHING: AppUpdateRow = { state: 'none', line: null, tone: 'plain', update: false, asks: null };

/** How long the last update stays in the line. */
const LAST_SHOWN_MS = 7 * 24 * 3600_000;

/**
 * One container's update row (pure). `manage`: the person may change this server (Full control); `agentHasApps`: its
 * helper reports apps (`agentReportsApps`).
 */
export function appUpdateRow(
  g: HostGuest,
  opts: { agentHasApps: boolean; manage: boolean; now: number; locale?: string | null },
): AppUpdateRow {
  if (g.platform !== 'docker') return NOTHING;
  const w = appUpdateWords(opts.locale);
  const state = appUpdateState(g, opts.agentHasApps);
  const risk = appUpdateRisk(g);
  const asks = risk.reasons.includes('database')
    ? w.asks.database
    : risk.reasons.includes('major')
      ? w.asks.major
      : null;
  if (state === 'updating') return { state, line: w.updating, tone: 'plain', update: false, asks: null };
  if (state === 'blocked') return { state, line: w.pinned, tone: 'plain', update: false, asks: null };
  if (state === 'available')
    return {
      state,
      line: risk.to ? interpolate(w.availableTo, { version: risk.to }) : w.available,
      tone: 'note',
      update: opts.manage,
      asks,
    };
  const last = g.app?.last ?? null;
  if (last && (!last.at || opts.now - Date.parse(last.at) <= LAST_SHOWN_MS)) {
    const ago = last.at ? formatAgoIso(last.at, opts.now, opts.locale) : '';
    const from = versionWords(last.from);
    const to = versionWords(last.to);
    const line =
      last.status === 'updated'
        ? to
          ? interpolate(w.last.updated, { version: to, ago })
          : interpolate(w.last.updatedPlain, { ago })
        : last.status === 'rolled_back'
          ? to && from
            ? interpolate(w.last.rolledBack, { to, from })
            : w.last.rolledBackPlain
          : last.status === 'held'
            ? to
              ? interpolate(w.last.held, { version: to })
              : null
            : last.status === 'failed'
              ? w.last.failed
              : null;
    if (line)
      return {
        state,
        line: line.trim(),
        tone: last.status === 'updated' ? 'plain' : 'bad',
        update: false,
        asks: null,
      };
  }
  return { state, line: null, tone: 'plain', update: false, asks: null };
}

/**
 * The apps list's one note, or null: the server's helper is older than app updates, or some containers with a newer
 * image were started with `docker run` (watch-only).
 */
export function appUpdatesNote(guests: readonly HostGuest[], locale?: string | null): string | null {
  const docker = guests.filter((g) => g.platform === 'docker');
  if (!docker.length) return null;
  const w = appUpdateWords(locale);
  const hasApps = agentReportsApps(docker);
  if (!hasApps && docker.some((g) => g.project)) return w.outdated;
  if (docker.some((g) => !g.app && g.updateAvailable === true)) return w.composeOnly;
  return null;
}
