import { describe, expect, it } from 'vitest';
import { FeedbackOutcome } from '../domain/index.js';
import {
  FEEDBACK_REPORTER_ID_PATTERN,
  FEEDBACK_REPORTER_STATUSES,
  FEEDBACK_REPORTER_SUMMARY_MAX,
  FEEDBACK_REPORTER_TOKEN_PATTERN,
  newReporterCode,
  newReporterId,
  newReporterToken,
  normalizeReporterEmail,
  REPORTER_STATUS_COPY,
  REPORTER_TYPE_COPY,
  reporterCodeEmail,
  reporterCodeMac,
  reporterDigestEqual,
  reporterEmailDigest,
  reporterStatusOf,
  reporterSummaryOf,
  reporterTokenFrom,
  reporterTokenHash,
} from './reporters.js';

const SITE = 'fbs_Q3v9xLpA0dZkT7mW2bNcYe12';

describe('reporterStatusOf (CT-163)', () => {
  it.each([
    ['resolved', null, null, 'fixed'],
    ['resolved', 'done', 'needs_information', 'fixed'],
    ['closed', 'running', null, 'closed'],
    ['in_progress', 'done', 'confirmed_bug', 'in_progress'],
    ['triaged', 'queued', null, 'confirmed'],
    ['triaged', 'done', 'needs_information', 'confirmed'],
    ['new', 'running', null, 'reviewing'],
    ['new', 'running', 'needs_information', 'reviewing'],
    ['new', 'done', 'needs_information', 'needs_info'],
    ['new', 'done', 'insufficient_evidence', 'needs_info'],
    ['new', 'done', 'confirmed_bug', 'confirmed'],
    ['new', 'done', 'likely_bug', 'confirmed'],
    ['new', 'done', 'duplicate', 'confirmed'],
    ['new', 'done', 'feature_request', 'confirmed'],
    ['new', 'done', 'configuration_or_support', 'reviewing'],
    ['new', 'failed', 'likely_bug', 'confirmed'],
    ['new', 'queued', null, 'received'],
    ['new', 'not_configured', null, 'received'],
    ['new', 'paused', null, 'received'],
    ['new', 'blocked', null, 'received'],
    ['new', 'failed', null, 'received'],
    ['new', null, null, 'received'],
    ['archived', 'done', 'confirmed_bug', 'received'],
  ] as const)('%s / %s / %s → %s', (status, assessmentState, assessmentOutcome, expected) => {
    expect(reporterStatusOf({ status, assessmentState, assessmentOutcome })).toBe(expected);
  });

  it('maps every outcome to a status', () => {
    for (const outcome of FeedbackOutcome.options)
      expect(FEEDBACK_REPORTER_STATUSES).toContain(
        reporterStatusOf({ status: 'new', assessmentState: 'done', assessmentOutcome: outcome }),
      );
  });

  it('has copy for every status and type', () => {
    for (const type of ['bug', 'feature'] as const)
      for (const status of FEEDBACK_REPORTER_STATUSES)
        expect(REPORTER_STATUS_COPY[type][status]).toMatch(/^[A-Z]/);
    expect(REPORTER_STATUS_COPY.bug).toEqual({
      received: 'Received',
      reviewing: 'Being looked at',
      needs_info: 'Needs more information',
      confirmed: 'Confirmed',
      in_progress: 'In progress',
      fixed: 'Fixed',
      closed: 'Closed',
    });
    expect(REPORTER_STATUS_COPY.feature.confirmed).toBe('Noted');
    expect(REPORTER_STATUS_COPY.feature.fixed).toBe('Done');
    expect(REPORTER_TYPE_COPY).toEqual({ bug: 'Problem', feature: 'Idea' });
  });
});

