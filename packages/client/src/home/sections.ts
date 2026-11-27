/**
 * One Home on web and phone (Whombat home-redesign.md HR-20, HR-22, HR-23; app home-redesign.md AP-2206…AP-2215,
 * home-simplify.md AP-2269…): which sections Home shows, in which order, and their rows. Both apps draw
 * `homeSections`; neither decides what goes on Home by itself. The order: Needs you (only when something does),
 * Servers (where the hosts service runs), Your things, pinned panels (only when there are any). Asking the assistant
 * and its chats live in the sidebar and the Chats tab, what it changed on each thing's page (AP-2269). The web pairs
 * the panels on a wide screen (`homeWebSlots`). Pure.
 */
import type { MarkLike } from '@whombat/brand';
import type { HomeOverview, NeedsYouItem, ThingStatus, ThingSummary, Widget } from '@whombat/core';
import { formatLocaleOf } from '@whombat/core/i18n';
import {
  daysAgo,
  formatDate,
  formatShortWeekday,
  formatWeekday,
  toDate,
  zonedParts,
} from '@whombat/core/text';
import { clientTranslator } from '../i18n/catalog';
import { type NeedsYouRow, needsYouRows } from './needsYou';
import { type StatusLevel, thingStatusView } from './statusLevel';
import {
  listedThings,
  THING_STATUS_LABELS,
  type ThingGlyph,
  thingGlyph,
  thingMark,
  thingStatusLabels,
  thingTileTitle,
} from './things';

/* What Home reads -------------------------------------------------------------------------------------------------- */

/** `home.overview` as Home's sections read it. */
export type HomeInput = Pick<HomeOverview, 'summary' | 'needsYou' | 'things' | 'widgets'>;

/* Your things ------------------------------------------------------------------------------------------------------ */

function locWeekday(at: string, timeZone: string, style: 'long' | 'short', locale?: string | null): string {
  if (!locale) return style === 'long' ? formatWeekday(at, timeZone) : formatShortWeekday(at, timeZone);
  return new Intl.DateTimeFormat(formatLocaleOf(locale), { weekday: style, timeZone })
    .format(toDate(at))
    .replace(/\.$/, '');
}

function locDate(at: string, now: Date | number, timeZone: string, locale?: string | null): string {
  if (!locale) return formatDate(at, timeZone, { now: toDate(now) });
  const d = toDate(at);
  const sameYear = zonedParts(d, timeZone).year === zonedParts(now, timeZone).year;
  return new Intl.DateTimeFormat(formatLocaleOf(locale), {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone,
  })
    .format(d)
    .replace(/\.$/, '');
}

/**
 * When a connection was last used, as part of its line (HR-23): “used today”, “used yesterday”, “used Friday” this
 * week, else “used 3 Oct”. A time ahead of `now` (a clock that runs early) counts as today.
 */
export function usedPhrase(
  usedAt: string,
  now: Date | number,
  timeZone: string,
  locale?: string | null,
): string {
  const tr = clientTranslator(locale);
  const days = daysAgo(usedAt, now, timeZone);
  if (days <= 0) return tr.t('sections.usedToday');
  if (days === 1) return tr.t('sections.usedYesterday');
  if (days < 7) return tr.t('sections.usedWhen', { when: locWeekday(usedAt, timeZone, 'long', locale) });
  return tr.t('sections.usedWhen', { when: locDate(usedAt, now, timeZone, locale) });
}

/** The web table's LAST USED (AP-2272): “today”, “yesterday”, “Fri” this week, else “3 Oct”. */
export function usedShort(
  usedAt: string,
  now: Date | number,
  timeZone: string,
  locale?: string | null,
): string {
  const tr = clientTranslator(locale);
  const days = daysAgo(usedAt, now, timeZone);
  if (days <= 0) return tr.t('sections.today');
  if (days === 1) return tr.t('sections.yesterday');
  if (days < 7) return locWeekday(usedAt, timeZone, 'short', locale);
  return locDate(usedAt, now, timeZone, locale);
}

