import { DECISION_WAITING } from '@whombat/client';
import { type TrackerFixView, type TrackerItemView, UNKNOWN_TRACKER_WORDS } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { stepOutcome } from './AutomationRunScreen';
import {
  authorLabel,
  fixPullRequestUrl,
  fromTrackerItem,
  nextRequest,
  releaseLine,
  reporterLine,
  reportHeading,
  reportPlace,
  reportTags,
  STATUS_CHOICES,
  trackerDecisionOutcome,
  trackerReplySent,
  updateBody,
  updateDoneText,
  updateProblem,
} from './trackerItem';

const ACME = { product: 'Acme Desk', team: 'Acme team' };

const report: TrackerItemView = {
  connectionId: 'con_tracker',
  connection: 'Acme Desk dev',
  words: ACME,
  reportId: '6f1c2a10-3b4d-4c5e-8f60-71a2b3c4d515',
  number: 15,
  title: 'The rollout never finishes',
  type: 'bug',
  organization: 'HollowMere College',
  environment: 'production',
  status: 'in_progress',
  priority: 'high',
  assessment: 'likely_bug',
  createdAt: '2026-10-10T08:52:00.000Z',
  reporter: { name: 'Anna de Vries', email: 'a.devries@hollowmere.example' },
  description: 'Eleven of twelve devices updated.',
  expected: '',
  screenshot: null,
  messages: [],
  release: null,
  fix: null,
};

describe('a run’s tracker report', () => {
  it('reads as its number and title, where it comes from, and its tags', () => {
    expect(reportHeading(report)).toBe('#15 · The rollout never finishes');
    expect(reportPlace(report)).toBe('Acme Desk dev · HollowMere College · Production');
    expect(reportPlace({ ...report, organization: null, environment: 'development' })).toBe(
      'Acme Desk dev · Development',
    );
    expect(reportPlace({ ...report, organization: null, environment: null })).toBe('Acme Desk dev');
    expect(reportTags(report)).toEqual(['Bug report', 'In progress', 'High priority', 'Likely bug']);
    expect(
      reportTags({ ...report, type: 'feature', status: 'on_hold', priority: null, assessment: null }),
    ).toEqual(['Feature request', 'On hold']);
  });

  it('names the reporter as the tracker has them, and who wrote in the conversation, in its words', () => {
    expect(reporterLine(report.reporter)).toBe('Anna de Vries · a.devries@hollowmere.example');
    expect(reporterLine({ name: null, email: 'a@b.example' })).toBe('a@b.example');
    expect(reporterLine({ name: ' ', email: null })).toBe('Not given');
    expect(authorLabel('reporter', ACME)).toBe('The reporter');
    expect(authorLabel('team', ACME)).toBe('Acme team');
    expect(authorLabel('team', { product: 'Beacon Helpdesk', team: 'Beacon support' })).toBe(
      'Beacon support',
    );
    expect(authorLabel('team', UNKNOWN_TRACKER_WORDS)).toBe('The team');
    expect(releaseLine({ component: 'console', version: '0.1.132', evidence: '' })).toBe(
      'Released in console 0.1.132.',
    );
  });

  it('shows on runs a tracker’s report started', () => {
    const trigger = { summary: '', actorId: null, eventId: null, messageId: null, scheduledFor: null };
    expect(fromTrackerItem({ trigger: { ...trigger, kind: 'tracker' } })).toBe(true);
    expect(fromTrackerItem({ trigger: { ...trigger, kind: 'github' } })).toBe(false);
  });
});

