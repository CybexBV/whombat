import { describe, expect, it } from 'vitest';
import { api } from '../contracts/index.js';
import { ThingPage, ThingPagePanel, ThingPageQuery, thingPanelPlace, thingPanelSpan } from './thing-page.js';

const t0 = '2026-10-18T08:00:00.000Z';
const t1 = '2026-10-18T09:00:00.000Z';

const page = {
  id: 'connection:con_ha1',
  kind: 'connection',
  connectionId: 'con_ha1',
  catalogId: 'homeassistant',
  name: 'Home Assistant',
  icon: 'homeassistant',
  status: 'warn',
  badge: 'Needs a look',
  facts: [],
  runsOn: null,
  settings: true,
  actions: [],
  readAt: t1,
  range: '24h',
  ranges: ['1h', '6h', '24h', '7d', '30d'],
  refreshS: 60,
  tabs: [
    {
      key: 'overview',
      label: 'Summary',
      panels: [
        {
          kind: 'kpis',
          id: 'figures',
          place: 'top',
          items: [
            {
              key: 'cpu',
              label: 'CPU',
              value: '2 %',
              sub: 'of 4 cores',
              spark: [1.8, null, 2.1],
              color: 'blue',
            },
            {
              key: 'integrations',
              label: 'Integrations',
              value: '100',
              rest: 'of 102',
              meter: 0.98,
              tone: 'warn',
            },
          ],
        },
        {
          kind: 'chart',
          id: 'disk',
          place: 'chart',
          span: 1,
          title: 'Disk space',
          timestamps: [t0, t1],
          series: [{ key: 'disk', label: 'Disk', unit: '%', values: [75.6, 76], color: 'amber', fill: true }],
          figure: { value: '76 %', rest: '30 of 40 GB', tone: 'warn' },
          stats: [[{ text: '30 days' }], [{ text: '+ ' }, { text: '3.6 GB', strong: true }]],
          foot: [{ label: 'Old backups', value: '8.7 GB', tone: 'warn' }],
          axis: { min: 50, max: 100, unit: '%' },
          forecast: { at: '2026-12-18T00:00:00.000Z', value: 100, label: 'full ~18 Dec' },
        },
        {
          kind: 'chart',
          id: 'errors',
          place: 'chart',
          span: 2,
          title: 'Errors in the log',
          style: 'bars',
          timestamps: [t0, t1],
          series: [
            { key: 'modbus', label: 'Modbus', values: [470, 512], color: 'orange' },
            { key: 'other', label: 'Everything else', values: [41, 38], color: 'grey' },
          ],
        },
        {
          kind: 'bars',
          id: 'storage',
          place: 'bottom',
          title: 'Storage',
          columns: 3,
          items: [
            {
              id: 'local-lvm',
              label: 'local-lvm',
              mono: true,
              note: 'thin · NVMe',
              value: '660 of 930 GB',
              pct: 0.71,
              sub: 'Full in about 5 months',
            },
            { id: 'parity', label: 'Parity', value: 'valid', pct: null },
          ],
        },
        {
          kind: 'table',
          id: 'guests',
          place: 'main',
          title: 'Busiest guests',
          columns: [
            { key: 'name', label: 'Guest' },
            { key: 'cpu', label: 'CPU', numeric: true },
            { key: 'day', label: '24 h' },
            { key: 'open', label: '' },
          ],
          rows: [
            {
              id: 'pve:131',
              cells: {
                name: { text: 'home-assistant', mono: true, note: 'CT 131' },
                cpu: { text: '6.1 %', meter: 0.061 },
                day: { text: '', spark: [5, 6, 6.1] },
                open: {
                  text: 'Console',
                  href: '/things/server%3Apve-02?console=guest%3Apve%3A131',
                  button: true,
                },
              },
            },
          ],
        },
      ],
    },
  ],
};

describe('contracts 0.89.0: dashboards (CT-394…CT-397)', () => {
  it('reads a page with places, small lines, chart cards, bars and its range', () => {
    const r = ThingPage.safeParse(page);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it('keeps reading a 0.88 page without any of it', () => {
    const old = {
      ...page,
      range: undefined,
      ranges: undefined,
      refreshS: undefined,
      tabs: [
        {
          key: 'overview',
          label: 'Overview',
          panels: [{ kind: 'kpis', id: 'f', items: [{ key: 'a', label: 'A', value: '1' }] }],
        },
      ],
    };
    expect(ThingPage.safeParse(old).success).toBe(true);
  });

  it('refuses a colour, span or meter out of range', () => {
    const chart = page.tabs[0]?.panels[1] as Record<string, unknown>;
    expect(ThingPagePanel.safeParse({ ...chart, span: 4 }).success).toBe(false);
    expect(
      ThingPagePanel.safeParse({ ...chart, series: [{ key: 'a', label: 'A', values: [1], color: 'pink' }] })
        .success,
    ).toBe(false);
    expect(
      ThingPagePanel.safeParse({
        kind: 'kpis',
        id: 'f',
        items: [{ key: 'a', label: 'A', value: '1', meter: 1.2 }],
      }).success,
    ).toBe(false);
  });

  it('takes a range on things.page and only a known one', () => {
    expect(api.things.page.query).toBe(ThingPageQuery);
    expect(ThingPageQuery.safeParse({ range: '7d' }).success).toBe(true);
    expect(ThingPageQuery.safeParse({ range: '2d' }).success).toBe(false);
  });

  it('places a 0.88 panel from its width', () => {
    const kpis: ThingPagePanel = {
      kind: 'kpis',
      id: 'f',
      width: 'full',
      items: [{ key: 'a', label: 'A', value: '1' }],
    };
    const chart = { kind: 'chart', id: 'c', width: 'wide', title: 'C', timestamps: [], series: [] } as never;
    const notices: ThingPagePanel = {
      kind: 'notices',
      id: 'n',
      width: 'narrow',
      title: 'Worth a look',
      items: [],
    };
    const table = { kind: 'table', id: 't', width: 'wide', title: 'T', columns: [], rows: [] } as never;
    expect(thingPanelPlace(kpis, false)).toBe('top');
    expect(thingPanelPlace(kpis, true)).toBe('bottom');
    expect(thingPanelPlace(chart, false)).toBe('chart');
    expect(thingPanelSpan(chart)).toBe(2);
    expect(thingPanelPlace(notices, true)).toBe('side');
    expect(thingPanelPlace(table, true)).toBe('main');
    expect(thingPanelPlace({ ...notices, place: 'main' } as ThingPagePanel, true)).toBe('main');
    expect(thingPanelSpan({ ...kpis, place: 'chart' } as ThingPagePanel)).toBe(1);
  });
});
