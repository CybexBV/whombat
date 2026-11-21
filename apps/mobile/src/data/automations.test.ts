import { ApiError, automationOverview, DECISION_WAITING } from '@whombat/client';
import {
  type AgentScheduleView,
  type Automation,
  type AutomationAssessment,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationRunStep,
  assessmentLine,
  assessmentMarkdown,
} from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_DELETE_TEXT,
  AUTOMATION_LIST_TEXT,
  automationGone,
  canDeleteAutomation,
  conditionStory,
  onlyTellsYouRows,
  runActive,
  runSteps,
  runStepsView,
  SUGGESTS_A_CHANGE,
  stepAssessment,
  stepOutcome,
  TECHNICAL_DETAILS,
  waitingLine,
} from './automations';

const _automation = (over: Partial<Automation> = {}): Automation => ({
  id: 'aut_1',
  burrowId: 'bur_burrow-hq',
  name: 'Suspected bug',
  description: '',
  status: 'published',
  currentVersion: 1,
  draft: null,
  draftJson: null,
  draftProblems: [],
  draftHash: null,
  definition: null,
  principalId: 'prn_auto',
  createdById: 'prn_mara',
  createdAt: '2026-09-24T08:00:00.000Z',
  updatedAt: '2026-09-24T08:00:00.000Z',
  publishedById: 'prn_mara',
  triggerSummary: 'Message in #billing-v2',
  summary: '',
  deletedAt: null,
  grants: [],
  webhook: { enabled: false, hasSecret: false, path: '/webhooks/automations/aut_1' },
  nextRunAt: null,
  lastRun: null,
  recentRuns: [],
  glance: null,
  waitingPlanId: null,
  talk: null,
  ...over,
});

describe('run steps', () => {
  const run = {
    status: 'waiting',
    steps: [
      {
        stepId: 'check',
        name: 'Check',
        state: 'succeeded',
        output: { text: 'ACTIONABLE: 2' },
        error: null,
        inputSummary: 'Asked Neo',
        approvalNumber: null,
      },
      {
        stepId: 'approve',
        name: 'Approve',
        state: 'waiting',
        output: {},
        error: null,
        inputSummary: 'Asked a person',
        approvalNumber: 13,
      },
      {
        stepId: 'post',
        name: 'Post',
        state: 'pending',
        output: {},
        error: null,
        inputSummary: '',
        approvalNumber: null,
      },
      {
        stepId: 'elsewhere',
        name: 'Ask in #incidents',
        state: 'succeeded',
        output: {},
        error: null,
        inputSummary: '',
        approvalNumber: null,
      },
    ],
  } as unknown as AutomationRun;

  it('open the approval screen from a step waiting for a person', () => {
    const steps = runSteps(run);
    expect(steps.map((s) => [s.state, s.body])).toEqual([
      ['done', 'ACTIONABLE: 2'],
      ['waiting', 'Asked a person'],
      ['not yet', null],
      ['done', null],
    ]);
    expect(steps[1]).toMatchObject({ approvalNumber: 13, approvalOpen: true });
    // Coding work and reviews say what came of them.
    const coding = {
      ...run,
      steps: [
        { ...run.steps[0], output: { text: 'Fixed.', commits: 1, workspace: { branch: 'feat/bug-3' } } },
        { ...run.steps[0], output: { text: 'Changes needed: no test.', verdict: 'changes_needed' } },
      ],
    } as AutomationRun;
    expect(runSteps(coding).map((s) => s.body)).toEqual([
      '1 new commit on feat/bug-3.',
      'Verdict: Changes needed.',
    ]);
    expect(runActive('waiting')).toBe(true);
    expect(runActive('succeeded')).toBe(false);
  });
});

