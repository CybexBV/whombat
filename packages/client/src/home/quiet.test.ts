import type { NeedsYouItem, ThingPage, ThingPageNotice, ThingWatch } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { NEEDS_YOU_IGNORE, needsYouActions, needsYouIgnoreDone } from './needsYou';
import { askFixText, NEEDS_YOU_WORDS, needsYouListRow, needsYouSettledText } from './needsYouList';
import {
  activeCount,
  expectedQuiet,
  handleTheseLink,
  handleTheseView,
  noticeGroups,
  noticeLink,
  noticeRef,
  QUIET_TOASTS,
  quietLineText,
  quietMenu,
  quietUndo,
  STOP_WATCHING_WORDS,
  stopName,
  thingWatchView,
  withNoticeQuiet,
  withoutQuietException,
  withoutWatchedLines,
  withWatched,
} from './quiet';

const TZ = 'Europe/Amsterdam';
/** Thursday 22 October 2026, 11:00 in Amsterdam. */
const NOW = Date.parse('2026-10-22T09:00:00Z');
const AT = new Date(NOW).toISOString();

const hallway: ThingPageNotice = {
  id: 'ap-hallway',
  tone: 'warn',
  icon: 'network',
  title: 'Hallway AP is offline',
  detail: 'Offline since 09:12',
  link: { kind: 'ask', label: 'Look into it', question: 'Why is Hallway AP offline?' },
  nature: 'problem',
  check: 'unifi.device_offline',
  subject: { id: 'device:abc', name: 'Hallway AP' },
  ignore: { lifts: 'fixed', words: 'Until it’s back online.' },
};

const firmware: ThingPageNotice = {
  id: 'firmware',
  tone: 'info',
  icon: 'update',
  title: 'Firmware 7.1 for 3 switches',
  link: { kind: 'tab', label: 'Show them', tab: 'devices' },
  nature: 'fyi',
  check: 'unifi.firmware',
  ignore: { lifts: 'newer', words: 'Until there’s a newer version.' },
};

function page(items: ThingPageNotice[]): ThingPage {
  return {
    tabs: [
      {
        key: 'overview',
        label: 'Overview',
        panels: [{ kind: 'notices', id: 'worth', title: 'Worth a look', items }],
      },
    ],
  } as unknown as ThingPage;
}

const itemsOf = (p: ThingPage) => {
  const panel = p.tabs[0]?.panels[0];
  return panel?.kind === 'notices' ? panel.items : [];
};

describe('a line’s ⋯ menu (QN-10; AP-4800)', () => {
  it('holds Ignore with its words, Remind me tomorrow and Stop watching its item', () => {
    expect(quietMenu(hallway)).toEqual({
      ref: { check: 'unifi.device_offline', subject: 'device:abc' },
      label: 'More for Hallway AP is offline',
      ignore: { label: 'Ignore', words: 'Until it’s back online.' },
      snooze: { label: 'Remind me tomorrow' },
      stop: { label: 'Stop watching Hallway AP', words: STOP_WATCHING_WORDS, subject: hallway.subject },
    });
    expect(quietMenu(firmware)?.stop.label).toBe('Stop watching this');
  });

  it('is not there without Ignore (Look only, older servers) nor on a quiet line', () => {
    const { ignore: _i, ...lookOnly } = hallway;
    expect(quietMenu(lookOnly)).toBeNull();
    expect(quietMenu({ ...hallway, check: undefined })).toBeNull();
    expect(
      quietMenu({ ...hallway, quiet: { state: 'ignored', words: 'until it’s back online', at: AT } }),
    ).toBeNull();
  });
});

describe('links by kind (QN-02, QN-S49; AP-4801)', () => {
  it('lets only a problem ask; a quiet line keeps no link', () => {
    expect(noticeLink(hallway)?.kind).toBe('ask');
    expect(noticeLink({ ...hallway, nature: 'you' })).toBeUndefined();
    expect(noticeLink({ ...hallway, nature: 'fyi' })).toBeUndefined();
    expect(noticeLink(firmware)?.kind).toBe('tab');
    expect(
      noticeLink({ ...hallway, quiet: { state: 'snoozed', words: 'until tomorrow 09:00', at: AT } }),
    ).toBeUndefined();
    // An older server's line: its kind read from the tone and link.
    const { nature: _n, ...old } = hallway;
    expect(noticeLink(old)?.kind).toBe('ask');
  });
});

