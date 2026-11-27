/**
 * “Your things” (one-whombat.md ONE-04, ONE-05; app one-whombat-shell.md AP-1267): servers, connections and devices as
 * the sidebar lists them (a status dot, “learning” while a device is learned) and the tiles Home shows for connections
 * with live facts (“Home · Home Assistant · 127 devices”). Pure; web and phone share it.
 */
import { isBrandMark, type MarkLike } from '@whombat/brand';
import type { ThingStatus, ThingSummary } from '@whombat/core';
import { clientTranslator } from '../i18n/catalog';
import { type StatusLevel, statusMarkLabel, thingStatusView } from './statusLevel';

/** The glyphs the clients draw for a thing (`ThingSummary.icon` or its catalog entry). */
export type ThingGlyph =
  | 'server'
  | 'home'
  | 'thermometer'
  | 'wifi'
  | 'cloud'
  | 'mail'
  | 'calendar'
  | 'device'
  | 'code'
  | 'plug';

const GLYPHS: Record<string, ThingGlyph> = {
  server: 'server',
  home: 'home',
  homeassistant: 'home',
  home_assistant: 'home',
  thermometer: 'thermometer',
  thermo: 'thermometer',
  heatpump: 'thermometer',
  device: 'device',
  code: 'code',
  repositories: 'code',
  wifi: 'wifi',
  unifi: 'wifi',
  network: 'wifi',
  cloud: 'cloud',
  hetzner: 'cloud',
  mail: 'mail',
  gmail: 'mail',
  google_mail: 'mail',
  calendar: 'calendar',
  google_calendar: 'calendar',
};

/** The thing's glyph: its icon name, else its catalog entry's, else by kind. */
export function thingGlyph(thing: Pick<ThingSummary, 'icon' | 'catalogId' | 'kind'>): ThingGlyph {
  return (
    GLYPHS[thing.icon] ??
    (thing.catalogId ? GLYPHS[thing.catalogId] : undefined) ??
    (thing.kind === 'server' ? 'server' : thing.kind === 'device' ? 'device' : 'plug')
  );
}

/**
 * The thing's mark (marks.md AP-2204): a connection's own logo when it has one (a Custom connection the assistant gave
 * one, connection-looks.md), else its icon when that names a brand mark (a server's `debian`, `proxmox` from contracts
 * 0.90 `hostOsMark`; a connection's catalog id), else its catalog entry's; null for a thing without one (a device, a
 * server whose system isn't known), which draws its glyph.
 */
export function thingMark(thing: Pick<ThingSummary, 'icon' | 'catalogId' | 'logo'>): MarkLike | null {
  if (thing.logo) return thing.logo;
  if (isBrandMark(thing.icon)) return thing.icon;
  return thing.catalogId && isBrandMark(thing.catalogId) ? thing.catalogId : null;
}

/** A status dot's words, for screen readers and its tooltip. */
export function thingStatusLabels(locale?: string | null): Record<ThingStatus, string> {
  const tr = clientTranslator(locale);
  return {
    ok: tr.t('thing.status.ok'),
    warn: tr.t('thing.status.warn'),
    bad: tr.t('thing.status.bad'),
    learning: tr.t('thing.status.learning'),
    offline: tr.t('thing.status.offline'),
    unknown: tr.t('thing.status.unknown'),
  };
}

export const THING_STATUS_LABELS: Record<ThingStatus, string> = thingStatusLabels();

export interface ThingRow {
  id: string;
  name: string;
  /**
   * The name without what tells it apart from another of its kind, and that part (“Hetzner Cloud” and “dev” for
   * “Hetzner Cloud · dev”), drawn quieter. A name without “ · ” is all `main`; a server's host name is never split.
   */
  main: string;
  note: string | null;
  glyph: ThingGlyph;
  /** Drawn instead of the glyph when there is one (`thingMark`). */
  mark: MarkLike | null;
  status: ThingStatus;
  /** Servers' names are host names: set in the mono face (mock). */
  mono: boolean;
  /** A device still being learned: “learning” and a dashed dot. */
  learning: boolean;
  href: string;
  selected: boolean;
  /** Why it isn't fine (`ThingSummary.reason`, contracts 0.95 CT-453), or null. */
  reason: string | null;
  /**
   * Whether the sidebar draws its dot (Whombat sidebar.md SB-04; app sidebar.md AP-2603): only when it isn't fine — it
   * needs a look, has a problem or is offline — or is being learned. Fine and not checked yet draw none.
   */
  dot: boolean;
  /** “pve-02, needs a look: filling up”; “Unraid, running fine”. */
  label: string;
  /** The row's tooltip: its name, and why when it isn't fine (“blackbox · Filling up”, “pve-02 · Needs a look”). */
  tip: string;
  /** Its status level, the mark's shape (`statusLevel.ts`). */
  level: StatusLevel;
  /** The mark's accessible name (“blackbox: disk array failed”); null when connected, which draws no mark. */
  markLabel: string | null;
}

