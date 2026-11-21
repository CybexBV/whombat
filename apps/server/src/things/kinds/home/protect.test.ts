import { ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { CatalogConnectionRow } from '../../../connections/types';
import { slotProblems } from '../slots';
import {
  PROTECT_cameras,
  PROTECT_events,
  PROTECT_info,
  PROTECT_lights,
  PROTECT_nvr,
  PROTECT_profiles,
  PROTECT_sensors,
} from './fixtures/protect';
import {
  armButtons,
  cameraItems,
  detectionItems,
  detectionWords,
  offlineSinceOf,
  PROTECT_CHECKS,
  type ProtectCtx,
  parseProtect,
  protectKpis,
  protectNotices,
  protectSkipped,
  protectTrend,
  protectUrl,
  protectView,
  ringWords,
} from './protect';
import {
  BACKOFF_FIRST_MS,
  BACKOFF_MAX_MS,
  detectionOf,
  type EventDays,
  type KeptEvent,
  nextBackoff,
} from './protect-events';

const NOW = new Date('2026-10-21T21:00:00Z');
const TZ = 'Europe/Amsterdam';
const ROW = {
  id: 'con_protect',
  access: 'manage',
  label: 'UniFi Protect',
  catalogId: 'unifi_protect',
  fields: { url: 'https://192.168.1.1' },
  baseUrl: 'https://192.168.1.1/proxy/protect/integration',
} as unknown as CatalogConnectionRow;

const snapshot = (over: Partial<Parameters<typeof parseProtect>[0]> = {}) =>
  parseProtect(
    {
      info: PROTECT_info,
      cameras: PROTECT_cameras,
      nvr: PROTECT_nvr,
      profiles: PROTECT_profiles,
      sensors: PROTECT_sensors,
      lights: PROTECT_lights,
      ...over,
    },
    NOW,
  );

/** Kept detections per day: `counts` the last days, today last, as the database counts them. */
function days(counts: number[], rings = 0, followedDays = counts.length): EventDays {
  const out = new Map<string, { all: number; rings: number }>();
  counts.forEach((n, i) => {
    const at = new Date(NOW.getTime() - (counts.length - 1 - i) * 86_400_000);
    out.set(new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(at), {
      all: n,
      rings: i === counts.length - 1 ? rings : 0,
    });
  });
  return { days: out, oldest: new Date(NOW.getTime() - (followedDays - 1) * 86_400_000 - 3600_000) };
}

/** The kept rows for the event-stream fixtures (an update replaces its add). */
function kept(): KeptEvent[] {
  const by = new Map<string, KeptEvent>();
  for (const m of PROTECT_events) {
    const d = detectionOf(m);
    if (!d) continue;
    by.set(d.eventId, {
      eventId: d.eventId,
      at: d.at,
      kind: d.kind,
      device: d.device,
      title: 'Front Door',
      payload: {
        ...(d.detected.length ? { detected: d.detected } : {}),
        ...(d.end ? { end: d.end.toISOString() } : {}),
      },
    });
  }
  return [...by.values()].sort((a, b) => b.at.getTime() - a.at.getTime());
}

const ctx = (over: Partial<ProtectCtx> = {}): ProtectCtx => ({
  now: NOW,
  timeZone: TZ,
  events: kept(),
  offlineSince: new Map([['672094f900e26303e8000700', new Date('2026-10-21T12:02:00Z')]]),
  follow: { connected: true, failingSince: null },
  ...over,
});

describe('UniFi Protect', () => {
  it('reads cameras, version and the alarm', () => {
    const s = snapshot();
    expect(s.version).toBe('7.3.70');
    expect(s.cameras.map((c) => c.state)).toEqual(['CONNECTED', 'CONNECTED', 'DISCONNECTED']);
    expect(s.arm?.status).toBe('disabled');
    expect(s.profiles).toBe(1);
  });

  it('keeps rings and smart detections from the event stream, not plain motion', () => {
    const ds = PROTECT_events.map(detectionOf);
    expect(ds.map((d) => d?.kind ?? null)).toEqual(['smartDetectZone', 'smartDetectZone', 'ring', null]);
    expect(ds[1]?.detected).toEqual(['person', 'vehicle']);
    expect(ds[1]?.end?.getTime()).toBe(1792612812000);
    expect(
      detectionOf({ type: 'add', item: { modelKey: 'camera', id: 'x', type: 'ring', start: 1 } }),
    ).toBeNull();
    expect(detectionOf('not json')).toBeNull();
  });

  it('words detections', () => {
    const [ring, person] = kept();
    expect(detectionWords(ring as KeptEvent)).toBe('Doorbell rang at Front Door');
    expect(detectionWords(person as KeptEvent)).toBe('Person and Vehicle seen at Front Door');
    expect(detectionItems(kept()).map((i) => i.id)).toEqual([
      '6717a0010000000000000002',
      '6717a0010000000000000001',
    ]);
  });

  it('gives the four figures', () => {
    expect(protectKpis(snapshot(), ctx()).map((k) => [k.key, k.value])).toEqual([
      ['cameras', '2'],
      ['alarm', 'Disarmed'],
      ['detections', '2'],
      ['version', '7.3.70'],
    ]);
    expect(protectKpis(snapshot(), ctx())[0]?.tone).toBe('warn');
  });

  it('says which camera is offline and since when, one line per camera (QN-03)', () => {
    const n = protectNotices(snapshot(), ctx());
    expect(n.map((x) => [x.id, x.tone])).toEqual([['camera-offline-672094f900e26303e8000700', 'warn']]);
    expect(n[0]?.title).toContain('Server Room');
    expect(n[0]?.detail).toContain('14:02');
    expect(n[0]).toMatchObject({
      nature: 'problem',
      check: 'protect.camera_offline',
      subject: { id: 'camera:672094f900e26303e8000700', name: 'Server Room' },
      ignore: { lifts: 'fixed', words: 'Until it’s back online.' },
      confirm: 2,
    });
  });

  it('a camera reconnecting is offline only after 10 minutes (QN-04)', () => {
    const reconnecting = (min: number) => {
      const s = snapshot();
      (s.cameras[2] as { state: string }).state = 'CONNECTING';
      return protectNotices(
        s,
        ctx({
          offlineSince: new Map([['672094f900e26303e8000700', new Date(NOW.getTime() - min * 60_000)]]),
        }),
      );
    };
    expect(reconnecting(4)).toEqual([]);
    expect(reconnecting(12)[0]?.detail).toMatch(/^Reconnecting since/);
  });

  it('says when the alarm goes off, and when detections can’t be followed', () => {
    const breach = snapshot({
      nvr: { ...PROTECT_nvr, armMode: { ...PROTECT_nvr.armMode, status: 'breach' } },
    });
    const alarm = protectNotices(breach, ctx())[0];
    // Only a person checks the house and disarms: no assistant (QN-02); the next time it goes off is new.
    expect(alarm).toMatchObject({
      tone: 'bad',
      nature: 'you',
      check: 'protect.alarm',
      badge: 'Alarm going off',
    });
    expect(alarm?.link).toBeUndefined();
    expect(alarm?.ignore?.lifts).toBe('newer');
    const failing = protectNotices(
      snapshot(),
      ctx({ follow: { connected: false, failingSince: new Date(NOW.getTime() - 600_000) } }),
    );
    expect(failing.find((x) => x.id === 'events')).toMatchObject({ tone: 'info', nature: 'fyi' });
    expect(protectSkipped(snapshot(), ctx())).toEqual([]);
    expect(protectSkipped(snapshot({ nvr: null }), ctx({ follow: null }))).toEqual([
      'protect.alarm',
      'protect.events',
    ]);
    expect(PROTECT_CHECKS.map((c) => c.check)).toEqual([
      'protect.alarm',
      'protect.camera_offline',
      'protect.events',
    ]);
  });

  it('draws online cameras with a snapshot and offline ones greyed', () => {
    const items = cameraItems(
      snapshot(),
      ctx(),
      (id, alt) => ({ ref: `ref-${id}.signature000`, alt, shape: 'wide' }),
      null,
    );
    expect(items.map((i) => [i.title, !!i.image, i.muted ?? false])).toEqual([
      ['Front Door', true, false],
      ['Office Entrance', true, false],
      ['Server Room', false, true],
    ]);
    expect(items[2]?.sub).toContain('14:02');
  });

  it('puts the doorbells first, with when they last rang', () => {
    const cameras = PROTECT_cameras.map((c, i) => (i ? { ...c, type: 'UVC G5 Bullet' } : c));
    const items = cameraItems(
      snapshot({ cameras }),
      ctx(),
      (id, alt) => ({ ref: `ref-${id}.sig00000000`, alt, shape: 'wide' }),
      null,
    );
    expect(items[0]).toMatchObject({ title: 'Front Door', sub: 'Rang at 22:10' });
    expect(items[1]?.sub).toBeUndefined();
    expect(ringWords(new Date('2026-10-20T19:40:00Z'), ctx())).toBe('Rang yesterday at 21:40');
    expect(ringWords(undefined, ctx())).toBe('Hasn’t rung today');
    expect(ringWords(undefined, ctx({ events: null }))).toBeNull();
  });

  it('arms or disarms only with an alarm profile, confirmed', () => {
    const b = { row: ROW };
    expect(armButtons(snapshot(), b).map((x) => [x.action, !!x.confirm])).toEqual([['arm', true]]);
    const armed = snapshot({ nvr: { ...PROTECT_nvr, armMode: { ...PROTECT_nvr.armMode, status: 'armed' } } });
    expect(armButtons(armed, b).map((x) => x.action)).toEqual(['disarm']);
    expect(armButtons(snapshot({ profiles: [] }), b)).toEqual([]);
    expect(armButtons(snapshot({ profiles: null }), b)).toEqual([]);
  });

  it('reads sensors and lights, and the console’s name', () => {
    const s = snapshot();
    expect(s.nvrName).toBe('UNVR Pro');
    expect(s.sensors?.map((x) => [x.name, x.opened, x.lowBattery])).toEqual([
      ['Back door', true, false],
      ['Garage door', false, true],
    ]);
    expect(s.lights?.map((x) => [x.name, x.on])).toEqual([['Driveway light', true]]);
    expect(snapshot({ sensors: null, lights: null }).sensors).toBeNull();
  });

  it('builds its Summary in slots: Today with the alarm, In Protect, the cameras, the week', () => {
    const view = protectView(snapshot(), ctx({ days: days([12, 30, 8, 41, 22, 17, 2], 1) }), {
      buttons: { row: ROW },
      picture: (id, alt) => ({ ref: `ref-${id}.signature000`, alt, shape: 'wide' }),
      openUrl: protectUrl(ROW),
    });
    expect(slotProblems(view)).toEqual([]);
    expect(view.kpis).toEqual([]);
    expect(view.buttons).toEqual([]);
    expect(view.refreshS).toBe(10);
    for (const p of view.panels) expect(ThingPagePanel.safeParse(p).success).toBe(true);
    expect(view.panels.map((p) => p.id)).toEqual(['detections', 'inventory', 'cameras', 'week']);

    const today = view.panels[0];
    if (today?.kind !== 'list') throw new Error('Today is a list');
    expect(today.meta).toBe('2 detections · 1 ring');
    // The alarm first, with Arm and a figure a desk keeps; then today's detections, the ring first.
    expect(today.items[0]).toMatchObject({ id: 'alarm', right: 'Disarmed', figure: { value: 'Disarmed' } });
    expect(today.items[0]?.actions?.map((b) => [b.action, !!b.confirm])).toEqual([['arm', true]]);
    expect(today.items.slice(1).map((i) => i.title)).toEqual([
      'Doorbell rang at Front Door',
      'Person and Vehicle seen at Front Door',
    ]);

    const inv = view.panels[1];
    if (inv?.kind !== 'list') throw new Error('In Protect is a list');
    expect(inv.items.map((i) => [i.title, i.figure?.value, i.figure?.note ?? null])).toEqual([
      ['Cameras', '3', '1 offline'],
      ['Detections today', '2', '1 ring'],
      ['Sensors', '2', '1 low battery'],
      ['Lights', '1', '1 on'],
    ]);
    expect(inv.items[0]?.detail).toBe('3 doorbells');
    expect(inv.items[2]?.detail).toBe('1 open');

    const cameras = view.panels[2];
    expect(cameras).toMatchObject({ kind: 'gallery', look: 'shelf', shape: 'wide', meta: '2 of 3 online' });

    const week = view.panels[3];
    if (week?.kind !== 'chart') throw new Error('This week is a chart');
    expect(week.labels?.at(-1)).toBe('Today');
    expect(week.series[0]?.values).toEqual([12, 30, 8, 41, 22, 17, 2]);
    expect(week.figure).toMatchObject({ value: '132', rest: 'detections' });

    expect(view.slots?.machine.map((b) => [b.label, b.value, b.sub])).toEqual([
      ['Protect', '7.3.70', 'On UNVR Pro'],
      ['Detections', 'Followed live', 'Whombat keeps two weeks of them'],
    ]);
    expect(view.verdict).toBe('UniFi Protect is fine: 2 of 3 cameras are online.');
    expect(protectUrl(ROW)).toBe('https://192.168.1.1/protect/dashboard');
  });

  it('counts the week only from when Whombat follows, and the change once it followed two weeks', () => {
    // Followed for 3 days: no bars before, no change.
    const short = protectTrend(ctx({ days: days([5, 6, 7], 0, 3) }));
    expect(short?.series[0]?.values).toEqual([null, null, null, null, 5, 6, 7]);
    expect(short?.stats).toBeUndefined();
    expect(protectTrend(ctx({ days: days([5], 0, 1) }))).toBeNull();
    expect(protectTrend(ctx({ days: null }))).toBeNull();
    // Two weeks: 70 this week against 35 before.
    const two = protectTrend(ctx({ days: days([5, 5, 5, 5, 5, 5, 5, 10, 10, 10, 10, 10, 10, 10], 0, 14) }));
    expect(two?.figure?.value).toBe('70');
    expect(two?.stats?.[0]?.[0]?.text).toBe('+100 %');
  });

  it('leaves Today out without an alarm and without detections followed', () => {
    const view = protectView(snapshot({ nvr: null }), ctx({ events: null, days: null }), {
      buttons: { row: ROW },
      picture: () => undefined,
      openUrl: protectUrl(ROW),
    });
    expect(slotProblems(view)).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['inventory', 'cameras']);
  });

  it('keeps the card’s figures from its own', () => {
    const kpis = protectKpis(snapshot(), ctx({ days: days([3, 46], 3) }));
    expect(kpis.find((k) => k.key === 'detections')?.value).toBe('46');
  });

  it('remembers since when a camera is offline, and forgets it once it is back', () => {
    const s = snapshot();
    const first = offlineSinceOf('con_t', s).get('672094f900e26303e8000700');
    const later = { ...s, readAt: new Date(NOW.getTime() + 600_000) };
    expect(offlineSinceOf('con_t', later).get('672094f900e26303e8000700')).toEqual(first);
    const back = { ...later, cameras: later.cameras.map((c) => ({ ...c, state: 'CONNECTED' })) };
    expect(offlineSinceOf('con_t', back).size).toBe(0);
  });

  it('backs off when the stream keeps failing', () => {
    expect(nextBackoff(null)).toBe(BACKOFF_FIRST_MS);
    expect(nextBackoff(BACKOFF_FIRST_MS)).toBe(BACKOFF_FIRST_MS * 2);
    expect(nextBackoff(BACKOFF_MAX_MS)).toBe(BACKOFF_MAX_MS);
  });
});