describe('a quiet line (QN-14; AP-4802)', () => {
  it('reads who and until when, with Undo for who may quiet it', () => {
    const quiet = {
      state: 'ignored' as const,
      words: 'until it’s back online',
      by: { id: 'prn_john', name: 'John' },
      at: AT,
    };
    const q = { ...hallway, quiet } as ThingPageNotice;
    expect(quietLineText(q)).toBe('Ignored by John until it’s back online');
    expect(quietUndo(q)).toBe(true);
    const { ignore: _i, ...lookOnly } = q;
    expect(quietUndo(lookOnly)).toBe(false);
    expect(quietLineText(hallway)).toBeNull();
  });

  it('says a line is quiet with the whole thing: kept quiet, or because of its cause', () => {
    const window = {
      state: 'snoozed' as const,
      words: 'until 23:00',
      by: { id: 'prn_mara', name: 'Mara' },
      at: AT,
    };
    expect(quietLineText({ quiet: { ...window, held: 'window' } })).toBe('Kept quiet by Mara until 23:00');
    expect(
      quietLineText({ quiet: { state: 'ignored', words: 'while pve-02 is down', at: AT, held: 'cause' } }),
    ).toBe('Quiet while pve-02 is down');
  });

  it('is expected at once: ignored in Ignore’s words, snoozed until 09:00 tomorrow', () => {
    expect(expectedQuiet('ignore', hallway.ignore, NOW, TZ)).toEqual({
      state: 'ignored',
      words: 'until it’s back online',
      at: AT,
    });
    const snoozed = expectedQuiet('snooze', hallway.ignore, NOW, TZ);
    expect(snoozed).toMatchObject({
      state: 'snoozed',
      words: 'until tomorrow 09:00',
      until: '2026-10-23T07:00:00.000Z',
    });
  });

  it('goes to the bottom when quiet and comes back when undone, counting for nothing', () => {
    const p = page([hallway, firmware]);
    const quiet = expectedQuiet('ignore', hallway.ignore, NOW, TZ);
    const ref = noticeRef(hallway);
    if (!ref) throw new Error('no ref');
    const q = withNoticeQuiet(p, ref, quiet);
    expect(itemsOf(q).map((n) => [n.id, !!n.quiet])).toEqual([
      ['firmware', false],
      ['ap-hallway', true],
    ]);
    expect(activeCount(itemsOf(q))).toBe(1);
    const back = withNoticeQuiet(q, ref, null);
    expect(itemsOf(back).find((n) => n.id === 'ap-hallway')?.quiet).toBeUndefined();
    // Another line's ref changes nothing.
    expect(withNoticeQuiet(p, { check: 'unifi.device_offline', subject: 'device:zzz' }, quiet)).toBe(p);
  });

  it('leaves the page once its item or its check isn’t watched (QN-13)', () => {
    const p = page([hallway, firmware]);
    expect(itemsOf(withoutWatchedLines(p, 'unifi.device_offline', 'device:abc')).map((n) => n.id)).toEqual([
      'firmware',
    ]);
    expect(itemsOf(withoutWatchedLines(p, 'unifi.firmware')).map((n) => n.id)).toEqual(['ap-hallway']);
    expect(withoutWatchedLines(p, 'unifi.device_offline', 'device:zzz')).toBe(p);
  });

  it('names what stopped being watched in its toast', () => {
    expect(QUIET_TOASTS.stopped(stopName(hallway))).toBe('Whombat stopped watching Hallway AP.');
    expect(QUIET_TOASTS.stopped(stopName(firmware))).toBe(
      'Whombat stopped watching “Firmware 7.1 for 3 switches”.',
    );
    expect(QUIET_TOASTS.watched('Hallway AP')).toContain('Hallway AP');
  });
});

const watch: ThingWatch = {
  mayChange: true,
  checks: [
    {
      check: 'unifi.gateway_offline',
      name: 'The gateway going offline',
      nature: 'problem',
      on: true,
      perItem: false,
      exceptions: [],
    },
    {
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
          by: { id: 'prn_john', name: 'John' },
          at: '2026-10-21T08:00:00Z',
        },
        {
          subject: { id: 'device:attic', name: 'Attic AP' },
          state: 'stopped',
          words: 'always',
          at: '2026-10-20T08:00:00Z',
        },
      ],
    },
    {
      check: 'unifi.firmware',
      name: 'Firmware updates waiting',
      nature: 'fyi',
      on: false,
      perItem: false,
      off: { by: { id: 'prn_john', name: 'John' }, at: '2026-10-20T08:00:00Z' },
      exceptions: [],
    },
  ],
};

