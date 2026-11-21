import type {
  CouncilCard,
  CouncilCardMember,
  CouncilRoundResult,
  DelegationCard,
  DelegationCardTask,
  PlanStep,
} from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  councilFrame,
  councilResultWords,
  delegationFrame,
  planFocus,
  planFrame,
  runFrame,
} from './cardFrame';
import { THREAD_STAGE_WORDS, threadRowLabel, threadStage, threadStageWord } from './chat/stage';

const step = (n: number, state: PlanStep['state'], over: Partial<PlanStep> = {}): PlanStep =>
  ({
    id: `stp_${n}`,
    title: `Step ${n}`,
    state,
    stateLabel: state,
    runId: null,
    approvalId: null,
    automationRunId: null,
    dispatchId: null,
    note: null,
    updatedAt: null,
    refs: { runNumber: null, approvalNumber: null, automationRunNumber: null },
    ...over,
  }) as PlanStep;

const plan = (steps: PlanStep[]) => ({
  title: 'Invoice PDF export',
  steps,
  updatedAt: '2026-09-23T09:22:00Z',
});

describe('a thread’s stage', () => {
  it('reads only the flags, what waits first', () => {
    expect(threadStage({ waiting: true, working: true, handedOver: true })).toBe('waiting');
    expect(threadStage({ working: true, handedOver: true })).toBe('working');
    expect(threadStage({ handedOver: true })).toBe('handedOver');
    expect(threadStage({ settled: { at: '2026-09-23T09:00:00Z', how: 'person' } })).toBe('settled');
    // No flag is not Settled.
    expect(threadStage({})).toBeNull();
    expect(threadStage(null)).toBeNull();
  });

  it('names the assistant while it works and says every fact once to screen readers', () => {
    expect(threadStageWord('working', 'Neo')).toBe('Neo is working');
    const label = threadRowLabel({
      replies: '3 replies',
      stage: 'waiting',
      assistant: 'Neo',
      unread: 'New replies',
    });
    expect(label).toContain('3 replies');
    expect(label).toContain('New replies');
    expect(label).toContain(THREAD_STAGE_WORDS.waiting);
    expect(label.split('Waiting for you')).toHaveLength(2);
  });
});

describe('a plan card’s head', () => {
  it('names the step at work', () => {
    const f = planFrame(
      plan([step(1, 'done'), step(2, 'active', { title: 'Build the export endpoint' })]),
      'Neo',
    );
    expect(f).toMatchObject({ mark: 'working', word: 'Neo is working', title: 'Invoice PDF export' });
    expect(f.sentence).toContain('build the export endpoint');
    expect(planFocus(plan([step(1, 'active')]))?.kind).toBe('active');
  });

  it('names the step that waits for the person, with its own note', () => {
    const steps = [step(1, 'done'), step(2, 'gate', { note: 'Waiting for your go' }), step(3, 'active')];
    const f = planFrame(plan(steps), 'Neo');
    expect(f.mark).toBe('waiting');
    expect(f.sentence).toBe('Waiting for your go');
    expect(planFocus(plan(steps))?.step.id).toBe('stp_2');
  });

  it('says a blocked step and a finished plan', () => {
    expect(planFrame(plan([step(1, 'blocked')]), 'Neo')).toMatchObject({ mark: 'failed', word: 'Blocked' });
    expect(planFrame(plan([step(1, 'done'), step(2, 'cancelled')]), 'Neo')).toMatchObject({
      mark: 'done',
      sentence: null,
    });
    expect(planFrame(plan([step(1, 'queued')]), 'Neo').mark).toBe('queued');
  });

  it('keeps a name’s capitals in its sentence', () => {
    expect(planFrame(plan([step(1, 'active', { title: 'PDF library' })]), 'Neo').sentence).toContain('PDF');
  });
});

const member = (over: Partial<CouncilCardMember> = {}): CouncilCardMember => ({
  id: 'cnm_1',
  name: 'Claude Opus 5.5',
  provider: 'Claude',
  mark: 'claude',
  role: 'member',
  state: 'done',
  score: null,
  verdict: null,
  since: null,
  endedAt: null,
  step: null,
  url: null,
  ...over,
});

const round = (verdicts: (CouncilRoundResult['members'][number]['verdict'] | null)[], scores?: number[]) => ({
  stage: 'check' as const,
  round: 1,
  members: verdicts.map((verdict, i) => ({
    name: `M${i}`,
    mark: null,
    provider: 'P',
    state: 'done' as const,
    score: scores?.[i] ?? null,
    verdict,
  })),
});

const council = (over: Partial<CouncilCard> = {}): CouncilCard => ({
  kind: 'council',
  councilId: 'cnl_1',
  what: 'improve',
  title: 'Improve the Settings page',
  stage: 'done',
  round: 1,
  roundsMax: 3,
  target: 9,
  live: false,
  members: [member()],
  history: [round(['agree', 'agree', 'agree'])],
  plan: null,
  shots: [],
  outcome: 'done',
  startedAt: '2026-11-05T12:00:00Z',
  endedAt: '2026-11-05T12:30:00Z',
  ...over,
});

