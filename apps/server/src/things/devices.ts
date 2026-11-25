/**
 * A device's page (connection-pages.md CP-13; connection-pages-server.md CP-S17; dashboards.md DS-14): a switched-on
 * device shows its readings (figures with a small line of the range, a chart card for each of up to three numeric
 * readings from the points the reader stores, a table of all), when it was last read and what failed, and its actions
 * with their tiers (Settings). A device still being learned shows what Whombat found and tested, and “Open the chat” to
 * the proposal's card.
 */
import {
  catalogEntry,
  type ThingLine,
  type ThingPage,
  type ThingPageKpi,
  type ThingPagePanel,
  type ThingPageRow,
  type ThingSeriesColor,
} from '@whombat/core';
import { type ConnectionViewer, toolRowsOf } from '../connections/store';
import type { ReadingResult } from '../devices/driver';
import { DEVICE_FRESH_MS, deviceIcon, deviceLines, factOf } from '../devices/home';
import { actionToolName } from '../devices/profile';
import { type DeviceSkillRow, slugOf } from '../devices/store';
import { chatPlaceHref } from '../domain/links';
import { listChanges } from '../home/changes';
import type { Services } from '../services';
import type { ChartPanel } from './kinds/types';
import type { ThingTarget } from './page';
import { accessItems, BADGE, layout, rangeFields, SUMMARY_TAB } from './panels';
import { readingKey, readPoints } from './points';
import { thingQuiet, thingStates } from './quiet/store';
import { heldPage, markLines } from './quiet/wire';
import {
  avgPeakLines,
  DEFAULT_RANGE,
  downsample,
  drawable,
  onRange,
  type PageRange,
  RANGE_MS,
  seriesStats,
  statFigure,
  statsOf,
} from './series';
import { clip, line, plural, span } from './words';

/** Up to three numeric readings drawn over the day. */
export const DEVICE_CHART_MAX = 3;

/** The numeric readings a chart draws (their points are `r_<key>`). */
export function chartReadings(readings: readonly ReadingResult[]): ReadingResult[] {
  return readings.filter((r) => typeof r.value === 'number').slice(0, DEVICE_CHART_MAX);
}

/** A device's figures: its first readings, value and unit apart. */
export function readingKpis(readings: readonly ReadingResult[]): ThingPageKpi[] {
  return readings
    .filter((r) => r.value !== null)
    .slice(0, 5)
    .map((r) => {
      const f = factOf(r);
      return {
        key: readingKey(r.key).slice(2) || 'reading',
        label: clip(r.label, 30),
        value: clip(f.value || r.text, 40),
        ...(f.unit ? { rest: f.unit } : {}),
      };
    });
}

export function readingRows(readings: readonly ReadingResult[]): ThingPageRow[] {
  return readings.slice(0, 300).map((r) => ({
    id: r.key,
    cells: {
      reading: { text: clip(r.label, 200) },
      value:
        r.value === null
          ? { text: 'Couldn’t read it', tone: 'muted' as const }
          : { text: clip(r.text, 200), mono: true },
      ...(r.error ? { note: { text: clip(r.error, 200), tone: 'muted' as const } } : {}),
    },
  }));
}

const READING_COLUMNS = [
  { key: 'reading', label: 'Reading' },
  { key: 'value', label: 'Value', numeric: true },
  { key: 'note', label: 'Note' },
];

/** The readings' colours in order (DS-06). */
const READING_COLORS: ThingSeriesColor[] = ['blue', 'orange', 'green'];

/** Each numeric reading over the range as a chart card, and its line for the figure's small line. */
export function readingCharts(
  readings: readonly ReadingResult[],
  points: ReadonlyMap<string, { at: Date; value: number | null }[]>,
  range: PageRange,
  now: Date,
  timeZone: string,
): { charts: ChartPanel[]; lines: Map<string, (number | null)[]> } {
  const charts: ChartPanel[] = [];
  const lines = new Map<string, (number | null)[]>();
  chartReadings(readings).forEach((r, i) => {
    const key = readingKey(r.key);
    const grid = onRange([points.get(key) ?? []], range, now);
    const values = grid.values[0] as (number | null)[];
    if (!drawable(values)) return;
    lines.set(r.key, values);
    const f = factOf(r);
    const unit = r.unit ? ` ${r.unit}` : '';
    const color = READING_COLORS[i] ?? 'blue';
    charts.push({
      kind: 'chart',
      id: key,
      place: 'chart',
      span: 1,
      title: clip(r.label, 60),
      timestamps: grid.timestamps,
      series: [
        {
          key: (key.slice(2) || `r${i}`).slice(0, 40),
          label: clip(r.label, 40),
          ...(r.unit ? { unit: r.unit.slice(0, 16) } : {}),
          values,
          color,
          latest: clip(r.text, 40),
        },
      ],
      ...(r.value !== null
        ? { figure: { value: clip(f.value || r.text, 40), ...(f.unit ? { rest: f.unit } : {}) } }
        : {}),
      ...statsOf(
        avgPeakLines(seriesStats(values, grid.timestamps), (n) => `${statFigure(n)}${unit}`, now, timeZone),
      ),
      ...(r.unit ? { axis: { unit: r.unit.slice(0, 12) } } : {}),
    });
  });
  return { charts, lines };
}

