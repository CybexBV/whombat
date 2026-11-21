import { JOB_REPORT_LINES, type JobResult, jobAnswersMessage } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  JOB_RESULT_WORDS,
  jobAnswersOf,
  jobReport,
  jobResultFacts,
  jobResultView,
  jobSendBar,
} from './jobResult';

const REPORT = `The cleanup is done and running on development. Nothing works differently, and all the tests passed.

There was less to remove than expected.

## What changed
- **Backend:**
  - About 15 functions only passed calls on. They’re gone.
  - Four parts each had their own decoder; they now share one.
- **Deploy scripts:** removed functions nothing calls.
- A loose change without an area.

## What I decided
- I raised the workstation version, because the device agent changed.

## What the council decided
Three reviewers looked at the 10 points. They settled 7.
- **Removed: A function kept for a future task.** Only tests called it.
- **Kept: Three long sign-in checks.** Each checks something different.
  Merging them would hide that.

## Left for you
The council thinks these are yours.
1. **Keep the unused groundwork for moving Nest boxes?** About 2,150 lines wait for the Nest side.
   - Council's advice: remove it, unless moving boxes is still planned.
   - Choices: Keep | Remove
2. **Is retiring the old desktops finished?** Two systems share copied code.
   - Advice: don’t merge them.
   - Choices: It’s finished | Not yet
3. A question without bold. And its second sentence.

That is all of them.

## Technical detail
- \`fast-test\` passed.
\`\`\`
## not a heading
\`\`\`
`;

const result = (over: Partial<JobResult> = {}): JobResult => ({
  handoffId: 'thread:1',
  outcome: 'completed',
  endedAt: '2026-11-16T22:31:32.000Z',
  tests: 'passed',
  changes: { files: 198, additions: 840, deletions: 2000 },
  pullRequest: null,
  durationMs: 54 * 60_000,
  program: 'Claude · claude-opus-5-5',
  url: 'https://t3.example.com/env/thread',
  cut: false,
  sends: [],
  ...over,
});

describe('jobReport', () => {
  const report = jobReport(REPORT);

  it('reads the outcome before the first heading', () => {
    expect(report.outcome).toMatch(/^The cleanup is done/);
    expect(report.outcome).toContain('less to remove');
    expect(report.outcome).not.toContain('What changed');
  });

  it('keeps the sections in order and folds the technical detail away', () => {
    expect(report.sections.map((s) => s.kind)).toEqual(['changed', 'decided', 'council', 'left']);
    expect(report.detail).toContain('fast-test');
    expect(report.detail).toContain('## not a heading');
  });

  it('groups what changed by area', () => {
    const changed = report.sections[0];
    if (changed?.kind !== 'changed') throw new Error('no changes');
    expect(changed.groups?.[1]?.items[0]).toMatch(/^Removed functions/);
    expect(changed.groups?.map((g) => [g.label, g.items.length])).toEqual([
      ['Backend', 2],
      ['Deploy scripts', 1],
      [null, 1],
    ]);
  });

  it('reads each council decision with its word and reason', () => {
    const council = report.sections[2];
    if (council?.kind !== 'council') throw new Error('no council');
    expect(council.intro).toContain('Three reviewers');
    expect(council.decisions?.map((d) => [d.status, d.tone])).toEqual([
      ['Removed', 'ok'],
      ['Kept', 'quiet'],
    ]);
    expect(council.decisions?.[0]?.title).toBe('A function kept for a future task');
    expect(council.decisions?.[1]?.reason).toContain('Merging them would hide that');
  });

  it('reads the points left for the person with their advice and choices', () => {
    expect(report.points.map((p) => p.n)).toEqual([1, 2, 3]);
    const [first, second, third] = report.points;
    expect(first?.title).toBe('Keep the unused groundwork for moving Nest boxes?');
    expect(first?.text).toContain('2,150 lines');
    expect(first?.council).toBe(true);
    expect(first?.advice).toMatch(/^remove it/);
    expect(first?.choices).toEqual(['Keep', 'Remove']);
    expect(second?.council).toBe(false);
    expect(second?.advice).toBe('don’t merge them.');
    expect(second?.choices).toEqual(['It’s finished', 'Not yet']);
    expect(third?.title).toBe('A question without bold.');
    const left = report.sections[3];
    expect(left?.intro).toContain('yours');
    expect(left?.outro).toBe('That is all of them.');
  });

  it('takes a report without headings as its outcome, and bold lines as headings', () => {
    expect(jobReport('It works again.').sections).toEqual([]);
    const old = jobReport(
      'Merged.\n\n**What changed**\n- one\n\n**Not sure — for you to review**\n1. Keep it?',
    );
    expect(old.sections.map((s) => s.kind)).toEqual(['changed', 'left']);
    expect(old.points).toHaveLength(1);
  });

  it('reads the shape T3 Code is asked for', () => {
    const asked = jobReport(JOB_REPORT_LINES.join('\n'));
    expect(asked.sections.map((s) => s.kind)).toEqual(['changed', 'decided', 'council', 'left']);
    expect(asked.points[0]?.choices).toHaveLength(2);
    expect(asked.detail).not.toBeNull();
  });
});

