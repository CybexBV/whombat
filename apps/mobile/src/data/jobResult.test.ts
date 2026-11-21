import { JOB_RESULT_WORDS, jobResultView, jobSendBar } from '@whombat/client';
import { JOB_RESULT_REPORT, jobResultFixture } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import {
  answeredLine,
  chooseMark,
  doneLine,
  markedCount,
  marksFor,
  NO_MARKS,
  outcomeParts,
  plainList,
  pointsKey,
  sentLine,
  toggleWords,
  typeWords,
} from './jobResult';

const ENDED = '2026-11-16T22:31:00.000Z';
const view = (over: Parameters<typeof jobResultFixture>[1] = {}) => {
  const v = jobResultView({ text: JOB_RESULT_REPORT, jobResult: jobResultFixture(ENDED, over) });
  if (!v) throw new Error('no view');
  return v;
};

describe('marking the points left for the person', () => {
  const v = view();

  it('marks a choice, unmarks it when tapped again, and names Send after what is marked', () => {
    let m = chooseMark(NO_MARKS, 1, 'Remove');
    m = chooseMark(m, 2, 'Keep it for later');
    expect(markedCount(v.points, m)).toBe(2);
    expect(jobSendBar(v, markedCount(v.points, m))?.button).toBe('Send 2 answers');
    m = chooseMark(m, 2, 'Keep it for later');
    expect(markedCount(v.points, m)).toBe(1);
    expect(jobSendBar(v, 0)?.enabled).toBe(false);
  });

  it('takes words or a choice for a point, never both', () => {
    let m = chooseMark(NO_MARKS, 3, 'Not yet');
    m = toggleWords(m, 3);
    expect(m.writing).toEqual([3]);
    expect(m.marks[3]?.choice).toBeUndefined();
    // An open field without words isn't an answer yet.
    expect(markedCount(v.points, m)).toBe(0);
    m = typeWords(m, 3, 'Only on the old desktops');
    expect(markedCount(v.points, m)).toBe(1);
    m = chooseMark(m, 3, 'It’s finished');
    expect(m.writing).toEqual([]);
    expect(m.marks[3]).toEqual({ choice: 'It’s finished' });
    // Closing the field takes its words back.
    expect(markedCount(v.points, toggleWords(toggleWords(m, 2), 2))).toBe(1);
  });

  it('keeps the marks while the points stay the same, not once the report is written anew', () => {
    const key = pointsKey(v.points);
    const stored = { key, marks: chooseMark(NO_MARKS, 1, 'Keep') };
    // A send or a reaction changes the message, not its points.
    expect(pointsKey(view({ tests: 'failed' }).points)).toBe(key);
    expect(marksFor(stored, key)).toBe(stored.marks);
    const rewritten = jobResultView({
      text: JOB_RESULT_REPORT.replace('Keep | Remove', 'Keep | Remove | Later'),
      jobResult: jobResultFixture(ENDED),
    });
    expect(marksFor(stored, pointsKey(rewritten?.points ?? []))).toBe(NO_MARKS);
  });
});

describe('what the message says about its answers', () => {
  const answers = [
    { point: 1, title: 'Keep?', choice: 'Remove', words: null },
    { point: 2, title: 'Missing?', choice: null, words: 'Keep it, I’ll add it.' },
  ];

  it('shows each answered point and the time T3 Code has had them', () => {
    const v = view({ sends: [{ at: '2026-11-16T22:40:00.000Z', answers, doneAt: null, outcome: null }] });
    expect(answeredLine(v.points[0] ?? { answer: null })).toBe(JOB_RESULT_WORDS.left.chose('Remove'));
    expect(answeredLine(v.points[1] ?? { answer: null })).toBe(JOB_RESULT_WORDS.left.wrote);
    expect(answeredLine(v.points[2] ?? { answer: null })).toBeNull();
    // No Send while T3 Code is on them.
    expect(jobSendBar(v, 1)).toBeNull();
    const line = sentLine(v.pending ?? { answers: 0, at: '' }, Date.parse('2026-11-16T22:42:30.000Z'));
    expect(line).toContain('2 answers');
    expect(line).toContain('2m');
  });

  it('says when T3 Code was done, on the Whombat’s clock, or that it wasn’t', () => {
    const done = { at: '2026-11-16T22:44:00.000Z', outcome: 'completed' as const };
    expect(doneLine(done, 'Europe/Amsterdam')).toEqual({
      text: JOB_RESULT_WORDS.left.done('23:44'),
      tone: 'ok',
    });
    expect(doneLine({ ...done, outcome: 'failed' }, 'UTC').tone).toBe('bad');
    expect(doneLine({ ...done, outcome: 'stopped' }, 'UTC').text).toBe(JOB_RESULT_WORDS.left.stopped);
  });
});

describe('the outcome', () => {
  it('leads with its first paragraph, the rest under it', () => {
    const { lead, rest } = outcomeParts(view().report.outcome);
    expect(lead).toMatch(/^The cleanup is done/);
    expect(lead).not.toContain('less to remove');
    expect(rest).toContain('less to remove');
    expect(outcomeParts('It works again.')).toEqual({ lead: 'It works again.', rest: '' });
  });
});

describe('a part written as a plain list', () => {
  it('gives its items with the bullets What changed has, a wrapped line joined to its item', () => {
    const decided = view().report.sections.find((s) => s.kind === 'decided');
    expect(plainList(decided?.body ?? '')?.items).toEqual([
      expect.stringMatching(/^Because the device agent changed/),
    ]);
    expect(plainList('Two things:\n- First\n  goes on\n- Second\n\nThat was all.')).toEqual({
      intro: 'Two things:',
      items: ['First goes on', 'Second'],
      outro: 'That was all.',
    });
  });

  it('leaves anything else as the markdown it is', () => {
    expect(plainList('Just words.')).toBeNull();
    expect(plainList('- One\n  - nested')).toBeNull();
    expect(plainList('1. One\n2. Two')).toBeNull();
    expect(plainList('- One\n```\ncode\n```')).toBeNull();
  });
});
