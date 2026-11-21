import { describe, expect, it } from 'vitest';
import { deskScreensSource, deskWordsSource, taskCardSource } from './contractsSource';
import type { DeskPower } from './desk';
import {
  ago,
  clockText,
  DESK_WORDS,
  dateText,
  duration,
  FOUND,
  fill,
  foundHead,
  foundSay,
  grouped,
  powerBanner,
  powerChip,
  SCREEN_WORDS,
  unlockedText,
  wrongPinText,
} from './deskCopy';

/** Every word with its key path. */
function leaves(o: object, path: string[] = []): { path: string[]; word: string }[] {
  return Object.entries(o).flatMap(([k, v]) =>
    typeof v === 'string' ? [{ path: [...path, k], word: v }] : leaves(v as object, [...path, k]),
  );
}

// The contracts write the no-break space before “%” as `${NBSP}` in a template literal.
const NBSP = '\u00a0';
const literal = (w: string) => (w.includes(NBSP) ? `\`${w.replaceAll(NBSP, '\u0024{NBSP}')}\`` : `'${w}'`);

describe('SCREEN_WORDS', () => {
  it.each(leaves(SCREEN_WORDS).map((l) => [l.path.join('.'), l.word]))(
    '%s is the contracts’ word under the same key',
    (path, word) => {
      expect(deskScreensSource).toContain(`${path.split('.').at(-1)}: ${literal(word)}`);
    },
  );
});

