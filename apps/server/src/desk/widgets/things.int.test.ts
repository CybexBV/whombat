/**
 * Every connection's widgets on a real database (desk-display-server.md “Every connection's widgets”): Postgres is the
 * point — *Add a widget* lists the burrow's connections as Home's things does (a connection only automations use is
 * left out), and a widget resolves from the page `things.page` builds, its pictures signed for the connection they
 * belong to, so the screens' picture checks (`thingPicture`) take them.
 */
import { type DeskWidgetRef, thingId } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { principals } from '../../db/schema/index';
import type { PrincipalRow } from '../../read/principals';
import { IDS } from '../../seed/test-world';
import { insertConnection } from '../../test/connections';
import { useTestServer } from '../../test/harness';
import { imageRef, readImageRef } from '../../things/images';
import { KIND_MODULES } from '../../things/kinds/index';
import type { KindModule } from '../../things/kinds/registry';
import { createThingWidgets } from './things';
import type { WidgetCtx } from './types';

const t = useTestServer({ seed: true });

/** A kind whose page has what plays, as posters signed for its connection. */
const testKind: KindModule = {
  page: async (ctx) => ({
    kpis: [{ key: 'watching', label: 'Watching now', value: '1' }],
    charts: [],
    refreshS: 5,
    notices: [],
    panels: [
      {
        kind: 'gallery',
        id: 'playing',
        place: 'main',
        title: 'Now playing',
        shape: 'poster',
        items: [
          {
            id: 's1',
            title: 'Dune: Part Two',
            image: { ref: imageRef(ctx, { path: '/poster.png' }), alt: 'Dune: Part Two', shape: 'poster' },
          },
        ],
      },
    ],
    tabs: [],
    facts: [],
    actions: [],
    readAt: ctx.now,
    suggestions: [],
  }),
};
const kinds = KIND_MODULES as Record<string, KindModule | undefined>;
const before = kinds.grafana;
let grafana = '';
let ctx: WidgetCtx;

beforeAll(async () => {
  grafana = await insertConnection(t.services, {
    catalogId: 'grafana',
    burrowId: t.burrowId,
    label: 'Grafana',
    fields: { url: 'http://grafana.home-test.test:3000' },
    secret: 'x',
  });
  kinds.grafana = testKind;
  const [mara] = await t.services.db.select().from(principals).where(eq(principals.id, IDS.mara));
  const person = mara as PrincipalRow;
  ctx = {
    services: t.services,
    viewer: { accountId: person.accountId as string, burrowId: t.burrowId, principal: person },
    now: t.services.clock(),
    timeZone: 'Europe/Amsterdam',
    assistant: 'Dusty',
  };
});

afterAll(() => {
  kinds.grafana = before;
});

describe('every connection’s widgets', () => {
  it('lists the burrow’s connections with their page’s panels', async () => {
    const widgets = createThingWidgets(t.services);
    const ref = thingId('connection', grafana);
    const group = (await widgets.groups(ctx)).find((g) => g.thing === ref);
    expect(group?.label).toBe('Grafana');
    expect(group?.items.map((i) => i.opts.panel ?? i.type)).toEqual(
      expect.arrayContaining(['figures', 'playing']),
    );
  });

  it('resolves a panel from the real page, its pictures signed for its connection', async () => {
    const widgets = createThingWidgets(t.services);
    const ref = thingId('connection', grafana) as DeskWidgetRef;
    const got = await widgets.resolve(ctx, [
      { id: 'w_play', type: 'panel', ref, opts: { panel: 'playing' } },
      { id: 'w_fig', type: 'figures', ref, opts: {} },
    ]);
    const view = got.get('w_play')?.view;
    if (view?.kind !== 'posters') throw new Error(`posters, not ${JSON.stringify(view)}`);
    const image = view.items[0]?.image;
    expect(image?.thing).toBe(ref);
    expect(readImageRef(t.services.custody, image?.ref ?? '', t.services.clock())?.c).toBe(grafana);
    expect(got.get('w_play')?.refreshS).toBe(10);
    expect(got.get('w_fig')?.view.kind).toBe('figures');
  });
});
