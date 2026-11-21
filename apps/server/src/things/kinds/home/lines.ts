/**
 * Lines about several items (quiet-notices.md QN-03, QN-S20): one line per item, at most three lines, the last “N more”
 * with the shared subject (`moreSubject`) and the rest's ids hashed as its episode, so an Ignore of it lasts while the
 * rest is the same items. A thin wrapper of `things/quiet/items.ts` for the home and first kinds.
 */
import { moreSubject, shortHash, splitItems } from '../../quiet/items';
import { defaultNature, type KindNotice, type LooseNotice, type NoticeSubject } from '../../quiet/types';

export function itemLines<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  one: (item: T) => KindNotice,
  rest: (more: readonly T[], subject: NoticeSubject, episode: string) => KindNotice,
): KindNotice[] {
  const { each, rest: others } = splitItems(items);
  const out = each.map(one);
  if (others.length) out.push(rest(others, moreSubject(others.length), shortHash(others.map(idOf))));
  return out;
}

const RANK = { info: 0, warn: 1, bad: 2 } as const;

/**
 * The card's dot and reason from a kind's lines (QN-02): the worst line that isn't a heads-up, its badge or title. The
 * health pass works them out again with what is ignored and confirmed; this is what the lines say by themselves.
 */
export function statusOf(notices: readonly LooseNotice[]): {
  status: 'ok' | 'warn' | 'bad';
  reason?: string;
} {
  const worst = notices
    .filter((n) => (n.nature ?? defaultNature(n)) !== 'fyi' && n.tone !== 'info')
    .sort((a, b) => RANK[b.tone] - RANK[a.tone])[0];
  if (!worst) return { status: 'ok' };
  return {
    status: worst.tone === 'bad' ? 'bad' : 'warn',
    reason: (worst.badge ?? worst.title).slice(0, 120),
  };
}

/** A subject's name: at most 80 characters (`NoticeSubject.name`). */
export const subjectName = (name: string) => (name.length > 80 ? `${name.slice(0, 79)}…` : name || 'It');

/** A line's id on the page from its own and its item's (unique within the page, at most 120 characters). */
export const lineId = (id: string, item?: string) => (item ? `${id}-${item}` : id).slice(0, 120);
