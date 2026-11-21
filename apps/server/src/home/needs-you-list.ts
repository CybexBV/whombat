/**
 * The one Needs you list (docs/decisions/needs-you-list.md NYL-01…NYL-04): what Needs you and Watch had, each item once,
 * in its group. Needs you's own items (approvals, questions, connections to sign in again, a server's critical alerts,
 * enrolments) keep their buttons; what only Watch had (warnings and hints from servers, connections that stopped, devices
 * that don't answer, failed automations, and the servers' heads-ups) becomes an item of the same shape, with the server,
 * connection or device it is about so the assistant's research and *Ask {assistant}* find it. The group is core's
 * `needsYouGroupOf`; only `you` counts. Pure: the overview reads, this puts together.
 */
import {
  type LookResearch,
  type NeedsYouItem,
  type NeedsYouKind,
  needsYouGroupOf,
  type ThingSummary,
  thingId,
  type WatchItem,
} from '@whombat/core';

/** The most items the list carries (`HomeOverview.needsYouList`). */
export const NEEDS_YOU_LIST_MAX = 300;

const SEVERITY_ORDER = { bad: 0, warn: 1, info: 2 } as const;

/** What a Watch item is as a Needs you item, by what it is about. */
function kindOf(item: Pick<WatchItem, 'source' | 'ref'>): NeedsYouKind {
  if (item.ref.kind === 'device') return 'device';
  switch (item.source) {
    case 'server':
      return item.ref.kind === 'alert' ? 'alert' : 'hint';
    case 'connection':
      return 'connection';
    case 'device':
      return 'device';
    case 'automation':
      return 'automation_run';
  }
}

/** The thing a Watch item is about, named as the sidebar names it; null for a failed automation. */
function subjectOf(
  item: Pick<WatchItem, 'source' | 'ref' | 'serverId'>,
  names: ReadonlyMap<string, string>,
): NeedsYouItem['subject'] | null {
  const named = (kind: 'server' | 'connection' | 'device', id: string) => ({
    kind,
    id,
    name: (names.get(thingId(kind, id)) ?? id).slice(0, 120),
  });
  if (item.serverId) return named('server', item.serverId);
  if (item.ref.kind === 'device') return named('device', item.ref.id);
  if (item.ref.kind === 'connection') return named('connection', item.ref.id);
  return null;
}

/**
 * A Watch item as a Needs you item: no buttons of its own (the apps draw a line's: *Ask {assistant}*, the step it found,
 * Ignore, Remind me tomorrow, Bring it back), where it is, whether it is quiet and whether the assistant can do it.
 */
export function watchNeedsYou(item: WatchItem, names: ReadonlyMap<string, string>): NeedsYouItem {
  const subject = subjectOf(item, names);
  return {
    id: item.id,
    ref: item.ref,
    kind: kindOf(item),
    severity: item.severity,
    title: item.title,
    body: item.body,
    at: item.at,
    actions: [],
    ...(subject ? { subject } : {}),
    ...(item.nature ? { nature: item.nature } : {}),
    ...(item.href ? { href: item.href } : {}),
    ...(item.state !== 'open' ? { state: item.state } : {}),
    ...(item.snoozedUntil ? { snoozedUntil: item.snoozedUntil } : {}),
    ...(item.fixable ? { fixable: true as const } : {}),
    ...(item.watch ? { watch: item.watch } : {}),
  };
}

/** The names Watch items' things go by: the servers', connections' and devices' as Home lists them. */
export function thingNames(things: readonly Pick<ThingSummary, 'id' | 'name'>[]): Map<string, string> {
  return new Map(things.map((t) => [t.id, t.name]));
}

export interface NeedsYouListInput {
  /** Needs you's own items that aren't quiet, in any order. */
  open: readonly NeedsYouItem[];
  /** Needs you's own items the person snoozed or ignored, already marked (`state`). */
  quiet: readonly NeedsYouItem[];
  /** Watch's items, every state, heads-ups too. */
  watch: readonly WatchItem[];
  names: ReadonlyMap<string, string>;
  /** The assistant's live research by thing (`server:pve-02`, `connection:con_…`). */
  research: ReadonlyMap<string, LookResearch>;
}

/**
 * The list: Needs you's items first claim their id (a critical alert and a signed-out connection are on both), taking
 * Watch's place and quiet state; then every other Watch item. Research goes on what is about a thing (never an ask),
 * each item gets its group, worst first then newest.
 */
export function needsYouList(input: NeedsYouListInput): NeedsYouItem[] {
  const watch = new Map(input.watch.map((w) => [w.id, w]));
  const own = [...input.open, ...input.quiet].map((item) => {
    const seen = watch.get(item.id);
    if (!seen) return item;
    watch.delete(item.id);
    return {
      ...item,
      ...(!item.href && seen.href ? { href: seen.href } : {}),
      ...(item.state ? {} : seen.state !== 'open' ? { state: seen.state } : {}),
      ...(!item.snoozedUntil && seen.snoozedUntil ? { snoozedUntil: seen.snoozedUntil } : {}),
      ...(seen.fixable ? { fixable: true as const } : {}),
      ...(!item.watch && seen.watch ? { watch: seen.watch } : {}),
    };
  });
  const items = [...own, ...[...watch.values()].map((w) => watchNeedsYou(w, input.names))];
  return items
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.at.localeCompare(a.at))
    .slice(0, NEEDS_YOU_LIST_MAX)
    .map((item) => {
      const researched = withResearch(item, input.research);
      return { ...researched, group: needsYouGroupOf(researched) };
    });
}

/**
 * An item about a server, connection or device with what the assistant found out about that thing (look-research.md
 * LR-09): the research of the look with its key; an ask never has one.
 */
export function withResearch(item: NeedsYouItem, research: ReadonlyMap<string, LookResearch>): NeedsYouItem {
  if (!item.subject || item.kind === 'approval' || item.kind === 'question') return item;
  const found = research.get(thingId(item.subject.kind, item.subject.id));
  return found ? { ...item, research: found } : item;
}
