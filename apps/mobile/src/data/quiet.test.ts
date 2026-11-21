/**
 * Quiet notices on the phone (quiet-notices-mobile.md AP-4860…AP-4869): Worth a look's lines by their kind, their ⋯
 * menu and quiet lines with Undo, the count that leaves quiet lines out, What Whombat watches folded, what the toast
 * says, and the Needs you list's buttons by kind.
 */
import { needsYouListRow, QUIET_TOASTS, thingWatchView } from '@whombat/client';
import type { NeedsYouItem, ThingPageNotice, ThingPagePanel, ThingWatch } from '@whombat/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { phoneSheet } from './needsYou';
import { checkToastName, exceptionText, foldWatchRows, quietNote, watchRowSpoken } from './quiet';
import { noticeRows, noticesBadge, type PhoneThingTab } from './thingPage';
import { showToast, toasts } from './toast';

const TZ = 'Europe/Amsterdam';
/** Thursday 22 October 2026, 11:00 in Amsterdam. */
const NOW = Date.parse('2026-10-22T09:00:00Z');
const AT = new Date(NOW).toISOString();

const TABS: PhoneThingTab[] = [
  { key: 'overview', label: 'Summary', count: null, settings: false, spoken: 'Summary' },
  { key: 'devices', label: 'Devices', count: 22, settings: false, spoken: 'Devices, 22' },
];

const hallway: ThingPageNotice = {
  id: 'ap-hallway',
  tone: 'warn',
  icon: 'network',
  title: 'Hallway AP is offline',
  detail: 'Offline since 09:12',
  link: { kind: 'ask', label: 'Look into it', question: 'Why is Hallway AP offline in UniFi?' },
  nature: 'problem',
  check: 'unifi.device_offline',
  subject: { id: 'device:abc', name: 'Hallway AP' },
  ignore: { lifts: 'fixed', words: 'Until it’s back online.' },
};

