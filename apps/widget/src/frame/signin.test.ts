/**
 * The frame with the navigation trail and reporter sign-in on (CT-161, CT-162, AP-427 … AP-433), direct mode against a
 * fake runtime: the tabs, the trail in “What will be sent” and in the report, sign-in by email and code, the signed-in
 * form and receipt, “Your reports”, sign-out, an ended session, a server without the routes and storage that throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameMessage, WidgetContext } from '../shared/protocol';
import { FrameApp } from './app';
import type { PublicConfig } from './config';
import type { SubmissionBody } from './draft';
import { CONFIG, CONTEXT } from './fixtures';
import { reporterKey } from './reporter-store';
import type { FetchLike } from './submit';

const BASE = 'https://whombat.example.com/embed/v1/frame.html?site=x';
const SITE = 'fbs_abcdefghijklmnopqrstuvwx';
const PARENT = 'https://shop.example.com';
const API = `https://whombat.example.com/embed/v1/sites/${SITE}`;
const TOKEN = `fbrs_${'T'.repeat(43)}`;
const params = {
  site: SITE,
  parent: PARENT,
  theme: 'auto' as const,
  instance: 'AAAAAAAAAAAAAAAAAAAAAA',
  key: null,
};
const ON: PublicConfig = { ...CONFIG, trail: true, reporters: true };
const TRAIL = [
  { url: 'https://shop.example.com/', title: 'Shop', at: '2026-09-30T09:50:00.000Z' },
  {
    url: 'https://shop.example.com/customers/acme/invoices',
    title: 'Invoices',
    at: '2026-09-30T09:58:00.000Z',
  },
];
const CTX: WidgetContext = { ...CONTEXT, trail: TRAIL };

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
type Answer = { status: number; body?: unknown };

let calls: Call[];
let routes: Record<string, Answer[]>;
let posted: FrameMessage[];
let app: FrameApp;

const json = (a: Answer) =>
  new Response(a.body === undefined ? null : JSON.stringify(a.body), {
    status: a.status,
    headers: { 'content-type': 'application/json' },
  });

const fetchMock: FetchLike = async (url, init) => {
  const method = init.method ?? 'GET';
  if (url.includes('/config?')) return json({ status: 200, body: cfg });
  const headers = { ...(init.headers as Record<string, string>) };
  calls.push({ method, url, headers, body: init.body ? JSON.parse(String(init.body)) : undefined });
  const key = `${method} ${url.slice(API.length)}`;
  const queued = routes[key]?.shift();
  if (queued) return json(queued);
  if (key === 'POST /reporter/code') return json({ status: 202, body: { ok: true } });
  if (key === 'POST /reporter/session')
    return json({
      status: 200,
      body: { token: TOKEN, email: 'ann@example.com', expiresAt: '2099-10-30T10:00:00.000Z' },
    });
  if (key === 'DELETE /reporter/session') return json({ status: 204 });
  if (key === 'GET /reporter/reports')
    return json({ status: 200, body: { email: 'ann@example.com', reports: [] } });
  if (key === 'POST /reports')
    return json({ status: 201, body: { reference: 'FB-7K3Q-9M2X', receivedAt: '2026-09-30T10:00:00.000Z' } });
  return json({ status: 404, body: {} });
};

let cfg: PublicConfig = ON;

async function start(config: PublicConfig = ON): Promise<FrameApp> {
  cfg = config;
  const root = document.createElement('div');
  document.body.append(root);
  app = new FrameApp({
    params,
    bridge: { post: (m) => posted.push(m), close() {} },
    fetch: fetchMock,
    baseUrl: BASE,
    root,
  });
  await app.load();
  app.handle({ type: 'open', payload: { context: CTX } });
  return app;
}

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel) as T;
const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === text,
  ) as HTMLButtonElement;
function type(sel: string, value: string) {
  const el = $<HTMLInputElement | HTMLTextAreaElement>(sel);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}
async function submitForm(id: string) {
  $<HTMLFormElement>(`#${id}`).requestSubmit();
  await flush();
}

/** Signs in through the view (from the form's link). */
async function signIn(email = 'Ann@Example.com ') {
  button('Sign in to follow your reports').click();
  type('#wb-signin-email', email);
  await submitForm('wb-signin');
  type('#wb-signin-code', '123456');
  await submitForm('wb-signin');
}

