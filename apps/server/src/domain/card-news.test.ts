import { describe, expect, it } from 'vitest';
import { cardNews } from './card-news';

const council = (over: Record<string, unknown> = {}) => ({
  kind: 'council',
  stage: 'research',
  round: 1,
  live: true,
  outcome: null,
  plan: null,
  shots: [],
  note: 'Looking at it',
  members: [
    { id: 'cnm_1', state: 'working', score: null, verdict: null, step: null, since: '2026-11-06T10:00:00Z' },
    { id: 'cnm_2', state: 'working', score: null, verdict: null, step: null, since: '2026-11-06T10:00:00Z' },
  ],
  ...over,
});

const checklist = (over: Record<string, unknown> = {}) => ({
  kind: 'delegation',
  stage: 'working',
  live: true,
  outcome: null,
  note: null,
  tasks: [
    {
      id: 'dlt_1',
      title: 'Fix it',
      state: 'working',
      pending: null,
      merge: null,
      checks: null,
      pr: null,
      step: 'Reading',
    },
  ],
  ...over,
});

describe('a live card’s news', () => {
  it('is a member’s answer, a new stage or round, how it ended', () => {
    const answered = council({
      members: [
        { id: 'cnm_1', state: 'done', score: 8, verdict: null },
        { id: 'cnm_2', state: 'working', score: null, verdict: null },
      ],
    });
    expect(cardNews(council(), answered)).toBe(true);
    expect(cardNews(council(), council({ stage: 'agree' }))).toBe(true);
    expect(cardNews(council(), council({ live: false, outcome: 'done' }))).toBe(true);
  });

  it('is a task’s state, an OK it waits for, its pull request, a task added', () => {
    const t = checklist().tasks[0];
    expect(cardNews(checklist(), checklist({ tasks: [{ ...t, state: 'done' }] }))).toBe(true);
    expect(cardNews(checklist(), checklist({ tasks: [{ ...t, pending: 'approval' }] }))).toBe(true);
    expect(cardNews(checklist(), checklist({ tasks: [{ ...t, pr: 'https://github.com/o/r/pull/1' }] }))).toBe(
      true,
    );
    expect(cardNews(checklist(), checklist({ tasks: [t, { ...t, id: 'dlt_2' }] }))).toBe(true);
  });

  it('isn’t what a task does now, a clock or the words under the card', () => {
    const t = checklist().tasks[0];
    expect(cardNews(checklist(), checklist({ tasks: [{ ...t, step: 'Running the tests' }] }))).toBe(false);
    expect(cardNews(council(), council({ note: 'Still looking' }))).toBe(false);
    expect(cardNews(council(), council())).toBe(false);
  });

  it('is never another card’s', () => {
    expect(cardNews(null, { kind: 'run' })).toBe(false);
  });
});
