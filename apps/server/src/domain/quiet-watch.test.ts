import { THING_WATCH_CHECKS_MAX, THING_WATCH_EXCEPTIONS_MAX, type ThingWatchCheck } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { ThingQuiet } from '../things/quiet/store';
import { addQuietExceptions, watchList } from './quiet-watch';

const NOW = new Date('2026-10-31T10:00:00Z');
const AT = new Date('2026-10-30T08:00:00Z');

const check = (id: string): ThingWatchCheck => ({
  check: id,
  name: id,
  nature: 'problem',
  on: true,
  perItem: true,
  exceptions: [],
});

function list(...ids: string[]) {
  const checks = new Map(ids.map((id) => [id, check(id)]));
  const at = (id: string, name: string) => {
    let c = checks.get(id);
    if (!c) {
      c = { ...check(id), name };
      checks.set(id, c);
    }
    return c;
  };
  return { checks, at };
}

const by = (id: string | null) => (id === 'prn_mara' ? { by: { id, name: 'Mara Okafor' } } : {});
const off = (row: Partial<ThingQuiet['offs'][number]>) =>
  ({
    checkId: 'ap.offline',
    subject: '',
    subjectName: null,
    byId: 'prn_mara',
    at: AT,
    ...row,
  }) as ThingQuiet['offs'][number];
const quiet = (row: Partial<ThingQuiet['quiets'][number]>) =>
  ({
    checkId: 'ap.offline',
    subject: '',
    subjectName: null,
    state: 'ignored',
    until: null,
    title: 'Access points offline',
    words: null,
    byId: null,
    at: AT,
    ...row,
  }) as ThingQuiet['quiets'][number];

describe('What Whombat watches from the quiet store', () => {
  it('a check off as a whole, an item off, and lines ignored or snoozed, each under its check', () => {
    const { checks, at } = list('ap.offline', 'disk.full');
    addQuietExceptions(
      {
        offs: [
          off({ checkId: 'disk.full' }),
          off({ subject: 'ap_garage', subjectName: 'Garage AP', byId: null }),
        ],
        quiets: [
          quiet({
            subject: 'ap_attic',
            subjectName: 'Attic AP',
            state: 'snoozed',
            until: new Date('2026-11-01T08:00:00Z'),
          }),
          quiet({ checkId: 'gone.check', title: 'A check it no longer lists', byId: 'prn_mara' }),
        ],
      },
      { at, by, now: NOW, timeZone: 'UTC' },
    );
    expect(checks.get('disk.full')).toMatchObject({
      on: false,
      off: { by: { id: 'prn_mara' }, at: AT.toISOString() },
    });
    const ap = checks.get('ap.offline');
    expect(ap?.on).toBe(true);
    expect(ap?.exceptions).toEqual([
      {
        subject: { id: 'ap_garage', name: 'Garage AP' },
        state: 'stopped',
        words: 'always',
        at: AT.toISOString(),
      },
      {
        subject: { id: 'ap_attic', name: 'Attic AP' },
        state: 'snoozed',
        words: 'until tomorrow 08:00',
        until: '2026-11-01T08:00:00.000Z',
        at: AT.toISOString(),
      },
    ]);
    // A check the thing no longer lists still shows, so the person can take its row back.
    expect(checks.get('gone.check')).toMatchObject({
      name: 'A check it no longer lists',
      exceptions: [{ state: 'ignored', words: 'until it changes', by: { id: 'prn_mara' } }],
    });
  });

  it('answers within the contract’s caps', () => {
    const { checks } = list(...Array.from({ length: THING_WATCH_CHECKS_MAX + 5 }, (_, i) => `c.${i}`));
    const first = checks.get('c.0');
    first?.exceptions.push(
      ...Array.from({ length: THING_WATCH_EXCEPTIONS_MAX + 5 }, () => ({
        state: 'ignored' as const,
        at: AT.toISOString(),
      })),
    );
    const answer = watchList(checks);
    expect(answer.checks).toHaveLength(THING_WATCH_CHECKS_MAX);
    expect(answer.checks[0]?.exceptions).toHaveLength(THING_WATCH_EXCEPTIONS_MAX);
    expect(answer.mayChange).toBe(true);
  });
});
