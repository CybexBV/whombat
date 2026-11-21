/**
 * Reporter sign-in's client side (CT-162, AP-429 … AP-433): the routes in both modes equal the contracts, each call
 * sends what the contract says (bearer only with a session, no cookies or referrer) and maps every answer, the answers
 * are checked by hand as strictly as core's Zod shapes, and “Your reports” merges the server's list with what the
 * frame sent.
 */
import { CONTROL_PREFIX, feedbackDropApi } from '@whombat/control-contracts';
import {
  FEEDBACK_PUBLIC_MESSAGES,
  FEEDBACK_PUBLIC_PATHS,
  FeedbackReporterReports,
  FeedbackReporterSession,
} from '@whombat/core';
import { REPORTER_STATUS_COPY } from '@whombat/core/feedback/reporters';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reporterCodePath, reporterReportsPath, reporterSessionPath } from './drop';
import {
  endSession,
  fetchReports,
  formatDay,
  LOCAL_ONLY_MS,
  mergeReports,
  parseReportsAnswer,
  parseSessionAnswer,
  type ReporterEndpoints,
  requestCode,
  retryText,
  SIGNIN_MESSAGES,
  startSession,
} from './reporters';
import type { FetchLike } from './submit';

const SITE = 'fbs_abcdefghijklmnopqrstuvwx';
const TOKEN = `fbrs_${'A'.repeat(43)}`;
const EP: ReporterEndpoints = {
  code: 'https://whombat.example.com/embed/v1/sites/x/reporter/code',
  session: 'https://whombat.example.com/embed/v1/sites/x/reporter/session',
  reports: 'https://whombat.example.com/embed/v1/sites/x/reporter/reports',
  mode: 'same-origin',
};
const SESSION = { token: TOKEN, email: 'ann@example.com', expiresAt: '2026-10-30T10:00:00.000Z' };
const REPORT = {
  reference: 'FB-7K3Q-9M2X',
  type: 'bug',
  status: 'reviewing',
  receivedAt: '2026-09-29T10:00:00.000Z',
  updatedAt: '2026-09-29T11:00:00.000Z',
  summary: 'The invoice total is wrong',
} as const;

function answer(status: number, body?: unknown, headers: Record<string, string> = {}) {
  return vi.fn<FetchLike>(
    async () =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
  );
}
const request = (f: ReturnType<typeof answer>) => f.mock.calls[0] as [string, RequestInit];

afterEach(() => vi.restoreAllMocks());

describe('the routes and copy the frame repeats', () => {
  it('equal the runtime’s and control’s paths', () => {
    const direct = (p: string) =>
      new URL(p.replace(':site', SITE).slice('/embed/v1/'.length), 'https://w.example/embed/v1/frame.html');
    expect(direct(FEEDBACK_PUBLIC_PATHS.reporterCode).pathname).toBe(`/embed/v1/sites/${SITE}/reporter/code`);
    expect(direct(FEEDBACK_PUBLIC_PATHS.reporterSession).pathname).toBe(
      `/embed/v1/sites/${SITE}/reporter/session`,
    );
    expect(direct(FEEDBACK_PUBLIC_PATHS.reporterReports).pathname).toBe(
      `/embed/v1/sites/${SITE}/reporter/reports`,
    );
    const control = (p: string) => `${CONTROL_PREFIX}${p}`.replace(':site', SITE);
    expect(reporterCodePath(SITE)).toBe(control(feedbackDropApi.reporterCode.path));
    expect(reporterSessionPath(SITE)).toBe(control(feedbackDropApi.reporterSession.path));
    expect(reporterSessionPath(SITE)).toBe(control(feedbackDropApi.reporterSignOut.path));
    expect(reporterReportsPath(SITE)).toBe(control(feedbackDropApi.reporterReports.path));
    expect(feedbackDropApi.reporterSignOut.method).toBe('DELETE');
    expect(feedbackDropApi.reporterReports.method).toBe('GET');
  });

  it('the sign-in messages are core’s public messages', () => {
    expect(SIGNIN_MESSAGES.code_refused).toBe(FEEDBACK_PUBLIC_MESSAGES.code_refused);
    expect(SIGNIN_MESSAGES.signed_out).toBe(FEEDBACK_PUBLIC_MESSAGES.signed_out);
  });

  it('status words per type come from core', () => {
    expect(REPORTER_STATUS_COPY.bug.fixed).toBe('Fixed');
    expect(REPORTER_STATUS_COPY.feature.fixed).toBe('Done');
    expect(REPORTER_STATUS_COPY.feature.confirmed).toBe('Noted');
    expect(REPORTER_STATUS_COPY.bug.reviewing).toBe('Being looked at');
  });
});