describe('What Whombat watches (QN-15; AP-4803)', () => {
  it('lists a switch per check with who switched it off and what is excepted', () => {
    const v = thingWatchView(watch, TZ, NOW);
    expect(v.mayChange).toBe(true);
    expect(v.empty).toBeNull();
    expect(v.rows.map((r) => [r.name, r.on, r.offLine])).toEqual([
      ['The gateway going offline', true, null],
      ['Access points and switches going offline', true, null],
      ['Firmware updates waiting', false, 'Off since 20 Oct (John)'],
    ]);
    const ex = v.rows[1]?.exceptions ?? [];
    expect(ex.map((e) => [e.name, e.words, e.undo.kind])).toEqual([
      ['Garage AP', 'until it’s back', 'quiet'],
      ['Attic AP', 'always', 'watch'],
    ]);
    expect(ex[0]?.undo).toEqual({
      kind: 'quiet',
      ref: { check: 'unifi.device_offline', subject: 'device:garage' },
    });
    expect(ex[0]?.undoLabel).toContain('Garage AP');
    expect(thingWatchView({ checks: [], mayChange: false }, TZ, NOW).empty).toBe(
      'Nothing to watch here yet.',
    );
  });

  it('switches at once: a check, an item, and an Undo of an ignore', () => {
    const off = withWatched(watch, 'unifi.gateway_offline', undefined, false, NOW);
    expect(off.checks[0]).toMatchObject({ on: false, off: { at: AT } });
    expect(withWatched(off, 'unifi.gateway_offline', undefined, true, NOW).checks[0]).toEqual(
      watch.checks[0],
    );
    const attic = { id: 'device:attic', name: 'Attic AP' };
    const back = withWatched(watch, 'unifi.device_offline', attic, true, NOW);
    expect(back.checks[1]?.exceptions.map((e) => e.subject?.name)).toEqual(['Garage AP']);
    const undone = withoutQuietException(watch, { check: 'unifi.device_offline', subject: 'device:garage' });
    expect(undone.checks[1]?.exceptions.map((e) => e.subject?.name)).toEqual(['Attic AP']);
  });
});

describe('Needs you (QN-02, QN-21; AP-4806, AP-4807)', () => {
  const investigate = {
    id: 'look',
    label: 'Look into it',
    style: 'primary' as const,
    kind: 'investigate' as const,
  };
  const open = {
    id: 'open',
    label: 'Open',
    style: 'secondary' as const,
    kind: 'open' as const,
    href: '/connections',
  };

  it('asks the assistant only about a problem', () => {
    expect(needsYouActions({ actions: [investigate, open] })).toEqual([investigate, open]);
    expect(needsYouActions({ actions: [investigate, open], nature: 'problem' })).toEqual([investigate, open]);
    expect(needsYouActions({ actions: [investigate, open], nature: 'you' })).toEqual([open]);
  });

  it('says Ignore is shared on alerts and connections', () => {
    expect(needsYouIgnoreDone({ kind: 'alert' })).toBe('Ignored. You’ll hear if it changes.');
    expect(needsYouIgnoreDone({ kind: 'connection' })).toBe('Ignored. You’ll hear if it changes.');
    expect(needsYouIgnoreDone({ kind: 'approval' })).toBe(NEEDS_YOU_IGNORE.done);
  });
});

describe('the Inbox hands over only a problem (QN-02, QN-26; inbox.md IBX-04)', () => {
  const item: NeedsYouItem = {
    id: 'w1',
    ref: { kind: 'connection', id: 'con_fusebox' },
    kind: 'connection',
    severity: 'warn',
    title: 'Fusebox needs you to sign in again',
    body: '',
    at: AT,
    actions: [],
    group: 'you',
  };
  const kinds = (over: Partial<NeedsYouItem>) =>
    needsYouListRow({ ...item, ...over }, { now: NOW, timeZone: TZ, assistant: 'Dusty' }).buttons.map(
      (b) => b.kind,
    );

  it('hands over a problem, never an only-you line it can’t do', () => {
    expect(kinds({})).toEqual(['handle', 'settle', 'talk', 'snooze']);
    expect(kinds({ nature: 'problem' })).toEqual(['handle', 'settle', 'talk', 'snooze']);
    expect(kinds({ nature: 'you' })).toEqual(['settle', 'talk', 'snooze']);
    // Only you, but the assistant can do it: a backup job, a snapshot schedule (QN-26).
    expect(kinds({ nature: 'you', fixable: true })).toEqual(['askFix', 'settle', 'talk', 'snooze']);
  });

  it('says a problem’s one verb, Ask {assistant} to handle it, and sends what the item says', () => {
    expect(NEEDS_YOU_WORDS.askFix({ name: 'Dusty' })).toBe(NEEDS_YOU_WORDS.handle({ name: 'Dusty' }));
    const text = askFixText({
      title: '25 guests in no backup job',
      body: 'wp-rabosch. Add them to a backup job.',
    });
    expect(text).toContain('25 guests in no backup job');
    expect(text).toContain('wp-rabosch');
  });

  it('says a settled line comes back when it happens again, anything else just settles', () => {
    expect(needsYouSettledText({ kind: 'hint' })).toBe(NEEDS_YOU_WORDS.settledLine);
    expect(needsYouSettledText({ kind: 'backup' })).toBe(NEEDS_YOU_WORDS.settledOwn);
  });
});

