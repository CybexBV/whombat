/**
 * Servers and Connections as places of their own (docs/decisions/servers-connections-places.md): the list Chat's shape
 * draws beside a server's or connection's page — one row each with its logo, its name, how it is in a few words and, for
 * a server, its processor now — and the place's own line under its heading. Pure; the web and the phone draw the same.
 *
 * The rows come from what Overview already reads: the servers from the hosts fleet (`overviewServerRows`, so the order
 * and the words are Overview's: broken first, then by name, a server that runs on another under it), the connections
 * from Overview's tiles (`overviewTiles`, worst first, the tile's one line).
 */

import type { MarkLike } from '@whombat/brand';
import type { HostServer } from '@whombat/core/domain';
import { serverHref } from '../hosts/model';
import { type OverviewServerRow, overviewServerRows } from '../hosts/overview';
import { clientTranslator } from '../i18n/catalog';
import type { OverviewTile } from './overview';
import type { StatusLevel } from './statusLevel';
import { STATUS_LEVEL_RANK, statusSummary } from './statusLevel';
import { nameAndNote, type ThingGlyph, type ThingRow, thingStatusLabels } from './things';

/** The two places. */
export type ThingPlace = 'servers' | 'connections';

/** How a row's line is drawn: in the problem's colour, amber, grey, or plain. */
export type PlaceRowTone = 'bad' | 'warn' | 'mut' | 'plain';

export interface PlaceRow {
  /** The thing id (`server:pve-02`, `connection:con_unifi`): the page's address names it. */
  id: string;
  name: string;
  /** The name without what tells two of a kind apart (“Hetzner Cloud” of “Hetzner Cloud · dev”). */
  main: string;
  /** What tells two of a kind apart (“dev”), drawn quieter after `main`; null for most. */
  note: string | null;
  href: string;
  mark: MarkLike | null;
  glyph: ThingGlyph;
  /** Its status level: the mark's shape before the line, and its place in the list. */
  level: StatusLevel;
  /** How it is in a few words: “Disk array failed”, “Quiet · 19 of 22 running”, “1 access point offline”. */
  line: string;
  tone: PlaceRowTone;
  /** A server's processor now (“10 %”) at the row's end, where Chat's rows have their time; null for a connection. */
  figure: string | null;
  /** It runs on the server in a row above it: set in under it with an elbow line. */
  child: boolean;
  /** The row's accessible name: its name, how it is and the figure. */
  label: string;
}

export interface PlaceWords {
  title: string;
  add: string;
  empty: string;
  failed: string;
  noun: (n: number) => string;
  back: string;
}

/** Each place's own words in a locale (English when none is given). */
export function placeWords(locale?: string | null): Record<ThingPlace, PlaceWords> {
  const tr = clientTranslator(locale);
  const servers = tr.t('thingPlace.servers.title');
  const connections = tr.t('thingPlace.connections.title');
  return {
    servers: {
      title: servers,
      add: tr.t('thingPlace.servers.add'),
      empty: tr.t('thingPlace.servers.empty'),
      failed: tr.t('thingPlace.servers.failed'),
      noun: (n) => tr.tp('thingPlace.servers.noun', n),
      back: servers,
    },
    connections: {
      title: connections,
      add: tr.t('thingPlace.connections.add'),
      empty: tr.t('thingPlace.connections.empty'),
      failed: tr.t('thingPlace.connections.failed'),
      noun: (n) => tr.t('thingPlace.connections.noun', { count: n }),
      back: connections,
    },
  };
}

export const PLACE_WORDS: Record<ThingPlace, PlaceWords> = placeWords();

/** Servers when the hosts service can't be reached and nothing is listed. */
export function serversDown(locale?: string | null): string {
  return clientTranslator(locale).t('thingPlace.serversDown');
}

export const SERVERS_DOWN = serversDown();