describe('the calls', () => {
  it('asks for a code: JSON, no cookies, referrer or bearer; 202 is the only “sent”', async () => {
    const f = answer(202, { ok: true });
    expect(
      await requestCode(f, EP, { email: 'ann@example.com', parent: 'https://shop.example.com' }),
    ).toEqual({
      kind: 'ok',
      value: true,
    });
    const [url, init] = request(f);
    expect(url).toBe(EP.code);
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      mode: 'same-origin',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: { 'content-type': 'application/json' },
    });
    expect(JSON.parse(String(init.body))).toEqual({
      email: 'ann@example.com',
      parent: 'https://shop.example.com',
    });
    expect(init.headers).not.toHaveProperty('authorization');
    const body = { email: 'a@b.co', parent: 'https://p.example' };
    expect(await requestCode(answer(400, {}), EP, body)).toEqual({ kind: 'invalid' });
    expect(await requestCode(answer(404, {}), EP, body)).toEqual({ kind: 'unavailable' });
    expect(
      await requestCode(
        answer(429, { error: { code: 'rate_limited', message: 'x', retryAfter: 90 } }),
        EP,
        body,
      ),
    ).toEqual({ kind: 'rate_limited', retryAfter: 90 });
    expect(await requestCode(answer(429, {}, { 'retry-after': '30' }), EP, body)).toEqual({
      kind: 'rate_limited',
      retryAfter: 30,
    });
    expect(await requestCode(answer(500, {}), EP, body)).toEqual({ kind: 'server' });
    const offline = vi.fn<FetchLike>(async () => Promise.reject(new TypeError('Failed to fetch')));
    expect(await requestCode(offline, EP, body)).toEqual({ kind: 'network' });
  });

  it('exchanges the code: a session, or code_refused for every 400', async () => {
    const body = { email: 'ann@example.com', code: '012345', parent: 'https://shop.example.com' };
    const f = answer(200, SESSION);
    expect(await startSession(f, EP, body)).toEqual({ kind: 'ok', value: SESSION });
    expect(request(f)[0]).toBe(EP.session);
    expect(await startSession(answer(400, { error: { code: 'code_refused' } }), EP, body)).toEqual({
      kind: 'code_refused',
    });
    expect(await startSession(answer(400, { error: { code: 'invalid' } }), EP, body)).toEqual({
      kind: 'code_refused',
    });
    expect(await startSession(answer(200, { ...SESSION, token: 'fbrs_short' }), EP, body)).toEqual({
      kind: 'server',
    });
  });

  it('lists the reports with the bearer token; 401 is signed out', async () => {
    const f = answer(200, { email: 'ann@example.com', reports: [REPORT] });
    expect(await fetchReports(f, EP, TOKEN)).toEqual({ kind: 'ok', value: [REPORT] });
    const [url, init] = request(f);
    expect(url).toBe(EP.reports);
    expect(init).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(init.body).toBeUndefined();
    expect(await fetchReports(answer(401, {}), EP, TOKEN)).toEqual({ kind: 'signed_out' });
    expect(await fetchReports(answer(404, {}), EP, TOKEN)).toEqual({ kind: 'unavailable' });
    expect(await fetchReports(answer(200, { reports: 'x' }), EP, TOKEN)).toEqual({ kind: 'server' });
  });

  it('signs out with DELETE and the bearer token, whatever the answer', async () => {
    const f = answer(204);
    await endSession(f, { ...EP, mode: 'cors' }, TOKEN);
    const [url, init] = request(f);
    expect(url).toBe(EP.session);
    expect(init).toMatchObject({
      method: 'DELETE',
      mode: 'cors',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    await expect(
      endSession(
        vi.fn<FetchLike>(async () => Promise.reject(new TypeError('offline'))),
        EP,
        TOKEN,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('the answers', () => {
  it('a session is exactly what core accepts', () => {
    expect(FeedbackReporterSession.parse(SESSION)).toEqual(SESSION);
    expect(parseSessionAnswer(SESSION)).toEqual(SESSION);
    for (const bad of [
      null,
      [],
      { ...SESSION, token: `fbrs_${'A'.repeat(42)}` },
      { ...SESSION, email: '' },
      { ...SESSION, expiresAt: 'soon' },
    ])
      expect(parseSessionAnswer(bad)).toBeNull();
  });

  it('reports rows a newer server may add are left out, not the whole list', () => {
    const answer = {
      email: 'ann@example.com',
      reports: [REPORT, { ...REPORT, summary: null, type: 'feature' }],
    };
    expect(FeedbackReporterReports.parse(answer)).toEqual(answer);
    expect(parseReportsAnswer(answer)).toEqual(answer.reports);
    expect(
      parseReportsAnswer({
        email: 'a@b.co',
        reports: [
          REPORT,
          { ...REPORT, status: 'escalated' },
          { ...REPORT, type: 'question' },
          { ...REPORT, reference: 'FB-bad' },
          { ...REPORT, summary: 'x'.repeat(141) },
          'row',
        ],
      }),
    ).toEqual([REPORT]);
    expect(parseReportsAnswer({ reports: [] })).toBeNull();
    expect(parseReportsAnswer(null)).toBeNull();
  });
});

describe('“Your reports”', () => {
  const now = Date.parse('2026-09-30T12:00:00.000Z');

  it('uses the frame’s summary where the server has none and lists sent reports not collected yet', () => {
    const sent = [
      {
        reference: 'FB-AAAA-AAAA',
        type: 'feature' as const,
        summary: 'Dark mode',
        at: '2026-09-30T11:00:00.000Z',
      },
      { reference: 'FB-7K3Q-9M2X', type: 'bug' as const, summary: 'Mine', at: '2026-09-29T10:00:00.000Z' },
      {
        reference: 'FB-BBBB-BBBB',
        type: 'bug' as const,
        summary: 'Long ago',
        at: new Date(now - LOCAL_ONLY_MS - 1000).toISOString(),
      },
    ];
    const rows = mergeReports(
      [
        { ...REPORT, summary: null },
        { ...REPORT, reference: 'FB-CCCC-CCCC', status: 'fixed', receivedAt: '2026-09-20T10:00:00.000Z' },
      ],
      sent,
      now,
    );
    expect(rows).toEqual([
      {
        reference: 'FB-AAAA-AAAA',
        type: 'feature',
        status: 'received',
        receivedAt: '2026-09-30T11:00:00.000Z',
        summary: 'Dark mode',
      },
      {
        reference: 'FB-7K3Q-9M2X',
        type: 'bug',
        status: 'reviewing',
        receivedAt: REPORT.receivedAt,
        summary: 'Mine',
      },
      {
        reference: 'FB-CCCC-CCCC',
        type: 'bug',
        status: 'fixed',
        receivedAt: '2026-09-20T10:00:00.000Z',
        summary: REPORT.summary,
      },
    ]);
  });

  it('dates read “29 Sep”, with the year when it isn’t this one', () => {
    const today = new Date(2026, 8, 30, 12);
    expect(formatDay(new Date(2026, 8, 29, 10).toISOString(), today)).toBe('29 Sep');
    expect(formatDay(new Date(2025, 11, 3, 10).toISOString(), today)).toBe('3 Dec 2025');
    expect(formatDay('nope', today)).toBe('');
  });

  it('waiting is said in minutes', () => {
    expect(retryText(null)).toBe('Try again later.');
    expect(retryText(20)).toBe('Try again in a minute.');
    expect(retryText(150)).toBe('Try again in 3 minutes.');
  });
});
