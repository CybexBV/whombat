/**
 * Overview on one page (docs/decisions/overview-one-page.md): the sections it draws without tabs — Servers,
 * Connections, Pinned — with their jump links' count, dot and summary line, where an old `?tab=` address scrolls to,
 * and what a connection's small tile says. The server rows are `overviewServerRows` in `@whombat/client/hosts`. Pure;
 * the web and the phone draw the same.
 */
import type { ThingSummary } from '@whombat/core';
import type { HostServer } from '@whombat/core/domain';
import { overviewServersLine } from '../hosts/overview';
import { clientTranslator } from '../i18n/catalog';
import { thingStateWords } from './monitoring';
import { type HomeSection, type HomeThingRow, thingFigurePhrase, usedPhrase } from './sections';
import { sortByStatusLevel, statusSummary } from './statusLevel';
import { type ConnectionsTab, type ConnectionsTabView, connectionsTabs, overviewWords } from './tabs';

/* Sections and jump links ------------------------------------------------------------------------------------------ */

export interface OverviewSectionView extends ConnectionsTabView {
  /** The element id the jump link scrolls to: `overview-servers`, `overview-connections`, `overview-pinned`. */
  anchor: string;
  /** The line beside the heading: the servers' line, the connections' levels, “From your chats”. */
  summary: string;
}

const ANCHORS: Record<ConnectionsTab, string> = {
  servers: 'overview-servers',
  services: 'overview-connections',
  pinned: 'overview-pinned',
};

/**
 * Overview's sections in order, each with its jump link's name, count and dot (`connectionsTabs`' rules: Servers where
 * the hosts service runs, Connections, Pinned when something is). With the hosts fleet, Servers counts and colours from
 * it (what its rows show) and says `overviewServersLine`; an offline server is trouble here, a waiting one isn't.
 */
export function overviewSections(
  sections: readonly HomeSection[],
  fleet?: readonly HostServer[] | null,
  locale?: string | null,
): OverviewSectionView[] {
  const tr = clientTranslator(locale);
  const words = overviewWords(locale);
  return connectionsTabs(sections, locale).map((tab) => {
    if (tab.key === 'servers') {
      if (!fleet) return { ...tab, anchor: ANCHORS.servers, summary: '' };
      const tone = fleet.some((s) => s.status === 'bad' || s.status === 'offline')
        ? 'bad'
        : fleet.some((s) => s.status === 'warn')
          ? 'warn'
          : null;
      const count = fleet.length;
      return {
        ...tab,
        count,
        tone,
        spoken: [tab.label, String(count), tone ? tr.t('overview.tab.spokenWarn') : null]
          .filter(Boolean)
          .join(', '),
        anchor: ANCHORS.servers,
        summary: overviewServersLine(fleet, locale),
      };
    }
    if (tab.key === 'services') {
      const rows = sections.find((s) => s.kind === 'things')?.rows ?? [];
      const down = rows.filter((r) => r.notAnswering && r.level === 'connected');
      const rest = rows.filter((r) => !down.includes(r)).map((r) => r.level);
      return { ...tab, anchor: ANCHORS.services, summary: statusSummary(rest, down.length, locale) };
    }
    return { ...tab, anchor: ANCHORS.pinned, summary: words.fromYourChats };
  });
}

/**
 * “Quiet until 23:00” for each server kept quiet now, by its thing id (`server:pve-02`), from Home's things: the fleet's
 * rows don't carry a window. A server's row or card says it under its system line.
 */
export function serverQuietWords(
  things: readonly Pick<ThingSummary, 'id' | 'kind' | 'quietUntil'>[] | null | undefined,
  now: Date | number,
  timeZone: string,
): Map<string, string> {
  const out = new Map<string, string>();
  const at = typeof now === 'number' ? now : now.getTime();
  for (const t of things ?? []) {
    if (t.kind !== 'server' || !t.quietUntil || Date.parse(t.quietUntil) <= at) continue;
    const words = thingStateWords({ quietUntil: t.quietUntil }, now, timeZone);
    if (words) out.set(t.id, words);
  }
  return out;
}

/**
 * The section an old `?tab=` address scrolls to (`servers`, `services` or `connections`, `pinned`); null for anything
 * else (the page opens at its top).
 */
export function overviewSectionForTab(tab: unknown): ConnectionsTab | null {
  if (tab === 'servers' || tab === 'services' || tab === 'pinned') return tab;
  if (tab === 'connections') return 'services';
  return null;
}

/** The element id of a section's place on the page (the jump link's target). */
export function overviewSectionAnchor(key: ConnectionsTab): string {
  return ANCHORS[key];
}

