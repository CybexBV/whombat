/**
 * Fixture mode's Overview arranging (docs/decisions/overview-arranged.md): the layout as the runtime keeps it
 * (`overview.arrange`, sent with `home.overview`), what each connection's tile can show (`overview.figures`: its
 * figures and, for a few, panels of its page) and what it shows now (`overview.views`), made from the fixture world's
 * things so the page reads like a real Whombat's. Pure apart from the layout it keeps.
 */
import {
  type DeskCatalog,
  type DeskCatalogItem,
  type DeskWidgetView,
  type OverviewLayout,
  overviewShowId,
  parseOverviewShowParam,
  type ThingSummary,
} from '@whombat/core';

interface FixturePanel {
  id: string;
  name: string;
  line: string;
  view: (id: string, range: string) => DeskWidgetView;
}

/** A gentle line of `n` readings around `base`, the same for the same seed. */
function wave(seed: number, n: number, base: number, spread: number): number[] {
  return Array.from({ length: n }, (_, i) => {
    const v = base + spread * Math.sin((i + seed) / 4) + spread * 0.4 * Math.sin((i * 7 + seed) / 3);
    return Math.round(v * 10) / 10;
  });
}

const RANGE_SEED: Record<string, number> = { '1h': 3, '24h': 0, '7d': 11 };

/** Panels for the connections whose pages have them in the fixture world, by catalog id. */
const PANELS: Record<string, FixturePanel[]> = {
  homeassistant: [
    {
      id: 'power',
      name: 'Power use',
      line: 'What the house uses now, over time',
      view: (id, range) => ({
        id,
        kind: 'chart',
        title: 'Power now',
        figure: { value: '1.4 kW', rest: '9.8 kWh so far today' },
        series: [{ points: wave(5 + (RANGE_SEED[range] ?? 0), 48, 1.3, 0.5) }],
        unit: 'kW',
      }),
    },
    {
      id: 'climate',
      name: 'Inside',
      line: 'Temperature and humidity in the living room',
      view: (id) => ({
        id,
        kind: 'figures',
        title: 'Inside',
        items: [
          { value: '21.4', unit: '°C', label: 'Living room' },
          { value: '48', unit: '%', label: 'Humidity' },
        ],
        spark: wave(2, 40, 21, 0.6),
      }),
    },
    {
      id: 'lights',
      name: 'Lights',
      line: 'Which lights are on',
      view: (id) => ({
        id,
        kind: 'list',
        title: 'Lights on',
        head: '3 lights on',
        count: 3,
        rows: [
          { title: 'Kitchen', state: 'on', meta: '80 %' },
          { title: 'Hallway', state: 'on', meta: '40 %' },
          { title: 'Study', state: 'on', meta: '100 %' },
        ],
      }),
    },
  ],
  unifi: [
    {
      id: 'internet',
      name: 'Internet',
      line: 'Speed now and over the day',
      view: (id, range) => ({
        id,
        kind: 'chart',
        title: 'Internet',
        figure: { value: '84 Mbit/s', rest: '12 Mbit/s up' },
        series: [{ points: wave(9 + (RANGE_SEED[range] ?? 0), 48, 80, 25) }],
        unit: 'Mbit/s',
      }),
    },
    {
      id: 'devices',
      name: 'Devices',
      line: 'Phones, laptops and everything else on the network',
      view: (id) => ({
        id,
        kind: 'list',
        title: 'Devices',
        head: '38 devices · 1 new today',
        count: 38,
        rows: [
          { title: 'Noor’s phone', meta: 'new', time: '07:42' },
          { title: 'Living room TV', meta: 'Wi-Fi' },
          { title: 'Study laptop', meta: 'cable' },
        ],
      }),
    },
  ],
};

const panelsOf = (t: ThingSummary) => (t.catalogId ? (PANELS[t.catalogId] ?? []) : []);

/** A thing's figures: its facts as figures, with a line over time made from its id. */
function figuresView(id: string, t: ThingSummary, range: string): DeskWidgetView | null {
  const facts = t.facts.slice(0, 4);
  if (!facts.length) return null;
  let seed = 0;
  for (const ch of t.id) seed = (seed * 31 + ch.charCodeAt(0)) % 997;
  const view = {
    id,
    kind: 'figures' as const,
    title: t.name,
    items: facts.map((f) => ({
      value: f.value.slice(0, 24),
      ...(f.unit ? { unit: f.unit.slice(0, 12) } : f.note && f.note.length <= 12 ? { unit: f.note } : {}),
      label: f.label.slice(0, 40),
    })),
    spark: wave(seed + (RANGE_SEED[range] ?? 0), 40, 50, 18),
  };
  return view as DeskWidgetView;
}

export function createOverviewFixtures(things: () => readonly ThingSummary[]) {
  let arranged: OverviewLayout | null = null;
  const thingOf = (ref: string | undefined) => things().find((t) => t.id === ref);
  return {
    arranged: () => arranged,
    arrange(layout: OverviewLayout) {
      arranged = layout;
      return { arranged };
    },
    views(show: string): { views: DeskWidgetView[] } {
      const views: DeskWidgetView[] = [];
      for (const x of parseOverviewShowParam(show)) {
        const t = thingOf(x.thing);
        if (!t) continue;
        const id = overviewShowId(x);
        const range = x.range ?? '24h';
        const panel = x.panel ? panelsOf(t).find((p) => p.id === x.panel) : null;
        const view = panel ? panel.view(id, range) : figuresView(id, t, range);
        if (view) views.push(view);
      }
      return { views };
    },
    figures(thing?: string): DeskCatalog {
      const list = things().filter((t) => /^(connection|device):/.test(t.id) && (!thing || t.id === thing));
      return {
        groups: list.map((t) => ({
          key: t.id,
          label: t.name,
          thing: t.id,
          items: [
            {
              type: 'figures',
              opts: {},
              name: 'Its main figures',
              line: t.facts.length ? t.facts.map((f) => f.label).join(', ') : 'What it says now',
              view: 'figures',
            },
            ...panelsOf(t).map(
              (p): DeskCatalogItem => ({ type: 'panel', opts: { panel: p.id }, name: p.name, line: p.line }),
            ),
          ],
        })),
      };
    },
  };
}
