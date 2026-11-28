/**
 * App updates in words (app-updates.md): the approval card's ask and what it adds before the yes, and the one plain line
 * when the update ended (“immich_server is updated to 2.4.”, “immich_server 2.4 didn’t start, so I put 2.3 back.”).
 * Pure; English, said in the reader's language by the server's phrasebook (`phrase.apps.*`).
 */
import { type HostAppResult, versionWords } from '@whombat/core';

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

/** “immich_server”, “immich_server and immich_ml”, “3 apps”. */
export function appListWords(names: readonly string[]): string {
  if (names.length === 0) return 'the apps';
  if (names.length === 1) return names[0] as string;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.length} apps`;
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
  if (reasons.includes('version_unknown')) parts.push('The new version isn’t known before it’s downloaded.');
  if (args.snapshot === true) parts.push('I take a snapshot of the server first.');
  parts.push('If it doesn’t start, I put the previous version back.');
  return parts.join(' ');
}

const v = (x: string | null | undefined) => versionWords(x ?? null);

/** One app's outcome in one sentence. */
export function appOutcomeLine(
  r: Pick<HostAppResult, 'app' | 'status' | 'reason' | 'from' | 'to'>,
  server: string,
): string {
  const app = r.app;
  const from = v(r.from);
  const to = v(r.to);
  switch (r.status) {
    case 'updated':
      return to && to !== from ? `${app} is updated to ${to}.` : `${app} is updated.`;
    case 'current':
      return `${app} was already up to date.`;
    case 'held':
      return to && from
        ? `${app} ${to} is a new major version, so I left ${from} running for you to decide.`
        : `${app}’s update is a new major version, so I left it as it was for you to decide.`;
    case 'rolled_back':
      return to && from
        ? `${app} ${to} didn’t start, so I put ${from} back.`
        : `${app}’s update didn’t start, so I put the previous version back.`;
    default:
      switch (r.reason) {
        case 'pull':
          return `I couldn’t download ${app}’s update.`;
        case 'no_files':
          return `I couldn’t update ${app}: its Compose files aren’t where it was started from any more.`;
        case 'no_cli':
          return `I couldn’t update ${app}: Docker Compose isn’t installed on ${server}.`;
        case 'gone':
          return `${app} isn’t on ${server} any more.`;
        case 'back_failed':
          return `${app}${to ? ` ${to}` : ''} didn’t start, and putting the previous version back didn’t work either: it needs a look.`;
        case 'timeout':
          return `There wasn’t time left to update ${app}.`;
        default:
          return `I couldn’t update ${app}.`;
      }
  }
}

/**
 * The line when an app update ended: each app's sentence (at most four, then how many more), or null when the task
 * didn't say (the caller keeps its own words).
 */
export function appsOutcomeText(
  results: readonly HostAppResult[] | null | undefined,
  server: string,
): string | null {
  if (!results?.length) return null;
  const lines = results.slice(0, 4).map((r) => appOutcomeLine(r, server));
  const more = results.length - 4;
  if (more > 0) lines.push(more === 1 ? 'And 1 more.' : `And ${more} more.`);
  return lines.join(' ');
}
