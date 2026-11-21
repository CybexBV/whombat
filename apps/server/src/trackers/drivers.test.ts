/**
 * A driver bound to a connection (docs/decisions/report-trackers.md): every answer is checked against the interface's
 * schemas (one that doesn't fit is an answer Whombat doesn't understand), a report it can't read is set aside rather
 * than failing the whole poll, a call that takes too long gives up in plain words, what a driver throws becomes the
 * workflow's own errors, and the optional calls never break the step that uses them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type TrackerDriver, TrackerFailure, type TrackerItem } from './driver';
import { bindDriver, DRIVER_TIMEOUTS, wordsOfDriver } from './drivers';
import { AccessRefused, SourceProblem, TrackerConflict, TrackerNotFound, TrackerRefusal } from './errors';

const CONN = { id: 'con_acme', label: 'Acme dev', baseUrl: 'https://acme.test', token: 'secret' };

const ITEM: TrackerItem = {
  id: '6a4f8f3e-2c1b-4f53-9d1a-0b6c2a4e9f11',
  number: 12,
  kind: 'bug',
  title: 'Export does nothing',
  description: 'Clicking export does nothing.',
  expected: '',
  organization: { id: 'org-1', name: null },
  environment: 'development',
  version: null,
  page: null,
  browser: null,
  status: 'new',
  priority: null,
  assessment: null,
  duplicateOf: null,
  createdAt: '2026-11-10T09:00:00.000Z',
  updatedAt: '2026-11-10T09:00:00.000Z',
  messages: [],
  hasScreenshot: false,
  hasDiagnostics: false,
  release: null,
};

function driver(over: Partial<TrackerDriver> = {}): TrackerDriver {
  return {
    info: {
      api: 1,
      id: 'acme-desk',
      version: '1.0.0',
      words: { product: 'Acme Desk', team: 'Acme team' },
      guidance: {},
      releasedSeparately: [],
    },
    check: async () => ({ ok: true, refused: false, status: 200, message: null }),
    health: async () => ({ environment: null, version: null, revision: null }),
    poll: async () => ({ items: [ITEM], unreadable: [], backlog: false }),
    item: async () => ({ ...ITEM, reporter: { name: null, email: null }, screenshot: null, evidence: '' }),
    diagnostics: async () => ({ text: 'x'.repeat(50), cut: false }),
    write: async () => ({ unchanged: true }),
    send: async () => ({ skipped: 'nothing to send', now: 'new' }),
    ...over,
  } as TrackerDriver;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('a bound driver', () => {
  it('passes answers that fit, and sets aside a report it can’t read instead of failing the poll', async () => {
    const bound = bindDriver(
      driver({
        poll: async () =>
          ({
            items: [ITEM, { ...ITEM, id: 'not-a-uuid', number: 13, kind: 'nonsense' }, { nothing: true }],
            unreadable: [{ id: null, number: 14 }],
            backlog: true,
          }) as never,
      }),
      CONN,
    );
    expect(bound.words).toEqual({ product: 'Acme Desk', team: 'Acme team' });
    const next = await bound.poll({ after: 10, watch: [] });
    expect(next.items.map((i) => i.number)).toEqual([12]);
    expect(next.unreadable).toEqual([
      { id: null, number: 14 },
      { id: 'not-a-uuid', number: 13 },
      { id: null, number: null },
    ]);
    expect(next.backlog).toBe(true);
    // The baseline (nothing seen yet) is never a backlog.
    expect((await bound.poll({ after: null, watch: [] })).backlog).toBe(false);
    // Diagnostics are cut to what was asked for.
    expect(await bound.diagnostics(ITEM.id, 'pkg', 10)).toEqual({ text: 'x'.repeat(10), cut: true });
  });

  it('calls an answer that doesn’t fit one Whombat doesn’t understand, naming the tracker', async () => {
    const bound = bindDriver(driver({ health: async () => ({ version: 7 }) as never }), CONN);
    const err = await bound.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceProblem);
    expect((err as SourceProblem).code).toBe('invalid_answer');
    expect((err as Error).message).toContain('Acme Desk');
  });

  it('turns what a driver throws into the workflow’s own errors', async () => {
    const cases: [unknown, new (...args: never[]) => Error, string?][] = [
      [new TrackerFailure('refused', 'The token was refused.'), SourceProblem, 'refused'],
      [new TrackerFailure('unreachable', 'No answer.'), SourceProblem, 'unreachable'],
      [new TrackerFailure('invalid_answer', 'Odd.'), SourceProblem, 'invalid_answer'],
      [new TrackerFailure('conflict', 'Changed twice.'), TrackerConflict],
      [new TrackerFailure('not_found', 'Gone.'), TrackerNotFound],
      [new TrackerFailure('rejected', 'Not that.'), TrackerRefusal],
      [new TrackerFailure('access_refused', 'No access.'), AccessRefused],
      // Another copy of the interface (a plugin's own class) is read by its code; anything else is "unreachable".
      [Object.assign(new Error('Changed under it.'), { code: 'conflict' }), TrackerConflict],
      [new TypeError('fetch failed'), SourceProblem, 'unreachable'],
    ];
    for (const [thrown, kind, code] of cases) {
      const bound = bindDriver(
        driver({
          write: async () => {
            throw thrown;
          },
        }),
        CONN,
      );
      const err = await bound
        .write(ITEM.id, { assessment: 'likely_bug', priority: 'high', requestId: 'req_1', resend: false })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(kind);
      if (code) expect((err as SourceProblem).code).toBe(code);
    }
  });

  it('gives up on a call that takes too long, in plain words', async () => {
    vi.useFakeTimers();
    const bound = bindDriver(driver({ check: () => new Promise(() => {}) }), CONN);
    const answer = bound.check().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(DRIVER_TIMEOUTS.quick + 1);
    const err = await answer;
    expect(err).toBeInstanceOf(SourceProblem);
    expect((err as SourceProblem).code).toBe('unreachable');
    expect((err as Error).message).toBe('Acme Desk didn’t answer in time.');
  });

  it('never lets an optional call break its step', async () => {
    const without = bindDriver(driver(), CONN);
    expect(without.grant).toBeNull();
    expect(without.read).toBeNull();
    expect(without.revoke).toBeNull();
    expect(without.prLine(12)).toBeNull();
    const odd = bindDriver(
      driver({
        revoke: async () => {
          throw new Error('down');
        },
        prLine: () => 'Acme ticket: #12\nand more',
      }),
      CONN,
    );
    expect(await odd.revoke?.(ITEM.id)).toBe(false);
    expect(odd.prLine(12)).toBeNull();
    const throwing = bindDriver(
      driver({
        prLine: () => {
          throw new Error('no');
        },
      }),
      CONN,
    );
    expect(throwing.prLine(12)).toBeNull();
    expect(bindDriver(driver({ prLine: () => '  Acme ticket: #12  ' }), CONN).prLine(12)).toBe(
      'Acme ticket: #12',
    );
  });

  it('names an unknown tracker plainly when no driver is there', () => {
    expect(wordsOfDriver(null)).toEqual({ product: 'the tracker', team: 'the team' });
  });
});
