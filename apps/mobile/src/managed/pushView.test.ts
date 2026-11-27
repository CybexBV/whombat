import { describe, expect, it } from 'vitest';
import type { DeliveryStatus } from '../../modules/whombat-live/src/content';
import { notificationsView } from './pushView';

const now = Date.parse('2026-11-21T12:00:00Z');
const on = { state: { status: 'registered' as const, handle: 'h' }, lastReceivedAt: now - 300_000 };
const channels = [
  { id: 'whombat.needs-you', name: 'Needs you', blocked: false },
  { id: 'whombat.updates', name: 'Mentions and agent updates', blocked: false },
  { id: 'whombat.runs', name: 'Runs in progress', blocked: false },
];
const delivery = (over: Partial<DeliveryStatus> = {}): DeliveryStatus => ({
  enabled: true,
  channels,
  backgroundRestricted: false,
  batteryOptimized: false,
  liveUpdatesAllowed: true,
  ...over,
});
const blocked = (...ids: string[]) => channels.map((c) => ({ ...c, blocked: ids.includes(c.id) }));

describe('the Notifications row on Android', () => {
  it('is on, with the last arrival, when Android lets everything through', () => {
    const v = notificationsView(on, now, delivery());
    expect(v).toMatchObject({ dot: 'ok', title: 'On', action: null });
    expect(v.meta).toContain('Last one 5 minutes ago');
  });

  it('names one channel that is off and opens that channel’s page', () => {
    const v = notificationsView(on, now, delivery({ channels: blocked('whombat.needs-you') }));
    expect(v).toMatchObject({
      dot: 'warn',
      action: 'delivery',
      page: { page: 'channel', channel: 'whombat.needs-you' },
    });
    expect(v.meta).toContain('“Needs you”');
    expect(v.meta).not.toContain('Last one');
  });

  it('names several channels and opens the app’s notifications page', () => {
    const v = notificationsView(
      on,
      now,
      delivery({ channels: blocked('whombat.needs-you', 'whombat.updates') }),
    );
    expect(v.page).toEqual({ page: 'notifications' });
    expect(v.meta).toContain('“Needs you” and “Mentions and agent updates”');
  });

  it('with the app-wide switch off (Android 8 to 12 keep the channels), says notifications aren’t allowed', () => {
    const v = notificationsView(on, now, delivery({ enabled: false }));
    expect(v).toMatchObject({
      dot: 'warn',
      title: 'Not allowed',
      action: 'delivery',
      page: { page: 'notifications' },
    });
  });

  it('runs in progress off is a calm line with its channel’s page; with another channel off, only that one is named', () => {
    const runs = notificationsView(on, now, delivery({ channels: blocked('whombat.runs') }));
    expect(runs).toMatchObject({
      dot: 'ok',
      title: 'On',
      action: 'delivery',
      page: { page: 'channel', channel: 'whombat.runs' },
    });
    expect(runs.meta).toContain('“Runs in progress”');
    const both = notificationsView(
      on,
      now,
      delivery({ channels: blocked('whombat.runs', 'whombat.needs-you') }),
    );
    expect(both).toMatchObject({ dot: 'warn', page: { page: 'channel', channel: 'whombat.needs-you' } });
    expect(both.meta).not.toContain('Runs in progress');
  });

  it('with every channel off, says notifications aren’t allowed', () => {
    const v = notificationsView(
      on,
      now,
      delivery({ channels: blocked('whombat.needs-you', 'whombat.updates', 'whombat.runs') }),
    );
    expect(v).toMatchObject({ dot: 'warn', title: 'Not allowed', page: { page: 'notifications' } });
  });

  it('says so when the app’s battery use is restricted, and opens the app’s page', () => {
    const v = notificationsView(on, now, delivery({ backgroundRestricted: true }));
    expect(v).toMatchObject({ dot: 'warn', action: 'delivery', page: { page: 'battery' } });
  });

  it('a channel off comes before a restricted battery', () => {
    const v = notificationsView(
      on,
      now,
      delivery({ channels: blocked('whombat.updates'), backgroundRestricted: true }),
    );
    expect(v.page).toEqual({ page: 'channel', channel: 'whombat.updates' });
  });

  it('battery optimisation is one calm line with no button; Live Updates off has its page', () => {
    const battery = notificationsView(on, now, delivery({ batteryOptimized: true }));
    expect(battery).toMatchObject({ dot: 'ok', title: 'On', action: null });
    expect(battery.meta).toContain('battery');
    const live = notificationsView(on, now, delivery({ batteryOptimized: true, liveUpdatesAllowed: false }));
    expect(live).toMatchObject({ dot: 'ok', action: 'delivery', page: { page: 'liveUpdates' } });
    expect(live.meta).toContain('Live Updates');
    expect(live.meta).not.toContain('battery');
  });

  it('changes nothing without a status (iOS, an older build) or before push is on', () => {
    expect(notificationsView(on, now, null)).toMatchObject({ dot: 'ok', title: 'On', action: null });
    expect(
      notificationsView(
        { state: { status: 'denied' }, lastReceivedAt: null },
        now,
        delivery({ channels: blocked('whombat.runs') }),
      ),
    ).toMatchObject({ title: 'Not allowed', action: 'settings' });
  });
});

describe('the Notifications row on an iPhone allowed quietly', () => {
  it('says they are on, quietly, and offers to turn alerts on', () => {
    const v = notificationsView({ ...on, quiet: true }, now, null);
    expect(v).toMatchObject({ dot: 'ok', title: 'On, quietly', action: 'alerts' });
    expect(v.meta).toContain('Notification Center');
    expect(v.meta).toContain('Last one 5 minutes ago');
    // With alerts it is the usual row.
    expect(notificationsView({ ...on, quiet: false }, now, null)).toMatchObject({
      title: 'On',
      action: null,
    });
  });
});