describe('a merge once its checks pass (AP-1048)', () => {
  const merge = (over: Record<string, unknown>) =>
    ({
      stepId: 'merge',
      kind: 'merge_pull_request',
      name: 'Merge the fix',
      state: 'waiting',
      output: {},
      error: null,
      inputSummary: 'Waiting for checks on PR #10',
      approvalNumber: null,
      ...over,
    }) as unknown as AutomationRunStep;
  const run = (steps: AutomationRunStep[]) => ({ status: 'waiting', steps }) as unknown as AutomationRun;

  it('reads as any step: what it waits for, what it did, or why it left the pull request', () => {
    const [waiting, merged, failed] = runSteps(
      run([
        merge({}),
        merge({
          state: 'succeeded',
          output: { merged: true, prNumber: 10, text: 'Merged PR #10 into main.' },
        }),
        merge({ state: 'failed', error: 'Checks failed on PR #10, so I left it for you.' }),
      ]),
    );
    expect(waiting).toMatchObject({
      title: 'Merge the fix',
      state: 'waiting',
      body: 'Waiting for checks on PR #10',
    });
    expect(merged).toMatchObject({ state: 'done', body: 'Merged PR #10 into main.' });
    expect(merged?.accessibilityLabel).toBe('Merge the fix, done. Merged PR #10 into main.');
    expect(failed).toMatchObject({ error: 'Checks failed on PR #10, so I left it for you.' });
    expect(failed?.accessibilityLabel).toContain('Checks failed on PR #10, so I left it for you.');
    expect(stepOutcome(merge({}), {})).toBeNull();
  });
});