beforeEach(() => {
  calls = [];
  routes = {};
  posted = [];
  localStorage.clear();
  URL.createObjectURL = vi.fn(() => `blob:${Math.random()}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the form (CT-161)', () => {
  it('has no steps to reproduce; “What will be sent” lists the pages visited, redacted', async () => {
    await start();
    expect(document.querySelector('#wb-steps')).toBeNull();
    expect(document.body.textContent).not.toContain('Steps to reproduce');
    const preview = $('.trail-preview');
    expect(preview.hidden).toBe(false);
    expect(preview.textContent).toContain('Pages you visited on this site before reporting (up to 10):');
    expect([...preview.querySelectorAll('.trail-url')].map((e) => e.textContent)).toEqual([
      'https://shop.example.com/',
      'https://shop.example.com/customers/:id/invoices',
    ]);
    expect($('.trail-list').getAttribute('aria-labelledby')).toBe('wb-trail-label');
    expect($('.preview-body .hint').textContent).toBe(
      'Nothing else from the page is sent: no cookies, stored data or form contents.',
    );
  });

  it('sends the trail with the report; without config.trail neither shows nor sends it', async () => {
    await start();
    type('#wb-description', 'Wrong total');
    await app.submit();
    const body = calls.find((c) => c.url.endsWith('/reports'))?.body as SubmissionBody;
    expect(body.steps).toBe('');
    expect(body.context.trail?.map((s) => s.url)).toEqual([
      'https://shop.example.com/',
      'https://shop.example.com/customers/:id/invoices',
    ]);
    document.body.replaceChildren();
    calls = [];
    await start({ ...ON, trail: false });
    expect($('.trail-preview').hidden).toBe(true);
    type('#wb-description', 'Wrong total');
    await app.submit();
    const sent = calls.find((c) => c.url.endsWith('/reports'))?.body as SubmissionBody;
    expect(sent.context).not.toHaveProperty('trail');
  });
});

describe('tabs and sign-in (CT-162)', () => {
  it('without config.reporters: no tabs, no link, no storage', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem');
    await start({ ...CONFIG, trail: true });
    expect($('.tabs').hidden).toBe(true);
    expect(document.querySelector('#wb-signin-link')).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('shows the tabs as toggle buttons and the sign-in link at the end of the contact group', async () => {
    await start();
    expect($('.tabs').hidden).toBe(false);
    expect(button('New report').getAttribute('aria-pressed')).toBe('true');
    expect(button('Your reports').getAttribute('aria-pressed')).toBe('false');
    const contact = $('[data-group="contact"]');
    expect(contact.lastElementChild?.textContent).toBe('Sign in to follow your reports');
    button('Your reports').click();
    expect(app.view).toBe('signin');
    expect(button('Your reports').getAttribute('aria-pressed')).toBe('true');
    expect($('#wb-signin-title').textContent).toBe('Follow your reports');
  });

  it('signs in with email and code and returns to the draft', async () => {
    await start();
    type('#wb-description', 'Draft kept');
    type('#wb-name', 'Ann');
    button('Sign in to follow your reports').click();
    expect(app.view).toBe('signin');
    expect(document.body.textContent).toContain(
      'We’ll email you a 6-digit code. Signed in, you can see the reports you send on this site and how they’re going.',
    );
    expect(document.activeElement).toBe($('#wb-signin-email'));
    type('#wb-signin-email', 'not an email');
    await submitForm('wb-signin');
    expect($('#wb-signin-email').getAttribute('aria-invalid')).toBe('true');
    expect($('#wb-signin-email-error').textContent).toBe('Enter an email address like name@example.com.');
    expect(calls).toHaveLength(0);

    type('#wb-signin-email', ' Ann@Example.com ');
    await submitForm('wb-signin');
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${API}/reporter/code`,
      body: { email: 'ann@example.com', parent: PARENT },
    });
    expect(calls[0]?.headers).not.toHaveProperty('authorization');
    expect(app.signinStep).toBe('code');
    expect($('.lead').textContent).toBe('Enter the code we sent to ann@example.com.');
    const code = $<HTMLInputElement>('#wb-signin-code');
    expect(document.activeElement).toBe(code);
    expect(code.getAttribute('inputmode')).toBe('numeric');
    expect(code.getAttribute('autocomplete')).toBe('one-time-code');
    expect(button('Send a new code').disabled).toBe(true);

    type('#wb-signin-code', '12345');
    await submitForm('wb-signin');
    expect($('#wb-signin-code-error').textContent).toBe('Enter the 6-digit code from the email.');
    routes['POST /reporter/session'] = [
      { status: 400, body: { error: { code: 'code_refused', message: 'x' } } },
    ];
    type('#wb-signin-code', '000000');
    await submitForm('wb-signin');
    expect($('#wb-signin-code-error').textContent).toBe(
      'That code didn’t work. Check it or ask for a new one.',
    );
    expect(document.activeElement).toBe(code);

    type('#wb-signin-code', '123 456');
    await submitForm('wb-signin');
    expect(calls.at(-1)?.body).toEqual({ email: 'ann@example.com', code: '123456', parent: PARENT });
    expect(app.view).toBe('form');
    expect($<HTMLTextAreaElement>('#wb-description').value).toBe('Draft kept');
    expect(document.querySelector('#wb-email')).toBeNull();
    expect($('#wb-signed-in').textContent).toBe('Signed in as ann@example.com·Sign out');
    expect(document.activeElement).toBe($('#wb-signed-in'));
    expect(document.querySelector('[role=status][aria-live]')?.textContent).toBe(
      'Signed in as ann@example.com.',
    );
    expect(JSON.parse(localStorage.getItem(reporterKey(SITE)) ?? '')).toMatchObject({
      token: TOKEN,
      email: 'ann@example.com',
      name: 'Ann',
      sent: [],
    });
    expect(Object.keys(localStorage)).toEqual([reporterKey(SITE)]);
  });

  it('“Send a new code” waits 30 s, then says earlier codes no longer work', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], shouldAdvanceTime: true });
    await start();
    button('Sign in to follow your reports').click();
    type('#wb-signin-email', 'ann@example.com');
    await submitForm('wb-signin');
    const resend = button('Send a new code');
    expect(resend.disabled).toBe(true);
    vi.advanceTimersByTime(30_000);
    expect(resend.disabled).toBe(false);
    resend.click();
    await flush();
    expect(calls.filter((c) => c.url.endsWith('/reporter/code'))).toHaveLength(2);
    expect($('.signin-status').textContent).toBe('We sent a new code. Earlier codes no longer work.');
    expect(resend.disabled).toBe(true);
    button('Use a different email').click();
    expect(app.signinStep).toBe('email');
    expect($<HTMLInputElement>('#wb-signin-email').value).toBe('ann@example.com');
  });

  it('a signed-in report carries the bearer token and the session’s address; the receipt points to the list', async () => {
    await start();
    await signIn();
    type('#wb-description', 'The invoice total is wrong');
    await app.submit();
    const report = calls.find((c) => c.url.endsWith('/reports')) as Call;
    expect(report.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect((report.body as SubmissionBody).reporter.email).toBe('ann@example.com');
    expect(app.view).toBe('receipt');
    expect($('.receipt .follow').textContent).toBe('You can follow it under Your reports.');
    const stored = JSON.parse(localStorage.getItem(reporterKey(SITE)) ?? '');
    expect(stored.sent).toEqual([
      {
        reference: 'FB-7K3Q-9M2X',
        type: 'bug',
        summary: 'The invoice total is wrong',
        at: '2026-09-30T10:00:00.000Z',
      },
    ]);
  });

  it('signed out, a report has no bearer token and the receipt no pointer', async () => {
    await start();
    type('#wb-description', 'x');
    type('#wb-email', 'typed@example.com');
    await app.submit();
    const report = calls.find((c) => c.url.endsWith('/reports')) as Call;
    expect(report.headers).not.toHaveProperty('authorization');
    expect((report.body as SubmissionBody).reporter.email).toBe('typed@example.com');
    expect(document.querySelector('.receipt .follow')).toBeNull();
  });

  it('“Your reports” lists the reports with status words, the frame’s summary where the server has none', async () => {
    await start();
    await signIn();
    type('#wb-description', 'Sent from here');
    await app.submit();
    routes['GET /reporter/reports'] = [
      {
        status: 200,
        body: {
          email: 'ann@example.com',
          reports: [
            {
              reference: 'FB-7K3Q-9M2X',
              type: 'bug',
              status: 'needs_info',
              receivedAt: '2026-09-30T10:00:00.000Z',
              updatedAt: '2026-09-30T10:05:00.000Z',
              summary: null,
            },
            {
              reference: 'FB-AAAA-AAAA',
              type: 'feature',
              status: 'fixed',
              receivedAt: '2026-09-20T10:00:00.000Z',
              updatedAt: '2026-09-25T10:00:00.000Z',
              summary: 'Dark mode',
            },
          ],
        },
      },
    ];
    button('Your reports').click();
    await flush();
    expect(app.view).toBe('reports');
    expect(calls.at(-1)).toMatchObject({ method: 'GET', headers: { authorization: `Bearer ${TOKEN}` } });
    const rows = [...document.querySelectorAll('.report')];
    expect(rows.map((r) => r.querySelector('.report-type')?.textContent)).toEqual(['Problem', 'Idea']);
    expect(rows.map((r) => r.querySelector('.report-ref')?.textContent)).toEqual([
      'FB-7K3Q-9M2X',
      'FB-AAAA-AAAA',
    ]);
    expect(rows.map((r) => r.querySelector('.report-summary')?.textContent)).toEqual([
      'Sent from here',
      'Dark mode',
    ]);
    expect(rows.map((r) => r.querySelector('.report-status')?.textContent)).toEqual([
      'Needs more information',
      'Done',
    ]);
    expect(rows[0]?.querySelector('.report-date')?.textContent).toMatch(/^30 Sep$/);
    button('Refresh').click();
    await flush();
    expect(document.querySelector('[role=status][aria-live]')?.textContent).toBe(
      'Your reports are up to date.',
    );
    button('New report').click();
    expect(app.view).toBe('form');
    expect($<HTMLTextAreaElement>('#wb-description').value).toBe('');
  });

  it('an empty list says so', async () => {
    await start();
    await signIn();
    button('Your reports').click();
    await flush();
    expect($('.empty').textContent).toBe('No reports yet. Reports you send while signed in appear here.');
  });

  it('an ended session goes back to sign-in with the public message', async () => {
    await start();
    await signIn();
    routes['GET /reporter/reports'] = [
      { status: 401, body: { error: { code: 'signed_out', message: 'x' } } },
    ];
    button('Your reports').click();
    await flush();
    expect(app.view).toBe('signin');
    expect($('.alert').textContent).toContain('Your sign-in has ended. Sign in again.');
    expect(localStorage.getItem(reporterKey(SITE))).toBeNull();
    expect(app.session).toBeNull();
  });

  it('a 404 on the list keeps the session and says the list can’t be shown now', async () => {
    await start();
    await signIn();
    routes['GET /reporter/reports'] = [{ status: 404, body: {} }];
    button('Your reports').click();
    await flush();
    expect(app.view).toBe('reports');
    expect($('.alert').textContent).toContain('Your reports can’t be shown right now. Try again later.');
    expect(app.session?.token).toBe(TOKEN);
    expect(localStorage.getItem(reporterKey(SITE))).not.toBeNull();
  });

  it('signs out: DELETE with the token, storage cleared, the link back', async () => {
    await start();
    await signIn();
    button('Sign out').click();
    await flush();
    expect(calls.at(-1)).toMatchObject({
      method: 'DELETE',
      url: `${API}/reporter/session`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(localStorage.getItem(reporterKey(SITE))).toBeNull();
    expect(document.activeElement).toBe($('#wb-signin-link'));
    expect($('#wb-email')).not.toBeNull();
  });

  it('a server without the routes (404) hides sign-in again', async () => {
    await start();
    routes['POST /reporter/code'] = [{ status: 404, body: {} }];
    button('Sign in to follow your reports').click();
    type('#wb-signin-email', 'ann@example.com');
    await submitForm('wb-signin');
    expect($('.alert').textContent).toContain('Signing in isn’t available on this site right now.');
    expect($('.tabs').hidden).toBe(true);
    button('Back').click();
    expect(app.view).toBe('form');
    expect(document.querySelector('#wb-signin-link')).toBeNull();
  });

  it('a stored session signs in at once; an expired one doesn’t', async () => {
    const stored = {
      token: TOKEN,
      email: 'ann@example.com',
      name: 'Ann',
      expiresAt: '2099-01-01T00:00:00.000Z',
      sent: [],
    };
    localStorage.setItem(reporterKey(SITE), JSON.stringify(stored));
    await start();
    expect($('#wb-signed-in')).not.toBeNull();
    expect($<HTMLInputElement>('#wb-name').value).toBe('Ann');
    document.body.replaceChildren();
    localStorage.setItem(
      reporterKey(SITE),
      JSON.stringify({ ...stored, expiresAt: '2020-01-01T00:00:00.000Z' }),
    );
    await start();
    expect(document.querySelector('#wb-signed-in')).toBeNull();
    expect(localStorage.getItem(reporterKey(SITE))).toBeNull();
  });

  it('without storage the session lasts while the frame is open', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    await start();
    await signIn();
    expect(app.session?.email).toBe('ann@example.com');
    button('Your reports').click();
    await flush();
    expect(app.view).toBe('reports');
  });

  it('a site trigger asking for a type leaves the list for the form', async () => {
    await start();
    await signIn();
    button('Your reports').click();
    await flush();
    app.handle({ type: 'open', payload: { type: 'feature', context: CTX } });
    expect(app.view).toBe('form');
    expect(app.values.type).toBe('feature');
  });
});
