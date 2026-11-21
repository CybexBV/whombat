/**
 * Protect's detections on a real database (service-slots.md, migration 0135 `connection_events`): it needs Postgres for
 * the upsert that lets an event's update replace its add, the 24-hour window the page reads, the count per day in the
 * burrow's zone, the hourly prune after 14 days, and the rows going with their connection.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { catalogConnections, connectionEvents } from '../../../db/schema/index';
import { insertConnection } from '../../../test/connections';
import { useTestServer } from '../../../test/harness';
import { PROTECT_events } from './fixtures/protect';
import {
  type Detection,
  detectionOf,
  eventDays,
  pruneConnectionEvents,
  recentEvents,
  recordDetection,
} from './protect-events';

const t = useTestServer({ seed: true });

const H = 3600_000;
const D = 24 * H;
let n = 0;

async function protect(): Promise<string> {
  n += 1;
  return insertConnection(t.services, {
    handle: `protect-${n}`,
    catalogId: 'unifi_protect',
    burrowId: t.burrowId,
    fields: { url: 'https://192.168.1.1' },
    secret: 'protect-key',
    auth: { type: 'header', name: 'X-API-KEY', template: '{secret}' },
  });
}

const detection = (id: string, at: Date, over: Partial<Detection> = {}): Detection => ({
  eventId: id,
  at,
  kind: 'smartDetectZone',
  device: 'cam1',
  detected: ['person'],
  end: null,
  ...over,
});

describe('connection_events', () => {
  it('keeps an event once, its update replacing its add', async () => {
    const id = await protect();
    const [add, update, ring, motion] = PROTECT_events.map(detectionOf);
    expect(motion).toBeNull();
    for (const d of [add, update, ring]) if (d) await recordDetection(t.services.db, id, d, 'Front Door');
    const rows = await recentEvents(t.services.db, id, new Date(1792612800000 - H));
    expect(rows.map((r) => [r.kind, r.title])).toEqual([
      ['ring', 'Front Door'],
      ['smartDetectZone', 'Front Door'],
    ]);
    expect(rows[1]?.payload).toEqual({ detected: ['person', 'vehicle'], end: '2026-10-21T20:00:12.000Z' });
    // An update that says nothing new keeps what the add said.
    if (add) await recordDetection(t.services.db, id, { ...add, detected: [], end: null }, 'Front Door');
    const again = await recentEvents(t.services.db, id, new Date(1792612800000 - H));
    expect(again[1]?.payload.detected).toEqual(['person', 'vehicle']);
  });

  it('reads the last 24 hours, newest first, and prunes what is older than 14 days', async () => {
    const id = await protect();
    const now = new Date();
    await recordDetection(t.services.db, id, detection('old', new Date(now.getTime() - 15 * D)), 'Garden');
    await recordDetection(t.services.db, id, detection('week', new Date(now.getTime() - 10 * D)), 'Garden');
    await recordDetection(t.services.db, id, detection('day', new Date(now.getTime() - 23 * H)), 'Garden');
    await recordDetection(
      t.services.db,
      id,
      detection('new', new Date(now.getTime() - H), { kind: 'ring' }),
      'Garden',
    );
    const recent = await recentEvents(t.services.db, id, new Date(now.getTime() - 24 * H));
    expect(recent.map((r) => r.eventId)).toEqual(['new', 'day']);
    expect(await pruneConnectionEvents(t.services.db, now)).toBeGreaterThanOrEqual(1);
    const left = await t.services.db
      .select()
      .from(connectionEvents)
      .where(eq(connectionEvents.connectionId, id));
    expect(left.map((r) => r.eventId).sort()).toEqual(['day', 'new', 'week']);
  });

  it('counts the kept events per day in the burrow’s zone, rings apart, and says the oldest', async () => {
    const id = await protect();
    // 23:30 UTC on 1 November is 2 November in Amsterdam's winter time (UTC+1).
    const at = (iso: string) => new Date(iso);
    await recordDetection(t.services.db, id, detection('a', at('2026-11-01T10:00:00Z')), 'Porch');
    await recordDetection(t.services.db, id, detection('b', at('2026-11-01T23:30:00Z')), 'Porch');
    await recordDetection(
      t.services.db,
      id,
      detection('c', at('2026-11-02T08:00:00Z'), { kind: 'ring' }),
      'Porch',
    );
    const got = await eventDays(t.services.db, id, at('2026-10-25T00:00:00Z'), 'Europe/Amsterdam');
    expect([...got.days].sort()).toEqual([
      ['2026-11-01', { all: 1, rings: 0 }],
      ['2026-11-02', { all: 2, rings: 1 }],
    ]);
    expect(got.oldest?.toISOString()).toBe('2026-11-01T10:00:00.000Z');
    expect((await eventDays(t.services.db, 'con_none', at('2026-10-25T00:00:00Z'), 'UTC')).oldest).toBeNull();
  });

  it('goes with its connection', async () => {
    const id = await protect();
    await recordDetection(t.services.db, id, detection('x', new Date()), 'Porch');
    await t.services.db.delete(catalogConnections).where(eq(catalogConnections.id, id));
    const left = await t.services.db
      .select()
      .from(connectionEvents)
      .where(eq(connectionEvents.connectionId, id));
    expect(left).toEqual([]);
  });
});