describe('DESK_WORDS', () => {
  it.each(leaves(DESK_WORDS).map((l) => [l.path.join('.'), l.word]))(
    '%s is the contracts’ word under the same key',
    (path, word) => {
      const key = path.split('.').at(-1) ?? '';
      // A key that isn't a name is quoted there (`'24h': 'Last 24 hours'`, 0.115).
      const quoted = /^[A-Za-z_$][\w$]*$/.test(key) ? key : `'${key}'`;
      // A task row's states are core's task card words, which desk.ts takes as they are (0.116).
      const source = path.startsWith('tasks.') ? taskCardSource : deskWordsSource;
      expect(source).toContain(`${quoted}: ${literal(word)}`);
    },
  );

  it('takes a task row’s states where the contracts’ desk words take them (0.116, TF-17)', () => {
    expect(deskWordsSource).toContain('tasks: TASK_CARD_WORDS.states,');
    expect(taskCardSource).toMatch(/export const TASK_CARD_WORDS = \{\s*\/\*\*[^*]*\*\/\s*states: \{/);
  });

  it('fills holes like the contracts and keeps one without a value', () => {
    expect(fill(DESK_WORDS.unlockedAs, { name: 'John', n: 2 })).toBe('Unlocked as John · locks in 2 min');
    expect(fill(DESK_WORDS.unlockedHere, { name: 'John' })).toContain('John · stays unlocked');
    expect(fill('{a} and {b}', { a: 1 })).toBe('1 and {b}');
    expect(wrongPinText(3)).toContain('3 tries');
    expect(wrongPinText(1)).toContain('1 try left');
  });

  it('says on the chip how long it stays unlocked: minutes, while you’re here, or until Lock (DK-74)', () => {
    expect(unlockedText('John', 2, false)).toBe(fill(DESK_WORDS.unlockedAs, { name: 'John', n: 2 }));
    expect(unlockedText('John', 1, true)).toContain('while you’re here');
    const stays = unlockedText('John', null, false);
    expect(stays).toBe(fill(DESK_WORDS.unlockedStays, { name: 'John' }));
    expect(stays).not.toMatch(/min|\d/);
    expect(unlockedText('John', null, true)).toBe(stays);
  });
});

const power = (p: Partial<DeskPower>): DeskPower => ({
  source: 'ac',
  percent: 80,
  charging: false,
  minutesLeft: null,
  chargeLimit: 80,
  since: null,
  ...p,
});

describe('power', () => {
  it('says how the machine is powered in the top bar (DK-10), the number and % never apart', () => {
    expect(powerChip(power({}))).toBe('Plugged in · battery kept at 80 %');
    expect(powerChip(power({ charging: true, percent: 64 }))).toContain('charging · 64 %');
    expect(powerChip(power({ chargeLimit: null, percent: 100 }))).toContain('100 %');
    expect(powerChip(power({ source: 'battery', percent: 76, minutesLeft: 190 }))).toContain(
      'about 3 h 10 min left',
    );
    expect(powerChip(power({ source: 'battery', percent: 76, minutesLeft: null }))).not.toContain('left');
  });

  it('writes the banner with the local time the power went out and the assistant’s name', () => {
    const b = powerBanner(
      power({ source: 'battery', minutesLeft: 190, since: '2026-10-21T00:14:00Z' }),
      'Neo',
      'Europe/Amsterdam',
    );
    expect(b?.lead).toContain('02:14');
    expect(b?.rest).toContain('3 h 10 min');
    expect(b?.rest).toContain('Neo');
    expect(powerBanner(power({}), 'Neo', 'UTC')).toBeNull();
    expect(powerBanner(power({ source: 'battery' }), 'Neo', 'UTC')?.rest).not.toContain('left');
  });

  it('rounds durations to hours and minutes', () => {
    expect(duration(190)).toBe('3 h 10 min');
    expect(duration(45)).toBe('45 min');
    expect(duration(120)).toBe('2 h');
  });
});

describe('time', () => {
  const t = Date.parse('2026-10-20T12:34:00Z');

  it('shows the clock and date in the paired person’s time zone', () => {
    expect(clockText(t, 'Europe/Amsterdam')).toBe('14:34');
    expect(clockText(t, 'America/New_York')).toBe('08:34');
    expect(dateText(t, 'Europe/Amsterdam')).toBe('Tuesday 20 October');
  });

  it('says how long ago, short in rows and long on the sheet', () => {
    expect(ago('2026-10-20T12:31:00Z', t)).toBe('3 min ago');
    expect(ago('2026-10-20T12:31:00Z', t, true)).toBe('3 minutes ago');
    expect(ago('2026-10-20T12:33:30Z', t)).toBe('just now');
    expect(ago('2026-10-20T10:00:00Z', t)).toBe('2 h ago');
    expect(ago('2026-10-18T10:00:00Z', t, true)).toBe('2 days ago');
  });
});

describe('found on your network (DF-09, CG-231)', () => {
  const now = Date.parse('2026-10-20T12:34:20Z');
  const THIN = '\u202f';

  it('groups numbers by thousands with a thin space that never breaks', () => {
    expect(grouped(412)).toBe('412');
    expect(grouped(1022)).toBe(`1${THIN}022`);
    expect(grouped(1_000_000)).toBe(`1${THIN}000${THIN}000`);
    expect(grouped(-3)).toBe('0');
  });

  it('says what it does while the first scan looks: nothing yet, or how many so far', () => {
    const progress = { done: 412, total: 1022 };
    const none = foundSay({ progress, count: 0 });
    expect(none.text).toBe(FOUND.looking);
    expect(none.more).toBe(FOUND.lookingNone);
    const some = foundSay({ progress, count: 3 });
    expect(some.text).toBe(FOUND.looking);
    expect(some.more).toContain('3 found');
  });

  it('says what it found once it’s done, one or many', () => {
    const many = foundSay({ progress: null, count: 8 });
    expect(many.text).toContain('8 things');
    expect(many.more).toBe(FOUND.foundManyMore);
    expect(foundSay({ progress: null, count: 1022 }).text).toContain(`1${THIN}022 things`);
    const one = foundSay({ progress: null, count: 1 });
    expect(one.text).toContain('one thing');
    expect(one.more).toBe(FOUND.foundOneMore);
  });

  it('heads the panel with what it looked at, else how many and since when', () => {
    const looking = foundHead({ progress: { done: 412, total: 1022 }, count: 3, finishedAt: null }, now);
    expect(looking).toContain(`412 of 1${THIN}022`);
    expect(foundHead({ progress: null, count: 8, finishedAt: '2026-10-20T12:34:00Z' }, now)).toBe(
      '8 found · just now',
    );
    expect(foundHead({ progress: null, count: 8, finishedAt: '2026-10-20T10:30:00Z' }, now)).toContain(
      '2 h ago',
    );
    expect(foundHead({ progress: null, count: 8, finishedAt: null }, now)).toBe('8 found');
  });

  it('keeps DF-09’s key words, curly quotes and arrows', () => {
    expect(FOUND.title).toBe('Found on your network');
    expect(FOUND.stripTitle).toBe('Still on your network');
    expect(FOUND.notNow).toBe(DESK_WORDS.notNow);
    expect(FOUND.looking).toContain('I’m');
    expect(FOUND.foundManyMore).toContain('I’ll');
    expect(`${FOUND.connectMany.before}app.whombat.com${FOUND.connectMany.after}`).toContain(
      'computer: app.whombat.com → Connections',
    );
    expect(FOUND.connectOne.before).toContain('Connect it');
    expect(`${FOUND.stripConnect.before}app.whombat.com`).toBe('Connect on app.whombat.com');
    expect(fill(FOUND.stripMore, { k: 4 })).toBe('+4 more');
  });
});