function modelLine(skill: DeviceSkillRow): ThingLine | null {
  const { vendor, model } = skill.profile;
  if (!vendor && !model) return null;
  return line([vendor, model ? `**${model}**` : null].filter(Boolean).join(' '));
}

function deviceFacts(
  skill: DeviceSkillRow,
  readAt: Date | null,
  now: Date,
): Extract<ThingPagePanel, { kind: 'facts' }> {
  const p = skill.profile;
  const items: { label: string; value: string; mono?: boolean }[] = [];
  if (p.vendor) items.push({ label: 'Make', value: clip(p.vendor, 200) });
  if (p.model) items.push({ label: 'Model', value: clip(p.model, 200) });
  items.push({ label: 'Address', value: `${skill.host}:${skill.port}`, mono: true });
  items.push({ label: 'Talks', value: p.driver === 'modbus_tcp' ? 'Modbus TCP' : 'HTTP and JSON' });
  if (readAt) items.push({ label: 'Last read', value: `${span(now.getTime() - readAt.getTime())} ago` });
  if (p.source.title) items.push({ label: 'Described from', value: clip(p.source.title, 200) });
  return { kind: 'facts', id: 'device', place: 'side', title: 'The device', items };
}

/** A switched-on device's page over `range` (DS-14). */
export async function devicePage(
  services: Services,
  viewer: ConnectionViewer,
  target: Extract<ThingTarget, { kind: 'device' }>,
  timeZone: string,
  range: PageRange = DEFAULT_RANGE,
): Promise<ThingPage> {
  const now = services.clock();
  const { row, skill } = target;
  const readings = skill.lastRead ?? skill.tested;
  const readAt = skill.lastReadAt;
  const fresh = readAt !== null && now.getTime() - readAt.getTime() <= DEVICE_FRESH_MS;
  const status = skill.lastReadError ? 'offline' : fresh ? 'ok' : 'unknown';
  const keys = chartReadings(readings).map((r) => readingKey(r.key));
  const [points, tools, changes] = await Promise.all([
    readPoints(services.db, row.id, keys, now, RANGE_MS[range]),
    toolRowsOf(services.db, row.id),
    listChanges(services.db, viewer.principal, { limit: 1, thing: target.id, now }),
  ]);
  const { charts, lines } = readingCharts(readings, points, range, now, timeZone);
  // Its lines with what is quiet now, and the head from the active ones (quiet-notices.md QN-14, QN-S15).
  const [quiet, states] = await Promise.all([
    thingQuiet(services.db, viewer.burrowId, target.id),
    thingStates(services.db, target.id),
  ]);
  const marked = await markLines(services.db, deviceLines(skill), {
    quiet,
    states,
    now,
    timeZone,
    mayEnd: viewer.principal.kind === 'person',
  });
  const entry = catalogEntry(row.catalogId);
  const slug = slugOf(row);
  const labels = new Map(skill.profile.actions.map((a) => [actionToolName(slug, a.key), a.label]));
  const items = entry ? accessItems(entry, row, tools, labels) : [];
  const charted = chartReadings(readings);
  const kpis = readingKpis(readings).map((k) => {
    const i = charted.findIndex((r) => (readingKey(r.key).slice(2) || 'reading') === k.key);
    const values = i >= 0 ? lines.get((charted[i] as ReadingResult).key) : undefined;
    return values ? { ...k, spark: downsample(values), color: READING_COLORS[i] ?? ('blue' as const) } : k;
  });
  const summary: ThingPagePanel[] = [];
  if (kpis.length) summary.push({ kind: 'kpis', id: 'figures', items: kpis });
  summary.push(...charts);
  summary.push({
    kind: 'notices',
    id: 'notices',
    title: 'Worth a look',
    items: marked.items,
    empty: 'Nothing needs a look.',
  });
  summary.push({
    kind: 'table',
    id: 'readings-table',
    place: 'main',
    title: 'Readings',
    ...(readAt ? { meta: `read ${span(now.getTime() - readAt.getTime())} ago` } : {}),
    columns: READING_COLUMNS,
    rows: readingRows(readings),
  });
  summary.push(deviceFacts(skill, readAt, now));
  if (changes.changes.length)
    summary.push({ kind: 'changes', id: 'changes', place: 'main', title: 'Changes here', limit: 5 });
  if (items.length || row.access === 'read')
    summary.push({
      kind: 'access',
      id: 'access',
      place: 'main',
      title: 'What Whombat may do',
      items,
      lookOnly: row.access === 'read',
    });
  const first = charted[0];
  summary.push({
    kind: 'widgets',
    id: 'widgets',
    title: 'Show more here',
    suggestions: [
      first ? `${clip(first.label, 40)} over the week` : 'Readings over the week',
      'How often it answers',
    ],
  });
  const facts: ThingLine[] = [];
  const model = modelLine(skill);
  if (model) facts.push(model);
  if (readAt) facts.push(line(`Read **${span(now.getTime() - readAt.getTime())}** ago`));
  facts.push(
    row.access === 'read'
      ? line('Whombat may **look only**')
      : line(`Whombat may **change it** · within the limits you set`),
  );
  return {
    id: target.id,
    kind: 'device',
    connectionId: row.id,
    catalogId: 'device',
    name: clip(skill.name, 120),
    icon: deviceIcon(`${skill.name} ${skill.profile.model ?? ''}`),
    ...heldPage(marked, {
      status: marked.status !== 'ok' ? marked.status : status === 'offline' ? 'unknown' : status,
      badge:
        marked.status !== 'ok'
          ? (marked.badge ?? BADGE[marked.status])
          : skill.lastReadError
            ? 'Not answering'
            : BADGE[status],
    }).head,
    facts: facts.slice(0, 6),
    address: `${skill.host}:${skill.port}`,
    runsOn: null,
    settings: true,
    tabs: [{ ...SUMMARY_TAB, panels: layout(summary) }],
    actions: [],
    readAt: readAt ? readAt.toISOString() : null,
    ...heldPage(marked, { status: 'ok', badge: '' }).fields,
    ...rangeFields(range),
  };
}

