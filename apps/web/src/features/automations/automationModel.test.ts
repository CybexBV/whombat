import type { AgentScheduleView } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  approvalAsked,
  conditionStory,
  foldSkipped,
  fullRule,
  pullRequestUrl,
  SUGGESTS_A_CHANGE,
  skippedLine,
  stepAssessment,
  stepOutcome,
} from './AutomationRunScreen';
import { listedSchedules, nextRunWords, overviewWords } from './automationModel';

describe('the run page', () => {
  it('says what a step came to', () => {
    const step = {
      stepId: 'approve',
      index: 0,
      kind: 'request_approval' as const,
      name: 'Approve',
      state: 'succeeded' as const,
      attempt: 0,
      startedAt: null,
      finishedAt: null,
      wakeAt: null,
      inputSummary: '',
      output: { decision: 'declined', decidedById: 'prn_mara' },
      error: null,
      dispatchId: null,
      approvalId: null,
      approvalNumber: null,
      messageIds: [],
      prNumber: null,
      runNumbers: [],
      redacted: false,
    };
    expect(stepOutcome(step, () => 'Mara')).toBe('Declined by Mara.');
    expect(stepOutcome({ ...step, kind: 'condition', output: { result: false } }, () => '')).toBe(
      'False: it stopped here.',
    );
    // Coding work and reviews (bp-automations BP-C26, BP-C27).
    const coding = { ...step, kind: 'dispatch_agent' as const };
    expect(
      stepOutcome({ ...coding, output: { commits: 2, workspace: { branch: 'feat/bug-3' } } }, () => ''),
    ).toBe('2 new commits on feat/bug-3.');
    expect(stepOutcome({ ...coding, output: { verdict: 'changes_needed' } }, () => '')).toBe(
      'Verdict: Changes needed.',
    );
    expect(stepOutcome({ ...coding, output: { text: 'Done.' } }, () => '')).toBeNull();
  });

  it('answers a question-named condition, and says where a skip went on (AP-992)', () => {
    const base = {
      stepId: 'needs_yes',
      index: 3,
      kind: 'condition' as const,
      name: 'Does a person need to say yes?',
      state: 'succeeded' as const,
      attempt: 0,
      startedAt: null,
      finishedAt: null,
      wakeAt: null,
      inputSummary: '',
      output: { result: false },
      error: null,
      dispatchId: null,
      approvalId: null,
      approvalNumber: null,
      messageIds: [],
      prNumber: null,
      runNumbers: [],
      redacted: false,
    };
    const later = [
      base,
      { ...base, stepId: 'approve', index: 4, name: 'Approve the fix', state: 'skipped' as const },
      { ...base, stepId: 'fix', index: 5, name: 'Fix the bug', state: 'running' as const },
    ];
    expect(stepOutcome(base, () => '', later)).toBe('No: it skipped to “Fix the bug”.');
    expect(stepOutcome({ ...base, output: { result: true } }, () => '', later)).toBe('Yes: it went on.');
    expect(stepOutcome(base, () => '', later.slice(0, 2))).toBe('No: it stopped here.');
  });

  it('shows an assessment and the opened pull request (AP-991, AP-993)', () => {
    const step = {
      stepId: 'ask',
      index: 0,
      kind: 'dispatch_agent' as const,
      name: 'Assess it',
      state: 'succeeded' as const,
      attempt: 0,
      startedAt: null,
      finishedAt: null,
      wakeAt: null,
      inputSummary: '',
      output: {},
      error: null,
      dispatchId: null,
      approvalId: null,
      approvalNumber: null,
      messageIds: [],
      prNumber: null,
      runNumbers: [],
      redacted: false,
    };
    const assessment = {
      kind: 'bug',
      importance: 'high',
      confidence: 'high',
      size: 'small',
      summary: 'Floors cents.',
      fixPlan: '',
      duplicateOf: null,
    };
    // The server's line when it sends one, else said again from the fields.
    expect(
      stepAssessment({ ...step, output: { assessment: { ...assessment, line: 'Bug · as sent' } } }),
    ).toEqual({
      line: 'Bug · as sent',
      summary: 'Floors cents.',
      details: '',
      suggests: false,
    });
    expect(stepAssessment({ ...step, output: { assessment } })).toEqual({
      line: 'Bug · high importance · sure · small fix',
      summary: 'Floors cents.',
      details: '',
      suggests: false,
    });
    expect(stepAssessment({ ...step, output: { text: 'Done.' } })).toBeNull();
    const pr = {
      ...step,
      kind: 'open_pull_request' as const,
      prNumber: 215,
      output: {
        opened: true,
        prNumber: 215,
        text: 'PR #215 is open: https://github.com/whombat/web/pull/215',
      },
    };
    expect(stepOutcome(pr, () => '')).toBe('Opened pull request #215.');
    expect(pullRequestUrl(pr)).toBe('https://github.com/whombat/web/pull/215');
    expect(
      pullRequestUrl({ ...pr, output: { opened: false, text: 'the pull request is ready' } }),
    ).toBeNull();
  });
});

