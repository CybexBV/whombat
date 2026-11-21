import type { DelegationCard, DelegationCardTask } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { attachmentsBesideCard, wordsUnderCard } from './cardDisplay';
import { DELEGATION_WORDS, delegationCardView } from './delegation';

const NOW = Date.parse('2026-11-05T12:10:00Z');

const task = (n: number, over: Partial<DelegationCardTask> = {}): DelegationCardTask => ({
  id: `dlt_${n}` as DelegationCardTask['id'],
  n,
  title: `Task ${n}`,
  why: null,
  picked: true,
  after: null,
  state: 'offered',
  pending: null,
  step: null,
  program: null,
  since: null,
  endedAt: null,
  url: null,
  branch: null,
  pr: null,
  note: null,
  ...over,
});

const card = (over: Partial<DelegationCard> = {}): DelegationCard => ({
  kind: 'delegation',
  delegationId: 'dlg_1' as DelegationCard['delegationId'],
  title: 'Polish the Settings page',
  project: 'Whombat',
  stage: 'offer',
  live: true,
  atOnce: 3,
  pullRequests: true,
  tasks: [task(1), task(2, { picked: false }), task(3, { after: 1 })],
  outcome: null,
  note: null,
  startedAt: '2026-11-05T12:00:00Z',
  handedAt: null,
  endedAt: null,
  ...over,
});