/** A device still being learned: what Whombat found and tested, and its chat (CP-13). */
export async function learningPage(
  services: Services,
  target: Extract<ThingTarget, { kind: 'learning' }>,
  _timeZone: string,
): Promise<ThingPage> {
  const now = services.clock();
  const { skill } = target;
  const tested = skill.tested;
  // The proposal's thread in the chat it was made in (chat-channel.md CHT-08).
  const chat = skill.conversationId
    ? await chatPlaceHref(services.db, skill.conversationId, { messageId: skill.messageId })
    : null;
  const overview: ThingPagePanel[] = [
    {
      kind: 'text',
      id: 'learning',
      place: 'main',
      title: 'Still learning',
      body: `Whombat read ${plural(tested.filter((r) => r.value !== null).length, 'value')} from this device to test it and changed nothing. Choose what it may change in the chat; until then it isn’t switched on.`,
      ...(chat ? { link: { kind: 'href' as const, label: 'Open the chat', href: chat } } : {}),
    },
  ];
  const kpis = readingKpis(tested);
  if (kpis.length) overview.unshift({ kind: 'kpis', id: 'figures', items: kpis });
  overview.push({
    kind: 'table',
    id: 'tested',
    place: 'main',
    title: 'What it read',
    meta: `tested ${span(now.getTime() - skill.testedAt.getTime())} ago`,
    columns: READING_COLUMNS,
    rows: readingRows(tested),
  });
  overview.push(deviceFacts(skill, null, now));
  const facts: ThingLine[] = [];
  const model = modelLine(skill);
  if (model) facts.push(model);
  facts.push(line(`Tested **${span(now.getTime() - skill.testedAt.getTime())}** ago`));
  return {
    id: target.id,
    kind: 'device',
    proposalId: skill.id,
    catalogId: 'device',
    name: clip(skill.name, 120),
    icon: deviceIcon(`${skill.name} ${skill.profile.model ?? ''}`),
    status: 'learning',
    badge: BADGE.learning,
    facts,
    address: `${skill.host}:${skill.port}`,
    runsOn: null,
    settings: false,
    tabs: [{ ...SUMMARY_TAB, panels: layout(overview) }],
    actions: [],
    readAt: skill.testedAt.toISOString(),
  };
}
