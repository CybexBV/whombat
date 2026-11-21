/**
 * The calm glance's two reads of the database (desk-display-server.md DK-S142, DK-S143): which connections have an
 * activity to show (active, Home's, fresh) and which automations run next (live, scheduled, within the window). Postgres
 * because the point is what those queries pick out.
 */
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { catalogConnections } from '../db/schema/index';
import type { ConnectionGlance } from '../home/types';
import { IDS, useAutomationWorld } from '../test/automations';
import { insertConnection } from '../test/connections';
import { ACTIVITY_FRESH_MS, createDeskCalmSources, type DeskCalmSources } from './calm-sources';

const w = useAutomationWorld();
let sources: DeskCalmSources;
const viewer = () => ({ burrowId: w.burrowId, personId: IDS.mara, timeZone: 'UTC' });

async function withActivity(
  catalogId: string,
  label: string,
  activity: ConnectionGlance['activity'],
  more: { status?: 'active' | 'needs_reauth'; ageMs?: number } = {},
) {
  const id = await insertConnection(w.services, {
    catalogId,
    burrowId: w.burrowId,
    label,
    fields: { url: `http://${catalogId}.home-test.test:8080` },
    secret: 'x',
    status: more.status ?? 'active',
  });
  const glance: ConnectionGlance = { status: 'ok', facts: [], ...(activity ? { activity } : {}) };
  await w.services.db
    .update(catalogConnections)
    .set({ glance, glanceAt: new Date(w.now().getTime() - (more.ageMs ?? 60_000)) })
    .where(eq(catalogConnections.id, id));
  return id;
}

const every = (minutes: number) => ({
  version: 1 as const,
  conversationId: IDS.general,
  triggers: [
    {
      kind: 'schedule' as const,
      schedule: { kind: 'interval' as const, everyMinutes: minutes },
      timeZone: 'UTC',
    },
  ],
  steps: [{ id: 'hi', kind: 'post_message' as const, text: 'Tick' }],
});

beforeAll(() => {
  sources = createDeskCalmSources(w.services);
});

describe('activities', () => {
  it('lists the active connections with a fresh activity, going-on ones first', async () => {
    const plex = await withActivity('plex', 'Plex', { active: true, value: '2 watching', detail: 'Dune' });
    const sab = await withActivity('sabnzbd', 'SABnzbd', { active: false, value: 'Nothing to download' });
    await withActivity(
      'overseerr',
      'Old Seerr',
      { active: true, value: '1 new request' },
      { ageMs: ACTIVITY_FRESH_MS + 60_000 },
    );
    await withActivity(
      'radarr',
      'Radarr',
      { active: true, value: '1 downloading' },
      { status: 'needs_reauth' },
    );
    await withActivity('sonarr', 'Sonarr', undefined);
    const list = await sources.activities(viewer(), w.now());
    expect(list.map((a) => a.key)).toEqual([`connection:${plex}`, `connection:${sab}`]);
    expect(list[0]).toMatchObject({ name: 'Plex', mark: 'plex', active: true, detail: 'Dune' });
  });

  it('reads only the viewer’s burrow', async () => {
    expect(await sources.activities({ ...viewer(), burrowId: 'brw_elsewhere' }, w.now())).toEqual([]);
  });
});

describe('coming', () => {
  it('names the live scheduled automations within the window, soonest first', async () => {
    await w.publish(every(30), { name: 'Check the backups' });
    await w.publish(every(10), { name: 'Tidy the downloads' });
    await w.publish(every(20), { name: 'Switched off', enable: false });
    await w.publish(every(60 * 30), { name: 'Far off' });
    const coming = await sources.coming(viewer(), w.now(), 3_600);
    expect(coming.map((c) => c.name)).toEqual(['Tidy the downloads', 'Check the backups']);
    expect(Date.parse(coming[0]?.at ?? '')).toBeGreaterThan(w.now().getTime());
  });

  it('is empty when nothing runs within the window', async () => {
    expect(await sources.coming(viewer(), w.now(), 60)).toEqual([]);
  });
});
