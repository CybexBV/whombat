/**
 * What a thing's lines come to (quiet-notices.md QN-01…QN-04, QN-11…QN-14; QN-S03…QN-S08): Ignore's three ends and its
 * early end when worse, Remind me tomorrow, Stop watching, two passes for a flapping check, skipped checks, grouped
 * lines, the order of Worth a look and the words around a quiet line. Pure.
 */
import { describe, expect, it } from 'vitest';
import { applyQuiet, FIXED_PASSES, inPageOrder, isSkipped, type QuietRow, type StateRow } from './apply';
import { MORE_SUBJECT, moreSubject, shortHash } from './items';
import type { LooseNotice } from './types';
import { lowerWords, quietTitle, snoozeUntil, untilWords, watchTitle } from './words';

const NOW = new Date('2026-10-22T10:00:00Z');
const LATER = new Date('2026-10-22T10:05:00Z');

function line(over: Partial<LooseNotice> & { check?: string } = {}): LooseNotice {
  return {
    id: over.id ?? 'l',
    tone: 'warn',
    icon: 'warn',
    title: 'Hallway AP is offline',
    nature: 'problem',
    check: 'unifi.device_offline',
    subject: { id: 'device:aa', name: 'Hallway AP' },
    ignore: { lifts: 'fixed', words: 'Until it’s back online.' },
    ...over,
  };
}

function row(over: Partial<QuietRow> = {}): QuietRow {
  return {
    checkId: 'unifi.device_offline',
    subject: 'device:aa',
    state: 'ignored',
    lifts: 'fixed',
    episode: null,
    tone: 'warn',
    band: null,
    until: null,
    clearPasses: 0,
    title: 'Hallway AP is offline',
    subjectName: 'Hallway AP',
    words: 'Until it’s back online.',
    byId: 'prn_john',
    at: NOW,
    ...over,
  };
}

const base = { offs: [], states: [] as StateRow[], now: LATER };

