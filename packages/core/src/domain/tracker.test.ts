/** A run's tracker report and what is written back to it (0.69, CT-325; Whombat report-trackers.md TA-11…TA-15). */
import { describe, expect, it } from 'vitest';
import { unassessed } from '../automations/recipes.js';
import { AutomationAssessment } from './automation.js';
import {
  customerReplyProblem,
  namesOrganization,
  TRACKER_STATUS_LABELS,
  TrackerItemView,
  TrackerUpdateStatus,
  trackerNothingToWriteText,
  trackerStatusLabel,
  trackerWriteLine,
  trackerWriteOf,
  withoutOrganization,
} from './tracker.js';

const assessed = (over: Partial<AutomationAssessment>) =>
  AutomationAssessment.parse({
    kind: 'bug',
    importance: 'high',
    confidence: 'high',
    size: 'small',
    summary: 'The rollout never finishes.',
    ...over,
  });

describe('writing an assessment back (TA-11, TA-12)', () => {
  it('maps the kind to the tracker’s assessment and the importance to its priority, for bugs and features', () => {
    expect(trackerWriteOf(assessed({}))).toEqual({ write: { assessment: 'likely_bug', priority: 'high' } });
    expect(trackerWriteOf(assessed({ importance: 'critical' }))).toEqual({
      write: { assessment: 'likely_bug', priority: 'urgent' },
    });
    expect(trackerWriteOf(assessed({ kind: 'feature', importance: 'medium' }))).toEqual({
      write: { assessment: 'feature_request', priority: 'normal' },
    });
    expect(trackerWriteOf(assessed({ kind: 'question', importance: 'low' }))).toEqual({
      write: { assessment: 'needs_information', priority: null },
    });
    expect(trackerWriteOf(assessed({ kind: 'unclear', confidence: 'medium' }))).toEqual({
      write: { assessment: 'needs_information', priority: null },
    });
    expect(trackerWriteOf(assessed({ kind: 'duplicate', duplicateOf: 12 }))).toEqual({
      write: { assessment: 'duplicate', priority: null },
    });
  });

  it('writes nothing for not a bug, or when nothing was assessed, and says so', () => {
    expect(trackerWriteOf(assessed({ kind: 'not_a_bug' }))).toEqual({ skip: 'not_a_bug' });
    expect(trackerWriteOf(unassessed())).toEqual({ skip: 'not_assessed' });
    expect(trackerNothingToWriteText('not_a_bug', 'Banjo')).toBe(
      'Nothing to write: Banjo says it’s not a bug.',
    );
    expect(trackerNothingToWriteText('not_assessed', 'Banjo')).toBe(
      'Nothing to write: Banjo didn’t assess it.',
    );
  });

  it('asks a person about exactly what it writes', () => {
    expect(trackerWriteLine('Acme Desk dev', 15, { assessment: 'likely_bug', priority: 'high' })).toBe(
      'Acme Desk dev #15: Likely bug · high priority',
    );
    expect(trackerWriteLine('Acme Desk dev', 15, { assessment: 'needs_information', priority: null })).toBe(
      'Acme Desk dev #15: Needs information',
    );
  });
});

describe('the report people read and answer (TA-14, TA-15)', () => {
  it('offers people only the statuses Whombat may set, and names every status the tracker has', () => {
    expect(TrackerUpdateStatus.options).toEqual([
      'investigating',
      'needs_information',
      'planned',
      'in_progress',
      'awaiting_release',
      'closed',
      'not_planned',
    ]);
    for (const never of ['available', 'new', 'confirmed', 'duplicate'])
      expect(TrackerUpdateStatus.safeParse(never).success, never).toBe(false);
    for (const status of TrackerUpdateStatus.options)
      expect(TRACKER_STATUS_LABELS[status], status).toBeTruthy();
    expect(trackerStatusLabel('awaiting_release')).toBe('Fixed, waiting for a release');
    expect(trackerStatusLabel('on_hold')).toBe('On hold');
  });

  it('reads a report with its reporter, screenshot and conversation', () => {
    const report = TrackerItemView.parse({
      connectionId: 'con_trackerdev',
      connection: 'Acme Desk dev',
      reportId: '0190f3c2-7b1e-7c3a-9f00-123456789abc',
      number: 15,
      title: 'The rollout never finishes',
      type: 'bug',
      organization: 'HollowMere College',
      environment: 'production',
      status: 'new',
      priority: null,
      assessment: null,
      createdAt: '2026-10-10T08:00:00.000Z',
      reporter: { name: 'Sam', email: 'sam@hollowmere.example' },
      description: 'It stops at 80%.',
      expected: 'It finishes.',
      screenshot: null,
      messages: [{ author: 'reporter', body: 'Still stuck.', at: '2026-10-10T09:00:00.000Z' }],
      release: null,
    });
    expect(report.messages[0]?.author).toBe('reporter');
    expect(TrackerItemView.safeParse({ ...report, reportId: 'report 15' }).success).toBe(false);
  });
});

describe('a fix’s pull request never names the organization (TA-18)', () => {
  it('puts “the customer’s organization” in its place, whatever the case', () => {
    expect(
      withoutOrganization('I checked HollowMere College’s data in Acme Desk.', 'HollowMere College'),
    ).toBe('I checked the customer’s organization’s data in Acme Desk.');
    expect(withoutOrganization('hollowmere college (2 devices)', 'HollowMere College')).not.toMatch(
      /hollowmere/i,
    );
    expect(withoutOrganization('Acme (NL) c?', 'Acme (NL)')).toBe('the customer’s organization c?');
    expect(withoutOrganization('Nothing to hide.', null)).toBe('Nothing to hide.');
    // Only as a whole word: not inside another word or a name like DEMO-01; a short name is left alone.
    expect(withoutOrganization('Fixed DEMO-01 and the Demos page for Demo.', 'Demo')).toBe(
      'Fixed DEMO-01 and the Demos page for the customer’s organization.',
    );
    expect(withoutOrganization('Each commit for IT stays.', 'IT')).toBe('Each commit for IT stays.');
    // The first word of a longer name is its short form when no ordinary word could be it, in any case.
    expect(
      withoutOrganization(
        'HollowMere’s device, Hollowmere-based staff, a hollow mere.',
        'HollowMere College',
      ),
    ).toBe('the customer’s organization’s device, the customer’s organization-based staff, a hollow mere.');
    expect(withoutOrganization('The Device page of Device Partners BV.', 'Device Partners BV')).toBe(
      'The Device page of the customer’s organization.',
    );
  });
});

describe('a reply that names another customer waits for a person (TA-28)', () => {
  it('looks at every place the name appears, not only the first', () => {
    expect(customerReplyProblem('Demographic data from Demo shows it.', { organizations: ['Demo'] })).toMatch(
      /Demo/,
    );
    expect(customerReplyProblem('Demographic data shows it.', { organizations: ['Demo'] })).toBeNull();
    // Its short form too, when no ordinary word could be it.
    expect(
      customerReplyProblem('We saw this at HollowMere too.', { organizations: ['HollowMere College'] }),
    ).toMatch(/HollowMere College/);
    expect(
      customerReplyProblem('The Device page works.', { organizations: ['Device Partners BV'] }),
    ).toBeNull();
  });

  it('a pull request’s commits name the organization as the scrub would take it', () => {
    expect(namesOrganization('Fix export for HollowMere College', 'HollowMere College')).toBe(true);
    expect(namesOrganization('Fix export for every school', 'HollowMere College')).toBe(false);
  });
});
