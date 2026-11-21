/** Contracts 0.94.0, Connections: a figure opens its charts, the Connections page's path (CT-449…CT-452). */
import { describe, expect, it } from 'vitest';
import { CONNECTIONS_HREF, DASHBOARD_HREF, HomeHref } from './home.js';
import { ThingPageKpi, ThingPagePanel } from './thing-page.js';

const cpu = { key: 'cpu', label: 'CPU', value: '10 %', spark: [1, 2, null, 4], color: 'blue' } as const;

describe('a figure opens its charts or leads somewhere (CT-449)', () => {
  it('names up to three chart panels by id', () => {
    expect(ThingPageKpi.parse({ ...cpu, charts: ['cpu'] }).charts).toEqual(['cpu']);
    expect(ThingPageKpi.parse({ ...cpu, charts: ['network', 'disk'] }).charts).toEqual(['network', 'disk']);
    expect(ThingPageKpi.safeParse({ ...cpu, charts: [] }).success).toBe(false);
    expect(ThingPageKpi.safeParse({ ...cpu, charts: ['a', 'b', 'c', 'd'] }).success).toBe(false);
    expect(ThingPageKpi.safeParse({ ...cpu, charts: ['Not a key'] }).success).toBe(false);
  });

  it('leads to a tab or a page instead', () => {
    const guests = { key: 'guests', label: 'Guests', value: '19', rest: 'of 22 running' };
    const link = { kind: 'tab', label: 'Guests', tab: 'guests' } as const;
    expect(ThingPageKpi.parse({ ...guests, link }).link).toEqual(link);
    const href = { kind: 'href', label: 'All guests', href: '/things/servers?view=guests' } as const;
    expect(ThingPageKpi.parse({ ...guests, link: href }).link).toEqual(href);
  });

  it('keeps a figures panel without either as before', () => {
    const panel = ThingPagePanel.parse({ kind: 'kpis', id: 'figures', place: 'top', items: [cpu] });
    expect(panel.kind === 'kpis' && panel.items[0]).toEqual(cpu);
  });
});

describe('the Connections page (CT-450)', () => {
  it('has its own path and keeps the Dashboard’s', () => {
    expect(CONNECTIONS_HREF).toBe('/connections');
    expect(DASHBOARD_HREF).toBe('/dashboard');
    expect(HomeHref.safeParse(CONNECTIONS_HREF).success).toBe(true);
  });
});
