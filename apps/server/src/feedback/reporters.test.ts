/**
 * Pure parts of the navigation trail and reporter sign-in (docs/decisions/feedback-reporters.md): the trail's
 * structure cap and sanitizing, the public config's switches, the answer's lifted trail, control's attestation, and
 * the reporter's status of a report row.
 */
import { FeedbackContext, FeedbackIntegrationSettings, FeedbackSubmission } from '@whombat/core';
import { newReporterId, reporterEmailDigest } from '@whombat/core/feedback/reporters';
import { describe, expect, it } from 'vitest';
import { SITE_ORIGIN, submission } from '../test/feedback';
import { attestedReporter } from './drop/receive';
import { normalizeSubmission, normalizeTrail } from './intake';
import { splitTrail } from './read';
import { reporterStatusOfRow, reporterUpdatedAt } from './reporters';
import { checkStructure } from './structure';
import { publicConfigOf } from './submission';
import { reporterSignInOn, trailOn } from './switches';

const settings = FeedbackIntegrationSettings.parse({
  name: 'Lumio',
  productLabel: 'Lumio',
  allowedOrigins: [SITE_ORIGIN],
  channelId: 'cnv_billing-v2',
  agentId: null,
  repoId: null,
  reportTypes: ['bug', 'feature'],
  redactPaths: ['/customers/*'],
});

const step = (url: string, title: string | null = null) => ({ url, title, at: '2026-09-30T10:00:00.000Z' });

describe('switches (FR-03)', () => {
  it('default to on, also for settings stored before contracts 0.25', () => {
    expect(settings).toMatchObject({ trail: 'on', reporterSignIn: 'on' });
    expect(trailOn({})).toBe(true);
    expect(reporterSignInOn({})).toBe(true);
    expect(trailOn({ trail: 'off' })).toBe(false);
    expect(reporterSignInOn({ reporterSignIn: 'off' })).toBe(false);
  });

  it('the public config offers sign-in only with mail', () => {
    expect(publicConfigOf(settings, { mail: true })).toMatchObject({ trail: true, reporters: true });
    expect(publicConfigOf(settings, { mail: false })).toMatchObject({ trail: true, reporters: false });
    const off = { ...settings, trail: 'off' as const, reporterSignIn: 'off' as const };
    expect(publicConfigOf(off, { mail: true })).toMatchObject({ trail: false, reporters: false });
  });
});

describe('the trail (FR-04)', () => {
  it('is capped at 10 before the schema', () => {
    const ten = { context: { trail: Array.from({ length: 10 }, (_, i) => step(`${SITE_ORIGIN}/${i}`)) } };
    expect(checkStructure(ten)).toBeNull();
    const eleven = { context: { trail: Array.from({ length: 11 }, (_, i) => step(`${SITE_ORIGIN}/${i}`)) } };
    expect(checkStructure(eleven)).toBe('context.trail');
  });

  it('each step is sanitized again with redactPaths; non-http steps go; off drops it', () => {
    const trail = [
      step(`${SITE_ORIGIN}/customers/acme?x=1#y`, '  Acme\u0000 '),
      step('data:text/html,hi'),
      step(`${SITE_ORIGIN}/login/Xk9fQ2mZpL7tR4wB`),
    ];
    expect(normalizeTrail(trail, settings)).toEqual([
      step(`${SITE_ORIGIN}/customers/:id`, 'Acme'),
      step(`${SITE_ORIGIN}/login/:id`),
    ]);
    expect(normalizeTrail(trail, { ...settings, trail: 'off' })).toBeUndefined();
    // Pages on other origins than the integration's are never kept (FR-18).
    expect(
      normalizeTrail([step('https://elsewhere.example/account'), step(`${SITE_ORIGIN}/ok`)], settings),
    ).toEqual([step(`${SITE_ORIGIN}/ok`)]);
    expect(normalizeTrail([step('javascript:void(0)')], settings)).toBeUndefined();
    expect(normalizeTrail([], settings)).toBeUndefined();
  });

  it('is part of the normalized context and so of the payload hash', () => {
    const sub = FeedbackSubmission.parse(
      submission({ context: { ...submission().context, trail: [step(`${SITE_ORIGIN}/a`)] } }),
    );
    expect(normalizeSubmission(sub, settings).context.trail).toEqual([step(`${SITE_ORIGIN}/a`)]);
    const without = FeedbackSubmission.parse(submission());
    expect(normalizeSubmission(without, settings).context).not.toHaveProperty('trail');
  });

  it('a report answer carries it beside the context, never inside', () => {
    const stored = FeedbackContext.parse({ trail: [step(`${SITE_ORIGIN}/a`)] });
    const { context, trail } = splitTrail(stored);
    expect(trail).toEqual([step(`${SITE_ORIGIN}/a`)]);
    expect(context).not.toHaveProperty('trail');
    expect(splitTrail(null).trail).toEqual([]);
  });
});

