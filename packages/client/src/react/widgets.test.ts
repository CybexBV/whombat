/**
 * Widgets kept on Home or on a thing's page (contracts 0.88, CT-392; connection-pages.md CP-14): an answer of
 * `widgets.remove` or `widgets.move` patches the list of its own place only, and Home only for Home's widgets.
 */
import { QueryClient } from '@tanstack/react-query';
import type { HomeOverview, Widget } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { describe, expect, it } from 'vitest';
import { endpointKey } from '../query/keys';
import { applyWidgets } from './home';

const widget = (id: string, thingId?: string) =>
  ({ id, title: id, ...(thingId ? { thingId } : {}) }) as unknown as Widget;

function cache() {
  const qc = new QueryClient();
  const home = endpointKey(api.widgets.list, { params: { burrow: 'hq' } });
  const page = endpointKey(api.widgets.list, {
    params: { burrow: 'hq' },
    query: { thing: 'connection:con_ha' },
  });
  const other = endpointKey(api.widgets.list, {
    params: { burrow: 'hq' },
    query: { thing: 'connection:con_x' },
  });
  const overview = endpointKey(api.home.overview, { params: { burrow: 'hq' } });
  qc.setQueryData(home, { widgets: [widget('wdg_home')] });
  qc.setQueryData(page, { widgets: [widget('wdg_ha', 'connection:con_ha')] });
  qc.setQueryData(other, { widgets: [widget('wdg_x', 'connection:con_x')] });
  qc.setQueryData(overview, { widgets: [widget('wdg_home')] } as unknown as HomeOverview);
  const ids = (key: readonly unknown[]) =>
    (qc.getQueryData(key) as { widgets: Widget[] }).widgets.map((w) => w.id);
  return { qc, home, page, other, overview, ids };
}

describe('applyWidgets (CP-14)', () => {
  it('patches a thing page’s list only, leaving Home and other pages alone', () => {
    const { qc, home, page, other, overview, ids } = cache();
    applyWidgets(qc, [], 'connection:con_ha');
    expect(ids(page)).toEqual([]);
    expect(ids(home)).toEqual(['wdg_home']);
    expect(ids(other)).toEqual(['wdg_x']);
    expect(ids(overview)).toEqual(['wdg_home']);
  });

  it('patches Home’s list and Home for Home’s widgets', () => {
    const { qc, home, page, overview, ids } = cache();
    applyWidgets(qc, [widget('wdg_b'), widget('wdg_home')]);
    expect(ids(home)).toEqual(['wdg_b', 'wdg_home']);
    expect(ids(overview)).toEqual(['wdg_b', 'wdg_home']);
    expect(ids(page)).toEqual(['wdg_ha']);
  });
});