describe('applyQuiet', () => {
  it('quiets an ignored line: it no longer colours, and the next item still does', () => {
    const a = line();
    const b = line({ id: 'b', subject: { id: 'device:bb', name: 'Attic AP' } });
    const r = applyQuiet({ ...base, lines: [a, b], quiets: [row()], pass: false });
    expect(r.quiet.map((q) => q.line.id)).toEqual(['l']);
    expect(r.active.map((l) => l.id)).toEqual(['b']);
    expect(r.status).toBe('warn');
    expect(r.worst?.id).toBe('b');
    const alone = applyQuiet({ ...base, lines: [a], quiets: [row()], pass: false });
    expect(alone.status).toBe('ok');
    expect(alone.worst).toBeNull();
    expect(alone.reason).toBeUndefined();
  });

  it('ends an Ignore until fixed once passes for about an hour read the check without the line', () => {
    // A blip of a few passes isn't fixed (on-purpose.md): Plex retesting its mapping.
    expect(FIXED_PASSES).toBeGreaterThanOrEqual(12);
    const first = applyQuiet({ ...base, lines: [], quiets: [row()], pass: true });
    expect(first.lift).toEqual([]);
    expect(first.cleared.map((r) => r.clearPasses)).toEqual([1]);
    const almost = applyQuiet({
      ...base,
      lines: [],
      quiets: [row({ clearPasses: FIXED_PASSES - 2 })],
      pass: true,
    });
    expect(almost.lift).toEqual([]);
    const last = applyQuiet({
      ...base,
      lines: [],
      quiets: [row({ clearPasses: FIXED_PASSES - 1 })],
      pass: true,
    });
    expect(last.lift.map((r) => r.checkId)).toEqual(['unifi.device_offline']);
    // A page read never ends or counts anything.
    const read = applyQuiet({
      ...base,
      lines: [],
      quiets: [row({ clearPasses: FIXED_PASSES - 1 })],
      pass: false,
    });
    expect(read.lift).toEqual([]);
    expect(read.cleared).toEqual([]);
  });

  it('starts counting again when the line is back before the second pass', () => {
    const r = applyQuiet({ ...base, lines: [line()], quiets: [row({ clearPasses: 1 })], pass: true });
    expect(r.lift).toEqual([]);
    expect(r.cleared.map((x) => x.clearPasses)).toEqual([0]);
    expect(r.quiet).toHaveLength(1);
  });

  it('never counts a skipped check as fixed: exact, prefix, every check, or a test', () => {
    for (const skipped of [
      ['unifi.device_offline'],
      ['unifi.*'],
      ['*'],
      (c: string) => !c.startsWith('conn.'),
    ]) {
      const r = applyQuiet({ ...base, lines: [], quiets: [row({ clearPasses: 1 })], pass: true, skipped });
      expect(r.lift).toEqual([]);
      expect(r.cleared).toEqual([]);
    }
    expect(isSkipped(['unifi.*'], 'unifi_x.y')).toBe(false);
    expect(isSkipped(['conn.answers'], 'conn.signin')).toBe(false);
    expect(isSkipped(undefined, 'conn.signin')).toBe(false);
  });

  it('ends an Ignore until newer when the episode changes, and on a pass only', () => {
    const ignored = row({ lifts: 'newer', episode: '2026.10.2', checkId: 'ha.update', subject: '' });
    const same = line({ check: 'ha.update', subject: undefined, episode: '2026.10.2' });
    const newer = line({ check: 'ha.update', subject: undefined, episode: '2026.10.3' });
    expect(applyQuiet({ ...base, lines: [same], quiets: [ignored], pass: true }).quiet).toHaveLength(1);
    const lifted = applyQuiet({ ...base, lines: [newer], quiets: [ignored], pass: true });
    expect(lifted.lift).toHaveLength(1);
    expect(lifted.active).toHaveLength(1);
    // A page read shows it again but leaves the row for the pass.
    const read = applyQuiet({ ...base, lines: [newer], quiets: [ignored], pass: false });
    expect(read.active).toHaveLength(1);
    expect(read.lift).toEqual([]);
  });

  it('ends any Ignore on a new episode, but a missing episode on either side counts as the same', () => {
    const fixedRow = row({ episode: 'serial-1' });
    expect(
      applyQuiet({ ...base, lines: [line({ episode: 'serial-2' })], quiets: [fixedRow], pass: true }).lift,
    ).toHaveLength(1);
    expect(applyQuiet({ ...base, lines: [line()], quiets: [fixedRow], pass: true }).quiet).toHaveLength(1);
    expect(
      applyQuiet({ ...base, lines: [line({ episode: 'serial-2' })], quiets: [row()], pass: true }).quiet,
    ).toHaveLength(1);
  });

  it('ends an Ignore for a period when it resets, or when the line is gone long enough', () => {
    const until = new Date('2026-10-26T00:00:00Z');
    const week = row({ lifts: 'period', until, checkId: 'fusebox.week_runs_out', subject: 'acct:1' });
    const l = line({ check: 'fusebox.week_runs_out', subject: { id: 'acct:1', name: 'Codex' } });
    expect(applyQuiet({ ...base, lines: [l], quiets: [week], pass: true }).quiet).toHaveLength(1);
    expect(applyQuiet({ ...base, lines: [], quiets: [week], pass: true }).cleared).toHaveLength(1);
    expect(
      applyQuiet({ ...base, lines: [], quiets: [{ ...week, clearPasses: FIXED_PASSES - 1 }], pass: true })
        .lift,
    ).toHaveLength(1);
    // Newer too: gone long enough, the same episode later is new (QN-S04).
    const newer = row({ lifts: 'newer', episode: 'site-a' });
    expect(
      applyQuiet({ ...base, lines: [], quiets: [{ ...newer, clearPasses: FIXED_PASSES - 1 }], pass: true })
        .lift,
    ).toHaveLength(1);
    const after = { ...base, now: new Date('2026-10-26T00:00:01Z') };
    expect(applyQuiet({ ...after, lines: [l], quiets: [week], pass: true }).lift).toHaveLength(1);
    expect(applyQuiet({ ...after, lines: [l], quiets: [week], pass: false }).active).toHaveLength(1);
  });

  it('ends early when it gets worse: a higher tone or band; better keeps it', () => {
    const bad = line({ tone: 'bad' });
    expect(applyQuiet({ ...base, lines: [bad], quiets: [row()], pass: true }).lift).toHaveLength(1);
    const disk = (band: number, tone: 'warn' | 'bad') =>
      line({ check: 'machine.disk', subject: undefined, band, tone });
    const at75 = row({ checkId: 'machine.disk', subject: '', band: 75, tone: 'warn' });
    expect(applyQuiet({ ...base, lines: [disk(75, 'warn')], quiets: [at75], pass: true }).quiet).toHaveLength(
      1,
    );
    expect(applyQuiet({ ...base, lines: [disk(90, 'warn')], quiets: [at75], pass: true }).lift).toHaveLength(
      1,
    );
    const at90 = row({ checkId: 'machine.disk', subject: '', band: 90, tone: 'bad' });
    expect(applyQuiet({ ...base, lines: [disk(75, 'warn')], quiets: [at90], pass: true }).quiet).toHaveLength(
      1,
    );
  });

  it('snoozes until its time, ends early when worse, and keeps through a new episode or a gap', () => {
    const until = new Date('2026-10-23T07:00:00Z');
    const snoozed = row({ state: 'snoozed', lifts: null, until, episode: 'a' });
    expect(applyQuiet({ ...base, lines: [line()], quiets: [snoozed], pass: true }).quiet).toHaveLength(1);
    expect(
      applyQuiet({ ...base, lines: [line({ episode: 'b' })], quiets: [snoozed], pass: true }).quiet,
    ).toHaveLength(1);
    const gap = applyQuiet({ ...base, lines: [], quiets: [snoozed], pass: true });
    expect(gap.lift).toEqual([]);
    expect(gap.cleared).toEqual([]);
    expect(
      applyQuiet({ ...base, lines: [line({ tone: 'bad' })], quiets: [snoozed], pass: true }).lift,
    ).toHaveLength(1);
    const morning = { ...base, now: until };
    expect(applyQuiet({ ...morning, lines: [line()], quiets: [snoozed], pass: true }).lift).toHaveLength(1);
  });

  it('drops the lines of a check that starts off as those of one switched off (watch-defaults.md)', () => {
    const busy = line({ id: 'busy', check: 'unifi.gateway_busy', subject: undefined, tone: 'warn' });
    const r = applyQuiet({
      ...base,
      lines: [line(), busy],
      quiets: [row({ checkId: 'unifi.gateway_busy', subject: '' })],
      unwatched: (check) => check === 'unifi.gateway_busy',
      pass: true,
    });
    expect(r.dropped.map((l) => l.id)).toEqual(['busy']);
    expect(r.active.map((l) => l.id)).toEqual(['l']);
    expect(r.lift).toEqual([]);
    expect(r.worst?.id).toBe('l');
  });

  it('drops lines Whombat no longer watches: one item, or the whole check', () => {
    const a = line();
    const b = line({ id: 'b', subject: { id: 'device:bb', name: 'Attic AP' } });
    const loose: LooseNotice = { id: 'old', tone: 'warn', icon: 'warn', title: 'From an older kind' };
    const one = applyQuiet({
      ...base,
      lines: [a, b, loose],
      quiets: [],
      offs: [{ checkId: 'unifi.device_offline', subject: 'device:bb' }],
      pass: false,
    });
    expect(one.dropped.map((l) => l.id)).toEqual(['b']);
    expect(one.active.map((l) => l.id)).toEqual(['l', 'old']);
    const all = applyQuiet({
      ...base,
      lines: [a, b, loose],
      quiets: [row()],
      offs: [{ checkId: 'unifi.device_offline', subject: '' }],
      pass: true,
    });
    expect(all.dropped).toHaveLength(2);
    expect(all.quiet).toEqual([]);
    // A row under a dropped line neither holds nor counts.
    expect(all.lift).toEqual([]);
    expect(all.cleared).toEqual([]);
    expect(all.status).toBe('warn');
    expect(all.worst?.id).toBe('old');
  });

  it('colours the dot for a flapping check only from the second pass in a row', () => {
    const flappy = line({ confirm: 2 });
    const first = applyQuiet({ ...base, lines: [flappy], quiets: [], pass: true });
    expect(first.status).toBe('ok');
    expect(first.active).toHaveLength(1);
    expect(first.states).toMatchObject([
      { checkId: 'unifi.device_offline', subject: 'device:aa', seenPasses: 1 },
    ]);
    const second = applyQuiet({
      ...base,
      lines: [flappy],
      quiets: [],
      states: first.states,
      now: new Date(LATER.getTime() + 300_000),
      pass: true,
    });
    expect(second.status).toBe('warn');
    expect(second.states[0]?.seenPasses).toBe(2);
    expect(second.states[0]?.firstSeen).toEqual(LATER);
    // A page read goes by what the last pass saw.
    expect(
      applyQuiet({ ...base, lines: [flappy], quiets: [], states: first.states, pass: false }).status,
    ).toBe('ok');
    expect(
      applyQuiet({ ...base, lines: [flappy], quiets: [], states: second.states, pass: false }).status,
    ).toBe('warn');
  });

  it('forgets the state of a line that went, unless its check was skipped', () => {
    const states: StateRow[] = [
      {
        checkId: 'unifi.device_offline',
        subject: 'device:aa',
        firstSeen: NOW,
        lastSeen: NOW,
        seenPasses: 3,
        tone: 'warn',
      },
    ];
    expect(applyQuiet({ ...base, lines: [], quiets: [], states, pass: true }).gone).toHaveLength(1);
    expect(
      applyQuiet({ ...base, lines: [], quiets: [], states, pass: true, skipped: ['unifi.*'] }).gone,
    ).toEqual([]);
    expect(applyQuiet({ ...base, lines: [], quiets: [], states, pass: false }).gone).toEqual([]);
  });

  it('never colours for heads-ups or info lines, and names the worst line by its badge', () => {
    const fyi = line({ id: 'f', tone: 'warn', nature: 'fyi', check: 'fusebox.week_runs_out' });
    const info = line({ id: 'i', tone: 'info', nature: 'problem', check: 'x.y' });
    expect(applyQuiet({ ...base, lines: [fyi, info], quiets: [], pass: false }).status).toBe('ok');
    const warn = line({ id: 'w' });
    const bad = line({
      id: 'b',
      tone: 'bad',
      check: 'unifi.wan_down',
      subject: undefined,
      title: 'The internet line is down since this morning',
      badge: 'Internet down',
    });
    const r = applyQuiet({ ...base, lines: [fyi, warn, bad], quiets: [], pass: false });
    expect(r.status).toBe('bad');
    expect(r.worst?.id).toBe('b');
    expect(r.reason).toBe('Internet down');
    expect(r.badge).toBe('Internet down');
    // An older line without a nature: info is a heads-up, an ask link a problem, else only you.
    const older: LooseNotice = { id: 'o', tone: 'bad', icon: 'warn', title: 'Something' };
    expect(applyQuiet({ ...base, lines: [older], quiets: [], pass: false }).status).toBe('bad');
  });

  it('treats the “and N more” line as one item whose episode is its rest', () => {
    const rest = ['device:i', 'device:j', 'device:k'];
    const more = line({
      id: 'more',
      subject: moreSubject(3),
      episode: shortHash(rest),
      ignore: { lifts: 'newer', words: 'Until another one goes offline.' },
    });
    const ignored = row({ subject: MORE_SUBJECT, lifts: 'newer', episode: shortHash([...rest].reverse()) });
    expect(applyQuiet({ ...base, lines: [more], quiets: [ignored], pass: true }).quiet).toHaveLength(1);
    const grown = line({ ...more, subject: moreSubject(4), episode: shortHash([...rest, 'device:l']) });
    expect(applyQuiet({ ...base, lines: [grown], quiets: [ignored], pass: true }).lift).toHaveLength(1);
  });
});

