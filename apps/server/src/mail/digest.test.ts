import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationPreferences } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { PushSender } from '../push/sender';
import { silentLogger } from '../services';
import { productionTestEnv } from '../test/env';
import {
  type DigestItem,
  digestDue,
  digestLine,
  EMAIL_ITEMS_MAX,
  emailNotificationsAvailable,
  notificationCapabilities,
  renderDigest,
  webPushAvailable,
} from './digest';

const TZ = 'Europe/Amsterdam';
const prefs = (over: Partial<NotificationPreferences> = {}): NotificationPreferences => ({
  ...DEFAULT_NOTIFICATION_PREFERENCES,
  ...over,
});
// Wednesday 30 September 2026, 14:00 in Amsterdam (UTC+2).
const at = (local: string) => new Date(`2026-09-30T${local}:00+02:00`);

describe('when an email may go (essentials-people.md EP-15)', () => {
  it('hourly: at most one an hour; off: never', () => {
    expect(digestDue({ prefs: prefs(), now: at('14:00'), timeZone: TZ, lastEmailedAt: null })).toBe(true);
    expect(digestDue({ prefs: prefs(), now: at('14:00'), timeZone: TZ, lastEmailedAt: at('13:30') })).toBe(
      false,
    );
    expect(digestDue({ prefs: prefs(), now: at('14:00'), timeZone: TZ, lastEmailedAt: at('13:00') })).toBe(
      true,
    );
    expect(
      digestDue({ prefs: prefs({ email: 'off' }), now: at('14:00'), timeZone: TZ, lastEmailedAt: null }),
    ).toBe(false);
  });

  it('daily: from 08:00 in the person’s zone, once that day', () => {
    const daily = prefs({ email: 'daily' });
    expect(digestDue({ prefs: daily, now: at('07:55'), timeZone: TZ, lastEmailedAt: null })).toBe(false);
    expect(digestDue({ prefs: daily, now: at('08:05'), timeZone: TZ, lastEmailedAt: null })).toBe(true);
    expect(
      digestDue({
        prefs: daily,
        now: at('14:00'),
        timeZone: TZ,
        lastEmailedAt: at('08:05'),
      }),
    ).toBe(false);
    // Yesterday's email doesn't hold today's back.
    expect(
      digestDue({
        prefs: daily,
        now: at('08:10'),
        timeZone: TZ,
        lastEmailedAt: new Date('2026-09-29T08:05:00+02:00'),
      }),
    ).toBe(true);
    // 08:00 in New York is 14:00 in Amsterdam.
    expect(
      digestDue({ prefs: daily, now: at('13:55'), timeZone: 'America/New_York', lastEmailedAt: null }),
    ).toBe(false);
    expect(
      digestDue({ prefs: daily, now: at('14:05'), timeZone: 'America/New_York', lastEmailedAt: null }),
    ).toBe(true);
  });

  it('never during Do not disturb or quiet hours; they end on time', () => {
    const dnd = prefs({ dndUntil: at('15:00').toISOString() });
    expect(digestDue({ prefs: dnd, now: at('14:00'), timeZone: TZ, lastEmailedAt: null })).toBe(false);
    expect(digestDue({ prefs: dnd, now: at('15:00'), timeZone: TZ, lastEmailedAt: null })).toBe(true);
    const quiet = prefs({ schedule: { enabled: true, start: '13:00', end: '15:00', days: ['wed'] } });
    expect(digestDue({ prefs: quiet, now: at('14:00'), timeZone: TZ, lastEmailedAt: null })).toBe(false);
    expect(digestDue({ prefs: quiet, now: at('15:01'), timeZone: TZ, lastEmailedAt: null })).toBe(true);
  });
});

const item = (over: Partial<DigestItem> = {}): DigestItem => ({
  kind: 'mention',
  actorName: 'Joris',
  where: '#billing-v2',
  text: 'Can you check the VAT rounding?',
  url: 'https://w.example/burrow-hq/c/billing-v2?message=msg_1',
  toYou: false,
  ...over,
});

describe('the email (EP-15)', () => {
  it('says what happened in one line per item', () => {
    expect(digestLine(item())).toBe('Joris mentioned you in #billing-v2');
    expect(digestLine(item({ kind: 'reply' }))).toBe('Joris replied in #billing-v2');
    expect(digestLine(item({ kind: 'agent_update', actorName: 'Dusty', toYou: true }))).toBe(
      'Dusty wrote to you',
    );
    expect(digestLine(item({ kind: 'needs_you', where: 'Deploy feat/invoice-pdf' }))).toBe(
      'Needs you · Deploy feat/invoice-pdf',
    );
  });

  it('is plain and short: links, a quote, the way to change it', () => {
    const { subject, text } = renderDigest({
      name: 'Mara',
      items: [
        item(),
        item({ kind: 'agent_update', toYou: true, text: '**Lunch?**', url: 'https://w.example/x' }),
      ],
      cadence: 'hourly',
      openUrl: 'https://w.example/burrow-hq',
      settingsUrl: 'https://w.example/burrow-hq/settings?tab=notifications',
    });
    expect(subject).toBe('2 things waiting for you in Whombat');
    expect(text).toBe(
      [
        'Hi Mara,',
        '',
        'While you were away:',
        '',
        '· Joris mentioned you in #billing-v2',
        '  “Can you check the VAT rounding?”',
        '  https://w.example/burrow-hq/c/billing-v2?message=msg_1',
        '',
        '· Joris wrote to you',
        '  “**Lunch?**”',
        '  https://w.example/x',
        '',
        'Open Whombat: https://w.example/burrow-hq',
        '',
        'You get this at most once an hour when something waits for you. Change it or turn it off in Settings → Notifications:',
        'https://w.example/burrow-hq/settings?tab=notifications',
        '',
      ].join('\n'),
    );
  });

  it('one item names it in the subject; many are cut at ten', () => {
    expect(
      renderDigest({ name: 'Mara', items: [item()], cadence: 'daily', openUrl: 'o', settingsUrl: 's' })
        .subject,
    ).toBe('Joris mentioned you in #billing-v2');
    const many = Array.from({ length: EMAIL_ITEMS_MAX + 3 }, () => item());
    const { text } = renderDigest({
      name: 'Mara',
      items: many,
      cadence: 'daily',
      openUrl: 'o',
      settingsUrl: 's',
    });
    expect(text).toContain('…and 3 more in your inbox.');
    expect(text).toContain('You get this once a day');
    expect(text.match(/mentioned you/g)).toHaveLength(EMAIL_ITEMS_MAX);
  });
});

describe('capabilities (CT-175, EP-16, HE-56)', () => {
  it('email needs a mail server; web push needs a VAPID pair, configured or the box’s own', () => {
    const config = loadConfig({ ...productionTestEnv(), SMTP_URL: 'smtp://mail.example:587' });
    const mail = (on: boolean) => ({ availableNow: () => on });
    expect(emailNotificationsAvailable(mail(true))).toBe(true);
    expect(emailNotificationsAvailable(mail(false))).toBe(false);
    const push = new PushSender(null as never, config, silentLogger);
    expect(webPushAvailable(push)).toBe(false);
    push.useOwnVapid({ publicKey: 'pub', privateKey: 'priv' });
    expect(webPushAvailable(push)).toBe(true);
    expect(notificationCapabilities({ boxMail: mail(true) as never, push })).toEqual({
      emailNotifications: true,
      webPush: true,
    });
    const configured = new PushSender(
      null as never,
      { ...config, VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'q' },
      silentLogger,
    );
    expect(configured.vapid()).toEqual({ publicKey: 'p', privateKey: 'q' });
  });
});