describe('sending to the reporter (AP-1025)', () => {
  it('offers the statuses a person sets, in the tracker vocabulary’s words', () => {
    expect(STATUS_CHOICES.map((c) => c.label)).toEqual([
      'Investigating',
      'Needs information',
      'Planned',
      'In progress',
      'Fixed, waiting for a release',
      'Closed',
      'Not planned',
    ]);
  });

  it('needs a reply to reply, a status to set one, and a reply when it isn’t planned', () => {
    expect(updateProblem({ mode: 'reply', message: '  ', status: '' }, 'new')).toBe('Write a reply.');
    expect(updateProblem({ mode: 'reply', message: 'Thanks!', status: 'planned' }, 'new')).toBeNull();
    expect(updateProblem({ mode: 'status', message: '', status: '' }, 'new')).toBe('Choose a status.');
    expect(updateProblem({ mode: 'status', message: '', status: 'not_planned' }, 'new')).toBe(
      'Tell the reporter why when it isn’t planned: write a reply.',
    );
    expect(updateProblem({ mode: 'status', message: '', status: 'in_progress' }, 'in_progress')).toBe(
      'It’s In progress already.',
    );
    expect(
      updateProblem({ mode: 'status', message: 'Update: …', status: 'in_progress' }, 'in_progress'),
    ).toBeNull();
    expect(updateProblem({ mode: 'reply', message: 'x'.repeat(8001), status: '' }, 'new')).toBe(
      'A reply is at most 8,000 characters.',
    );
  });

  it('sends the reply trimmed and the status when chosen, and says what happened', () => {
    const both = updateBody({ mode: 'reply', message: ' Thanks, we’re on it. ', status: 'investigating' });
    expect(both).toEqual({ message: 'Thanks, we’re on it.', status: 'investigating' });
    expect(updateDoneText(both)).toBe('Sent to the reporter, and set to Investigating.');
    expect(updateDoneText(updateBody({ mode: 'reply', message: 'Hi', status: '' }))).toBe(
      'Sent to the reporter.',
    );
    expect(updateDoneText(updateBody({ mode: 'status', message: '', status: 'closed' }))).toBe(
      'Set to Closed.',
    );
  });

  it('reuses the request id for the same words, and makes a new one when they change', () => {
    let n = 0;
    const make = () => `id-${++n}`;
    const first = nextRequest(null, { message: 'Hi' }, make);
    expect(first.id).toBe('id-1');
    // A lost answer, sent again: the tracker replays id-1 and emails once.
    expect(nextRequest(first, { message: 'Hi' }, make)).toBe(first);
    const changed = nextRequest(first, { message: 'Hi', status: 'planned' }, make);
    expect(changed.id).toBe('id-2');
    // After a success the page forgets it: the same words again are a new message.
    expect(nextRequest(null, { message: 'Hi' }, make).id).toBe('id-3');
  });
});

describe('the write-back step (AP-1026)', () => {
  it('is the step’s outcome line on the run page', () => {
    const step = {
      stepId: 'write_back',
      kind: 'tracker_update' as const,
      index: 1,
      name: 'Write back to Acme Desk',
      state: 'succeeded' as const,
      attempt: 0,
      startedAt: null,
      finishedAt: null,
      wakeAt: null,
      inputSummary: '',
      output: {
        wrote: true,
        connection: 'Acme Desk dev',
        number: 15,
        assessment: 'duplicate',
        priority: null,
      },
      error: null,
      dispatchId: null,
      approvalId: null,
      approvalNumber: null,
      messageIds: [],
      prNumber: null,
      runNumbers: [],
      redacted: false,
    };
    expect(stepOutcome(step, (id) => id)).toBe('Wrote to Acme Desk dev #15: Duplicate.');
    // An output without its connection's name says the tracker's.
    const bare = { ...step, output: { wrote: true, number: 15 } };
    expect(stepOutcome(bare, (id) => id, [], { product: 'Beacon Helpdesk', team: 'Beacon support' })).toBe(
      'Wrote to Beacon Helpdesk #15.',
    );
  });

  it('says nothing about a step of a kind this version doesn’t know', () => {
    const step = {
      stepId: 'old',
      kind: 'unknown' as const,
      index: 0,
      name: '',
      state: 'succeeded' as const,
      attempt: 0,
      startedAt: null,
      finishedAt: null,
      wakeAt: null,
      inputSummary: '',
      output: { wrote: true },
      error: null,
      dispatchId: null,
      approvalId: null,
      approvalNumber: null,
      messageIds: [],
      prNumber: null,
      runNumbers: [],
    };
    expect(stepOutcome(step, (id) => id)).toBeNull();
  });
});

