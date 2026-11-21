import { describe, expect, it } from 'vitest';
import { FEEDBACK_PUBLIC_PATHS, feedbackEndpoints } from '../contracts/feedback.js';
import {
  FEEDBACK_PUBLIC_ERROR_STATUS,
  FEEDBACK_PUBLIC_MESSAGES,
  FEEDBACK_REMOVED_TEXT,
  FEEDBACK_TRAIL_MAX,
  FeedbackAssessment,
  FeedbackContext,
  FeedbackIntegrationSettings,
  FeedbackPublicConfig,
  FeedbackPublicErrorCode,
  FeedbackReport,
  FeedbackReporterCodeRequest,
  FeedbackReporterOk,
  FeedbackReporterReport,
  FeedbackReporterReports,
  FeedbackReporterSession,
  FeedbackReporterSessionRequest,
  FeedbackReporterStatus,
  FeedbackReporterToken,
  FeedbackSubmission,
  FeedbackTrailStep,
  redactedAssessment,
} from '../domain/index.js';
import {
  coarseBrowser,
  looksLikeId,
  normalizeOrigin,
  originAllowed,
  sanitizeCustomContext,
  sanitizePageUrl,
  sanitizeReferences,
  validRedactPath,
  WIDGET_ATTRIBUTES,
} from './index.js';