describe('the delegation card', () => {
  it('is a checklist while it waits: ticks counted, Hand over N', () => {
    const v = delegationCardView(card(), NOW);
    expect(v.offer).toBe(true);
    expect(v.picked).toBe(2);
    expect(v.handOver).toBe('Hand over 2');
    expect(v.stage).toContain('2 of 3');
    expect(v.tasks.map((t) => t.checkbox)).toEqual([true, true, true]);
    expect(v.tasks[1]?.label).toContain('not ticked');
    expect(v.stoppable).toBe(false);
  });

  it('shows each handed-over task where it is, folds the finished ones, and leaves out what wasn’t handed over', () => {
    const v = delegationCardView(
      card({
        stage: 'working',
        handedAt: '2026-11-05T12:01:00Z',
        tasks: [
          task(1, { state: 'working', since: '2026-11-05T12:02:00Z', step: 'Running the tests' }),
          task(2, { state: 'skipped', picked: false }),
          task(3, { state: 'queued', after: 1 }),
          task(4, { state: 'working', pending: 'question', since: '2026-11-05T12:02:00Z' }),
          task(5, {
            state: 'done',
            pr: 'https://github.com/o/r/pull/7',
            since: '2026-11-05T12:02:00Z',
            endedAt: '2026-11-05T12:06:00Z',
          }),
        ],
      }),
      NOW,
      'Dusty',
    );
    expect(v.offer).toBe(false);
    expect(v.stage).toBe('1 of 4 done · 2 working');
    // Not handed over: off the card. Finished: folded into one line.
    expect(v.tasks.map((t) => t.n)).toEqual([1, 3, 4]);
    expect(v.folded?.label).toBe('1 done');
    const [one, three, four] = v.tasks;
    expect(one).toMatchObject({
      working: true,
      detail: 'Running the tests',
      elapsed: '8 min',
      stoppable: true,
    });
    expect(three?.status).toBe('After 1');
    // A question the assistant answers itself is nothing for the person to do.
    expect(four).toMatchObject({ attention: false, status: 'Asked Dusty', detail: null });
    // A screen reader hears the name as a name.
    expect(four?.label).toContain('asked Dusty');
    expect(v.folded?.tasks[0]).toMatchObject({
      done: true,
      pr: 'https://github.com/o/r/pull/7',
      elapsed: '4 min',
      stoppable: false,
    });
    expect(v.stoppable).toBe(true);
  });

  it('shows a task waiting for its checks as holding no place, and red checks as needing a look', () => {
    const v = delegationCardView(
      card({
        stage: 'working',
        tasks: [
          task(1, { state: 'working', checks: 'running', since: '2026-11-05T12:02:00Z' }),
          task(2, { state: 'done', checks: 'failing' }),
          task(3, { state: 'working', pending: 'approval' }),
        ],
      }),
      NOW,
    );
    expect(v.tasks[0]).toMatchObject({
      working: false,
      status: DELEGATION_WORDS.checks.running,
      elapsed: '8 min',
    });
    expect(v.tasks[1]).toMatchObject({
      attention: true,
      done: false,
      status: DELEGATION_WORDS.checks.failing,
    });
    expect(v.tasks[2]).toMatchObject({ attention: true, status: DELEGATION_WORDS.pending.approval });
    expect(v.stage).toBe('0 of 3 done · 1 working · 2 need a look');
  });

  it('shows one thread doing several tasks as one row: how many it finished, its words, its items', () => {
    const thread = 'https://t3.example/thread/1';
    const working = delegationCardView(
      card({
        stage: 'working',
        tasks: [
          task(1, {
            state: 'working',
            url: thread,
            step: 'Running a command',
            said: 'The reconciler split is ready.',
            since: '2026-11-05T12:02:00Z',
            reported: true,
            note: 'Removed the empty crates.',
          }),
          task(2, { state: 'working', after: 1, url: thread, step: 'Running a command' }),
          task(3, {
            state: 'working',
            after: 1,
            url: thread,
            reported: true,
            note: 'Errors keep their cause.',
          }),
          task(4, { state: 'queued' }),
          task(5, { state: 'queued', after: 4 }),
        ],
      }),
      NOW,
    );
    const [row] = working.tasks;
    expect(working.tasks.map((t) => t.id)).toEqual(['dlt_1', 'dlt_4', 'dlt_5']);
    expect(row).toMatchObject({
      title: DELEGATION_WORDS.together.title(3),
      slot: '3',
      status: DELEGATION_WORDS.together.done(2, 3),
      detail: 'The reconciler split is ready.',
      note: null,
      working: true,
      elapsed: '8 min',
    });
    expect(row?.items?.map((i) => [i.n, i.done, i.note])).toEqual([
      [1, true, 'Removed the empty crates.'],
      [2, false, null],
      [3, true, 'Errors keep their cause.'],
    ]);
    // The thread works as one; what it said it finished counts as done.
    expect(working.stage).toBe('2 of 5 done · 1 working');
    expect(working.tasks[2]?.status).toBe(DELEGATION_WORDS.with(4));
  });

  it('keeps a thread doing several tasks as one row while it asks, and on its step before it says anything', () => {
    const thread = 'https://t3.example/thread/1';
    const tasks = [
      task(1, { state: 'working', url: thread, step: 'Running the tests' }),
      task(2, { state: 'working', after: 1, url: thread }),
    ];
    const quiet = delegationCardView(card({ stage: 'working', tasks }), NOW);
    expect(quiet.tasks).toHaveLength(1);
    expect(quiet.tasks[0]).toMatchObject({ status: 'Working', detail: 'Running the tests' });
    const asking = delegationCardView(
      card({
        stage: 'working',
        tasks: [{ ...tasks[0], pending: 'approval' } as DelegationCardTask, tasks[1] as DelegationCardTask],
      }),
      NOW,
    );
    expect(asking.tasks[0]).toMatchObject({ status: DELEGATION_WORDS.pending.approval, attention: true });
  });

  it('shows the tasks of a thread that ended on rows of their own again', () => {
    const thread = 'https://t3.example/thread/1';
    const v = delegationCardView(
      card({
        stage: 'working',
        merge: true,
        tasks: [
          task(1, { state: 'done', url: thread, merge: 'waiting', note: 'One.' }),
          task(2, { state: 'done', after: 1, url: thread, merge: 'waiting', note: 'Two.' }),
        ],
      }),
      NOW,
    );
    expect(v.tasks.map((t) => [t.title, t.items])).toEqual([
      ['Task 1', null],
      ['Task 2', null],
    ]);
  });

  it('says a task waits for one that didn’t finish', () => {
    const v = delegationCardView(
      card({
        stage: 'working',
        tasks: [task(1, { state: 'failed' }), task(2, { state: 'queued', after: 1 })],
      }),
      NOW,
    );
    expect(v.tasks[1]?.status).toContain('didn’t finish');
  });

  it('ends as done, done with some unfinished, stopped, or never handed over', () => {
    const ended = { live: false, endedAt: '2026-11-05T12:09:00Z' } as const;
    expect(
      delegationCardView(
        card({ ...ended, stage: 'done', outcome: 'done', tasks: [task(1, { state: 'done' })] }),
        NOW,
      ).ended,
    ).toBe('Done');
    expect(
      delegationCardView(
        card({
          ...ended,
          stage: 'done',
          outcome: 'incomplete',
          tasks: [task(1, { state: 'done' }), task(2, { state: 'failed' })],
        }),
        NOW,
      ).ended,
    ).toContain('1 didn’t finish');
    expect(
      delegationCardView(
        card({ ...ended, stage: 'stopped', outcome: 'stopped', handedAt: '2026-11-05T12:01:00Z' }),
        NOW,
      ).ended,
    ).toBe('Stopped');
    expect(delegationCardView(card({ ...ended, stage: 'stopped', outcome: 'stopped' }), NOW).ended).toBe(
      'Not handed over',
    );
  });

  it('shows each pull request’s merge, one at a time, when Whombat merges them', () => {
    expect(delegationCardView(card({ merge: true }), NOW).stage).toContain(DELEGATION_WORDS.merges);
    expect(delegationCardView(card(), NOW).stage).not.toContain(DELEGATION_WORDS.merges);
    const v = delegationCardView(
      card({
        stage: 'working',
        merge: true,
        tasks: [
          task(1, { state: 'done', merge: 'merged' }),
          task(2, { state: 'working', merge: 'merging' }),
          task(3, { state: 'done', merge: 'waiting' }),
          task(4, { state: 'done', merge: 'not_merged' }),
          task(5, { state: 'queued', after: 4 }),
        ],
      }),
      NOW,
    );
    expect(v.tasks.map((t) => t.status)).toEqual([
      DELEGATION_WORDS.merge.merging,
      DELEGATION_WORDS.merge.waiting,
      DELEGATION_WORDS.merge.not_merged,
      DELEGATION_WORDS.blocked(4),
    ]);
    expect(v.folded).toMatchObject({ label: '1 merged' });
    expect(v.folded?.tasks.map((t) => t.status)).toEqual([DELEGATION_WORDS.merge.merged]);
    expect(v.tasks[2]?.attention).toBe(true);
    expect(v.stage).toBe('1 of 5 merged · 1 working · 1 needs a look');
    expect(v.stoppable).toBe(true);
    const ended = delegationCardView(
      card({
        live: false,
        stage: 'done',
        outcome: 'incomplete',
        merge: true,
        tasks: [task(1, { state: 'done', merge: 'merged' }), task(2, { state: 'done', merge: 'not_merged' })],
      }),
      NOW,
    ).ended;
    expect(ended).toBe(DELEGATION_WORDS.doneUnmerged(1));
  });

  it('shows the agent’s words under the card', () => {
    expect(wordsUnderCard(card({ note: 'Two are done.' }))).toBe('Two are done.');
  });

  it('leaves the tasks’ pictures out of the message’s own files: the rows show them', () => {
    const shot = {
      view: 'Settings · light',
      attachmentId: 'att_shot' as never,
      width: 10,
      height: 20,
      areas: 1,
      notes: [],
    };
    const files = [{ id: 'att_shot' }, { id: 'att_log' }];
    const withShot = card({ stage: 'working', tasks: [task(1, { state: 'done', shots: [shot] }), task(2)] });
    expect(attachmentsBesideCard(files, withShot).map((a) => a.id)).toEqual(['att_log']);
    expect(attachmentsBesideCard(files, card())).toBe(files);
  });
});