describe('reporter email, digest and code', () => {
  it('normalizes addresses', () => {
    expect(normalizeReporterEmail('  Sanne@Visser-Advies.Example ')).toBe('sanne@visser-advies.example');
  });

  it('digests site + normalized email (vector)', () => {
    const digest = '2d59d9c037930488db3c5d57661b1e3a1b828d7907a877be35a87d3cf3277e6b';
    expect(reporterEmailDigest(SITE, 'sanne@visser-advies.example')).toBe(digest);
    expect(reporterEmailDigest(SITE, ' Sanne@VISSER-advies.example')).toBe(digest);
    expect(reporterEmailDigest('fbs_Q3v9xLpA0dZkT7mW2bNcYe13', 'sanne@visser-advies.example')).not.toBe(
      digest,
    );
  });

  it('keys stored codes (vector)', () => {
    const key = Uint8Array.from({ length: 32 }, (_, i) => i);
    const mac = '4a1a6e00124a717302b6b1cd097669d07cf184a083276d5f207938bf814bfd6a';
    expect(reporterCodeMac(key, SITE, 'Sanne@visser-advies.example', '042917')).toBe(mac);
    expect(reporterCodeMac(key, SITE, 'sanne@visser-advies.example', '042918')).not.toBe(mac);
    expect(reporterDigestEqual(mac, mac)).toBe(true);
    expect(reporterDigestEqual(mac, `${mac.slice(0, -1)}b`)).toBe(false);
    expect(reporterDigestEqual(mac, mac.slice(1))).toBe(false);
  });

  it('makes codes, tokens and ids of the right shape', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const code = newReporterCode();
      expect(code).toMatch(/^[0-9]{6}$/);
      codes.add(code);
    }
    expect(codes.size).toBeGreaterThan(190);
    const token = newReporterToken();
    expect(token).toMatch(FEEDBACK_REPORTER_TOKEN_PATTERN);
    expect(newReporterToken()).not.toBe(token);
    expect(newReporterId()).toMatch(FEEDBACK_REPORTER_ID_PATTERN);
    expect(reporterTokenHash(`fbrs_${'A'.repeat(43)}`)).toBe(
      'a3ecc4769ab7f215b93d2585a8ddf125173801fe19979a83d9888854a37cd033',
    );
  });

  it('reads the bearer token', () => {
    const token = `fbrs_${'a'.repeat(43)}`;
    expect(reporterTokenFrom(`Bearer ${token}`)).toBe(token);
    expect(reporterTokenFrom(`bearer ${token}`)).toBe(token);
    expect(reporterTokenFrom(`Basic ${token}`)).toBeNull();
    expect(reporterTokenFrom(`Bearer ${token}x`)).toBeNull();
    expect(reporterTokenFrom('Bearer tok_abc')).toBeNull();
    expect(reporterTokenFrom('')).toBeNull();
    expect(reporterTokenFrom(undefined)).toBeNull();
  });

  it('writes the code email', () => {
    expect(
      reporterCodeEmail({ code: '042917', productLabel: 'Lumio', parent: 'https://app.lumio.example:8443' }),
    ).toEqual({
      subject: '042917 is your code for Lumio feedback',
      text: 'Enter this code in the feedback window on app.lumio.example:8443 to follow your reports:\n\n042917\n\nIt works once, for 10 minutes. If you didn’t ask for it, you can ignore this email — nobody can sign in without the code.',
    });
  });
});

describe('reporterSummaryOf', () => {
  it('collapses whitespace and cuts at 140 characters', () => {
    expect(reporterSummaryOf('  The invoice\n\ntotal is  wrong ')).toBe('The invoice total is wrong');
    const long = reporterSummaryOf('word '.repeat(60));
    expect(long.length).toBeLessThanOrEqual(FEEDBACK_REPORTER_SUMMARY_MAX);
    expect(long.endsWith('…')).toBe(true);
    const exact = 'x'.repeat(FEEDBACK_REPORTER_SUMMARY_MAX);
    expect(reporterSummaryOf(exact)).toBe(exact);
  });

  it('never splits a surrogate pair', () => {
    const s = reporterSummaryOf(`${'x'.repeat(FEEDBACK_REPORTER_SUMMARY_MAX - 2)}😀😀`);
    expect(s.length).toBeLessThanOrEqual(FEEDBACK_REPORTER_SUMMARY_MAX);
    expect(s.endsWith('x…')).toBe(true);
  });
});