describe('the run page in plain words (AP-1002…AP-1004)', () => {
  const step = {
    stepId: 'ask',
    index: 0,
    kind: 'dispatch_agent' as const,
    name: 'Assess it',
    state: 'succeeded' as const,
    attempt: 0,
    startedAt: null as string | null,
    finishedAt: null,
    wakeAt: null,
    inputSummary: '',
    output: {},
    error: null,
    dispatchId: null,
    approvalId: null,
    approvalNumber: null,
    messageIds: [],
    prNumber: null,
    runNumbers: [],
    redacted: false,
  };

  it('keeps an assessment’s technical details, without the parts the server adds for a comment (AP-1002)', () => {
    const assessment = {
      kind: 'not_a_bug',
      importance: 'low',
      confidence: 'medium',
      size: 'small',
      summary: 'Prices leave out VAT for business customers, as they should.',
      fixPlan: '',
      details: '  - `CartTotals.tsx:18–34` shows `priceExVat`.  ',
      duplicateOf: null,
    };
    // 0.68's server sends `heading` and `detailsBlock` too; the line is said again when it sends none.
    const sent = { ...assessment, heading: '**Not a bug**\n\n', detailsBlock: '\n\n<details>…</details>' };
    expect(stepAssessment({ ...step, output: { assessment: sent } })).toEqual({
      line: 'Not a bug · low importance · fairly sure',
      summary: 'Prices leave out VAT for business customers, as they should.',
      details: '- `CartTotals.tsx:18–34` shows `priceExVat`.',
      suggests: false,
    });
    // An assessment from 0.67, without details: nothing to fold.
    const { kind, importance, confidence, size, summary } = assessment;
    const older = { kind, importance, confidence, size, summary };
    expect(stepAssessment({ ...step, output: { assessment: older } })?.details).toBe('');
  });

  it('says when the agent recommends a change, and not for “nothing” or a report from before 0.71 (AP-1053)', () => {
    const assessment = {
      kind: 'bug',
      importance: 'medium',
      confidence: 'high',
      size: 'small',
      summary: 'The Diagnostics view lists the oldest events first, so the latest are hard to find.',
      fixPlan: 'Show the newest events first in a compact list.',
      details: '',
      duplicateOf: null,
      recommends: 'change',
    };
    const suggested = stepAssessment({ ...step, output: { assessment } });
    expect(suggested).toMatchObject({ line: 'Bug · medium importance · sure · small fix', suggests: true });
    expect(SUGGESTS_A_CHANGE).toBe('Suggests a change');
    expect(
      stepAssessment({ ...step, output: { assessment: { ...assessment, recommends: 'nothing' } } })?.suggests,
    ).toBe(false);
    const { recommends: _recommends, ...older } = assessment;
    expect(stepAssessment({ ...step, output: { assessment: older } })?.suggests).toBe(false);
    // The server's line beside the fields doesn't hide it.
    expect(
      stepAssessment({ ...step, output: { assessment: { ...assessment, line: 'Bug · as sent' } } })?.suggests,
    ).toBe(true);
  });

  it('shows a check’s rule whole when the server cut it, from the definition it ran (AP-1054)', () => {
    const rule = `!(steps.ask.assessment.kind == "bug" && ${'steps.ask.assessment.confidence == "high" && '.repeat(8)}run.test == false)`;
    expect(rule.length).toBeGreaterThan(300);
    const cut = `${rule.slice(0, 299)}…`;
    const check = { ...step, stepId: 'needs_yes', kind: 'condition' as const, inputSummary: cut };
    const definition = (ifRule: string) => ({
      steps: [{ id: 'needs_yes', kind: 'condition' as const, if: ifRule }],
    });
    const live = { definition: definition(rule), draft: null } as unknown as Parameters<typeof fullRule>[1];
    expect(fullRule(check, live)).toBe(rule);
    // The draft's when the live one is another rule; what the step says when neither is the same rule.
    const drafted = { definition: definition('true'), draft: definition(rule) } as unknown as Parameters<
      typeof fullRule
    >[1];
    expect(fullRule(check, drafted)).toBe(rule);
    const other = { definition: definition('other'), draft: null } as unknown as Parameters<
      typeof fullRule
    >[1];
    expect(fullRule(check, other)).toBe(cut);
    // A short rule is itself; any other step's input stays as it is.
    expect(fullRule({ ...check, inputSummary: 'true' }, other)).toBe('true');
    expect(fullRule({ ...step, inputSummary: 'Asked Banjo' }, live)).toBe('Asked Banjo');
  });

  it('a request for a yes says what it asks, in the card’s words (AP-1054)', () => {
    const approve = {
      ...step,
      stepId: 'approve',
      kind: 'request_approval' as const,
      output: { title: 'Suggested change for #214: Let us filter invoices by status' },
    };
    expect(approvalAsked(approve)).toBe('Suggested change for #214: Let us filter invoices by status');
    expect(approvalAsked({ ...approve, output: { title: '  ' } })).toBeNull();
    expect(approvalAsked({ ...step, output: { title: 'Not a request' } })).toBeNull();
  });

  it('a recipe’s check says what it decided; without a story it reads as before (AP-1003)', () => {
    const check = {
      ...step,
      stepId: 'worth_fixing',
      kind: 'condition' as const,
      name: 'A bug worth fixing?',
      inputSummary: 'trigger.item == "issue" && steps.ask.assessment.kind == "bug"',
      output: { result: false, story: 'No: Banjo says it’s not a bug.' },
    };
    expect(conditionStory(check)).toBe('No: Banjo says it’s not a bug.');
    expect(conditionStory({ ...check, output: { result: false } })).toBeNull();
    expect(conditionStory({ ...check, output: { result: false, story: '  ' } })).toBeNull();
    expect(stepOutcome({ ...check, output: { result: false } }, () => '')).toBe('No: it stopped here.');
    // Only a condition tells a story.
    expect(conditionStory({ ...step, output: { story: 'No.' } })).toBeNull();
  });

  it('folds the steps a stopped run never reached into one line, and keeps every step that ran (AP-1004)', () => {
    const at = '2026-10-09T09:23:00.000Z';
    const s = (stepId: string, state: 'succeeded' | 'skipped', started = state === 'succeeded') => ({
      ...step,
      stepId,
      state,
      startedAt: started ? at : null,
    });
    const steps = [
      s('ask', 'succeeded'),
      s('worth_fixing', 'succeeded'),
      s('needs_yes', 'skipped'),
      s('approve', 'skipped'),
      s('fix', 'skipped'),
    ];
    const folded = foldSkipped({ status: 'succeeded', steps });
    expect(folded.shown.map((x) => x.stepId)).toEqual(['ask', 'worth_fixing']);
    expect(folded.skipped.map((x) => x.stepId)).toEqual(['needs_yes', 'approve', 'fix']);
    expect(skippedLine(folded.skipped.length)).toBe('3 more steps skipped');
    // Still running: nothing folds yet.
    expect(foldSkipped({ status: 'running', steps }).skipped).toEqual([]);
    // One skipped step says more as itself than as a line.
    expect(foldSkipped({ status: 'succeeded', steps: steps.slice(0, 3) }).skipped).toEqual([]);
    // A step skipped with a reason started (a comment it may not make): it and the steps before it stay.
    const reasoned = [...steps.slice(0, 3), s('comment', 'skipped', true), s('linked', 'skipped')];
    expect(foldSkipped({ status: 'succeeded', steps: reasoned }).skipped).toEqual([]);
    // A skip ahead (`skipTo`) leaves steps that ran after it: none of those fold.
    const ahead = [s('needs_yes', 'succeeded'), s('approve', 'skipped'), s('fix', 'succeeded')];
    expect(foldSkipped({ status: 'succeeded', steps: ahead }).skipped).toEqual([]);
  });
});