describe('a signed-in reporter’s address (FR-08, FR-09)', () => {
  it('replaces the submission’s, even with the email field off', () => {
    const sub = FeedbackSubmission.parse(submission({ reporter: { name: 'Ada', email: 'x@example.com' } }));
    const offEmail = { ...settings, contactFields: { name: 'optional' as const, email: 'off' as const } };
    expect(normalizeSubmission(sub, offEmail).reporterEmail).toBeNull();
    expect(normalizeSubmission(sub, offEmail, { verifiedEmail: 'ada@example.com' }).reporterEmail).toBe(
      'ada@example.com',
    );
  });

  it('control’s attestation counts only for the same site, address and a site that offers sign-in', () => {
    const site = 'fbs_AAAAAAAAAAAAAAAAAAAAAAAA';
    const id = newReporterId();
    const reporter = { id, emailDigest: reporterEmailDigest(site, 'ada@example.com') };
    const row = { settings };
    expect(attestedReporter({ site, reporter }, row, ' Ada@Example.com')).toEqual({
      id,
      email: 'ada@example.com',
    });
    expect(attestedReporter({ site, reporter }, row, 'bea@example.com')).toBeNull();
    expect(
      attestedReporter({ site: 'fbs_BBBBBBBBBBBBBBBBBBBBBBBB', reporter }, row, 'ada@example.com'),
    ).toBeNull();
    expect(attestedReporter({ site }, row, 'ada@example.com')).toBeNull();
    expect(attestedReporter({ site, reporter }, row, '')).toBeNull();
    expect(
      attestedReporter(
        { site, reporter },
        { settings: { ...settings, reporterSignIn: 'off' } },
        'ada@example.com',
      ),
    ).toBeNull();
  });
});

describe('the reporter’s status of a report', () => {
  it('follows the person’s status, else the assessment', () => {
    const at = (status: string, assessmentState: string, outcome: string | null = null) =>
      reporterStatusOfRow({
        status,
        assessmentState,
        assessment: outcome ? ({ outcome } as never) : null,
      });
    expect(at('new', 'queued')).toBe('received');
    expect(at('new', 'running')).toBe('reviewing');
    expect(at('new', 'done', 'needs_information')).toBe('needs_info');
    expect(at('new', 'done', 'likely_bug')).toBe('confirmed');
    expect(at('triaged', 'done')).toBe('confirmed');
    expect(at('in_progress', 'done')).toBe('in_progress');
    expect(at('resolved', 'done')).toBe('fixed');
    expect(at('closed', 'queued')).toBe('closed');
  });

  it('changed when the report or its assessment last did', () => {
    const a = new Date('2026-09-30T10:00:00Z');
    const b = new Date('2026-09-30T11:00:00Z');
    expect(reporterUpdatedAt({ updatedAt: a, assessmentUpdatedAt: b })).toBe(b);
    expect(reporterUpdatedAt({ updatedAt: b, assessmentUpdatedAt: a })).toBe(b);
  });
});
