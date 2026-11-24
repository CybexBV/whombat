/**
 * Arranging the Overview (docs/decisions/overview-arranged.md): the layout is kept on the Whombat's row (a Postgres
 * column, written through the commit pipeline), `home.overview` carries it to every device, and a layout naming a
 * thing twice is refused. A tile that names nothing the runtime reads gets no view.
 */
import { HomeOverview, type OverviewLayout } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { burrows } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';

const t = useTestServer({ seed: true, app: true });
const BASE = '/api/v1/burrows/burrow-hq';

const LAYOUT: OverviewLayout = {
  tiles: [
    { thing: 'connection:con_ha', size: 'l', panel: 'power', range: '7d' },
    { thing: 'device:dev_heat', size: 's', hidden: true },
  ],
  top: [{ own: 'servers' }, { thing: 'connection:con_ha', range: '24h' }],
  pins: { wdg_01HZX3K4M5N6P7Q8R9S0T1V2W3: { size: 'full' } },
};

describe('arranging the Overview', () => {
  it('keeps one layout for the Whombat and sends it with the Overview', async () => {
    const { cookie } = await sessionFor(t.services, IDS.mara);
    const before = await t.api.inject({ method: 'GET', url: `${BASE}/home`, headers: { cookie } });
    expect(before.statusCode, before.body).toBe(200);
    expect(HomeOverview.parse(before.json()).arranged).toBeNull();

    const put = await t.api.inject({
      method: 'PUT',
      url: `${BASE}/overview/layout`,
      headers: { cookie },
      payload: { layout: LAYOUT },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().arranged.tiles[0]).toMatchObject({
      thing: 'connection:con_ha',
      size: 'l',
      panel: 'power',
    });

    const [row] = await t.services.db
      .select({ layout: burrows.overviewLayout })
      .from(burrows)
      .where(eq(burrows.slug, 'burrow-hq'));
    expect(row?.layout?.top).toHaveLength(2);

    const after = await t.api.inject({ method: 'GET', url: `${BASE}/home`, headers: { cookie } });
    const arranged = HomeOverview.parse(after.json()).arranged;
    expect(arranged?.tiles.map((x) => x.thing)).toEqual(['connection:con_ha', 'device:dev_heat']);
    expect(arranged?.tiles[1]?.hidden).toBe(true);
    expect(arranged?.pins.wdg_01HZX3K4M5N6P7Q8R9S0T1V2W3?.size).toBe('full');
  });

  it('refuses a layout with the same thing twice', async () => {
    const { cookie } = await sessionFor(t.services, IDS.mara);
    const res = await t.api.inject({
      method: 'PUT',
      url: `${BASE}/overview/layout`,
      headers: { cookie },
      payload: {
        layout: {
          tiles: [
            { thing: 'connection:con_ha', size: 's' },
            { thing: 'connection:con_ha', size: 'w' },
          ],
          top: [],
        },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('reads no view for what isn’t a tile', async () => {
    const { cookie } = await sessionFor(t.services, IDS.mara);
    const res = await t.api.inject({
      method: 'GET',
      url: `${BASE}/overview/views?show=${encodeURIComponent('server:pve-01~~,nothing~~')}`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().views).toEqual([]);
  });
});