describe('the list (AP-1084)', () => {
  it('names the next run today, this week and later', () => {
    const now = new Date('2026-10-10T08:00:00.000Z');
    expect(nextRunWords('2026-10-10T15:00:00.000Z', now, 'Europe/Amsterdam')).toBe('Next run 17:00');
    expect(nextRunWords('2026-10-12T07:00:00.000Z', now, 'Europe/Amsterdam')).toBe('Next run Mon 09:00');
    expect(nextRunWords('2026-11-03T08:00:00.000Z', now, 'Europe/Amsterdam')).toBe('Next run 3 Nov');
  });
});

describe('the overview (Whombat automation-chat.md)', () => {
  it('names the agent in the title’s words and the field', () => {
    const words = overviewWords('Dusty');
    expect(words.subtitle).toContain('Dusty');
    expect(words.intro).toContain('tell Dusty');
    expect(words.placeholderShort).toBe('Tell Dusty…');
    expect(words.placeholder.startsWith('Tell Dusty ')).toBe(true);
  });

  it('lists running and paused schedules, and ended ones only when Resume renews them', () => {
    const s = (
      id: string,
      status: AgentScheduleView['status'],
      endedReason: AgentScheduleView['endedReason'] = null,
    ) => ({ id, status, endedReason }) as AgentScheduleView;
    expect(
      listedSchedules([
        s('a', 'active'),
        s('b', 'paused'),
        s('c', 'ended', 'done'),
        s('d', 'ended', 'expired'),
      ]).map((x) => x.id),
    ).toEqual(['a', 'b', 'd']);
    expect(listedSchedules(undefined)).toEqual([]);
  });
});
