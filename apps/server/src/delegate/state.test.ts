import { describe, expect, it } from 'vitest';
import type { DelegationTaskRow } from '../db/schema/delegations';
import { allOver, eligibleIntegration, finalDue, readyTasks, togetherWith } from './state';

const at = new Date('2026-11-07T12:00:00Z');
const task = (id: string, position: number, fields: Partial<DelegationTaskRow> = {}): DelegationTaskRow =>
  ({
    id,
    position,
    createdAt: at,
    kind: 'task',
    state: 'queued',
    picked: true,
    afterId: null,
    mergeState: null,
    checks: null,
    threadId: null,
    sendPending: null,
    stopPending: false,
    pr: null,
    branch: `delegate/${id}`,
    ...fields,
  }) as DelegationTaskRow;
const source = (id: string, position: number, fields: Partial<DelegationTaskRow> = {}) =>
  task(id, position, {
    state: 'done',
    mergeState: 'waiting',
    checks: 'passing',
    pr: `https://github.com/example/project/pull/${id}`,
    ...fields,
  });
const final = (fields: Partial<DelegationTaskRow> = {}) => task('final', 99, { kind: 'final', ...fields });

describe('batch work before main is changed', () => {
  it('lets a dependent use a passing predecessor’s unmerged branch, leaving legacy behavior unchanged', () => {
    const a = source('a', 0);
    const b = task('b', 1, { afterId: 'a' });
    expect(readyTasks([a, b])).toEqual([]);
    expect(readyTasks([a, b], true)).toEqual([b]);
    expect(readyTasks([{ ...a, checks: 'none' }, b], true)).toEqual([b]);
    expect(readyTasks([{ ...a, branch: null }, b], true)).toEqual([]);
    expect(readyTasks([{ ...a, pr: null }, b], true)).toEqual([]);
  });

  it.each(['failing', 'running', null] as const)(
    'does not build on an unmerged predecessor with %s checks',
    (checks) => {
      const a = source('a', 0, { checks });
      const b = task('b', 1, { afterId: 'a' });
      expect(readyTasks([a, b], true)).toEqual([]);
    },
  );

  it('does not spin on a dependent blocked by a failed predecessor', () => {
    const tasks = [task('a', 0, { state: 'failed' }), task('b', 1, { afterId: 'a' }), final()];
    expect(readyTasks(tasks, true)).toEqual([]);
    expect(finalDue(tasks, true)).toBe(false);
    expect(allOver(tasks, true)).toBe(true);
  });

  it('keeps automatic descendants of kept work out of readiness and the combined candidate', () => {
    const a = source('a', 0, { mergeState: 'kept' });
    const b = source('b', 1, { afterId: 'a' });
    const c = task('c', 2, { afterId: 'b' });
    expect(readyTasks([a, b, c, final()], true)).toEqual([]);
    expect(eligibleIntegration([a, b, c])).toEqual([]);
    expect(allOver([a, b, c, final()], true)).toBe(true);
    const keptChild = { ...c, mergeState: 'kept' as const };
    expect(readyTasks([a, b, keptChild], true)).toEqual([keptChild]);
  });

  it('lets kept descendants work on the kept branch without scheduling it for main', () => {
    const a = source('a', 0, { mergeState: 'kept' });
    const b = task('b', 1, { afterId: 'a', mergeState: 'kept' });
    expect(readyTasks([a, b], true)).toEqual([b]);
    expect(eligibleIntegration([a, source('b', 1, { afterId: 'a', mergeState: 'kept' })])).toEqual([]);
  });

  it('combines passing waiting PRs in dependency order, even after the card was reordered', () => {
    const a = source('a', 2);
    const b = source('b', 1, { afterId: 'a' });
    const c = source('c', 0, { afterId: 'b', checks: 'none' });
    expect(eligibleIntegration([c, b, a]).map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(finalDue([c, b, a, final()], true)).toBe(true);
    expect(readyTasks([c, b, a, final()], true).map((t) => t.id)).toEqual(['final']);
    expect(finalDue([c, b, a, final()])).toBe(false);
  });

  it('excludes failed, unselected, stopping and unverified source branches', () => {
    const tasks = [
      source('good', 0),
      source('failed', 1, { state: 'failed' }),
      source('unselected', 2, { picked: false }),
      source('stopping', 3, { stopPending: true }),
      source('red', 4, { checks: 'failing' }),
      source('unknown', 5, { checks: null }),
      source('missing-pr', 6, { pr: null }),
    ];
    expect(eligibleIntegration(tasks).map((t) => t.id)).toEqual(['good']);
  });

  it('still checks work already merged, but waits until ordinary work can go no further', () => {
    const a = source('a', 0, { mergeState: 'merged' });
    const b = task('b', 1, { state: 'working' });
    expect(finalDue([a, b, final()], true)).toBe(false);
    expect(finalDue([a, { ...b, state: 'failed' }, final()], true)).toBe(true);
  });

  it('keeps the final check on a full twelve-task card ready and the batch unfinished', () => {
    const sources = Array.from({ length: 12 }, (_, n) => source(`task-${n}`, n));
    const check = final();
    expect(readyTasks([...sources, check], true)).toEqual([check]);
    expect(allOver([...sources, check], true)).toBe(false);
    expect(allOver(sources, true)).toBe(false);
  });

  it('waits for the final check and its separate permission to merge', () => {
    const a = source('a', 0);
    expect(allOver([a, final({ state: 'working' })], true)).toBe(false);
    expect(allOver([a, final({ state: 'done', mergeState: 'waiting' })], true)).toBe(false);
    expect(allOver([a, final({ state: 'done', mergeState: 'merged' })], true)).toBe(true);
  });

  it('lets the agent honestly finish an incomplete batch after a terminal final failure', () => {
    const a = source('a', 0);
    const failed = final({ state: 'failed', checks: 'failing' });
    expect(readyTasks([a, failed], true)).toEqual([]);
    expect(allOver([a, failed], true)).toBe(true);
    expect(allOver([a, failed])).toBe(false);
  });

  it('does not claim, group, or build on tasks still stopping', () => {
    const a = task('a', 0);
    const b = task('b', 1, { afterId: 'a', stopPending: true });
    const c = task('c', 2, { afterId: 'b' });
    const d = task('d', 3, { stopPending: true });
    expect(readyTasks([a, b, c, d], true)).toEqual([a]);
    expect(togetherWith(a, [a, b, c, d])).toEqual([]);
    expect(togetherWith({ ...a, stopPending: true }, [a, b, c, d])).toEqual([]);
    expect(readyTasks([source('p', 0, { stopPending: true }), task('q', 1, { afterId: 'p' })], true)).toEqual(
      [],
    );
    expect(readyTasks([source('p', 0), final({ stopPending: true })], true)).toEqual([]);
  });
});