describe('Worth a look in two parts', () => {
  const line = (id: string, over: Partial<ThingPageNotice>): ThingPageNotice => ({
    id,
    tone: 'warn',
    icon: 'warn',
    title: id,
    ...over,
  });
  const failed = line('1 service failed', { nature: 'problem', detail: 'agent-resource-cleanup' });
  const backups = line('2 machines aren’t backed up', {
    nature: 'you',
    detail: 'whombat-link, whombat-prod-box · no scheduled snapshots, no backup in 30 days',
  });
  const updates = line('1 update waiting', { tone: 'info', nature: 'fyi' });
  const images = line('8 containers have updates', { tone: 'info' });
  const ignored = line('Hallway AP is offline', {
    nature: 'problem',
    quiet: { state: 'ignored', words: 'x', at: AT },
  });

  it('opens on what asks and folds heads-ups and quiet lines under one row', () => {
    const g = noticeGroups([updates, failed, images, ignored, backups]);
    expect(g.asking.map((n) => n.id)).toEqual([failed.id, backups.id]);
    expect(g.folded.map((n) => n.id)).toEqual([updates.id, images.id, ignored.id]);
    expect(g.foldLabel).toBe('Show 2 heads-ups and 1 ignored');
    expect(noticeGroups([updates]).foldLabel).toBe('Show 1 heads-up');
    expect(noticeGroups([failed]).foldLabel).toBeNull();
    const held = line('Disk 3 failed', {
      nature: 'problem',
      quiet: { state: 'snoozed', words: 'until 23:00', at: AT, held: 'window' },
    });
    expect(noticeGroups([updates, ignored, held]).foldLabel).toBe(
      'Show 1 heads-up, 1 ignored and 1 kept quiet',
    );
  });

  it('keeps a heads-up with a button of its own in sight, without counting it', () => {
    const paused = line('Blocking is off until 10:30', {
      nature: 'fyi',
      action: { action: 'resume', label: 'Resume', allowed: true },
    });
    const g = noticeGroups([paused, updates]);
    expect(g.shown.map((n) => n.id)).toEqual([paused.id]);
    expect(g.asking).toEqual([]);
    expect(g.foldLabel).toBe('Show 1 heads-up');
  });

  it('hands two or more asking lines to the assistant with one button, naming them', () => {
    const all = handleTheseLink([failed, backups], 'the-titan', 'Dusty');
    expect(all?.label).toBe('Ask Dusty to handle these');
    expect(all?.question).toContain('the-titan');
    expect(all?.question).toContain('agent-resource-cleanup');
    expect(all?.question).toContain('whombat-prod-box');
    expect(all?.question.length).toBeLessThanOrEqual(300);
    expect(handleTheseLink([failed], 'the-titan', 'Dusty')).toBeNull();
    expect(
      handleTheseLink([failed, backups], 'x', 'Bartholomew-the-Great')?.label.length,
    ).toBeLessThanOrEqual(30);
    // A long list stays within the question's limit.
    const many = Array.from({ length: 30 }, (_, i) => line(`Disk ${i} getting full`, { nature: 'problem' }));
    expect(handleTheseLink(many, 'the-titan', 'Dusty')?.question.length).toBeLessThanOrEqual(300);
  });

  it('hands the lines over, says while it is on them, and steps aside for a plan that waits (handle-it.md)', () => {
    const at = '2026-10-30T09:00:00Z';
    const idle = handleTheseView([failed, backups], null, 'the-titan', 'Dusty');
    expect(idle).toMatchObject({ label: 'Ask Dusty to handle these', busy: null });
    // The question stays for a Whombat without looks.handle.
    expect(idle?.fallback.question).toContain('the-titan');
    const looking = handleTheseView([failed, backups], { state: 'looking' }, 'the-titan', 'Dusty');
    expect(looking).toMatchObject({ label: null, busy: 'Dusty is looking into these' });
    expect(handleTheseView([failed, backups], { state: 'fixing' }, 'x', 'Dusty')?.busy).toBe(
      'Dusty is on it',
    );
    expect(
      handleTheseView([failed, backups], { state: 'found', plan: ['Restart nginx'] }, 'x', 'Dusty'),
    ).toBeNull();
    expect(
      handleTheseView([failed, backups], { state: 'found', fix: 'Restart nginx' }, 'x', 'Dusty'),
    ).toBeNull();
    // Found with nothing to press, fixed or failed: it can be asked again.
    for (const state of ['found', 'fixed', 'failed'] as const)
      expect(handleTheseView([failed, backups], { state }, 'x', 'Dusty')?.label).toBe(
        'Ask Dusty to handle these',
      );
    expect(handleTheseView([failed], null, 'x', 'Dusty')).toBeNull();
    expect(at).toBeTruthy();
  });
});