describe('replying to the customer (0.75, AP-1110)', () => {
  const signed = 'Thanks for letting us know.\n\nBanjo - AI Developer';

  it('shows what the customer got, signature included, only once it went', () => {
    expect(trackerReplySent({ sent: true, message: signed })).toBe(signed);
    expect(trackerReplySent({ sent: true, message: '  ' })).toBeNull();
    expect(trackerReplySent({ sent: false, reason: 'No.', message: signed })).toBeNull();
    expect(trackerReplySent({ sent: true })).toBeNull();
  });

  it('is the step’s outcome line on the run page', () => {
    const step = {
      stepId: 'reply',
      kind: 'tracker_reply' as const,
      index: 2,
      name: 'Reply to the customer',
      state: 'succeeded' as const,
      attempt: 0,
      startedAt: null,
      finishedAt: null,
      wakeAt: null,
      inputSummary: '',
      output: {
        sent: true,
        connection: 'Acme Desk dev',
        number: 17,
        message: signed,
        status: 'investigating',
      },
      error: null,
      dispatchId: null,
      approvalId: null,
      approvalNumber: null,
      messageIds: [],
      prNumber: null,
      runNumbers: [],
      redacted: false,
    };
    expect(stepOutcome(step, (id) => id)).toBe(
      'Replied to the customer and set Acme Desk dev #17 to “Investigating”.',
    );
  });
});

describe('a feature request put to the person (3.12)', () => {
  const step = (over: { state: 'waiting' | 'succeeded' | 'skipped' | 'pending'; inputSummary: string }) => ({
    stepId: 'decide',
    kind: 'tracker_decision' as const,
    index: 2,
    name: 'Ask you about a feature request',
    attempt: 0,
    startedAt: null,
    finishedAt: null,
    wakeAt: null,
    output: {},
    error: null,
    dispatchId: null,
    approvalId: null,
    approvalNumber: null,
    messageIds: [],
    prNumber: null,
    runNumbers: [],
    redacted: false,
    ...over,
  });

  it('says what was decided, as the server wrote it, once', () => {
    expect(trackerDecisionOutcome({ state: 'succeeded', inputSummary: 'Approved by John · Planned' })).toBe(
      'Approved by John · Planned.',
    );
    // The person's words end in their own quote: no stop after it.
    const declined = 'Declined by John · “It only helps one customer.”';
    expect(trackerDecisionOutcome({ state: 'succeeded', inputSummary: declined })).toBe(declined);
    expect(trackerDecisionOutcome({ state: 'skipped', inputSummary: 'Not a feature request.' })).toBe(
      'Not a feature request.',
    );
    expect(trackerDecisionOutcome({ state: 'pending', inputSummary: '' })).toBeNull();
  });

  it('says where to answer while it waits', () => {
    const said = trackerDecisionOutcome({
      state: 'waiting',
      inputSummary: 'Asked you about feature request #21',
    });
    expect(said?.startsWith('Asked you about feature request #21.')).toBe(true);
    expect(said?.endsWith(DECISION_WAITING)).toBe(true);
  });

  it('is the step’s outcome line on the run page', () => {
    expect(
      stepOutcome(
        step({ state: 'skipped', inputSummary: 'A newer assessment of this report replaced it.' }),
        (id) => id,
      ),
    ).toBe('A newer assessment of this report replaced it.');
    expect(
      stepOutcome(step({ state: 'succeeded', inputSummary: 'Approved by Mara · Being built' }), (id) => id),
    ).toBe('Approved by Mara · Being built.');
  });
});

describe('where the report’s fix is (0.75, AP-1111)', () => {
  const fix: TrackerFixView = {
    state: 'open',
    repo: 'whombat/web',
    prNumber: 52,
    prUrl: 'https://github.com/whombat/web/pull/52',
    mergedAt: null,
    development: null,
    production: null,
    note: null,
  };
  it('links the pull request only to an https address', () => {
    expect(fixPullRequestUrl(fix)).toBe('https://github.com/whombat/web/pull/52');
    expect(fixPullRequestUrl({ prUrl: null })).toBeNull();
    expect(fixPullRequestUrl({ prUrl: 'javascript:alert(1)' })).toBeNull();
  });
});