/** The statuses the sidebar draws a dot for (SB-04): what isn't fine, and a device being learned. */
const DOTTED: ReadonlySet<ThingStatus> = new Set(['warn', 'bad', 'offline', 'learning']);

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * The things the sidebar and Home list (connection-pages.md CP-10, contracts 0.88 CT-391): everything but a connection
 * that is part of a server Whombat already watches (pve-02's Proxmox API), which the server's page links to instead.
 */
export function listedThings<T extends Pick<ThingSummary, 'partOf'>>(things: readonly T[]): T[] {
  return things.filter((t) => !t.partOf);
}

/** The things that are part of a server (`server:pve-02`): its page says “Also connected: Proxmox VE API”. */
export function partsOf<T extends Pick<ThingSummary, 'partOf'>>(
  things: readonly T[],
  serverThingId: string,
): T[] {
  return things.filter((t) => t.partOf === serverThingId);
}

/**
 * A connection's name and what tells it apart (“Hetzner Cloud · dev” is “Hetzner Cloud” and “dev”): the part after the
 * last “ · ”, when there is something on both sides. Two connections of one kind are told apart by renaming one so.
 */
export function nameAndNote(name: string): { main: string; note: string | null } {
  const at = name.lastIndexOf(' · ');
  const main = at > 0 ? name.slice(0, at).trim() : '';
  const note = at > 0 ? name.slice(at + 3).trim() : '';
  return main && note ? { main, note } : { main: name, note: null };
}

/** The sidebar's rows, in the server's order (servers first as it sends them); parts of a server are left out. */
export function thingRows(
  things: readonly ThingSummary[],
  selectedId?: string | null,
  locale?: string | null,
): ThingRow[] {
  const labels = locale ? thingStatusLabels(locale) : THING_STATUS_LABELS;
  return listedThings(things).map((t) => {
    const status = labels[t.status];
    const reason = t.status !== 'ok' && t.reason ? t.reason : null;
    const dot = DOTTED.has(t.status);
    const parts = t.kind === 'server' ? { main: t.name, note: null } : nameAndNote(t.name);
    const view = thingStatusView(t, locale);
    return {
      id: t.id,
      name: t.name,
      ...parts,
      glyph: thingGlyph(t),
      mark: thingMark(t),
      status: t.status,
      mono: t.kind === 'server',
      learning: t.status === 'learning',
      href: t.href,
      selected: selectedId === t.id,
      reason,
      dot,
      label: `${t.name}, ${status.toLowerCase()}${reason ? `: ${lowerFirst(reason)}` : ''}`,
      tip: reason ? `${t.name} · ${reason}` : dot ? `${t.name} · ${status}` : t.name,
      level: view.level,
      markLabel: statusMarkLabel(t.name, view),
    };
  });
}

/** A tile's or Home row's title: what the connection is for (“Network”), else its name. */
export function thingTileTitle(
  thing: Pick<ThingSummary, 'catalogId' | 'name'>,
  locale?: string | null,
): string {
  if (thing.catalogId === 'unifi') return clientTranslator(locale).t('thing.tile.network');
  return thing.name;
}

export interface ThingTile {
  id: string;
  title: string;
  /** “Home Assistant · 127 devices”. */
  meta: string;
  href: string;
  status: ThingStatus;
  facts: { label: string; value: string; note: string | null }[];
}

/**
 * Home's tiles: every connection or device with live facts, in the server's order. Servers have their own card, a
 * thing without facts (a mailbox, a device being learned) only its sidebar row, and a part of a server (CP-10) neither.
 */
export function thingTiles(things: readonly ThingSummary[], locale?: string | null): ThingTile[] {
  return listedThings(things)
    .filter((t) => t.kind !== 'server' && t.facts.length > 0)
    .map((t) => {
      const title = thingTileTitle(t, locale);
      const meta = [title === t.name ? null : t.name, t.line ?? null].filter(Boolean).join(' · ');
      return {
        id: t.id,
        title,
        meta,
        href: t.href,
        status: t.status,
        facts: t.facts.map((f) => ({
          label: f.label,
          value: f.unit ? `${f.value} ${f.unit}` : f.value,
          note: f.note ?? null,
        })),
      };
    });
}

/** The servers among the things (Home's Servers card and its counts). */
export function serverThings(things: readonly ThingSummary[]): ThingSummary[] {
  return things.filter((t) => t.kind === 'server');
}