/**
 * The line of a thing without live figures (HR-23): “Connected · used today”, or “Connected” when it hasn't been used
 * yet. A thing that isn't fine says so instead of “Connected”: “Offline · used Friday”, “Learning”, “Needs a look”.
 */
export function connectedLine(
  thing: Pick<ThingSummary, 'status' | 'usedAt'>,
  now: Date | number,
  timeZone: string,
  locale?: string | null,
): string {
  const state = connectedState(thing.status, locale);
  return thing.usedAt ? `${state} · ${usedPhrase(thing.usedAt, now, timeZone, locale)}` : state;
}

/** “Connected” for a thing that is fine (or not checked yet), else what is wrong with it. */
function connectedState(status: ThingStatus, locale?: string | null): string {
  const labels = locale ? thingStatusLabels(locale) : THING_STATUS_LABELS;
  return status === 'ok' || status === 'unknown'
    ? clientTranslator(locale).t('statusLevel.connected')
    : labels[status];
}

/**
 * One figure as a phrase of a one-line row (mock 4: “21.0 °C · alarm armed · door locked”, “38 devices · 1 new”): with
 * a unit its value and unit, a number its value and label, words its label and value.
 */
export function factPhrase(fact: Pick<ThingSummary['facts'][number], 'label' | 'value' | 'unit'>): string {
  const label = fact.label.trim().toLowerCase();
  if (fact.unit) return `${fact.value} ${fact.unit}`;
  if (/^[\d.,\s]+$/.test(fact.value)) return label ? `${fact.value} ${label}` : fact.value;
  return label ? `${label} ${fact.value}` : fact.value;
}

/** A row's edge and status word colour, as the servers' (`ok`, `warn`, `bad`, `mut`) plus a device being learned. */
export type HomeThingTone = 'ok' | 'warn' | 'bad' | 'learning' | 'mut';

export const THING_TONES: Record<ThingStatus, HomeThingTone> = {
  ok: 'ok',
  warn: 'warn',
  bad: 'bad',
  learning: 'learning',
  offline: 'mut',
  unknown: 'mut',
};

/** One of a thing's figures as the rows draw it: “169 of 171” over “Integrations”, “84 / 12 Mbit/s” over “Internet”. */
export interface HomeThingFigure {
  label: string;
  /** The value with its unit. */
  value: string;
  /** “online”, “of 24 °C”; null without. */
  note: string | null;
}

export interface HomeThingRow {
  id: string;
  /** Its name, as the sidebar shows it (“UniFi”). */
  name: string;
  /** What it is and its own line, under the name: “Network · 45 devices”, “Home Assistant 2026.10.2”; null without. */
  subtitle: string | null;
  /** Beside the name when it isn't fine: “Needs a look”, “Learning”, “Offline”; null when it is. */
  state: string | null;
  tone: HomeThingTone;
  /** Its live figures, at most `HOME_THING_FIGURES`; empty for a thing without. */
  figures: HomeThingFigure[];
  /** Without figures, what the figures' place says: “Connected”, or “—” when `state` already says what is wrong. */
  plain: string;
  /** When a call to it last worked: “today”, “Fri”, “3 Oct” (`usedShort`); null when never. */
  used: string | null;
  /**
   * The phone's second line after `state`: its subtitle; without figures, its subtitle and when it was used (“Daikin
   * Altherma · used Friday”), or for a thing that is fine `connectedLine` (“Connected · used today”). May be empty.
   */
  line: string;
  glyph: ThingGlyph;
  /** Its logo where it has one (`thingMark`), else the glyph is drawn. */
  mark: MarkLike | null;
  status: ThingStatus;
  href: string;
  /** “Home Assistant, needs a look, 169 of 171 integrations, 38 errors today, 2 updates, used today”. */
  label: string;
  /** Its status level (`statusLevel.ts`): the card's pill and its place on Overview, worst first. */
  level: StatusLevel;
  /** The pill's word: “Needs a look”, “Offline”, “Connected”. */
  word: string;
  /** Why it isn't connected, in a few plain words (at most `STATUS_REASON_MAX`); null when it is or nobody knows. */
  reason: string | null;
  /** Down because of something else and not kept quiet (`notAnswering`): grey, yet it doesn't work. */
  notAnswering: boolean;
}