describe('a council card’s head', () => {
  it('writes the result in words, not scores', () => {
    expect(councilFrame(council())).toMatchObject({
      mark: 'done',
      word: 'Done',
      headline: 'All three agree.',
    });
    expect(councilResultWords(council({ history: [round(['agree', 'changes', 'agree'])] }))).toBe(
      'Two of three agree.',
    );
    expect(councilResultWords(council({ history: [round([null, null], [9, 8])] }))).toBe(
      'One of two reached the 9 out of 10 they aimed for.',
    );
    expect(councilResultWords(council({ history: [] }))).toBeNull();
  });

  it('says what a review without an aim gave it', () => {
    const review = (scores: number[]) =>
      councilResultWords(
        council({
          what: 'review',
          target: null,
          history: [
            round(
              scores.map(() => null),
              scores,
            ),
          ],
        }),
      );
    expect(review([8, 8, 8])).toBe('All three give it 8 out of 10.');
    expect(review([6, 7, 6.5])).toBe('They give it 6 to 7 out of 10.');
    expect(review([7.5, 7.5])).toBe('Both give it 7.5 out of 10.');
  });

  it('says its plan is agreed while the Tasks card asks for the go-ahead, else works', () => {
    // Its plan waits for the Tasks card's Hand over: one card asks, this one says its part is done.
    expect(councilFrame(council({ live: true, stage: 'approve', outcome: null }))).toMatchObject({
      mark: 'done',
      word: 'Plan agreed',
    });
    const live = councilFrame(
      council({ live: true, stage: 'research', outcome: null, members: [member({ state: 'working' })] }),
    );
    expect(live).toMatchObject({ mark: 'working', headline: null });
    expect(live.sentence).toContain('0 of 1 answered');
  });
});

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

const delegation = (over: Partial<DelegationCard> = {}): DelegationCard => ({
  kind: 'delegation',
  delegationId: 'dlg_1' as DelegationCard['delegationId'],
  title: 'Polish the Settings page',
  project: 'Whombat',
  stage: 'offer',
  live: true,
  atOnce: 3,
  pullRequests: true,
  tasks: [task(1), task(2, { picked: false })],
  outcome: null,
  note: null,
  startedAt: '2026-11-05T12:00:00Z',
  handedAt: null,
  endedAt: null,
  ...over,
});

describe('a delegation card’s head', () => {
  it('waits for the checklist, then is handed over with how far it is', () => {
    expect(delegationFrame(delegation())).toMatchObject({ mark: 'waiting', kind: 'Tasks' });
    const working = delegationFrame(
      delegation({
        stage: 'working',
        handedAt: '2026-11-05T12:05:00Z',
        tasks: [task(1, { state: 'done' }), task(2, { state: 'working' }), task(3, { state: 'queued' })],
      }),
    );
    expect(working).toMatchObject({ mark: 'handedOver', at: '2026-11-05T12:05:00Z' });
    expect(working.headline).toBe('1 finished · 2 still in progress');
  });

  it('ends done, or says what didn’t finish', () => {
    const ended = delegation({
      live: false,
      stage: 'done',
      outcome: 'done',
      handedAt: '2026-11-05T12:05:00Z',
    });
    expect(delegationFrame({ ...ended, tasks: [task(1, { state: 'done' })] }).mark).toBe('done');
    expect(delegationFrame({ ...ended, tasks: [task(1, { state: 'failed' })] }).mark).toBe('failed');
  });
});

describe('a run card’s head', () => {
  it('says what it does now as a sentence', () => {
    const f = runFrame({
      status: 'live',
      title: 'Address review',
      activity: 'running the tests',
      summary: null,
      startedAt: '2026-09-23T09:00:00Z',
      finishedAt: null,
    });
    expect(f).toMatchObject({ mark: 'working', sentence: 'Now: running the tests.' });
    expect(f.label).toContain('Address review');
  });
});

describe('an offered list that changed', () => {
  it('says what changed under its title, at the time it changed', () => {
    const card = {
      kind: 'delegation',
      delegationId: 'dlg_a',
      title: 'Calm down the Inbox',
      project: null,
      stage: 'offer',
      live: true,
      atOnce: 3,
      pullRequests: true,
      tasks: [],
      outcome: null,
      note: null,
      changed: {
        at: '2026-11-09T07:37:00Z',
        said: ['Took off “A search box”', 'Moved “One line per item” to the top'],
      },
      startedAt: '2026-11-09T06:22:00Z',
      handedAt: null,
      endedAt: null,
    } as unknown as Parameters<typeof delegationFrame>[0];
    const f = delegationFrame(card);
    expect(f.at).toBe('2026-11-09T07:37:00Z');
    expect(f.changed).toBe('Changed: took off “A search box” · moved “One line per item” to the top.');
    expect(f.label).toContain('took off');
    expect(delegationFrame({ ...card, changed: null }).changed).toBeNull();
    // A copy of it as it was asks nothing: it says what was ticked.
    const offered = {
      ...card,
      tasks: [
        { id: 't1', n: 1, title: 'A', state: 'offered', picked: true },
        { id: 't2', n: 2, title: 'B', state: 'offered', picked: false },
      ],
    } as unknown as Parameters<typeof delegationFrame>[0];
    expect(delegationFrame(offered, true).sentence).toBe('1 of 2 ticked.');
    expect(delegationFrame(offered).sentence).toContain('Pick what to hand over');
  });
});

describe('an offered list a council is looking at', () => {
  it('waits for the council, not the person, and says Hand over comes after its answer', () => {
    const card = {
      kind: 'delegation',
      delegationId: 'dlg_a',
      title: 'Calm down the Inbox',
      project: null,
      stage: 'offer',
      live: true,
      atOnce: 3,
      pullRequests: true,
      tasks: [],
      outcome: null,
      note: null,
      checking: true,
      startedAt: '2026-11-09T06:22:00Z',
      handedAt: null,
      endedAt: null,
    } as unknown as Parameters<typeof delegationFrame>[0];
    expect(delegationFrame(card)).toMatchObject({ mark: 'working', word: 'Council at work' });
    expect(delegationFrame(card).sentence).toContain('once it answers');
  });
});