describe('a run in plain words (AP-1010…AP-1014)', () => {
  const _step = (over: Partial<AutomationRunStep> = {}): AutomationRunStep => ({
    stepId: 'ask',
    index: 0,
    kind: 'dispatch_agent',
    name: 'Assess',
    state: 'succeeded',
    attempt: 0,
    startedAt: '2026-10-09T09:00:00.000Z',
    finishedAt: '2026-10-09T09:04:00.000Z',
    wakeAt: null,
    inputSummary: 'Asked Banjo',
    output: {},
    error: null,
    dispatchId: null,
    approvalId: null,
    approvalNumber: null,
    messageIds: [],
    prNumber: null,
    runNumbers: [],
    ...over,
  });
  const _run = (steps: AutomationRunStep[], status: AutomationRun['status'] = 'succeeded') =>
    ({ number: 7, status, steps }) as unknown as AutomationRun;
  // Banjo's assessment of a Fusebox issue, as the server keeps it: the fields, its line and a comment's parts (CT-324).
  const notABug: AutomationAssessment = {
    kind: 'not_a_bug',
    importance: 'low',
    confidence: 'medium',
    size: 'small',
    summary:
      'The fuse trips because the limit in the reporter’s own settings is too low, not because of Fusebox.',
    fixPlan: '',
    title: '',
    details: '- `src/limits.rs:40-58` reads the limit as configured.\n- Checked with `cargo test --locked`.',
    duplicateOf: null,
    reply: '',
    replyAsks: false,
    language: '',
    value: null,
    valueWhy: '',
    approvedReply: '',
    declineReason: '',
    declinedReply: '',
  };
  const reported = (a: AutomationAssessment) => ({ ...a, line: assessmentLine(a), ...assessmentMarkdown(a) });
  const ask = _step({
    output: { text: 'I’m using the assess skill.\n\nThis isn’t a bug.', assessment: reported(notABug) },
  });

  it('shows an assessment as tags and its plain sentence, with the technical details folded', () => {
    const [step] = runSteps(_run([ask]));
    expect(step?.assessment).toEqual({
      line: 'Not a bug · low importance · fairly sure',
      tags: ['Not a bug', 'low importance', 'fairly sure'],
      summary: notABug.summary,
      details: notABug.details,
      suggests: false,
    });
    expect(TECHNICAL_DETAILS).toBe('Technical details');
    // TalkBack hears the step, its state and the assessment, never the dots.
    expect(step?.accessibilityLabel).toBe(
      `Assess, done. Assessment: Not a bug, low importance, fairly sure. ${notABug.summary}`,
    );
  });

  it('says the line again from the fields for an older Whombat, and opens nothing without details', () => {
    const bug: AutomationAssessment = {
      ...notABug,
      kind: 'bug',
      importance: 'high',
      confidence: 'high',
      details: '',
    };
    expect(stepAssessment(_step({ output: { assessment: { ...bug } } }))).toEqual({
      line: 'Bug · high importance · sure · small fix',
      tags: ['Bug', 'high importance', 'sure', 'small fix'],
      summary: bug.summary,
      details: null,
      suggests: false,
    });
    // A turn that reported nothing: said so, not hidden.
    expect(
      stepAssessment(
        _step({
          output: {
            assessment: {
              kind: 'unclear',
              importance: 'low',
              confidence: 'low',
              size: 'large',
              summary: 'No assessment was reported.',
              line: 'Not assessed',
            },
          },
        }),
      ),
    ).toMatchObject({ tags: ['Not assessed'], summary: 'No assessment was reported.', details: null });
  });

  it('says when the agent recommends a change (AP-1057), and TalkBack hears it after the line', () => {
    const suggestion: AutomationAssessment = {
      ...notABug,
      kind: 'bug',
      importance: 'medium',
      confidence: 'high',
      fixPlan: 'Show the newest events first in a compact list.',
      recommends: 'change',
    };
    const [step] = runSteps(_run([_step({ output: { assessment: reported(suggestion) } })]));
    expect(step?.assessment).toMatchObject({
      tags: ['Bug', 'medium importance', 'sure', 'small fix'],
      suggests: true,
    });
    expect(SUGGESTS_A_CHANGE).toBe('Suggests a change');
    expect(step?.accessibilityLabel).toBe(
      `Assess, done. Assessment: Bug, medium importance, sure, small fix, suggests a change. ${suggestion.summary}`,
    );
    // “nothing”, and a report from before 0.71 (no `recommends`): no tag.
    const nothing = { ...suggestion, recommends: 'nothing' as const };
    expect(stepAssessment(_step({ output: { assessment: reported(nothing) } }))?.suggests).toBe(false);
    expect(stepAssessment(_step({ output: { assessment: reported(notABug) } }))?.suggests).toBe(false);
  });

  it('a request for a yes says what it asks while it waits, in the card’s words (AP-1057)', () => {
    const title = 'Suggested change for #214: Let us filter invoices by status';
    const waiting = _step({
      stepId: 'approve',
      kind: 'request_approval',
      name: 'Approve it',
      state: 'waiting',
      inputSummary: 'Asked a person to approve (request #32)',
      approvalNumber: 32,
      output: { title },
    });
    const [step] = runSteps(_run([waiting], 'waiting'));
    expect(step).toMatchObject({ body: title, approvalOpen: true });
    const decided = { ...waiting, state: 'succeeded' as const, output: { title, decision: 'approved' } };
    expect(runSteps(_run([decided]))[0]?.body).toBe('Approved.');
  });

  it('leaves steps without an assessment as they were', () => {
    expect(stepAssessment(_step({ output: { text: 'Done.' } }))).toBeNull();
    expect(stepAssessment(_step({ output: { assessment: { kind: 'nonsense' } } }))).toBeNull();
    expect(
      stepAssessment(_step({ kind: 'post_message', output: { assessment: reported(notABug) } })),
    ).toBeNull();
    const [plain] = runSteps(_run([_step({ output: { text: 'ACTIONABLE: 2' } })]));
    expect(plain).toMatchObject({ body: 'ACTIONABLE: 2', bodyLines: 2, assessment: null });
    expect(plain?.accessibilityLabel).toBe('Assess, done. ACTIONABLE: 2.');
  });

  it('tells a recipe’s check as its story, whole, and never shows a condition’s expression', () => {
    const check = (output: AutomationRunStep['output'], over: Partial<AutomationRunStep> = {}) =>
      _step({
        stepId: 'worth_fixing',
        kind: 'condition',
        name: 'A bug worth fixing?',
        inputSummary: 'trigger.item == "issue" && steps.ask.assessment.kind == "bug"',
        output,
        ...over,
      });
    const [story, older, notYet] = runSteps(
      _run([
        check({ result: false, story: 'No: Banjo says it’s not a bug.' }),
        check({ result: false }),
        check({}, { state: 'pending', startedAt: null }),
      ]),
    );
    expect(story).toMatchObject({ body: 'No: Banjo says it’s not a bug.', bodyLines: 0 });
    expect(story?.accessibilityLabel).toBe('A bug worth fixing?, done. No: Banjo says it’s not a bug.');
    expect(older).toMatchObject({ body: 'False: it stopped here.', bodyLines: 2 });
    expect(notYet?.body).toBeNull();
    expect(
      conditionStory(
        check({
          result: true,
          story: 'Yes, a person decides: Banjo isn’t sure enough and someone is assigned to it.',
        }),
      ),
    ).toBe('Yes, a person decides: Banjo isn’t sure enough and someone is assigned to it.');
    expect(conditionStory(_step({ output: { story: 'Not a check.' } }))).toBeNull();
  });

  it('says what a comment and a pull request did instead of their URLs, as the web does', () => {
    const steps = runSteps(
      _run([
        _step({
          stepId: 'comment',
          kind: 'github_comment',
          name: 'Comment on GitHub',
          output: {
            number: 12,
            commentUrl: 'https://github.com/lumio/fusebox/issues/12#issuecomment-1',
            text: 'Commented on lumio/fusebox#12: https://github.com/lumio/fusebox/issues/12#issuecomment-1',
          },
        }),
        _step({
          stepId: 'linked',
          kind: 'github_comment',
          name: 'Say so on the issue',
          state: 'skipped',
          inputSummary: 'This automation may not comment on GitHub.',
          output: { reason: 'This automation may not comment on GitHub.' },
        }),
        _step({
          stepId: 'pr',
          kind: 'open_pull_request',
          name: 'Open the pull request',
          output: {
            opened: true,
            prNumber: 215,
            text: 'PR #215 is open: https://github.com/lumio/fusebox/pull/215',
          },
        }),
      ]),
    );
    expect(steps.map((s) => s.body)).toEqual([
      'Commented on #12.',
      'This automation may not comment on GitHub.',
      'Opened pull request #215.',
    ]);
  });

  describe('what a write to the tracker did (report-trackers.md TA-11)', () => {
    const write = (output: AutomationRunStep['output'], over: Partial<AutomationRunStep> = {}) =>
      _step({
        stepId: 'write_back',
        kind: 'tracker_update',
        name: 'Write back to Acme Desk',
        inputSummary: 'Banjo’s assessment of Acme Desk dev #15',
        output,
        ...over,
      });
    const said = (output: AutomationRunStep['output']) => stepOutcome(write(output), output);

    it('says what it wrote, in the tracker’s words, never the raw text', () => {
      const output = {
        wrote: true,
        connection: 'Acme Desk dev',
        number: 15,
        assessment: 'likely_bug',
        priority: 'high',
        text: 'PATCH /api/reports/0f9c… assessment=likely_bug priority=high',
      };
      expect(said(output)).toBe('Wrote to Acme Desk dev #15: Likely bug · high priority.');
      const [step] = runSteps(_run([write(output)]));
      expect(step?.body).toBe('Wrote to Acme Desk dev #15: Likely bug · high priority.');
      expect(step?.accessibilityLabel).toBe(
        'Write back to Acme Desk, done. Wrote to Acme Desk dev #15: Likely bug · high priority.',
      );
    });

    it('leaves out a priority it didn’t write, and says the tracker without the connection’s name', () => {
      expect(
        said({
          wrote: true,
          connection: 'Acme Desk dev',
          number: 15,
          assessment: 'needs_information',
          priority: null,
        }),
      ).toBe('Wrote to Acme Desk dev #15: Needs information.');
      const unnamed = { wrote: true, number: 9, assessment: 'feature_request', priority: 'low' };
      expect(said(unnamed)).toBe('Wrote to the tracker #9: Feature request · low priority.');
      // The tracker's words the automation keeps, any tracker's.
      const words = { product: 'Beacon Helpdesk', team: 'Beacon support' };
      expect(stepOutcome(write(unnamed), unnamed, words)).toBe(
        'Wrote to Beacon Helpdesk #9: Feature request · low priority.',
      );
      expect(runSteps(_run([write(unnamed)]), words)[0]?.body).toContain('Beacon Helpdesk #9');
      expect(
        said({ wrote: true, connection: 'Acme Desk dev', number: 15, assessment: null, priority: null }),
      ).toBe('Wrote to Acme Desk dev #15.');
    });

    it('says why it wrote nothing', () => {
      const output = {
        wrote: false,
        reason: 'Nothing to write: Banjo says it’s not a bug.',
        text: 'skipped',
      };
      expect(said(output)).toBe('Nothing to write: Banjo says it’s not a bug.');
      expect(runSteps(_run([write(output, { state: 'skipped' })]))[0]?.body).toBe(
        'Nothing to write: Banjo says it’s not a bug.',
      );
    });

    it('says nothing of an output it doesn’t know, and shows what it was asked instead of its text', () => {
      expect(said({})).toBeNull();
      expect(said({ wrote: false })).toBeNull();
      expect(said({ text: 'Wrote it.' })).toBeNull();
      // The web's rule for what's half there: a reason alone, a write without its number, values a tracker doesn't take.
      expect(said({ reason: 'This automation may not update Acme Desk reports.' })).toBe(
        'This automation may not update Acme Desk reports.',
      );
      expect(said({ wrote: true, connection: 'Acme Desk dev' })).toBe('Wrote to Acme Desk dev.');
      expect(
        said({
          wrote: true,
          connection: 'Acme Desk dev',
          number: 15,
          assessment: 'reproduced',
          priority: 'p1',
        }),
      ).toBe('Wrote to Acme Desk dev #15.');
      expect(runSteps(_run([write({ text: 'Wrote it.' })]))[0]?.body).toBe(
        'Banjo’s assessment of Acme Desk dev #15',
      );
      // Other steps keep their own outcome.
      expect(stepOutcome(_step({ kind: 'dispatch_agent' }), { wrote: true, number: 15 })).toBeNull();
    });
  });

  describe('what a reply to the customer did (0.75)', () => {
    const signed = 'Thanks for letting us know.\n\nBanjo - AI Developer';
    const reply = (output: AutomationRunStep['output'], over: Partial<AutomationRunStep> = {}) =>
      _step({
        stepId: 'reply',
        kind: 'tracker_reply',
        name: 'Reply to the customer',
        inputSummary: 'On Acme Desk dev #16',
        output,
        ...over,
      });
    const said = (output: AutomationRunStep['output']) => stepOutcome(reply(output), output);

    it('says it replied and the status it set, in the tracker’s words, never the message itself', () => {
      const output = {
        sent: true,
        connection: 'Acme Desk dev',
        number: 16,
        message: signed,
        status: 'needs_information',
        text: signed,
      };
      expect(said(output)).toBe('Replied to the customer and set Acme Desk dev #16 to “Needs information”.');
      const [step] = runSteps(_run([reply(output)]));
      expect(step?.body).toBe('Replied to the customer and set Acme Desk dev #16 to “Needs information”.');
      expect(step?.accessibilityLabel).toBe(
        'Reply to the customer, done. Replied to the customer and set Acme Desk dev #16 to “Needs information”.',
      );
      expect(said({ ...output, status: null })).toBe('Replied to the customer on Acme Desk dev #16.');
      expect(said({ sent: true })).toBe('Replied to the customer on the tracker.');
    });

    it('says why it sent nothing, and nothing of an output it doesn’t know', () => {
      const output = { sent: false, reason: 'Nothing to send: Banjo had nothing to tell the customer.' };
      expect(said(output)).toBe('Nothing to send: Banjo had nothing to tell the customer.');
      expect(runSteps(_run([reply(output, { state: 'skipped' })]))[0]?.body).toBe(
        'Nothing to send: Banjo had nothing to tell the customer.',
      );
      expect(said({})).toBeNull();
      expect(said({ sent: false })).toBeNull();
      expect(runSteps(_run([reply({ text: signed })]))[0]?.body).toBe('On Acme Desk dev #16');
    });
  });

  describe('a feature request’s decision and the reply that tells it (3.12)', () => {
    const decide = (over: Partial<AutomationRunStep>) =>
      _step({ stepId: 'decide', kind: 'tracker_decision', name: 'Ask you about a feature request', ...over });

    it('says where the decision is in the server’s words, never its drafts', () => {
      const waiting = decide({
        state: 'waiting',
        inputSummary: 'Asked you about feature request #21',
        output: { requestId: 'tfr_21', decided: false },
      });
      const done = decide({
        inputSummary: 'Approved by John · Planned',
        output: {
          decided: true,
          choice: 'approve',
          status: 'planned',
          message: 'We’re going to build this.',
          text: 'raw',
        },
      });
      const replaced = decide({
        state: 'skipped',
        inputSummary: 'A newer assessment of this report replaced it.',
        output: { decided: false, reason: 'A newer assessment of this report replaced it.' },
      });
      const [w, d, r] = runSteps(_run([waiting, done, replaced], 'waiting'));
      // While it waits, also where to answer.
      expect(w?.state).toBe('waiting');
      expect(w?.body).toContain('feature request #21');
      expect(w?.body).toContain(DECISION_WAITING);
      expect(d?.body).toBe('Approved by John · Planned.');
      expect(d?.accessibilityLabel).not.toContain('build this');
      expect(r).toMatchObject({ state: 'skipped', body: 'A newer assessment of this report replaced it.' });
      // An older row without a summary still says why it skipped.
      expect(stepOutcome(decide({ inputSummary: '' }), { reason: 'Not a feature request.' })).toBe(
        'Not a feature request.',
      );
      expect(stepOutcome(decide({ inputSummary: '' }), {})).toBeNull();
    });

    it('reads the status the decision set in the tracker vocabulary’s words', () => {
      const reply = (status: string) =>
        stepOutcome(_step({ kind: 'tracker_reply' }), {
          sent: true,
          connection: 'Acme Desk dev',
          number: 21,
          status,
        });
      expect(reply('planned')).toContain('“Planned”');
      expect(reply('in_progress')).toContain('“In progress”');
      expect(reply('not_planned')).toContain('“Not planned”');
      expect(reply('planned')).toContain('Acme Desk dev #21');
    });
  });

  it('names a step of a kind this version doesn’t know as an earlier step', () => {
    const [older] = runSteps(
      _run([_step({ stepId: 'older', kind: 'unknown', name: '', output: { wrote: true } })]),
    );
    expect(older?.title).toBe('An earlier step');
    expect(older?.accessibilityLabel).toMatch(/^An earlier step, /);
    // A name the server kept stays.
    expect(runSteps(_run([_step({ kind: 'unknown', name: 'Check the build' })]))[0]?.title).toBe(
      'Check the build',
    );
  });

  describe('a finished run’s skipped last steps', () => {
    const unreached = (stepId: string) =>
      _step({
        stepId,
        name: stepId,
        kind: 'dispatch_agent',
        state: 'skipped',
        startedAt: null,
        finishedAt: null,
      });
    const stopped = [
      ask,
      _step({ stepId: 'comment', kind: 'github_comment', name: 'Comment on GitHub', output: { number: 12 } }),
      _step({
        stepId: 'worth_fixing',
        kind: 'condition',
        name: 'A bug worth fixing?',
        output: { result: false, story: 'No: Banjo says it’s not a bug.' },
      }),
      ...['needs_yes', 'approve', 'fix', 'review', 'approved', 'pr', 'pr_open', 'linked'].map(unreached),
    ];

    it('fold into one row that opens them', () => {
      const view = runStepsView(_run(stopped));
      expect(view.steps.map((s) => s.key)).toEqual(['ask', 'comment', 'worth_fixing']);
      expect(view.skipped?.label).toBe('8 more steps skipped');
      expect(view.skipped?.steps.map((s) => [s.key, s.state])).toEqual(
        ['needs_yes', 'approve', 'fix', 'review', 'approved', 'pr', 'pr_open', 'linked'].map((k) => [
          k,
          'skipped',
        ]),
      );
    });

    it('stay as they are while the run goes on, when only one was skipped, or when the last one started', () => {
      expect(runStepsView(_run(stopped, 'running')).skipped).toBeNull();
      expect(runStepsView(_run(stopped.slice(0, 4))).skipped).toBeNull();
      expect(runStepsView(_run(stopped.slice(0, 4))).steps).toHaveLength(4);
      // Skipped with its own reason (it started): what it says stays in sight.
      const ownReason = _step({
        stepId: 'linked',
        kind: 'github_comment',
        name: 'Say so on the issue',
        state: 'skipped',
        output: { reason: 'This automation may not comment on GitHub.' },
      });
      expect(runStepsView(_run([...stopped.slice(0, -1), ownReason])).skipped).toBeNull();
    });

    it('say “steps skipped” when no step ran before them', () => {
      const view = runStepsView(_run([unreached('a'), unreached('b')], 'skipped'));
      expect(view.steps).toEqual([]);
      expect(view.skipped?.label).toBe('2 steps skipped');
    });
  });
});

