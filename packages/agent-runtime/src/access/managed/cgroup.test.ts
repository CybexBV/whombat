/**
 * The task wrapper's script (managed-sandbox.md MSB-05, memory-pool.md MP-02) with a plain directory for the cgroup:
 * it joins, raises the OOM score only upwards, then execs; a cgroup it can't join runs nothing.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TASK_OOM_SCORE_ADJ, taskWrapperScript } from './cgroup';

const own = Number(readFileSync('/proc/self/oom_score_adj', 'utf8').trim());
const wrapped = (adj: number | undefined, dir: string) =>
  spawnSync('/bin/sh', ['-c', taskWrapperScript(adj), dir, 'cat', '/proc/self/oom_score_adj'], {
    encoding: 'utf8',
  });

describe('the task wrapper (MP-02)', () => {
  it('a turn’s CLI goes before Whombat (-900) and after the agent’s commands (500)', () => {
    expect(TASK_OOM_SCORE_ADJ).toBe(-500);
    expect(taskWrapperScript()).toContain('-lt -500 ] && echo -500 > /proc/self/oom_score_adj');
  });

  it('joins the cgroup, raises a lower score and leaves a higher one, then execs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-cgroup-'));
    const up = Math.min(1000, own + 50);
    const raised = wrapped(up, dir);
    expect(raised.status).toBe(0);
    expect(raised.stdout.trim()).toBe(String(up));
    // The shell's pid joined the cgroup (the command is that same process after exec).
    expect(Number(readFileSync(join(dir, 'cgroup.procs'), 'utf8').trim())).toBeGreaterThan(0);
    // Lowering would need privilege: the wrapper doesn't try, and says nothing.
    const kept = wrapped(own - 50, dir);
    expect([kept.status, kept.stdout.trim(), kept.stderr]).toEqual([0, String(own), '']);
    if (own >= TASK_OOM_SCORE_ADJ) expect(wrapped(undefined, dir).stdout.trim()).toBe(String(own));
  });

  it('runs nothing when it can’t join the cgroup', () => {
    const missing = join(tmpdir(), 'wb-cgroup-missing', 'nowhere');
    const r = spawnSync('/bin/sh', ['-c', taskWrapperScript(), missing, 'echo', 'ran'], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
  });
});