/* Connection tiles ------------------------------------------------------------------------------------------------- */

/** `bad` and `warn` say why it isn't fine in their colour; `mut` is grey (learning, offline); `plain` is what it says. */
export type OverviewTileTone = 'bad' | 'warn' | 'mut' | 'plain';

export interface OverviewTile {
  row: HomeThingRow;
  /** The tile's one line: why it isn't fine, that it is being learned, its first two figures, what it is, or “Connected”. */
  line: { text: string; tone: OverviewTileTone };
  /** The foot's left: what it is (its subtitle) when the line didn't already say it; else null. */
  what: string | null;
  /** The foot's right: “Used today”, “Used yesterday”, “Used Friday”, “Used 3 Oct”; null when never used. */
  used: string | null;
  /** The tile's accessible name: its name, its state when not fine, the line, what it is and when it was used. */
  label: string;
  /**
   * Down because of something else (`cause`: “Not answering while pve-02 is down”) or kept quiet (`quiet`: “Quiet until
   * 23:00”): the line says so whatever else the tile could show. Null otherwise.
   */
  held: 'cause' | 'quiet' | null;
}

/** What a tile says when the Whombat didn't say why: something the person can act on. A tile's line has no full stop. */
const NO_REASON: Partial<Record<HomeThingRow['status'], string>> = {
  offline: 'Whombat can’t reach it right now',
  bad: 'It isn’t working. Open it to see why',
  warn: 'Open it to see what needs a look',
};

const upFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A reason as a tile's line: its first letter up, without a closing full stop (“4 things need a look”). */
function tileReason(text: string): string {
  return upFirst(text.trim()).replace(/\.$/, '');
}

/** A thing being learned: “Dusty is still learning it”. */
export function learningLine(assistant: string | null | undefined): string {
  return `${assistant?.trim() || 'Your agent'} is still learning it`;
}

/**
 * The connections' tiles in Overview's order, worst first (`sortByStatusLevel`). Nothing is made up: a connection
 * without figures or a subtitle says “Connected” and has no foot on the left.
 */
export function overviewTiles(
  rows: readonly HomeThingRow[],
  things: readonly Pick<ThingSummary, 'id' | 'usedAt' | 'causedBy' | 'quietUntil'>[],
  now: Date | number,
  timeZone: string,
  assistantName: string | null | undefined,
): OverviewTile[] {
  const byId = new Map(things.map((t) => [t.id, t]));
  return sortByStatusLevel(rows, (r) => r.level).map((row) => {
    let line: OverviewTile['line'];
    let usedSubtitle = false;
    const thing = byId.get(row.id);
    const heldWords =
      thing && (thing.causedBy || thing.quietUntil) ? thingStateWords(thing, now, timeZone) : null;
    // Its cause's grey only when the cause's words are what it says: a window someone chose comes first.
    const held = heldWords ? (heldWords === thing?.causedBy?.words ? 'cause' : 'quiet') : null;
    if (heldWords) {
      line = { text: heldWords, tone: 'mut' };
    } else if (row.level === 'notWorking' || row.level === 'needsLook') {
      const tone: OverviewTileTone = row.tone === 'bad' ? 'bad' : row.tone === 'warn' ? 'warn' : 'mut';
      const text = row.reason ? tileReason(row.reason) : (NO_REASON[row.status] ?? row.word);
      line = { text, tone };
    } else if (row.level === 'learning') {
      line = { text: learningLine(assistantName), tone: 'mut' };
    } else if (row.figures.length) {
      line = { text: row.figures.slice(0, 2).map(thingFigurePhrase).join(' · '), tone: 'plain' };
    } else if (row.subtitle) {
      line = { text: row.subtitle, tone: 'plain' };
      usedSubtitle = true;
    } else {
      line = { text: 'Connected', tone: 'plain' };
    }
    const at = thing?.usedAt;
    const used = at ? upFirst(usedPhrase(at, now, timeZone)) : null;
    // The held words are the line already: the foot doesn't say them again (a thing down because of something else
    // has them as its own line too).
    const what = usedSubtitle
      ? null
      : heldWords && row.subtitle
        ? row.subtitle
            .split(' · ')
            .filter((part) => part !== heldWords)
            .join(' · ') || null
        : row.subtitle;
    return {
      row,
      line,
      held,
      what,
      used,
      label: [row.name, row.level === 'connected' ? null : row.word.toLowerCase(), line.text, what, used]
        .filter(Boolean)
        .join(', '),
    };
  });
}