describe('jobResultView', () => {
  it('is null for an ordinary message', () => {
    expect(jobResultView({ text: REPORT, jobResult: null })).toBeNull();
  });

  it('gives the facts in one line’s order', () => {
    expect(jobResultFacts(result()).map((f) => f.key)).toEqual(['tests', 'files', 'lines', 'time', 'model']);
    expect(jobResultFacts(result()).find((f) => f.key === 'lines')?.text).toBe('1,160 lines fewer');
    expect(jobResultFacts(result({ outcome: 'failed', tests: null, changes: null }))[0]).toMatchObject({
      key: 'problem',
      tone: 'bad',
    });
  });

  it('marks the points T3 Code works on and holds further answers until it is done', () => {
    const answers = [{ point: 1, title: 'Keep?', choice: 'Remove', words: null }];
    const view = jobResultView({
      text: REPORT,
      jobResult: result({
        sends: [{ at: '2026-11-16T22:40:00.000Z', answers, doneAt: null, outcome: null }],
      }),
    });
    expect(view?.points[0]?.answer).toEqual({ choice: 'Remove', words: null });
    expect(view?.open).toBe(2);
    expect(view?.pending?.answers).toBe(1);
    expect(view && jobSendBar(view, 0)).toBeNull();
    const done = jobResultView({
      text: REPORT,
      jobResult: result({
        sends: [
          {
            at: '2026-11-16T22:40:00.000Z',
            answers,
            doneAt: '2026-11-16T22:44:00.000Z',
            outcome: 'completed',
          },
        ],
      }),
    });
    expect(done?.pending).toBeNull();
    expect(done?.done?.outcome).toBe('completed');
    expect(done?.open).toBe(3);
  });
});

describe('answering', () => {
  const view = jobResultView({ text: REPORT, jobResult: result() });
  if (!view) throw new Error('no view');

  it('sends only the points that were marked, with a choice, words or both', () => {
    const answers = jobAnswersOf(view.points, {
      1: { choice: 'Remove' },
      2: { words: '  Yes, it is finished. ' },
      3: { choice: null, words: ' ' },
    });
    expect(answers).toEqual([
      { point: 1, title: 'Keep the unused groundwork for moving Nest boxes?', choice: 'Remove', words: null },
      {
        point: 2,
        title: 'Is retiring the old desktops finished?',
        choice: null,
        words: 'Yes, it is finished.',
      },
    ]);
    const message = jobAnswersMessage(answers);
    expect(message).toContain('1. Keep the unused groundwork for moving Nest boxes?: Remove');
    expect(message).toContain('2. Is retiring the old desktops finished?: Yes, it is finished.');
  });

  it('names the send button after what is marked', () => {
    expect(jobSendBar(view, 0)).toMatchObject({ enabled: false, hint: JOB_RESULT_WORDS.left.hintNone });
    expect(jobSendBar(view, 2)).toMatchObject({ button: 'Send 2 answers', enabled: true });
    expect(jobSendBar(view, 2)?.hint).toContain('1 still open');
    expect(jobSendBar(view, 3)?.hint).toBe(JOB_RESULT_WORDS.left.hintAll);
  });
});