describe('normalizeOrigin', () => {
  it.each([
    ['https://app.example.com', 'https://app.example.com'],
    ['https://App.Example.com/', 'https://app.example.com'],
    ['https://app.example.com:443', 'https://app.example.com'],
    ['https://app.example.com:8443', 'https://app.example.com:8443'],
    ['http://localhost:5173', 'http://localhost:5173'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
    ['http://lumio.localhost:3000', 'http://lumio.localhost:3000'],
  ])('accepts %s', (input, out) => expect(normalizeOrigin(input)).toBe(out));

  it.each([
    'http://app.example.com',
    'https://*.example.com',
    'https://app.example.com/path',
    'https://user:pw@app.example.com',
    'https://app.example.com?x=1',
    'https://app.example.com#x',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'null',
    '',
    'app.example.com',
    'data:text/html,hi',
  ])('rejects %s', (input) => expect(normalizeOrigin(input)).toBeNull());

  it('matches exact origins only', () => {
    const allowed = ['https://app.example.com'];
    expect(originAllowed('https://app.example.com', allowed)).toBe(true);
    expect(originAllowed('https://app.example.com.evil.com', allowed)).toBe(false);
    expect(originAllowed('https://evil.app.example.com', allowed)).toBe(false);
    expect(originAllowed('http://app.example.com', allowed)).toBe(false);
    expect(originAllowed('https://app.example.com:444', allowed)).toBe(false);
    expect(originAllowed('null', allowed)).toBe(false);
    expect(originAllowed('https://APP.example.com', allowed)).toBe(false);
    expect(originAllowed(undefined, allowed)).toBe(false);
  });
});

describe('sanitizePageUrl', () => {
  it('redacts id-like segments', () => {
    expect(
      sanitizePageUrl(
        'https://a.com/orgs/3f2c1a9e-5b7d-4c1e-9a0b-1c2d3e4f5a6b/devices/1234567/logs/abcdef0123456789ab',
      ),
    ).toBe('https://a.com/orgs/:id/devices/:id/logs/:id');
    expect(sanitizePageUrl('https://a.com/users/jane%40example.com')).toBe('https://a.com/users/:id');
    expect(sanitizePageUrl('https://a.com/s/eyJhbGciOiJIUzI1NiJ9abc123')).toBe('https://a.com/s/:id');
  });
  it('redacts shorter tokens too: magic links, nanoids, base64url (R1-9)', () => {
    expect(sanitizePageUrl('https://a.com/magic-login/Xk9fQ2mZpL7tR4wB')).toBe(
      'https://a.com/magic-login/:id',
    );
    expect(sanitizePageUrl('https://a.com/invite/aB3dE5gH7jK9/accept')).toBe(
      'https://a.com/invite/:id/accept',
    );
    expect(sanitizePageUrl('https://a.com/r/V1StGXR8_Z5jdHi6B-myT')).toBe('https://a.com/r/:id');
    expect(sanitizePageUrl('https://a.com/s/XkfQmZpLtRwBabcdEF')).toBe('https://a.com/s/:id');
    expect(sanitizePageUrl('https://a.com/invoices/INV-2026-000123')).toBe('https://a.com/invoices/:id');
  });
  it.each([
    'billing-v2',
    'MyAccountSettings',
    'release-notes-2026-v10',
    'report_2026-09.pdf',
    'abcdefghijklmnopqrstu',
  ])('keeps the word or slug %s', (segment) => {
    expect(looksLikeId(segment)).toBe(false);
    expect(sanitizePageUrl(`https://a.com/x/${segment}`)).toBe(`https://a.com/x/${segment}`);
  });
  it.each([
    'Xk9fQ2mZpL7tR4wB',
    'aB3dE5gH7jK9',
    'eyJhbGciOiJIUzI1NiJ9',
    'V1StGXR8_Z5jdHi6B-myT',
    'deadbeef1234',
    'user-8f3k2j9d0s1a',
  ])('redacts the token %s', (segment) => {
    expect(looksLikeId(segment)).toBe(true);
  });
  it('applies redact templates', () => {
    expect(sanitizePageUrl('https://a.com/customers/acme/invoices/march', ['/customers/*/invoices/*'])).toBe(
      'https://a.com/customers/:id/invoices/:id',
    );
    expect(sanitizePageUrl('https://a.com/customers/acme', ['/customers/*'])).toBe(
      'https://a.com/customers/:id',
    );
    expect(sanitizePageUrl('https://a.com/team/acme', ['/customers/*'])).toBe('https://a.com/team/acme');
  });
  it('refuses non-http URLs', () => {
    expect(sanitizePageUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizePageUrl('not a url')).toBeNull();
  });
  it('validates templates', () => {
    expect(validRedactPath('/customers/*')).toBe(true);
    expect(validRedactPath('customers/*')).toBe(false);
    expect(validRedactPath('/a/(.*)+')).toBe(false);
    expect(validRedactPath('/')).toBe(false);
  });
});

describe('context helpers', () => {
  it('reduces a user agent to browser and OS', () => {
    expect(
      coarseBrowser(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome 131 · macOS');
    expect(coarseBrowser('Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0')).toBe(
      'Firefox 133 · Linux',
    );
  });
  it('keeps only allowlisted scalar custom context', () => {
    expect(
      sanitizeCustomContext(
        { plan: 'pro', seats: 12, beta: true, token: 'x', nested: { a: 1 }, list: [1], 'bad key': 1 },
        ['plan', 'seats', 'beta', 'nested', 'list'],
      ),
    ).toEqual({ plan: 'pro', seats: 12, beta: true });
    expect(sanitizeCustomContext('nope', ['a'])).toEqual({});
  });
  it('keeps short printable references', () => {
    expect(sanitizeReferences(['req_123', 'a b', 42, 'x'.repeat(200), 'e-9f31', '1', '2', '3', '4'])).toEqual(
      ['req_123', 'e-9f31', '1', '2', '3'],
    );
  });
});

describe('schemas', () => {
  const settings = {
    name: 'Lumio',
    productLabel: 'Lumio',
    allowedOrigins: ['https://app.lumio.example', 'http://localhost:5173'],
    repoId: null,
    reportTypes: ['bug', 'feature'],
  };
  it('canonicalizes origins and fills defaults', () => {
    const parsed = FeedbackIntegrationSettings.parse({
      ...settings,
      allowedOrigins: ['https://App.Lumio.example/'],
    });
    expect(parsed.allowedOrigins).toEqual(['https://app.lumio.example']);
    expect(parsed.limits.maxAttachments).toBe(3);
    expect(parsed.launcher).toBe('floating');
    expect(parsed.handoff).toBe('off');
    expect(FeedbackIntegrationSettings.parse({ ...settings, handoff: 'on' }).handoff).toBe('on');
    expect(FeedbackIntegrationSettings.safeParse({ ...settings, handoff: true }).success).toBe(false);
  });
  it('refuses wildcard origins', () => {
    expect(
      FeedbackIntegrationSettings.safeParse({ ...settings, allowedOrigins: ['https://*.lumio.example'] })
        .success,
    ).toBe(false);
  });
  it('rejects routing fields in a submission', () => {
    const base = {
      submissionId: 'abcdefghijklmnopqrstuv',
      parentOrigin: 'https://app.lumio.example',
      type: 'bug',
      description: 'It broke',
    };
    expect(FeedbackSubmission.safeParse(base).success).toBe(true);
    for (const extra of [
      { channelId: 'cnv_x' },
      { agentId: 'prn_x' },
      { burrowId: 'bur_x' },
      { approved: true },
    ])
      expect(FeedbackSubmission.safeParse({ ...base, ...extra }).success).toBe(false);
    expect(FeedbackSubmission.safeParse({ ...base, context: { cookies: 'a=b' } }).success).toBe(false);
  });
  it('requires observed evidence for a confirmed bug', () => {
    const a = {
      outcome: 'confirmed_bug',
      summary: 'Rounding error',
      confidence: 'high',
      reproduction: { status: 'not_attempted' },
      revision: { inspected: 'abc123' },
      severity: { level: 'medium' },
      evidence: [{ kind: 'file', ref: 'src/a.ts:1', hypothesis: true }],
    };
    expect(FeedbackAssessment.safeParse(a).success).toBe(false);
    expect(
      FeedbackAssessment.safeParse({
        ...a,
        evidence: [{ kind: 'file', ref: 'src/a.ts:1', hypothesis: false }],
      }).success,
    ).toBe(true);
    expect(FeedbackAssessment.safeParse({ ...a, outcome: 'duplicate' }).success).toBe(false);
  });
});

describe('redactedAssessment (FB-F3-11)', () => {
  it('keeps the outcome and levels, removes every word, and stays a valid assessment', () => {
    const a = FeedbackAssessment.parse({
      outcome: 'confirmed_bug',
      summary: 'Order 4411 of visitor@example.com is wrong.',
      confidence: 'high',
      uncertainty: 'The visitor said so.',
      reproduction: { status: 'reproduced', notes: 'Ran it with order 4411.' },
      evidence: [{ kind: 'test', ref: 'order 4411 test', note: 'visitor@example.com', hypothesis: false }],
      revision: { inspected: 'main', reported: '1.4.2', mismatch: 'the visitor’s build' },
      severity: { level: 'high', rationale: 'Visible to visitor@example.com.' },
      missingInformation: ['Their address'],
      nextAction: 'Fix order 4411.',
      duplicateOf: null,
      feature: { goal: 'x', existingBehavior: 'y', workarounds: 'z', scope: 'w', tradeoffs: 'v' },
    });
    const r = redactedAssessment(a);
    expect(FeedbackAssessment.parse(r)).toEqual(r);
    expect(r).toMatchObject({
      outcome: 'confirmed_bug',
      confidence: 'high',
      summary: FEEDBACK_REMOVED_TEXT,
      reproduction: { status: 'reproduced', notes: FEEDBACK_REMOVED_TEXT },
      severity: { level: 'high', rationale: '' },
      evidence: [{ kind: 'test', ref: FEEDBACK_REMOVED_TEXT, note: '', hypothesis: false }],
      missingInformation: [],
    });
    expect(JSON.stringify(r)).not.toMatch(/4411|visitor|main|1\.4\.2/);
  });
});

describe('navigation trail and reporter sign-in (0.25, CT-161, CT-162)', () => {
  const settings = {
    name: 'Lumio',
    productLabel: 'Lumio',
    allowedOrigins: ['https://app.lumio.example'],
    repoId: null,
    reportTypes: ['bug'],
  };
  const step = {
    url: 'https://app.lumio.example/invoices/:id',
    title: 'Invoice',
    at: '2026-09-30T08:01:00Z',
  };

  it('turns both on by default, so stored settings without them parse', () => {
    const parsed = FeedbackIntegrationSettings.parse(settings);
    expect(parsed.trail).toBe('on');
    expect(parsed.reporterSignIn).toBe('on');
    const off = FeedbackIntegrationSettings.parse({ ...settings, trail: 'off', reporterSignIn: 'off' });
    expect([off.trail, off.reporterSignIn]).toEqual(['off', 'off']);
    expect(FeedbackIntegrationSettings.safeParse({ ...settings, trail: true }).success).toBe(false);
    const update = feedbackEndpoints.updateIntegration.body.parse({
      revision: 3,
      settings: { ...settings, trail: 'off' },
    });
    expect(update.settings.trail).toBe('off');
    expect(feedbackEndpoints.createIntegration.body.parse(settings).reporterSignIn).toBe('on');
  });

  it('carries up to 10 strict trail steps in the context', () => {
    expect(FEEDBACK_TRAIL_MAX).toBe(10);
    expect(FeedbackContext.parse({}).trail).toBeUndefined();
    const ctx = FeedbackContext.parse({ trail: [{ url: step.url, at: step.at }, step] });
    expect(ctx.trail?.[0]).toEqual({ url: step.url, title: null, at: step.at });
    expect(FeedbackContext.safeParse({ trail: Array(10).fill(step) }).success).toBe(true);
    expect(FeedbackContext.safeParse({ trail: Array(11).fill(step) }).success).toBe(false);
    expect(FeedbackTrailStep.safeParse({ ...step, referrer: 'x' }).success).toBe(false);
    expect(FeedbackTrailStep.safeParse({ ...step, at: 'yesterday' }).success).toBe(false);
    expect(FeedbackTrailStep.safeParse({ ...step, url: '' }).success).toBe(false);
    expect(
      FeedbackTrailStep.safeParse({ ...step, url: `https://a.example/${'x'.repeat(1024)}` }).success,
    ).toBe(false);
    expect(FeedbackTrailStep.safeParse({ ...step, title: 't'.repeat(161) }).success).toBe(false);
  });

  it('lets the public config say trail and reporters, absent meaning false', () => {
    const config = {
      productLabel: 'Lumio',
      reportTypes: ['bug'],
      theme: 'auto',
      position: 'bottom-right',
      launcher: 'floating',
      launcherLabel: 'Feedback',
      privacyUrl: null,
      contactFields: { name: 'optional', email: 'optional' },
      attachments: { max: 3, maxBytes: 3145728, types: ['image/png'] },
      text: { description: 5000, expected: 3000, steps: 3000 },
      redactPaths: [],
      contextKeys: [],
    };
    const old = FeedbackPublicConfig.parse(config);
    expect(old.trail ?? false).toBe(false);
    expect(old.reporters ?? false).toBe(false);
    expect(FeedbackPublicConfig.parse({ ...config, trail: true, reporters: false })).toMatchObject({
      trail: true,
      reporters: false,
    });
    expect(FeedbackPublicConfig.safeParse({ ...config, trail: 'on' }).success).toBe(false);
  });

  it('adds code_refused and signed_out with fixed messages', () => {
    expect(FEEDBACK_PUBLIC_ERROR_STATUS.code_refused).toBe(400);
    expect(FEEDBACK_PUBLIC_ERROR_STATUS.signed_out).toBe(401);
    expect(FEEDBACK_PUBLIC_MESSAGES.code_refused).toBe(
      'That code didn’t work. Check it or ask for a new one.',
    );
    expect(FEEDBACK_PUBLIC_MESSAGES.signed_out).toBe('Your sign-in has ended. Sign in again.');
    for (const code of FeedbackPublicErrorCode.options) {
      expect(FEEDBACK_PUBLIC_ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
      expect(FEEDBACK_PUBLIC_MESSAGES[code]).toMatch(/\.$/);
    }
  });

  it('parses the reporter requests strictly and normalizes the email', () => {
    const parent = 'https://app.lumio.example';
    expect(FeedbackReporterCodeRequest.parse({ email: ' Sanne@Visser.Example ', parent })).toEqual({
      email: 'sanne@visser.example',
      parent,
    });
    expect(FeedbackReporterCodeRequest.safeParse({ email: 'not-an-address', parent }).success).toBe(false);
    expect(
      FeedbackReporterCodeRequest.safeParse({ email: `${'a'.repeat(250)}@x.example`, parent }).success,
    ).toBe(false);
    expect(FeedbackReporterCodeRequest.safeParse({ email: 'a@b.example', parent, name: 'x' }).success).toBe(
      false,
    );
    const session = { email: 'a@b.example', code: '042917', parent };
    expect(FeedbackReporterSessionRequest.safeParse(session).success).toBe(true);
    for (const code of ['42917', '0429170', '04291a', '０４２９１７', ' 042917'])
      expect(FeedbackReporterSessionRequest.safeParse({ ...session, code }).success, code).toBe(false);
    expect(FeedbackReporterSessionRequest.safeParse({ ...session, token: 'x' }).success).toBe(false);
  });

  it('shapes sessions and the reports list', () => {
    const token = `fbrs_${'A'.repeat(42)}w`;
    expect(
      FeedbackReporterSession.safeParse({ token, email: 'a@b.example', expiresAt: '2026-10-30T08:00:00Z' })
        .success,
    ).toBe(true);
    expect(FeedbackReporterToken.safeParse(`fbrs_${'A'.repeat(42)}`).success).toBe(false);
    expect(FeedbackReporterToken.safeParse(`tok_${'A'.repeat(43)}`).success).toBe(false);
    expect(FeedbackReporterOk.safeParse({ ok: true }).success).toBe(true);
    const report = {
      reference: 'FB-7K3Q-9M2X',
      type: 'bug',
      status: 'needs_info',
      receivedAt: '2026-09-29T10:00:00Z',
      updatedAt: '2026-09-29T11:00:00Z',
      summary: 'The invoice total is wrong',
    };
    expect(FeedbackReporterReport.safeParse(report).success).toBe(true);
    expect(FeedbackReporterReport.safeParse({ ...report, summary: null }).success).toBe(true);
    expect(FeedbackReporterReport.safeParse({ ...report, summary: 'x'.repeat(141) }).success).toBe(false);
    expect(FeedbackReporterReport.safeParse({ ...report, status: 'triaged' }).success).toBe(false);
    expect(FeedbackReporterReport.safeParse({ ...report, assessment: {} }).success).toBe(false);
    expect(FeedbackReporterStatus.options).toEqual([
      'received',
      'reviewing',
      'needs_info',
      'confirmed',
      'in_progress',
      'fixed',
      'closed',
    ]);
    const list = { email: 'a@b.example', reports: Array(200).fill(report) };
    expect(FeedbackReporterReports.safeParse(list).success).toBe(true);
    expect(FeedbackReporterReports.safeParse({ ...list, reports: Array(201).fill(report) }).success).toBe(
      false,
    );
  });

  it('reads an older report as unverified and without a trail', () => {
    const submitted = FeedbackReport.shape.submitted;
    const reporter = submitted.shape.reporter;
    expect(reporter.parse({ name: 'Sanne', email: 'sanne@visser.example' }).verified).toBe(false);
    expect(reporter.parse({ name: null, email: 'a@b.example', verified: true }).verified).toBe(true);
    const old = {
      description: 'x',
      expected: '',
      steps: '',
      reporter: { name: null, email: null },
      context: {},
    };
    expect(submitted.parse({ ...old, attachments: [] }).trail).toEqual([]);
    expect(submitted.parse({ ...old, attachments: [], trail: [step] }).trail).toEqual([step]);
  });

  it('lifts the trail out of the context in answers: a 0.24 client’s context is strict', () => {
    const v024Context = FeedbackContext.omit({ trail: true });
    expect(v024Context.safeParse({ trail: [step] }).success).toBe(false);
    expect(v024Context.safeParse({}).success).toBe(true);
  });

  it('names the loader attribute and the self-hosted routes', () => {
    expect(WIDGET_ATTRIBUTES.trail).toBe('data-trail');
    expect(FEEDBACK_PUBLIC_PATHS.reporterCode).toBe('/embed/v1/sites/:site/reporter/code');
    expect(FEEDBACK_PUBLIC_PATHS.reporterSession).toBe('/embed/v1/sites/:site/reporter/session');
    expect(FEEDBACK_PUBLIC_PATHS.reporterReports).toBe('/embed/v1/sites/:site/reporter/reports');
  });
});
