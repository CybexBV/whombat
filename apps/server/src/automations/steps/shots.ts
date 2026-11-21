/**
 * A fix's before and after screenshots in its pull request (docs/decisions/report-trackers.md TA-52). The T3 Code
 * thread that made the fix pushes them to `pr-shots/<branch>`, a branch that holds only them, and the pull request shows
 * them as a table: a row per screen, its before beside its after. The pictures stay in the repository, so a private
 * one shows them only to people who may read it, and chat never gets a picture it can't load.
 */
import { SHOTS_BRANCH_PREFIX } from '@whombat/core';

/** The pictures a pull request shows at most. */
export const SHOTS_MAX = 12;
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const PAIRED = /^(before|after)(?:[-_. ]+(.*))?$/i;

/** The screenshots branch of a fix's branch: `pr-shots/feat/tracker-2-22`. */
export const shotsBranch = (branch: string): string => `${SHOTS_BRANCH_PREFIX}${branch}`;

const safe = (s: string): string => s.replace(/[<>"|`\\[\]]/g, '').trim();

/**
 * The pull request's “Screenshots” part for the files at the top of a screenshots branch at commit `sha`, or null when
 * none of them is a picture. `before-<screen>.png` and `after-<screen>.png` share a row; any other picture follows the
 * table on its own.
 */
export function shotsSection(repo: string, sha: string, names: readonly string[]): string | null {
  const images = names.filter((n) => IMAGE.test(n) && !n.includes('/')).sort((a, b) => a.localeCompare(b));
  if (!images.length) return null;
  const rows = new Map<string, { before?: string; after?: string }>();
  const loose: string[] = [];
  for (const name of images) {
    const m = PAIRED.exec(name.replace(IMAGE, ''));
    if (!m) {
      loose.push(name);
      continue;
    }
    const screen = safe((m[2] ?? '').replace(/[-_.]+/g, ' ')) || 'Screen';
    const side = (m[1] as string).toLowerCase() as 'before' | 'after';
    rows.set(screen, { ...rows.get(screen), [side]: name });
  }
  const url = (name: string) => `https://github.com/${repo}/blob/${sha}/${encodeURIComponent(name)}?raw=true`;
  const img = (name: string | undefined, alt: string) =>
    name ? `<img src="${url(name)}" width="380" alt="${safe(alt)}">` : '';
  const lines = ['## Screenshots', ''];
  let shown = 0;
  if (rows.size) {
    lines.push('| | Before | After |', '|---|---|---|');
    for (const [screen, row] of rows) {
      if (shown >= SHOTS_MAX) break;
      lines.push(
        `| ${screen} | ${img(row.before, `Before: ${screen}`)} | ${img(row.after, `After: ${screen}`)} |`,
      );
      shown += (row.before ? 1 : 0) + (row.after ? 1 : 0);
    }
  }
  for (const name of loose) {
    if (shown >= SHOTS_MAX) break;
    lines.push('', img(name, name.replace(IMAGE, '')));
    shown += 1;
  }
  return lines.join('\n');
}
