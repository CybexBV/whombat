/** This phone's sync log: which reads it notes, what it keeps between runs, and the file the person shares. */
import { QueryClient } from '@tanstack/query-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyncLog, readName, SYNC_LOG_TEXT, shortAge, syncLogFile, watchReads } from './syncLog';

const key = (conversationId: string) => ['whombat', 'messages.list', { burrow: 'hq', conversationId }, {}];

afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  // The cache stamps its reads with `Date.now()`: the log reads the same clock.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 10, 5, 9, 40));
  const clock = { now: () => Date.now(), pass: (ms: number) => vi.setSystemTime(Date.now() + ms) };
  const log = createSyncLog(clock.now, 50);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const off = watchReads(qc.getQueryCache(), log, clock.now);
  return { clock, log, qc, off, texts: () => log.entries().map((e) => e.text) };
}

describe('the sync log', () => {
  it('notes a read asked over old or owed data and its answer, not a routine one', async () => {
    const { clock, qc, texts, off } = setup();
    qc.setQueryData(key('cnv_chat'), { pages: [] });
    // Read a moment ago: routine.
    await qc.fetchQuery({ queryKey: key('cnv_chat'), queryFn: () => ({ pages: [1] }) });
    expect(texts()).toEqual([]);
    clock.pass(4 * 24 * 3600_000);
    qc.getQueryCache()
      .find({ queryKey: key('cnv_chat') })
      ?.invalidate();
    await qc.fetchQuery({
      queryKey: key('cnv_chat'),
      queryFn: async () => {
        clock.pass(1_200);
        return { pages: [2] };
      },
    });
    expect(texts()).toEqual([
      'ask messages.list cnv_chat · data 4 d old, marked to read again',
      'answer messages.list cnv_chat · 1.2 s',
    ]);
    off();
  });

  it('notes every failure with how long it took and its code, never what a read brought', async () => {
    const { clock, qc, texts, off } = setup();
    await qc
      .fetchQuery({
        queryKey: key('cnv_x'),
        queryFn: async () => {
          clock.pass(30_000);
          throw Object.assign(new Error('Not delivered: secret words'), { name: 'NotDeliveredError' });
        },
      })
      .catch(() => {});
    expect(texts()).toEqual(['failed messages.list cnv_x after 30.0 s · NotDeliveredError']);
    off();
  });

  it('keeps the newest notes, and merges an earlier run’s by time without counting one twice', () => {
    let t = 10;
    const log = createSyncLog(() => t, 3);
    log.note('b');
    t = 20;
    log.note('c');
    log.prepend([
      { at: 5, text: 'a' },
      { at: 10, text: 'b' },
    ]);
    expect(log.entries().map((e) => e.text)).toEqual(['a', 'b', 'c']);
    t = 30;
    log.note('d');
    expect(log.entries().map((e) => e.text)).toEqual(['b', 'c', 'd']);
    log.prepend('not a list' as never);
    expect(log.entries()).toHaveLength(3);
  });

  it('shares a text file that says which app and Whombat, in UTC', () => {
    const file = syncLogFile({
      entries: [{ at: Date.UTC(2026, 10, 10, 7, 43, 55), text: 'app active' }],
      app: 'android 3.93.3 (393030)',
      whombat: 'Home',
    });
    expect(file).toContain('android 3.93.3 (393030)');
    expect(file).toContain('Home');
    expect(file).toContain('2026-11-10T07:43:55.000Z app active');
    expect(syncLogFile({ entries: [], app: 'a', whombat: 'w' })).toContain(SYNC_LOG_TEXT.empty);
  });

  it('names a read by its endpoint and ids, and an age briefly', () => {
    expect(readName({ queryKey: key('cnv_E09ut0t8XtZl') })).toBe('messages.list cnv_E09ut0t8XtZl');
    expect(shortAge(45_000)).toBe('45 s');
    expect(shortAge(12 * 60_000)).toBe('12 min');
    expect(shortAge((3 * 60 + 5) * 60_000)).toBe('3 h 5 min');
    expect(shortAge((4 * 24 + 3) * 3600_000)).toBe('4 d 3 h');
  });
});
