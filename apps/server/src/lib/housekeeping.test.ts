import { describe, expect, it } from 'vitest';
import { describeStale, Housekeeping } from './housekeeping';

describe('Housekeeping (server-efficiency.md SV-03)', () => {
  it('runs each job on its own period and keeps going past a failure', async () => {
    const warned: string[] = [];
    const h = new Housekeeping(() => ({ warn: (_o, msg) => warned.push(msg ?? '') }), 1_000);
    const ran: string[] = [];
    const job = (name: string) => async () => {
      await new Promise((r) => setTimeout(r, 5));
      ran.push(name);
    };
    h.add('every tick', 1_000, job('a'), { first: 'tick' });
    h.add('every third', 3_000, job('b'), { first: 'tick' });
    h.add('broken', 1_000, async () => {
      throw new Error('boom');
    });
    const stopC = h.add('later', () => 60_000, job('c'));
    await h.tick();
    expect(ran.sort()).toEqual(['a', 'b']);
    // Not due again yet (a tick hasn't passed).
    await h.tick();
    expect(ran).toEqual(['a', 'b']);
    stopC();
    expect(h.has('later')).toBe(false);
    await h.close();
    expect(warned).toEqual([]);
  });

  it('runs a job again once its period minus half a tick has passed, and logs its failures', async () => {
    const warned: string[] = [];
    const h = new Housekeeping(() => ({ warn: (_o, msg) => warned.push(msg ?? '') }), 40);
    let n = 0;
    h.add('count', 40, async () => {
      n++;
    });
    h.add('broken', 40, async () => {
      throw new Error('boom');
    });
    await new Promise((r) => setTimeout(r, 150));
    await h.close();
    expect(n).toBeGreaterThanOrEqual(2);
    expect(warned[0]).toBe('housekeeping: broken failed');
    const after = n;
    await new Promise((r) => setTimeout(r, 100));
    expect(n).toBe(after);
  });
});

describe('Housekeeping: a stuck job', () => {
  const quiet = () => ({ warn: () => {} });

  it("doesn't hold up the other jobs or the next ticks", async () => {
    const h = new Housekeeping(quiet, 1_000);
    let runs = 0;
    // A job that never ends and ignores its abort.
    h.add('stuck', 1_000, () => new Promise(() => {}), { first: 'tick', deadlineMs: 100 });
    h.add(
      'count',
      1_000,
      async () => {
        runs++;
      },
      { first: 'tick' },
    );
    // The tick waits for the stuck job only until its deadline; the other job ran beside it.
    await h.tick();
    expect(runs).toBe(1);
    // The next tick skips the job still stuck and runs the other one again at once.
    await new Promise((r) => setTimeout(r, 1_000));
    const t0 = performance.now();
    await h.tick();
    expect(runs).toBe(2);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(h.jobs().find((j) => j.name === 'stuck')?.running).toBe(true);
    await h.close(10);
  });

  it('is cancelled at its deadline, never overlaps itself, and the failure is logged', async () => {
    const warned: string[] = [];
    const h = new Housekeeping(() => ({ warn: (_o, msg) => warned.push(msg ?? '') }), 20);
    let started = 0;
    let aborted = 0;
    h.add(
      'stuck',
      20,
      (signal) =>
        new Promise<void>(() => {
          started++;
          signal.addEventListener('abort', () => aborted++);
        }),
      { first: 'tick', deadlineMs: 50 },
    );
    await h.tick();
    expect(started).toBe(1);
    // Still running before its deadline: the next tick doesn't start it again.
    await new Promise((r) => setTimeout(r, 30));
    await h.tick();
    expect(started).toBe(1);
    await new Promise((r) => setTimeout(r, 60));
    expect(aborted).toBe(1);
    expect(warned).toContain('housekeeping: stuck ran past its deadline and was stopped');
    await h.close();
  });

  it('records each job’s last success and tells which jobs are stale', async () => {
    let now = Date.parse('2026-11-07T10:00:00Z');
    const h = new Housekeeping(quiet, 1_000, () => now);
    let fail = false;
    h.add('fine', 1_000, async () => {}, { first: 'tick' });
    h.add(
      'flaky',
      1_000,
      async () => {
        if (fail) throw new Error('boom');
      },
      { first: 'tick' },
    );
    h.add('stuck', 1_000, () => new Promise(() => {}), { first: 'tick', deadlineMs: 50 });
    await h.tick();
    expect(h.jobs().find((j) => j.name === 'fine')?.lastOkAt).toEqual(new Date(now));
    expect(h.jobs().find((j) => j.name === 'stuck')?.lastOkAt).toBeNull();
    expect(h.stale()).toEqual([]);
    expect(describeStale(h.jobs())).toBeNull();
    fail = true;
    now += 16 * 60_000;
    await new Promise((r) => setTimeout(r, 1_000));
    await h.tick();
    // 'fine' just succeeded; 'flaky' failed since its last success over 15 minutes ago; 'stuck' never finished.
    expect(
      h
        .stale()
        .map((j) => j.name)
        .sort(),
    ).toEqual(['flaky', 'stuck']);
    const words = describeStale(h.jobs()) ?? '';
    expect(words).toMatch(/^maintenance is stale/);
    expect(words).toContain('flaky last finished 16 minutes ago');
    expect(words).toContain('stuck');
    expect(words).not.toContain('fine');
    await h.close(10);
  });
});