const signIn: ThingPageNotice = {
  id: 'signin',
  tone: 'warn',
  icon: 'key',
  title: 'Claude needs to sign in again',
  link: { kind: 'ask', label: 'Look into it', question: 'Why does Claude need to sign in again?' },
  nature: 'you',
  check: 'fusebox.signin',
  subject: { id: 'tool:claude', name: 'Claude' },
  ignore: { lifts: 'fixed', words: 'Until it’s signed in again.' },
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

const attic: ThingPageNotice = {
  ...hallway,
  id: 'ap-attic',
  title: 'Attic AP is offline',
  subject: { id: 'device:def', name: 'Attic AP' },
  quiet: {
    state: 'ignored',
    words: 'until it’s back online',
    by: { id: 'prn_john', name: 'John' },
    at: AT,
  },
};

const panel = (items: ThingPageNotice[]): Extract<ThingPagePanel, { kind: 'notices' }> => ({
  kind: 'notices',
  id: 'look',
  title: 'Worth a look',
  items,
});

describe('Worth a look’s lines (QN-01, QN-02, QN-10; AP-4860, AP-4861)', () => {
  it('lets only a problem ask; an only-you line and a heads-up keep their other ways out', () => {
    const rows = noticeRows(panel([hallway, signIn, firmware]), TABS, { quiet: true });
    expect(rows.map((r) => [r.title, r.nature, r.action?.label ?? null])).toEqual([
      ['Hallway AP is offline', 'problem', 'Look into it'],
      ['Claude needs to sign in again', 'you', null],
      ['Firmware 7.1 for 3 switches', 'fyi', 'Show them'],
    ]);
  });

  it('gives a line its ⋯ menu for who may quiet it, on a Whombat that can', () => {
    const [row] = noticeRows(panel([hallway]), TABS, { quiet: true });
    expect(row?.menu).toMatchObject({
      ref: { check: 'unifi.device_offline', subject: 'device:abc' },
      label: 'More for Hallway AP is offline',
      ignore: { label: 'Ignore', words: 'Until it’s back online.' },
      stop: { label: 'Stop watching Hallway AP' },
    });
    expect(row?.line).toEqual({
      title: 'Hallway AP is offline',
      check: 'unifi.device_offline',
      subject: { id: 'device:abc', name: 'Hallway AP' },
      ignore: { lifts: 'fixed', words: 'Until it’s back online.' },
    });
  });

  it('has no menu on an older runtime, for Look only, nor on an older server’s line', () => {
    expect(noticeRows(panel([hallway]), TABS)[0]?.menu).toBeNull();
    const { ignore: _i, ...lookOnly } = hallway;
    expect(noticeRows(panel([lookOnly]), TABS, { quiet: true })[0]?.menu).toBeNull();
    const { check: _c, subject: _s, nature: _n, ignore: _g, ...older } = hallway;
    const [row] = noticeRows(panel([older]), TABS, { quiet: true });
    expect(row?.menu).toBeNull();
    // An older server's warning that asks reads as a problem: it keeps “Look into it”.
    expect(row?.action?.label).toBe('Look into it');
  });
});

describe('a quiet line (QN-14; AP-4862)', () => {
  it('is greyed with its words instead of its detail, without a link, and offers Undo to who may quiet it', () => {
    const rows = noticeRows(panel([hallway, attic]), TABS, { quiet: true });
    const quiet = rows[1];
    expect(quiet).toMatchObject({
      tone: null,
      detail: null,
      action: null,
      menu: null,
      quiet: 'Ignored by John until it’s back online',
      undo: { check: 'unifi.device_offline', subject: 'device:def' },
    });
    expect(quiet?.spoken).toContain('Ignored by John');
    expect(quiet?.spoken).not.toContain('Needs a look');
    expect(rows[0]?.quiet).toBeNull();
    expect(rows[0]?.undo).toBeNull();
  });

  it('has no Undo for Look only nor on an older runtime', () => {
    const { ignore: _i, ...lookOnly } = attic;
    expect(noticeRows(panel([lookOnly]), TABS, { quiet: true })[0]?.undo).toBeNull();
    expect(noticeRows(panel([attic]), TABS)[0]?.undo).toBeNull();
  });

  it('counts for nothing beside Worth a look', () => {
    expect(noticesBadge(panel([hallway, attic]))).toEqual({ text: '1', tone: 'warn' });
    expect(noticesBadge(panel([attic]))).toBeNull();
    // A heads-up waits folded and counts for nothing either.
    expect(noticesBadge(panel([firmware, attic]))).toBeNull();
  });
});

describe('What Whombat watches (QN-15; AP-4865…AP-4867)', () => {
  const watch: ThingWatch = {
    mayChange: true,
    checks: [
      {
        check: 'unifi.device_offline',
        name: 'Access points and switches going offline',
        nature: 'problem',
        on: true,
        perItem: true,
        exceptions: [
          {
            subject: { id: 'device:abc', name: 'Garage AP' },
            state: 'ignored',
            words: 'until it’s back',
            by: { id: 'prn_john', name: 'John' },
            at: AT,
          },
        ],
      },
      {
        check: 'unifi.firmware',
        name: 'Firmware updates',
        nature: 'fyi',
        on: false,
        perItem: true,
        exceptions: [],
      },
      ...['a', 'b', 'c', 'd', 'e', 'f'].map((x) => ({
        check: `unifi.more_${x}`,
        name: `Check ${x}`,
        nature: 'problem' as const,
        on: true,
        perItem: false,
        exceptions: [],
      })),
    ],
  };

  it('folds a server’s list after the first few, all of them once opened', () => {
    const view = thingWatchView(watch, TZ, NOW);
    expect(foldWatchRows(view, 6, false)).toMatchObject({ more: 2 });
    expect(foldWatchRows(view, 6, false).shown).toHaveLength(6);
    expect(foldWatchRows(view, 6, true)).toMatchObject({ more: 0 });
    expect(foldWatchRows(view, null, false).shown).toHaveLength(8);
  });

  it('reads a check’s state where there is no switch, and an exception with its item and words', () => {
    const view = thingWatchView({ ...watch, mayChange: false }, TZ, NOW);
    const [on, off] = view.rows;
    if (!on || !off) throw new Error('rows');
    expect(watchRowSpoken(on, false)).toBe('Access points and switches going offline. On');
    expect(watchRowSpoken(off, false)).toMatch(/^Firmware updates\. Off\. Off/);
    expect(watchRowSpoken(on, true)).toBe('Access points and switches going offline');
    const e = on.exceptions[0];
    if (!e) throw new Error('exception');
    expect(exceptionText(e)).toBe('Garage AP until it’s back');
    expect(e.undo).toEqual({ kind: 'quiet', ref: { check: 'unifi.device_offline', subject: 'device:abc' } });
  });

  it('names a whole check in quotes in its toast', () => {
    expect(QUIET_TOASTS.stopped(checkToastName('Firmware updates'))).toBe(
      'Whombat stopped watching “Firmware updates”.',
    );
  });
});

describe('the quiet actions’ note (AP-4864)', () => {
  afterEach(() => {
    toasts.dismiss();
  });

  it('says a refusal in the server’s words without Undo', () => {
    const undo = vi.fn();
    const note = quietNote(showToast);
    note('Only owners can do that.', { undo, failed: true });
    expect(toasts.get()).toMatchObject({ text: 'Only owners can do that.', action: null });
    note(QUIET_TOASTS.ignored, { undo });
    expect(toasts.get()?.action?.label).toBe('Undo');
  });
});

describe('Needs you and Watch ask only about problems (QN-02, QN-21; AP-4868, AP-4869)', () => {
  const item: NeedsYouItem = {
    id: 'ny-1',
    kind: 'connection',
    ref: { kind: 'connection', id: 'con_fusebox' },
    severity: 'warn',
    title: 'Fusebox needs you to sign in again',
    body: 'Its sign-in ran out.',
    at: AT,
    actions: [
      { id: 'look', label: 'Look into it', style: 'primary', kind: 'investigate' },
      {
        id: 'open',
        label: 'Sign in again',
        style: 'secondary',
        kind: 'open',
        href: '/things/connection%3Acon_fusebox',
      },
    ],
    nature: 'you',
  } as NeedsYouItem;

  const sheet = (i: NeedsYouItem) =>
    phoneSheet(needsYouListRow(i, { now: NOW, timeZone: TZ, assistant: 'Dusty' }), {
      Name: 'Dusty',
    }).buttons.map((b) => b.label);

  it('an only-you line keeps where it is done, never asks; Settle, then talking it over and Remind me tomorrow', () => {
    const labels = sheet(item);
    expect(labels.slice(0, 2)).toEqual(['Sign in again', 'Settle']);
    expect(labels.at(-1)).toBe('Remind me tomorrow');
    expect(labels.some((l) => /handle|fix it/.test(l))).toBe(false);
  });

  it('a problem nobody looks at asks the assistant first, in the shared words', () => {
    const labels = sheet({ ...item, nature: 'problem' });
    expect(labels.slice(0, 3)).toEqual(['Ask Dusty to handle it', 'Sign in again', 'Settle']);
    expect(labels.at(-1)).toBe('Remind me tomorrow');
    expect(
      sheet({ ...item, nature: 'problem' }).some((l) => /Look into it|Snooze|Watch again|Not now/.test(l)),
    ).toBe(false);
  });
});
