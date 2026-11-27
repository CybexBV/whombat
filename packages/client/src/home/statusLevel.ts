/**
 * One status scale for servers, connections and Inbox items (docs/decisions/ui-refresh-status.md): Not working, Needs a
 * look, Learning, Connected, each with a plain reason. The sidebar draws it as a mark by shape, a card as a pill with
 * its word, and Overview and the Inbox sort by it. Derived from what the Whombat already sends (`ThingSummary.status`
 * and `reason`, a server's status, an item's severity), so web and phone say the same. Pure.
 */
import type { HomeSeverity, NeedsYouItem, ThingStatus, ThingSummary } from '@whombat/core';
import type { HostServerStatus } from '@whombat/core/domain';
import { clientTranslator } from '../i18n/catalog';

export const STATUS_LEVELS = ['notWorking', 'needsLook', 'learning', 'connected'] as const;
export type StatusLevel = (typeof STATUS_LEVELS)[number];

/** The pill's word for each level; a thing that is offline says “Offline” (its own word) instead of “Not working”. */
export function statusLevelWords(locale?: string | null): Record<StatusLevel, string> {
  const tr = clientTranslator(locale);
  return {
    notWorking: tr.t('statusLevel.notWorking'),
    needsLook: tr.t('statusLevel.needsLook'),
    learning: tr.t('statusLevel.learning'),
    connected: tr.t('statusLevel.connected'),
  };
}

export const STATUS_LEVEL_WORDS: Record<StatusLevel, string> = statusLevelWords();

/** The longest reason a mark's name or a card's line carries; the rest is on the thing's page. */
export const STATUS_REASON_MAX = 60;

/** How a status shows: its level, the pill's word and why (null when there is nothing to say). */
export interface StatusView {
  level: StatusLevel;
  word: string;
  reason: string | null;
}

/** A thing's level: a problem or offline is not working; a device still being learned is learning. */
export function thingStatusLevel(status: ThingStatus): StatusLevel {
  switch (status) {
    case 'bad':
    case 'offline':
      return 'notWorking';
    case 'warn':
      return 'needsLook';
    case 'learning':
      return 'learning';
    // Not checked yet reads as connected, as its line already did (“Connected · used today”).
    case 'ok':
    case 'unknown':
      return 'connected';
  }
}

/** A server's level from the hosts fleet: waiting for its first report is still being learned. */
export function serverStatusLevel(status: HostServerStatus): StatusLevel {
  switch (status) {
    case 'bad':
    case 'offline':
      return 'notWorking';
    case 'warn':
      return 'needsLook';
    case 'pending':
      return 'learning';
    case 'ok':
      return 'connected';
  }
}

/**
 * An Inbox item's level: a problem of severity `bad` is not working; everything else that waits for the person (an ask,
 * a warning, a heads-up) needs a look.
 */
export function needsYouStatusLevel(
  item: Pick<NeedsYouItem, 'kind' | 'nature'> & { severity: HomeSeverity },
): StatusLevel {
  const ask = item.kind === 'approval' || item.kind === 'question' || item.nature === 'you';
  return item.severity === 'bad' && !ask ? 'notWorking' : 'needsLook';
}

/** A reason cut to `STATUS_REASON_MAX` at a word, with “…”; its first letter as sent. Null for nothing. */
export function statusReason(reason: string | null | undefined): string | null {
  const text = reason?.trim().replace(/\s+/g, ' ');
  if (!text) return null;
  if (text.length <= STATUS_REASON_MAX) return text;
  const cut = text.slice(0, STATUS_REASON_MAX - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > STATUS_REASON_MAX / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:·.]+$/, '')}…`;
}

/** A thing's status as the sidebar and Overview show it: “Offline” or “Not working”, “Needs a look”, … and why. */
export function thingStatusView(
  thing: Pick<ThingSummary, 'status' | 'reason'>,
  locale?: string | null,
): StatusView {
  const level = thingStatusLevel(thing.status);
  const words = statusLevelWords(locale);
  return {
    level,
    word: thing.status === 'offline' ? clientTranslator(locale).t('thing.status.offline') : words[level],
    reason: level === 'connected' ? null : statusReason(thing.reason),
  };
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * A mark's accessible name: “blackbox: disk array failed”, or the word without a reason (“pve-02: needs a look”); null
 * when connected (no mark).
 */
export function statusMarkLabel(name: string, view: StatusView): string | null {
  if (view.level === 'connected') return null;
  return `${name}: ${lowerFirst(view.reason ?? view.word)}`;
}

/** The order Overview and the Inbox sort by: not working first, connected last. */
export const STATUS_LEVEL_RANK: Record<StatusLevel, number> = {
  notWorking: 0,
  needsLook: 1,
  learning: 2,
  connected: 3,
};

/** `items` by level, worst first; the same level keeps the order it came in (the sidebar never sorts). */
export function sortByStatusLevel<T>(items: readonly T[], levelOf: (item: T) => StatusLevel): T[] {
  return items
    .map((item, i) => ({ item, i, rank: STATUS_LEVEL_RANK[levelOf(item)] }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.item);
}

/**
 * How many of each level, in words: “2 connected · 2 need a look · 1 learning”, “1 not working” first. `notAnswering`
 * more are down because of something else (not among `levels`): “1 not answering” after what isn't working. Empty for
 * none.
 */
export function statusSummary(
  levels: readonly StatusLevel[],
  notAnswering = 0,
  locale?: string | null,
): string {
  const tr = clientTranslator(locale);
  const count = (level: StatusLevel) => levels.filter((l) => l === level).length;
  const notWorking = count('notWorking');
  const look = count('needsLook');
  const connected = count('connected');
  const learning = count('learning');
  return [
    notWorking ? tr.t('statusLevel.summary.notWorking', { count: notWorking }) : null,
    notAnswering ? tr.t('statusLevel.summary.notAnswering', { count: notAnswering }) : null,
    connected ? tr.t('statusLevel.summary.connected', { count: connected }) : null,
    look ? tr.tp('statusLevel.summary.needsLook', look) : null,
    learning ? tr.t('statusLevel.summary.learning', { count: learning }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