/**
 * Whether a thing is down because of something else (its server down, its machine stopped, the internet down) and not
 * kept quiet now. Its dot is grey, since the problem is its cause's, but it doesn't work, so Overview's counts take it
 * as not answering. A thing kept quiet counts as its dot says whatever stopped it: the person chose not to hear about
 * it until then, and its tile says the window. One only quiet with its server isn't down.
 */
export function notAnswering(
  thing: Pick<ThingSummary, 'causedBy' | 'quietUntil'>,
  now: Date | number,
): boolean {
  if (!thing.causedBy || thing.causedBy.kind === 'quiet') return false;
  return !(thing.quietUntil && Date.parse(thing.quietUntil) > toDate(now).getTime());
}

/** A row's figure in words: its value, its note and its label (“169 of 171 integrations”, “38 devices”). */
export function thingFigurePhrase(f: HomeThingFigure): string {
  return [f.value, f.note, f.label.toLowerCase()].filter(Boolean).join(' ');
}

/** The most figures a thing's row shows (the rest are on its page). */
export const HOME_THING_FIGURES = 3;

/**
 * Your things on Home (HR-23; AP-2270): every connection and device, as a row like a server's — its name and what it
 * is, its live figures, when it was last used — those with figures first, each group in the server's order. Servers
 * have their own section; a connection that is part of a server (pve-02's Proxmox API, CP-10) stays on the server's
 * page.
 */
export function homeThingRows(
  things: readonly ThingSummary[],
  now: Date | number,
  timeZone: string,
): HomeThingRow[] {
  const listed = listedThings(things).filter((t) => t.kind !== 'server');
  const ordered = [
    ...listed.filter((t) => t.facts.length > 0),
    ...listed.filter((t) => t.facts.length === 0),
  ];
  return ordered.map((t) => {
    const title = thingTileTitle(t);
    const subtitle = [title === t.name ? null : title, t.line ?? null].filter(Boolean).join(' · ') || null;
    const figures = t.facts.slice(0, HOME_THING_FIGURES).map((f) => ({
      label: f.label,
      value: f.unit ? `${f.value} ${f.unit}` : f.value,
      note: f.note ?? null,
    }));
    const state = t.status === 'ok' || t.status === 'unknown' ? null : THING_STATUS_LABELS[t.status];
    const used = t.usedAt ? usedShort(t.usedAt, now, timeZone) : null;
    const said = figures.length ? figures.map(thingFigurePhrase) : [connectedState(t.status).toLowerCase()];
    return {
      id: t.id,
      name: t.name,
      subtitle,
      state,
      tone: THING_TONES[t.status],
      figures,
      plain: state ? '—' : connectedState(t.status),
      used,
      line: figures.length
        ? (subtitle ?? '')
        : state
          ? [subtitle, t.usedAt ? usedPhrase(t.usedAt, now, timeZone) : null].filter(Boolean).join(' · ')
          : connectedLine(t, now, timeZone),
      glyph: thingGlyph(t),
      mark: thingMark(t),
      status: t.status,
      href: t.href,
      ...thingStatusView(t),
      notAnswering: notAnswering(t, now),
      label: [
        t.name,
        figures.length ? state?.toLowerCase() : null,
        ...said,
        t.usedAt ? usedPhrase(t.usedAt, now, timeZone) : null,
      ]
        .filter(Boolean)
        .join(', '),
    };
  });
}

/**
 * The head of Your things (AP-2271), as the servers' “5 online · 66 of 133 guests running”: how many work and what
 * isn't fine — “4 working · 1 learning”, “3 working · 1 needs a look · 1 offline”. Empty without things.
 */
