/**
 * App updates in words (app-updates.md): the approval card's ask and what it adds before the yes, and the one plain line
 * when the update ended (“immich_server is updated to 2.4.”, “immich_server 2.4 didn’t start, so I put 2.3 back.”).
 * Pure. The line at the end is said in the reader's language (`hosts.apps.*`); the card's ask and note stay English,
 * like the rest of a Servers call's approval card.
 */
import { type HostAppResult, versionWords } from '@whombat/core';
import { tpServer, tServer } from '../i18n/catalog';

type Args = Readonly<Record<string, unknown>>;

/** The apps a call names, as people see them: the container names, without `docker:`. */
export function appNames(args: Args): string[] {
  const raw = Array.isArray(args.apps) ? args.apps : [];
  return raw
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .map((x) =>
      x
        .trim()
        .replace(/^docker:/, '')
        .slice(0, 80),
    );
}

/** “immich_server”, “immich_server and immich_ml”, “3 apps”; in `locale` (English when none). */
export function appListWords(names: readonly string[], locale?: string | null): string {
  if (names.length === 0) return tServer(locale, 'hosts.apps.list.none');
  if (names.length === 1) return names[0] as string;
  if (names.length === 2)
    return tServer(locale, 'hosts.apps.list.two', { first: names[0] as string, second: names[1] as string });
  return tpServer(locale, 'hosts.apps.list.many', names.length, { n: names.length });
}

/** The card's ask and the running line. */
export function appAskPhrase(args: Args): { ask: string; doing: string } {
  const server =
    typeof args.server === 'string' && args.server.trim() ? args.server.trim().slice(0, 80) : 'a server';
  const list = appListWords(appNames(args));
  return { ask: `update ${list} on ${server}`, doing: `Updating ${list} on ${server}` };
}

/**
 * What the card adds before the yes: why it asks (a database's update can't be undone by going back; a new major
 * version), that the version isn't known, and the snapshot first. Null when there is nothing to add.
 */
export function appCardNote(args: Args): string | null {
  const reasons = Array.isArray(args.reasons) ? args.reasons.filter((x) => typeof x === 'string') : [];
  const parts: string[] = [];
  if (reasons.includes('database'))
    parts.push(
      'It’s a database: its update can change its data, and putting the old version back can’t undo that.',
    );
  if (reasons.includes('major')) parts.push('This is a new major version, which can change how it works.');
  if (reasons.includes('version_unknown') && !reasons.includes('major'))
    parts.push('I can’t tell its version numbers, so this may be a new major version.');
  if (args.snapshot === true) parts.push('I take a snapshot of the server first.');
  parts.push('If it doesn’t start, I put the previous version back.');
  return parts.join(' ');
}

const v = (x: string | null | undefined) => versionWords(x ?? null);

/** One app's outcome in one sentence, in `locale` (English when none). */
export function appOutcomeLine(
  r: Pick<HostAppResult, 'app' | 'status' | 'reason' | 'from' | 'to'>,
  server: string,
  locale?: string | null,
): string {
  const t = (key: Parameters<typeof tServer>[1], vars: Record<string, string> = {}) =>
    tServer(locale, key, { app: r.app, server, ...vars });
  const from = v(r.from);
  const to = v(r.to);
  switch (r.status) {
    case 'updated':
      return to && to !== from ? t('hosts.apps.updatedTo', { to }) : t('hosts.apps.updated');
    case 'current':
      return t('hosts.apps.current');
    case 'held':
      return to && from ? t('hosts.apps.held', { to, from }) : t('hosts.apps.heldUnknown');
    case 'rolled_back':
      return to && from ? t('hosts.apps.rolledBack', { to, from }) : t('hosts.apps.rolledBackUnknown');
    default:
      switch (r.reason) {
        case 'pull':
          return t('hosts.apps.pull');
        case 'no_files':
          return t('hosts.apps.noFiles');
        case 'no_cli':
          return t('hosts.apps.noCli');
        case 'gone':
          return t('hosts.apps.gone');
        case 'back_failed':
          return to ? t('hosts.apps.backFailed', { to }) : t('hosts.apps.backFailedUnknown');
        case 'timeout':
          return t('hosts.apps.timeout');
        case 'changed':
          return t('hosts.apps.changed');
        case 'interrupted':
          return t('hosts.apps.interrupted');
        default:
          return t('hosts.apps.failed');
      }
  }
}

/**
 * The line when an app update ended: each app's sentence (at most four, then how many more), in `locale`, or null when
 * the task didn't say (the caller keeps its own words).
 */
export function appsOutcomeText(
  results: readonly HostAppResult[] | null | undefined,
  server: string,
  locale?: string | null,
): string | null {
  if (!results?.length) return null;
  const lines = results.slice(0, 4).map((r) => appOutcomeLine(r, server, locale));
  const more = results.length - 4;
  if (more > 0) lines.push(tpServer(locale, 'hosts.apps.more', more, { n: more }));
  return lines.join(' ');
}