/** The thing id a server of the hosts fleet has in Home's things (`server:pve-02`). */
function serverThingId(serverId: string): string {
  return decodeURIComponent(serverHref(serverId).replace(/^\/things\//, ''));
}

function serverLine(
  row: OverviewServerRow,
  level: StatusLevel,
  parentName: string | null,
  locale: string | null | undefined,
): { line: string; tone: PlaceRowTone } {
  const tr = clientTranslator(locale);
  if (row.pill) {
    // The tone follows the level, so an offline server is as red as a broken one and one kept quiet stays grey.
    const tone = level === 'notWorking' ? 'bad' : level === 'needsLook' ? 'warn' : 'mut';
    return { line: row.pill.word, tone };
  }
  const word = row.cpu.word ?? tr.t('thing.status.ok');
  if (parentName) return { line: tr.t('thingPlace.line.on', { word, parent: parentName }), tone: 'plain' };
  const running =
    row.running.nothing || !row.running.count
      ? null
      : tr.t('hosts.overview.running', { count: row.running.count });
  return { line: running ? `${word} · ${running}` : word, tone: 'plain' };
}

/**
 * The Servers list: the hosts fleet in Overview's order with each server's line. `reasons` are Home's things' reasons by
 * thing id: a server that isn't fine says why (“arnica-prod-nest-01 needs a restart”) when the Whombat said, else its
 * pill's word. Without the fleet (no hosts service yet, or not read yet) the servers among Home's things in their
 * order, saying their status.
 */
export function serverPlaceRows(
  fleet: readonly HostServer[] | null | undefined,
  serverThings: readonly ThingRow[],
  now: number,
  timeZone: string,
  /** The servers the person keeps quiet for now (`serverQuietWords`' ids): Home's level for them, not the fleet's. */
  quiet: ReadonlySet<string> | ReadonlyMap<string, unknown> = new Set(),
  locale?: string | null,
): PlaceRow[] {
  const things = new Map(serverThings.map((t) => [t.id, t]));
  const fromThing = (t: ThingRow) => thingPlaceRow(t, locale);
  if (!fleet?.length) return sortRows(serverThings.map(fromThing));
  const tr = clientTranslator(locale);
  const rows = overviewServerRows(fleet, now, timeZone, locale);
  const names = new Map(fleet.map((s) => [s.id, s.name]));
  const fromFleet = rows.map((r): PlaceRow => {
    const id = serverThingId(r.id);
    const thing = things.get(id);
    const parentName = r.parentId ? (names.get(r.parentId) ?? null) : null;
    // The fleet's level is the live one; Home's only for a server the person keeps quiet, which the fleet doesn't know.
    const level = thing && quiet.has(id) ? thing.level : r.level;
    const said = serverLine(r, level, parentName, locale);
    const line = r.pill && thing?.reason ? upFirst(thing.reason) : said.line;
    const figure = r.cpu.value;
    return {
      id,
      name: thing?.name ?? r.name,
      main: thing?.name ?? r.name,
      note: null,
      href: thing?.href ?? r.href,
      mark: r.mark ?? thing?.mark ?? null,
      glyph: thing?.glyph ?? 'server',
      level,
      line,
      tone: said.tone,
      figure,
      child: r.child,
      label: [thing?.name ?? r.name, line, figure ? tr.t('thingPlace.line.processor', { figure }) : null]
        .filter(Boolean)
        .join(', '),
    };
  });
  // A server Home knows that the fleet doesn't (not reporting to the hosts service) is still one of the servers.
  const seen = new Set(fromFleet.map((r) => r.id));
  return [...fromFleet, ...sortRows(serverThings.filter((t) => !seen.has(t.id)).map(fromThing))];
}

/** A server or connection row from Home's things alone (no fleet, no tile): its reason or its status in words. */
function thingPlaceRow(t: ThingRow, locale: string | null | undefined): PlaceRow {
  const tone: PlaceRowTone =
    t.level === 'notWorking'
      ? 'bad'
      : t.level === 'needsLook'
        ? 'warn'
        : t.level === 'learning'
          ? 'mut'
          : 'plain';
  const line = t.reason
    ? upFirst(t.reason)
    : t.level === 'connected'
      ? clientTranslator(locale).t('statusLevel.connected')
      : thingStatusLabels(locale)[t.status];
  return {
    id: t.id,
    name: t.name,
    main: t.main,
    note: t.note,
    href: t.href,
    mark: t.mark,
    glyph: t.glyph,
    level: t.level,
    line,
    tone,
    figure: null,
    child: false,
    label: t.label,
  };
}

/**
 * The Connections list: Overview's tiles (worst first, each with its one line), each matched to its sidebar row for the
 * logo; a connection that has no tile (Overview not read yet) keeps its row's words.
 */
export function connectionPlaceRows(
  rows: readonly ThingRow[],
  tiles: readonly OverviewTile[] | null | undefined,
  locale?: string | null,
): PlaceRow[] {
  const fromThing = (t: ThingRow) => thingPlaceRow(t, locale);
  if (!tiles?.length) return sortRows(rows.map(fromThing));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const fromTiles = tiles.map((tile): PlaceRow => {
    const t = byId.get(tile.row.id);
    return {
      id: tile.row.id,
      name: t?.name ?? tile.row.name,
      ...(t ? { main: t.main, note: t.note } : nameAndNote(tile.row.name)),
      href: t?.href ?? tile.row.href,
      mark: t?.mark ?? tile.row.mark,
      glyph: t?.glyph ?? tile.row.glyph,
      level: tile.row.level,
      line: tile.line.text,
      tone: tile.line.tone,
      figure: null,
      child: false,
      label: tile.label,
    };
  });
  const seen = new Set(fromTiles.map((r) => r.id));
  return [...fromTiles, ...sortRows(rows.filter((r) => !seen.has(r.id)).map(fromThing))];
}

function sortRows(rows: PlaceRow[]): PlaceRow[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => STATUS_LEVEL_RANK[a.row.level] - STATUS_LEVEL_RANK[b.row.level] || a.i - b.i)
    .map((x) => x.row);
}

/** A part of the place's line, in the tone of what it counts (the count of all of them is plain). */
export interface PlaceSummaryPart {
  text: string;
  tone: 'bad' | 'warn' | null;
}

const SUMMARY_TONES: Partial<Record<StatusLevel, PlaceSummaryPart['tone']>> = {
  notWorking: 'bad',
  needsLook: 'warn',
};

/**
 * The place's line under its heading, a part each: “5 servers · 1 not working · 1 needs a look”, the problems in their
 * tone (red, amber) as the mock draws them.
 */
export function placeSummaryParts(
  place: ThingPlace,
  rows: readonly Pick<PlaceRow, 'level'>[],
  locale?: string | null,
): PlaceSummaryPart[] {
  if (!rows.length) return [];
  // Learning isn't a problem: the mock's line counts only what isn't working and what needs a look.
  const levels: StatusLevel[] = ['notWorking', 'needsLook'];
  return [
    { text: placeWords(locale)[place].noun(rows.length), tone: null },
    ...levels.flatMap((level) => {
      const text = statusSummary(
        rows.filter((r) => r.level === level).map((r) => r.level),
        0,
        locale,
      );
      return text ? [{ text, tone: SUMMARY_TONES[level] ?? null }] : [];
    }),
  ];
}

/** The place's line as one string (its spoken form): “5 servers · 1 not working · 1 needs a look”. */
export function placeSummary(
  place: ThingPlace,
  rows: readonly Pick<PlaceRow, 'level'>[],
  locale?: string | null,
): string {
  return placeSummaryParts(place, rows, locale)
    .map((p) => p.text)
    .join(' · ');
}

/** The worst tone of what a place holds, for the mark on its menu item; null when all is fine. */
export function placeTone(rows: readonly Pick<ThingRow, 'status'>[]): 'bad' | 'warn' | null {
  if (rows.some((r) => r.status === 'bad' || r.status === 'offline')) return 'bad';
  return rows.some((r) => r.status === 'warn') ? 'warn' : null;
}

/** The worst tone of a place's own rows (their levels, from the fleet and Overview's tiles once read). */
export function placeRowsTone(rows: readonly Pick<PlaceRow, 'level'>[]): 'bad' | 'warn' | null {
  if (rows.some((r) => r.level === 'notWorking')) return 'bad';
  return rows.some((r) => r.level === 'needsLook') ? 'warn' : null;
}

/** The menu item's name with its mark said: “Servers, something isn’t working”. */
export function placeSpoken(place: ThingPlace, tone: 'bad' | 'warn' | null, locale?: string | null): string {
  const tr = clientTranslator(locale);
  const title = placeWords(locale)[place].title;
  if (!tone) return title;
  return tr.t(tone === 'bad' ? 'thingPlace.spoken.bad' : 'thingPlace.spoken.warn', { title });
}

/**
 * Which place a thing's page belongs to: a server to Servers, anything else listed to Connections; null for a page
 * neither lists (every guest of every server, a part of a server), which keeps the whole width.
 */
export function placeOfThing(
  thingId: string,
  lists: { servers: readonly Pick<PlaceRow, 'id'>[]; connections: readonly Pick<PlaceRow, 'id'>[] },
): ThingPlace | null {
  if (lists.servers.some((r) => r.id === thingId)) return 'servers';
  if (lists.connections.some((r) => r.id === thingId)) return 'connections';
  return null;
}

/**
 * The row a place opens on when nothing is picked: the one looked at last when it is still listed, else the first.
 * Null for an empty list.
 */
export function placeOpening(
  rows: readonly Pick<PlaceRow, 'id' | 'href'>[],
  last: string | null,
): string | null {
  // Only a page of its own opens beside the list; an older account's row that leads to Settings is picked by hand.
  const pages = rows.filter((r) => r.href.startsWith('/things/'));
  return (pages.find((r) => r.id === last) ?? pages[0])?.href ?? null;
}

const upFirst = (s: string) => {
  const t = s.trim().replace(/\.$/, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
};