export function thingsLine(rows: readonly Pick<HomeThingRow, 'status'>[]): string {
  if (!rows.length) return '';
  const count = (s: ThingStatus) => rows.filter((r) => r.status === s).length;
  const working = count('ok') + count('unknown');
  const parts = [
    working ? `${working} working` : null,
    count('warn') ? `${count('warn')} ${count('warn') === 1 ? 'needs' : 'need'} a look` : null,
    count('bad') ? `${count('bad')} with a problem` : null,
    count('offline') ? `${count('offline')} offline` : null,
    count('learning') ? `${count('learning')} learning` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

/* The sections ---------------------------------------------------------------------------------------------------- */

export type HomeSectionKind = 'needsYou' | 'servers' | 'things' | 'panels';

export type HomeSection =
  | { kind: 'needsYou'; count: number; items: NeedsYouItem[]; rows: NeedsYouRow[] }
  | { kind: 'servers'; servers: ThingSummary[] }
  | { kind: 'things'; rows: HomeThingRow[]; add: boolean }
  | { kind: 'panels'; widgets: Widget[] };

export type HomeSectionOf<K extends HomeSectionKind> = Extract<HomeSection, { kind: K }>;

export interface HomeSectionsOptions {
  now: Date | number;
  timeZone: string;
  /** The hosts service runs here (`hosts.status.present`): Servers shows, read from its fleet. */
  servers: boolean;
  /** The viewer may add a connection: Your things offers “Add a connection”. */
  canAddConnection: boolean;
}

/**
 * Home's sections in the order both apps draw them (HR-20, AP-2269). Needs you only when something does; Servers where
 * the hosts service runs; Your things when there is something or the viewer may add something; pinned panels only when
 * there are any.
 */
export function homeSections(overview: HomeInput, options: HomeSectionsOptions): HomeSection[] {
  const { now, timeZone } = options;
  const sections: HomeSection[] = [];
  if (overview.needsYou.length > 0) {
    sections.push({
      kind: 'needsYou',
      count: Math.max(overview.summary.needsYou, overview.needsYou.length),
      items: [...overview.needsYou],
      rows: needsYouRows(overview.needsYou, now, timeZone),
    });
  }
  if (options.servers) {
    sections.push({ kind: 'servers', servers: overview.things.filter((t) => t.kind === 'server') });
  }
  const things = homeThingRows(overview.things, now, timeZone);
  if (things.length > 0 || options.canAddConnection) {
    sections.push({ kind: 'things', rows: things, add: options.canAddConnection });
  }
  if (overview.widgets.length > 0) sections.push({ kind: 'panels', widgets: [...overview.widgets] });
  return sections;
}

/** One section of a list, by kind. */
export function homeSection<K extends HomeSectionKind>(
  sections: readonly HomeSection[],
  kind: K,
): HomeSectionOf<K> | undefined {
  return sections.find((s): s is HomeSectionOf<K> => s.kind === kind);
}

/* The web's grid -------------------------------------------------------------------------------------------------- */

/** A place in the web's grid: half the width (two panels side by side) or the whole width. */
export type HomePlace = 'half' | 'full';

export type HomeSlot =
  | { key: string; place: HomePlace; section: Exclude<HomeSection, { kind: 'panels' }> }
  | { key: string; place: HomePlace; panel: Widget; index: number; count: number };

/**
 * The web's grid on a wide screen (HR-20, AP-2273): every section across the whole width, the pinned panels two by
 * two; a last panel without a partner takes the whole width. In the sections' order, so the page reads as the phone's.
 */
export function homeWebSlots(sections: readonly HomeSection[]): HomeSlot[] {
  const slots: HomeSlot[] = [];
  for (const section of sections) {
    if (section.kind !== 'panels') {
      slots.push({ key: section.kind, place: 'full', section });
      continue;
    }
    const count = section.widgets.length;
    section.widgets.forEach((panel, index) => {
      const lone = index % 2 === 0 && index === count - 1;
      slots.push({ key: `panel:${panel.id}`, place: lone ? 'full' : 'half', panel, index, count });
    });
  }
  return slots;
}
