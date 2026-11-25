/**
 * Contracts 0.122.0, quiet notices (Whombat quiet-notices.md QN-01…QN-24; CT-1060…CT-1066): kinds of line, checks and
 * items, Ignore and quiet lines, What Whombat watches, the ops' bodies, Home's natures and the servers' checks.
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  api,
  QUIET_HOWS,
  QuietNoticeBody,
  QuietNoticeResponse,
  SetThingWatchBody,
} from '../contracts/index.js';
import { DESK_WORDS } from './desk.js';
import { NeedsYouItem, WatchItem } from './home.js';
import {
  HOST_OTHER_ALERT_CHECK,
  HOST_OTHER_HINT_CHECK,
  HOST_WATCH_CHECKS,
  hostAlertCheck,
  hostEntityName,
  hostHintCheck,
  hostHintNature,
  hostNoticeSubjectId,
} from './host-watch.js';
import { HostAlert, HostBanner, HostHint } from './hosts.js';
import {
  fillQuietWords,
  NOTICE_NATURES,
  NoticeCheck,
  NoticeIgnore,
  NoticeQuiet,
  NoticeRef,
  NoticeSubject,
  noticeNature,
  QUIET_LIFTS,
  QUIET_WORDS,
  quietLine,
  quietWordsOf,
  stopWatchingLabel,
  THING_WATCH_CHECKS_MAX,
  THING_WATCH_EXCEPTIONS_MAX,
  ThingWatch,
  ThingWatchCheck,
  ThingWatchException,
} from './quiet.js';
import { ThingPageNotice } from './thing-page.js';

const ok = (schema: z.ZodType, value: unknown) =>
  expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(true);
const no = (schema: z.ZodType, value: unknown) =>
  expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(false);

const AT = '2026-10-22T10:15:00.000Z';
const JOHN = { id: 'prn_john0000000001', name: 'John' };
const hallway = { id: 'device:64a1c3f00e2b', name: 'Hallway AP' };
const ignore = { lifts: 'fixed', words: 'Until it’s back online.' } as const;
const quiet = { state: 'ignored', words: 'until it’s back online', by: JOHN, at: AT } as const;

describe('kinds of line, checks and items (CT-1060)', () => {
  it('has three kinds and three ways an Ignore ends', () => {
    expect([...NOTICE_NATURES]).toEqual(['problem', 'you', 'fyi']);
    expect([...QUIET_LIFTS]).toEqual(['fixed', 'newer', 'period']);
  });

  it('takes checks of two parts or more in lower case', () => {
    for (const c of [
      'unifi.device_offline',
      'conn.signin',
      'host.disk.space_high',
      'host.hint.system.updates',
      'a.b2',
    ])
      ok(NoticeCheck, c);
    for (const c of [
      'unifi',
      'Unifi.offline',
      'unifi.',
      '.offline',
      'unifi..offline',
      '1unifi.x',
      'unifi.device-offline',
    ])
      no(NoticeCheck, c);
    no(NoticeCheck, `a.${'b'.repeat(79)}`);
  });

  it('names an item by an id kept across reads and its name', () => {
    ok(NoticeSubject, hallway);
    ok(NoticeSubject, { id: 'x'.repeat(160), name: 'x'.repeat(80) });
    no(NoticeSubject, { id: 'x'.repeat(161), name: 'Hallway AP' });
    no(NoticeSubject, { id: 'device:1', name: '' });
    ok(NoticeRef, { check: 'unifi.device_offline', subject: hallway.id });
    ok(NoticeRef, { check: 'conn.signin' });
    no(NoticeRef, { check: 'conn.signin', subject: '' });
  });

  it('says what Ignore does, a sentence of at most 60', () => {
    ok(NoticeIgnore, ignore);
    ok(NoticeIgnore, {
      lifts: 'period',
      words: 'Until the week resets.',
      until: '2026-10-26T00:00:00+02:00',
    });
    no(NoticeIgnore, { lifts: 'forever', words: 'Until it’s back online.' });
    no(NoticeIgnore, { lifts: 'fixed', words: '' });
    no(NoticeIgnore, { lifts: 'fixed', words: 'x'.repeat(61) });
  });

  it('says how a line is quiet, by whom when known', () => {
    ok(NoticeQuiet, quiet);
    ok(NoticeQuiet, {
      state: 'snoozed',
      words: 'until tomorrow 09:00',
      until: '2026-10-23T09:00:00+02:00',
      at: AT,
    });
    no(NoticeQuiet, { ...quiet, state: 'stopped' });
    no(NoticeQuiet, { ...quiet, at: undefined });
    no(NoticeQuiet, { ...quiet, by: { id: 'john', name: 'John' } });
  });

  it('reads an older line’s kind from its tone and link', () => {
    expect(noticeNature({ tone: 'info' })).toBe('fyi');
    expect(noticeNature({ tone: 'info', link: { kind: 'ask' } })).toBe('fyi');
    expect(noticeNature({ tone: 'warn', link: { kind: 'ask' } })).toBe('problem');
    expect(noticeNature({ tone: 'bad', link: { kind: 'url' } })).toBe('you');
    expect(noticeNature({ tone: 'bad' })).toBe('you');
    expect(noticeNature({ tone: 'info', nature: 'you' })).toBe('you');
    expect(noticeNature({ tone: 'bad', nature: 'fyi', link: { kind: 'ask' } })).toBe('fyi');
  });
});

describe('the words (CT-1060)', () => {
  it('has the menu’s, the toasts’ and the kinds’ words', () => {
    expect([QUIET_WORDS.ignore, QUIET_WORDS.snooze, QUIET_WORDS.undo]).toEqual([
      'Ignore',
      'Remind me tomorrow',
      'Undo',
    ]);
    expect(QUIET_WORDS.toastIgnored).toContain('You’ll hear if it changes');
    expect(QUIET_WORDS.natures).toEqual({ problem: 'Problem', you: 'Only you', fyi: 'Heads-up' });
    expect(fillQuietWords(QUIET_WORDS.menu, { title: 'Hallway AP is offline' })).toContain(
      'Hallway AP is offline',
    );
    expect(fillQuietWords(QUIET_WORDS.toastStopped, { name: 'Attic AP' })).toContain('Attic AP');
    expect(fillQuietWords(QUIET_WORDS.toastWatched, {})).toContain('{name}');
  });

  it('words a quiet line with or without who', () => {
    expect(quietLine(quiet)).toBe('Ignored by John until it’s back online');
    expect(quietLine({ state: 'snoozed', words: 'until tomorrow 09:00', by: JOHN })).toBe(
      'Snoozed by John until tomorrow 09:00',
    );
    expect(quietLine({ state: 'ignored', words: 'until it resolves' })).toBe('Ignored until it resolves');
    expect(quietLine({ state: 'snoozed', words: 'until tomorrow 09:00' })).toBe(
      'Snoozed until tomorrow 09:00',
    );
  });

  it('labels Stop watching by the item, or this', () => {
    expect(stopWatchingLabel(hallway)).toBe('Stop watching Hallway AP');
    expect(stopWatchingLabel()).toBe(QUIET_WORDS.stopThis);
  });

  it('turns Ignore’s sentence into a quiet line’s words', () => {
    expect(quietWordsOf('Until it’s back online.')).toBe('until it’s back online');
    expect(quietWordsOf(' Until the week resets. ')).toBe('until the week resets');
    expect(quietWordsOf('until it’s renewed')).toBe('until it’s renewed');
    for (const c of HOST_WATCH_CHECKS)
      ok(NoticeQuiet, { state: 'ignored', words: quietWordsOf(c.words), at: AT });
  });

  it('gives the desk the same toasts', () => {
    expect(DESK_WORDS.looks.ignored).toBe(QUIET_WORDS.toastIgnored);
    expect(DESK_WORDS.looks.snoozed).toBe(QUIET_WORDS.toastSnoozed);
    expect(DESK_WORDS.looks.fix).toContain('look into it');
    expect([DESK_WORDS.looks.ignore, DESK_WORDS.looks.notNow]).toEqual(['Ignore', 'Not now']);
  });
});

describe('a line on a thing’s page (CT-1061)', () => {
  const line = {
    id: 'device_offline-64a1c3f00e2b',
    tone: 'warn',
    icon: 'network',
    title: 'Hallway AP is offline',
    link: { kind: 'ask', label: 'Look into it', question: 'Why is Hallway AP offline in UniFi?' },
  } as const;

  it('carries its kind, check, item, Ignore and quiet', () => {
    ok(ThingPageNotice, {
      ...line,
      nature: 'problem',
      check: 'unifi.device_offline',
      subject: hallway,
      ignore,
    });
    ok(ThingPageNotice, {
      ...line,
      nature: 'problem',
      check: 'unifi.device_offline',
      subject: hallway,
      quiet,
    });
    ok(ThingPageNotice, line);
    no(ThingPageNotice, { ...line, nature: 'later' });
    no(ThingPageNotice, { ...line, check: 'offline' });
    no(ThingPageNotice, { ...line, subject: { id: hallway.id } });
  });

  it('is stripped of them by an older reader', () => {
    const older = ThingPageNotice.omit({
      nature: true,
      check: true,
      subject: true,
      ignore: true,
      quiet: true,
    });
    expect(older.parse({ ...line, nature: 'problem', check: 'unifi.device_offline', ignore, quiet })).toEqual(
      line,
    );
  });
});

describe('What Whombat watches (CT-1062)', () => {
  const check = {
    check: 'unifi.device_offline',
    name: 'Access points and switches going offline',
    nature: 'problem',
    on: true,
    perItem: true,
    exceptions: [
      {
        subject: { id: 'device:garage', name: 'Garage AP' },
        state: 'ignored',
        words: 'until it’s back',
        by: JOHN,
        at: AT,
      },
      {
        subject: { id: 'device:attic', name: 'Attic AP' },
        state: 'stopped',
        words: QUIET_WORDS.always,
        at: AT,
      },
    ],
  } as const;

  it('lists every check with its exceptions', () => {
    ok(ThingWatch, { checks: [check], mayChange: true });
    ok(ThingWatch, {
      checks: [{ ...check, on: false, off: { by: JOHN, at: AT }, exceptions: [] }],
      mayChange: false,
    });
    ok(ThingWatch, { checks: [], mayChange: false });
    ok(ThingWatchException, { state: 'snoozed', until: '2026-10-23T09:00:00+02:00', at: AT });
    no(ThingWatchException, { state: 'muted', at: AT });
    no(ThingWatchCheck, { ...check, nature: undefined });
    no(ThingWatchCheck, { ...check, name: 'x'.repeat(81) });
  });

  it('keeps to its bounds', () => {
    const many = Array.from({ length: THING_WATCH_EXCEPTIONS_MAX + 1 }, () => check.exceptions[1]);
    no(ThingWatchCheck, { ...check, exceptions: many });
    ok(ThingWatchCheck, { ...check, exceptions: many.slice(1) });
    no(ThingWatch, {
      checks: Array.from({ length: THING_WATCH_CHECKS_MAX + 1 }, () => check),
      mayChange: true,
    });
  });
});

describe('the ops (CT-1063)', () => {
  it('quiets, snoozes and takes back a line; only a snooze takes a time', () => {
    expect([...QUIET_HOWS]).toEqual(['ignore', 'snooze', 'undo']);
    ok(QuietNoticeBody, { notice: { check: 'unifi.device_offline', subject: hallway.id }, how: 'ignore' });
    ok(QuietNoticeBody, { notice: { check: 'conn.signin' }, how: 'snooze' });
    ok(QuietNoticeBody, {
      notice: { check: 'conn.signin' },
      how: 'snooze',
      until: '2026-10-23T09:00:00+02:00',
    });
    ok(QuietNoticeBody, { notice: { check: 'conn.signin' }, how: 'undo' });
    no(QuietNoticeBody, {
      notice: { check: 'conn.signin' },
      how: 'ignore',
      until: '2026-10-23T09:00:00+02:00',
    });
    no(QuietNoticeBody, { notice: { check: 'conn.signin' }, how: 'stop' });
    ok(QuietNoticeResponse, { notice: { check: 'conn.signin' }, quiet });
    ok(QuietNoticeResponse, { notice: { check: 'conn.signin' }, quiet: null });
    no(QuietNoticeResponse, { notice: { check: 'conn.signin' } });
  });

  it('switches a check off or on for an item or the whole thing', () => {
    ok(SetThingWatchBody, { check: 'unifi.device_offline', subject: hallway, watched: false });
    ok(SetThingWatchBody, { check: 'unifi.device_offline', watched: true });
    no(SetThingWatchBody, { check: 'unifi.device_offline', subject: hallway.id, watched: false });
    no(SetThingWatchBody, { check: 'unifi.device_offline' });
  });

  it('lives beside the thing’s page', () => {
    expect([api.things.quiet.method, api.things.quiet.path]).toEqual([
      'POST',
      '/burrows/:burrow/things/:thing/quiet',
    ]);
    expect([api.things.watch.method, api.things.watch.path]).toEqual([
      'GET',
      '/burrows/:burrow/things/:thing/watch',
    ]);
    expect([api.things.setWatch.method, api.things.setWatch.path]).toEqual([
      'POST',
      '/burrows/:burrow/things/:thing/watch',
    ]);
    expect(api.things.quiet.body).toBe(QuietNoticeBody);
    expect(api.things.watch.response).toBe(ThingWatch);
    expect(api.things.setWatch.body).toBe(SetThingWatchBody);
  });
});

describe('Home (CT-1064)', () => {
  it('says a Needs you or Watch item’s kind, optionally', () => {
    const watch = {
      id: 'conn:con_unifi',
      ref: { kind: 'connection', id: 'con_unifi' },
      source: 'connection',
      severity: 'warn',
      title: 'UniFi needs you to sign in again',
      body: '',
      at: AT,
      state: 'open',
    };
    ok(WatchItem, { ...watch, nature: 'you' });
    ok(WatchItem, watch);
    no(WatchItem, { ...watch, nature: 'later' });
    const needs = {
      id: 'alert:al_1',
      ref: { kind: 'alert', id: 'al_1' },
      kind: 'alert',
      severity: 'bad',
      title: 'pve-02 is offline',
      body: '',
      at: AT,
      actions: [],
    };
    ok(NeedsYouItem, { ...needs, nature: 'problem' });
    ok(NeedsYouItem, needs);
  });
});

describe('quiet on a server’s detail (CT-1068)', () => {
  const alert = {
    id: 'al_0123456789ab',
    serverId: 'pve-02',
    severity: 'critical',
    title: 'pve-02 isn’t reporting',
    detail: '',
    openedAt: AT,
    rule: 'agent.heartbeat_missing',
    state: 'open',
    attention: false,
  };
  const hint = {
    serverId: 'pve-02',
    kind: 'system.updates',
    severity: 'info',
    entity: 'host',
    title: '12 updates',
    detail: '',
    section: 'system',
  };

  it('names the banner’s alert by rule and id, from newer hubs only', () => {
    const banner = { severity: 'critical', title: 'pve-02 isn’t reporting', detail: '', section: null };
    ok(HostBanner, banner);
    ok(HostBanner, { ...banner, rule: 'agent.heartbeat_missing', alertId: 'al_0123456789ab' });
    no(HostBanner, { ...banner, rule: 'x'.repeat(81) });
    no(HostBanner, { ...banner, alertId: 'x'.repeat(201) });
  });

  it('marks an acknowledged alert and a quieted hint quiet, with who and until when', () => {
    ok(HostAlert, {
      ...alert,
      quiet: { state: 'ignored', words: 'until it’s back online', by: JOHN, at: AT },
    });
    ok(HostAlert, {
      ...alert,
      quiet: {
        state: 'snoozed',
        words: 'until tomorrow 09:00',
        until: '2026-10-23T09:00:00+02:00',
        by: JOHN,
        at: AT,
      },
    });
    no(HostAlert, { ...alert, quiet: { state: 'stopped', words: 'always', at: AT } });
    ok(HostHint, {
      ...hint,
      id: 'system.updates:host',
      quiet: { state: 'ignored', words: 'until there are more', at: AT },
    });
    no(HostHint, { ...hint, quiet: { state: 'ignored', words: '', at: AT } });
    expect(HostHint.parse(hint)).toEqual(hint);
  });
});

describe('servers (CT-1066)', () => {
  it('reads an alert’s item and key, and a hint’s id, from newer hubs only', () => {
    const alert = {
      id: 'al_0123456789ab',
      serverId: 'pve-02',
      severity: 'warning',
      title: '/mnt/data is 92 % full',
      detail: '',
      openedAt: AT,
      rule: 'disk.space_high',
      state: 'open',
      attention: true,
    };
    ok(HostAlert, alert);
    ok(HostAlert, { ...alert, entity: 'fs:/mnt/data', key: 'disk.space_high:fs:/mnt/data' });
    no(HostAlert, { ...alert, entity: 'x'.repeat(201) });
    const hint = {
      serverId: 'pve-02',
      kind: 'system.updates',
      severity: 'info',
      entity: 'host',
      title: '12 updates',
      detail: '',
      section: 'system',
    };
    ok(HostHint, hint);
    ok(HostHint, { ...hint, id: 'system.updates:host' });
  });

  it('has one check per rule and hint kind, each valid', () => {
    const rules = HOST_WATCH_CHECKS.filter((c) => c.rule);
    const hints = HOST_WATCH_CHECKS.filter((c) => c.hint);
    expect(rules).toHaveLength(30);
    expect(hints).toHaveLength(49);
    expect(new Set(HOST_WATCH_CHECKS.map((c) => c.check)).size).toBe(HOST_WATCH_CHECKS.length);
    for (const c of HOST_WATCH_CHECKS) {
      expect(c.rule === undefined, c.check).not.toBe(c.hint === undefined);
      expect(c.check, c.check).toBe(c.rule ? `host.${c.rule}` : `host.hint.${c.hint}`);
      ok(NoticeCheck, c.check);
      ok(ThingWatchCheck, {
        check: c.check,
        name: c.name,
        nature: c.nature,
        on: true,
        perItem: c.perItem,
        exceptions: [],
      });
      ok(NoticeIgnore, { lifts: c.lifts, words: c.words });
      expect(c.words, c.check).toMatch(/^Until .+\.$/);
      expect(c.lifts, c.check).not.toBe('period');
    }
  });

  it('has the catalogue’s kinds: alerts 20 · 8 · 2, the hub’s hints 7 · 12 · 26 and Whombat’s four', () => {
    const count = (cs: readonly (typeof HOST_WATCH_CHECKS)[number][]) =>
      Object.fromEntries(NOTICE_NATURES.map((n) => [n, cs.filter((c) => c.nature === n).length]));
    expect(count(HOST_WATCH_CHECKS.filter((c) => c.rule))).toEqual({ problem: 20, you: 8, fyi: 2 });
    const own = ['agent.update_failed', 'agent.needs_install', 'backup_place.cleanup', 'backup_place.space'];
    expect(count(HOST_WATCH_CHECKS.filter((c) => c.hint && !own.includes(c.hint)))).toEqual({
      problem: 7,
      you: 12,
      fyi: 26,
    });
    expect(own.map((k) => hostHintCheck(k).nature)).toEqual(['you', 'you', 'you', 'fyi']);
    // What a backup place's lines say starts off (backup-places.md BPL-11).
    expect(own.slice(2).map((k) => hostHintCheck(k).startsOn)).toEqual([false, false]);
  });

  it('finds a check by rule or kind, and names one a newer hub has', () => {
    expect(hostAlertCheck('disk.space_high').check).toBe('host.disk.space_high');
    expect(hostAlertCheck('guest.stopped')).toMatchObject({
      check: 'host.guest.stopped',
      startsOn: true,
      perItem: true,
      nature: 'problem',
    });
    expect(hostAlertCheck('agent.heartbeat_missing').words).toBe('Until it checks in again.');
    expect(hostHintCheck('system.updates').nature).toBe('fyi');
    const newer = hostAlertCheck('gpu.temp_high');
    expect([newer.check, newer.nature, newer.perItem]).toEqual(['host.gpu.temp_high', 'problem', true]);
    expect(hostAlertCheck('GPU hot').check).toBe(HOST_OTHER_ALERT_CHECK);
    expect(hostHintCheck('gpu.near_limit').check).toBe('host.hint.gpu.near_limit');
    expect(hostHintCheck('').check).toBe(HOST_OTHER_HINT_CHECK);
  });

  it('raises a hint’s kind at warning where the check says so', () => {
    expect(hostHintNature(hostHintCheck('incus.pool_full'), 'info')).toBe('fyi');
    expect(hostHintNature(hostHintCheck('incus.pool_full'), 'warning')).toBe('problem');
    expect(hostHintNature(hostHintCheck('unraid.notification'), 'warning')).toBe('you');
    expect(hostHintNature(hostHintCheck('sensor.near_limit'), 'warning')).toBe('fyi');
  });

  it('keys a line’s item by the hub’s entity, only for checks about one item', () => {
    const space = hostAlertCheck('disk.space_high');
    expect(hostNoticeSubjectId(space, 'fs:/mnt/data')).toBe('fs:/mnt/data');
    expect(hostNoticeSubjectId(space, 'host')).toBeUndefined();
    expect(hostNoticeSubjectId(space, undefined)).toBeUndefined();
    expect(hostNoticeSubjectId(hostAlertCheck('time.unsynced'), 'host')).toBeUndefined();
    expect(hostNoticeSubjectId(hostHintCheck('guests.unhealthy'), 'docker')).toBeUndefined();
    expect(hostEntityName('fs:/mnt/data')).toBe('/mnt/data');
    expect(hostEntityName('incus-pool:default')).toBe('default');
    expect(hostEntityName('pve/101')).toBe('pve/101');
  });
});