describe('inPageOrder', () => {
  it('puts active lines by tone, then heads-ups, then the quiet ones', () => {
    const warn = line({ id: 'warn', subject: { id: 'w', name: 'W' } });
    const fyi = line({ id: 'fyi', tone: 'info', nature: 'fyi', subject: { id: 'f', name: 'F' } });
    const bad = line({ id: 'bad', tone: 'bad', subject: { id: 'b', name: 'B' } });
    const quiet = line({ id: 'quiet', tone: 'bad', subject: { id: 'q', name: 'Q' } });
    const r = applyQuiet({
      ...base,
      lines: [fyi, warn, quiet, bad],
      quiets: [row({ subject: 'q', tone: 'bad' })],
      pass: false,
    });
    expect(inPageOrder(r).map((x) => [x.line.id, x.row !== null])).toEqual([
      ['bad', false],
      ['warn', false],
      ['fyi', false],
      ['quiet', true],
    ]);
  });
});

describe('quiet words', () => {
  it('snoozes until 09:00 tomorrow in the burrow’s zone', () => {
    // 23:30 in Amsterdam on 22 Oct (21:30Z) → 09:00 on 23 Oct, summer time (07:00Z).
    expect(snoozeUntil(new Date('2026-10-22T21:30:00Z'), 'Europe/Amsterdam').toISOString()).toBe(
      '2026-10-23T07:00:00.000Z',
    );
    // Across the clock change on 25 Oct: 09:00 winter time (08:00Z).
    expect(snoozeUntil(new Date('2026-10-24T12:00:00Z'), 'Europe/Amsterdam').toISOString()).toBe(
      '2026-10-25T08:00:00.000Z',
    );
    expect(snoozeUntil(new Date('2026-10-22T23:30:00Z'), 'UTC').toISOString()).toBe(
      '2026-10-23T09:00:00.000Z',
    );
  });

  it('says when it ends in lower case after “Ignored by John”', () => {
    expect(lowerWords('Until it’s back online.')).toBe('until it’s back online');
    expect(lowerWords(null)).toBe('until it changes');
    const now = new Date('2026-10-22T10:00:00Z');
    expect(untilWords(new Date('2026-10-23T07:00:00Z'), now, 'Europe/Amsterdam')).toBe(
      'until tomorrow 09:00',
    );
    expect(untilWords(new Date('2026-10-22T15:00:00Z'), now, 'Europe/Amsterdam')).toBe('until 17:00');
    expect(untilWords(new Date('2026-10-26T08:00:00Z'), now, 'Europe/Amsterdam')).toBe('until Mon 09:00');
  });

  it('names the line in the change titles', () => {
    expect(quietTitle('ignore', 'Hallway AP is offline', 'until it’s back online')).toContain(
      '“Hallway AP is offline”',
    );
    expect(watchTitle(false, 'Garage AP', false)).toContain('Garage AP');
    expect(watchTitle(true, 'Access points going offline', true)).toContain('“Access points going offline”');
  });
});