describe('Delete, and the agent’s schedules (AP-980…AP-983; automation-chat-mobile.md)', () => {
  const now = new Date('2026-10-28T09:00:00.000Z');
  const zone = 'Europe/Amsterdam';

  it('lets you delete, never the agent (AP-5736)', () => {
    expect(canDeleteAutomation({ id: 'prn_mara', kind: 'person' })).toBe(true);
    expect(canDeleteAutomation({ id: 'prn_banjo', kind: 'agent' })).toBe(false);
  });

  it('asks before deleting, in the web’s words', () => {
    expect(AUTOMATION_DELETE_TEXT.confirmTitle('Suspected bug')).toBe('Delete “Suspected bug”?');
    expect(AUTOMATION_DELETE_TEXT.confirmBody).toBe(
      'It stops now, and runs in progress stop too. Its past runs stay in the audit log.',
    );
  });

  it('knows an automation is gone from the frame or a 404', () => {
    expect(automationGone({ automation: { deletedAt: null } }, null)).toBe(false);
    expect(automationGone({ automation: { deletedAt: '2026-09-24T08:30:00.000Z' } }, null)).toBe(true);
    expect(
      automationGone(undefined, new ApiError(404, 'not_found', 'Not found', {}, 'automations.get')),
    ).toBe(true);
    expect(
      automationGone(undefined, new ApiError(403, 'forbidden', 'Not yours', {}, 'automations.delete')),
    ).toBe(false);
  });

  it('says which run waits for a person, newest first', () => {
    const run = (number: number, status: AutomationRunStatus, waitingOn: 'approval' | 'review' | null) => ({
      number,
      status,
      waitingOn,
    });
    const waiting = [
      run(3, 'running', null),
      run(2, 'waiting', 'approval'),
      run(1, 'needs_review', 'review'),
    ];
    expect(waitingLine(waiting)).toEqual({
      number: 2,
      text: 'Run #2 is waiting for a yes.',
      accessibilityLabel: 'Run #2 is waiting for a yes. Open.',
    });
    expect(waitingLine(waiting.slice(2))?.text).toBe('Run #1 needs you to look at it.');
    // Waiting for an agent, checks or time is no one's to answer.
    expect(waitingLine([run(1, 'waiting', null)])).toBeNull();
  });

  it('lists the agent’s schedules that still run as rows that only tell you', () => {
    const schedule = (o: Partial<AgentScheduleView>): AgentScheduleView => ({
      id: 'sch_brief',
      agentId: 'prn_dusty' as AgentScheduleView['agentId'],
      conversationId: 'cnv_chat' as AgentScheduleView['conversationId'],
      threadRootId: null,
      prompt: 'Tell me what’s on my calendar and in my mail.',
      when: { kind: 'cron', expr: '0 8 * * 1-5', zone },
      status: 'active',
      endedReason: null,
      nextAt: '2026-10-29T07:00:00.000Z',
      endsAt: null,
      runs: 5,
      lastRunAt: null,
      createdAt: '2026-10-20T07:00:00.000Z',
      ...o,
    });
    const rows = onlyTellsYouRows(
      [
        schedule({}),
        schedule({ id: 'sch_paused', status: 'paused', nextAt: null }),
        schedule({ id: 'sch_done', status: 'ended', endedReason: 'cancelled' }),
      ],
      'Dusty',
      zone,
      now,
    );
    expect(rows.map((r) => r.id)).toEqual(['sch_brief', 'sch_paused']);
    expect(rows[0]?.next?.value).toContain('08:00');
    expect(rows[0]?.actions).toEqual(['pause', 'remove']);
    expect(rows[0]?.accessibilityLabel).toContain('Only tells you');
    expect(rows[1]?.next).toBeNull();
    expect(rows[1]?.actions).toEqual(['resume', 'remove']);
    expect(AUTOMATION_LIST_TEXT.intro('Dusty')).toContain('Dusty');
    expect(AUTOMATION_LIST_TEXT.tellIntro('Dusty')).toContain('tell Dusty');
    expect(AUTOMATION_LIST_TEXT.tellShort('Dusty')).toBe('Tell Dusty…');
  });

  it('a schedules read that failed shows its notice with Try again, never the empty list', () => {
    const ended = {
      id: 'sch_done',
      agentId: 'prn_dusty' as AgentScheduleView['agentId'],
      conversationId: 'cnv_chat' as AgentScheduleView['conversationId'],
      threadRootId: null,
      prompt: 'Tell me what’s on my calendar.',
      when: { kind: 'cron', expr: '0 8 * * 1-5', zone },
      status: 'ended',
      endedReason: 'cancelled',
      nextAt: null,
      endsAt: null,
      runs: 5,
      lastRunAt: null,
      createdAt: '2026-10-20T07:00:00.000Z',
    } as AgentScheduleView;
    // As the phone's screen reads them: no automations, and the schedules' rows (the ended one isn't listed).
    const told = onlyTellsYouRows([ended], 'Dusty', zone, now);
    const automations = { pending: false, failed: false, count: 0 };
    expect(automationOverview(automations, { pending: false, failed: false, count: told.length }).body).toBe(
      'empty',
    );
    // The read failed: the notice, not “No automations yet”.
    expect(automationOverview(automations, { pending: false, failed: true, count: null })).toEqual({
      body: 'list',
      schedules: 'failed',
    });
    // Try again worked: the rows, or nothing yet.
    expect(automationOverview(automations, { pending: false, failed: false, count: 2 }).schedules).toBe(
      'rows',
    );
  });
});
