import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameMessage } from '../shared/protocol';
import { FrameApp } from './app';
import type { FrameBridge } from './bridge';
import type { SubmissionBody } from './draft';
import { CONFIG, CONTEXT } from './fixtures';
import type { FetchLike } from './submit';

const BASE = 'https://whombat.example.com/embed/v1/frame.html?site=x';
const params = {
  site: 'fbs_abcdefghijklmnopqrstuvwx',
  parent: 'https://shop.example.com',
  theme: 'auto' as const,
  instance: 'AAAAAAAAAAAAAAAAAAAAAA',
  key: null,
};
const RECEIPT = { reference: 'FB-7K3Q-9M2X', receivedAt: '2026-09-25T10:00:00.000Z' };

type Answer = { status: number; body?: unknown } | 'network';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let posted: FrameMessage[];
let reports: { url: string; body: Record<string, unknown> }[];
let answers: Answer[];
let config: unknown;
let app: FrameApp;

const fetchMock: FetchLike = async (url, init) => {
  if (url.includes('/config?')) {
    expect(init).toMatchObject({ credentials: 'omit', cache: 'no-store' });
    return config ? json(200, config) : json(404, { error: { code: 'unavailable', message: 'x' } });
  }
  reports.push({ url, body: JSON.parse(String(init.body)) });
  const next = answers.shift() ?? { status: 201, body: RECEIPT };
  if (next === 'network') throw new TypeError('Failed to fetch');
  return json(next.status, next.body ?? {});
};

async function start(cfg: unknown = CONFIG): Promise<FrameApp> {
  config = cfg;
  const bridge: FrameBridge = { post: (m) => posted.push(m), close() {} };
  const root = document.createElement('div');
  document.body.append(root);
  app = new FrameApp({ params, bridge, fetch: fetchMock, baseUrl: BASE, root });
  await app.load();
  return app;
}

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel) as T;
function type(sel: string, value: string) {
  const el = $<HTMLInputElement | HTMLTextAreaElement>(sel);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  posted = [];
  reports = [];
  answers = [];
  URL.createObjectURL = vi.fn(() => `blob:${Math.random()}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('loading', () => {
  it('renders the form as a labelled modal dialog', async () => {
    await start();
    const dialog = $('[role="dialog"]');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect($(`#${dialog.getAttribute('aria-labelledby')}`).textContent).toBe('Send feedback');
    expect($('.eyebrow').textContent).toBe('Shop');
    for (const control of document.querySelectorAll('input:not([type=file]), textarea'))
      expect(document.querySelector(`label[for="${control.id}"]`), control.id).not.toBeNull();
    expect($<HTMLAnchorElement>('.privacy a').rel).toBe('noopener noreferrer');
    expect($<HTMLAnchorElement>('.privacy a').target).toBe('_blank');
    expect($<HTMLInputElement>('input[type=file]').accept).toBe('image/png,image/jpeg');
    expect($('#wb-email-hint').textContent).toMatch(/Only used if/);
  });

  it('shows only the configured types and contact fields', async () => {
    await start({
      ...CONFIG,
      reportTypes: ['feature'],
      contactFields: { name: 'off', email: 'off' },
      privacyUrl: null,
      attachments: { ...CONFIG.attachments, max: 0 },
    });
    expect(document.querySelector('.types')).toBeNull();
    expect(document.querySelector('#wb-name')).toBeNull();
    expect(document.querySelector('#wb-email')).toBeNull();
    expect(document.querySelector('.privacy')).toBeNull();
    expect(document.querySelector('input[type=file]')).toBeNull();
    expect($('label[for="wb-description"]').textContent).toBe('What would you like?');
  });
});

describe('open', () => {
  it('an open type that arrives before the config is applied when it loads', async () => {
    config = CONFIG;
    const root = document.createElement('div');
    document.body.append(root);
    app = new FrameApp({
      params,
      bridge: { post: (m) => posted.push(m), close() {} },
      fetch: fetchMock,
      baseUrl: BASE,
      root,
    });
    app.handle({ type: 'open', payload: { type: 'feature', context: CONTEXT } });
    await app.load();
    expect(app.values.type).toBe('feature');
    expect(document.activeElement).toBe($('#wb-type-feature'));
  });

  it('Escape asks the loader to close; Tab stays inside the dialog', async () => {
    await start();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(posted.at(-1)).toEqual({ type: 'close', payload: {} });
    const buttons = [...document.querySelectorAll<HTMLElement>('.foot button')];
    const last = buttons.at(-1) as HTMLElement;
    last.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe($('.head .icon-button'));
    const back = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(back);
    expect(document.activeElement).toBe(last);
  });
});

describe('validation', () => {
  it('marks invalid fields, describes them and focuses the first', async () => {
    await start();
    type('#wb-email', 'not-an-email');
    $<HTMLFormElement>('form').requestSubmit();
    await flush();
    expect(reports).toHaveLength(0);
    const description = $('#wb-description');
    expect(description.getAttribute('aria-invalid')).toBe('true');
    expect(description.getAttribute('aria-describedby')).toContain('wb-description-error');
    expect($('#wb-description-error').textContent).toBe('Describe what went wrong.');
    expect($('#wb-email').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(description);
    expect($('.alert').textContent).toContain('Check the 2 highlighted fields.');
    type('#wb-description', 'It broke');
    expect(description.hasAttribute('aria-invalid')).toBe(false);
    expect(description.getAttribute('aria-describedby')).not.toContain('error');
  });

  it('counts characters against the limit', async () => {
    await start();
    type('#wb-description', 'x'.repeat(51));
    expect($('.counter').textContent).toBe('51 / 50');
    expect($('.counter').dataset.over).toBe('true');
  });

  it('checks screenshots when they are chosen, previews them and revokes their URLs', async () => {
    await start();
    const png = new File([new Uint8Array(10)], 'shot.png', { type: 'image/png' });
    const gif = new File([new Uint8Array(10)], 'anim.gif', { type: 'image/gif' });
    const big = new File([new Uint8Array(2 * 1024 * 1024)], 'big.png', { type: 'image/png' });
    app.addChosen([png, gif, big]);
    expect(app.values.files.map((f) => f.name)).toEqual(['shot.png']);
    expect($('#wb-attachments-error').textContent).toContain('“anim.gif” isn’t a PNG or JPEG image.');
    expect($('#wb-attachments-error').textContent).toContain('“big.png” is larger than 1 MB.');
    expect(document.querySelectorAll('.file img')).toHaveLength(1);
    expect($('.preview-list').textContent).toContain('shot.png');
    app.addChosen([png, png]);
    expect(app.values.files).toHaveLength(2);
    expect($('#wb-attachments-error').textContent).toMatch(/up to 2/);
    expect($<HTMLButtonElement>('.file-actions button').hidden).toBe(true);
    const remove = $<HTMLButtonElement>('.file button');
    expect(remove.getAttribute('aria-label')).toBe('Remove “shot.png”');
    remove.click();
    expect(app.values.files).toHaveLength(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
});

describe('sending', () => {
  async function fill() {
    await start();
    app.handle({ type: 'open', payload: { context: CONTEXT } });
    type('#wb-description', 'The invoice total is wrong');
    type('#wb-expected', 'The right total');
    type('#wb-email', 'ann@example.com');
  }

  it('sends once, shows the receipt and starts a new draft after', async () => {
    await fill();
    const png = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
    app.addChosen([png]);
    const first = app.submit();
    const second = app.submit();
    $<HTMLFormElement>('form').requestSubmit();
    expect($<HTMLButtonElement>('button[type=submit]').disabled).toBe(true);
    expect($('form').getAttribute('aria-busy')).toBe('true');
    expect(await second).toBeNull();
    await first;
    await flush();
    expect(reports).toHaveLength(1);
    const body = reports[0]?.body as unknown as SubmissionBody;
    expect(reports[0]?.url).toBe(
      'https://whombat.example.com/embed/v1/sites/fbs_abcdefghijklmnopqrstuvwx/reports',
    );
    expect(body).toMatchObject({
      parentOrigin: 'https://shop.example.com',
      type: 'bug',
      description: 'The invoice total is wrong',
      expected: 'The right total',
      reporter: { name: '', email: 'ann@example.com' },
      attachments: [{ name: 'shot.png', contentType: 'image/png', data: 'iVBORw==' }],
    });
    expect(body.context.page?.url).toBe('https://shop.example.com/customers/:id/invoices');
    expect(body.context.custom).toEqual({ plan: 'pro' });
    expect(app.view).toBe('receipt');
    expect(document.body.textContent).toContain('Thanks — we’ve received your report.');
    expect($('.reference').textContent).toBe('FB-7K3Q-9M2X');
    expect(document.querySelector('.receipt a')).toBeNull();
    expect(document.activeElement).toBe($('.receipt-title'));
    expect(posted).toContainEqual({ type: 'submitted', payload: { reference: 'FB-7K3Q-9M2X' } });
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    const firstId = body.submissionId;
    [...document.querySelectorAll<HTMLButtonElement>('.foot button')]
      .find((b) => b.textContent === 'Send another')
      ?.click();
    expect(app.view).toBe('form');
    expect($<HTMLTextAreaElement>('#wb-description').value).toBe('');
    expect(app.submitter.submissionId).not.toBe(firstId);
  });

  it('keeps the form and the submission id on network and server errors, then retries', async () => {
    await fill();
    answers = [
      'network',
      { status: 503 },
      { status: 429, body: { error: { code: 'rate_limited', message: 'x', retryAfter: 120 } } },
    ];
    await app.submit();
    expect($('.alert').textContent).toContain('Check your connection');
    expect($<HTMLTextAreaElement>('#wb-description').value).toBe('The invoice total is wrong');
    $<HTMLButtonElement>('.alert button').click();
    await flush();
    expect($('.alert').textContent).toContain('Something went wrong on our side');
    await app.submit();
    expect($('.alert').textContent).toContain('Try again in 2 minutes.');
    await app.submit();
    expect(app.view).toBe('receipt');
    const ids = reports.map((r) => r.body.submissionId);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(1);
  });

  it('a retry sends the very same body, sentAt and context included; an edit builds a new one (R1-2)', async () => {
    await fill();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-25T10:00:00.000Z'));
      answers = ['network', { status: 503 }, 'network'];
      await app.submit();
      // Seconds later, after the page moved on (the loader pushes the new context): “Try again”.
      vi.setSystemTime(new Date('2026-09-25T10:00:31.000Z'));
      app.handle({
        type: 'context',
        payload: { context: { ...CONTEXT, page: { url: 'https://shop.example.com/elsewhere', title: 'x' } } },
      });
      $<HTMLButtonElement>('.alert button').click();
      await flush();
      expect(reports).toHaveLength(2);
      expect(reports[1]?.body).toEqual(reports[0]?.body);
      expect(reports[0]?.body.context).toMatchObject({ sentAt: '2026-09-25T10:00:00.000Z' });
      // The visitor edits the draft: the next attempt is built again.
      type('#wb-description', 'The invoice total is wrong by a cent');
      await app.submit();
      const edited = reports[2]?.body as unknown as SubmissionBody;
      expect(edited.description).toBe('The invoice total is wrong by a cent');
      expect(edited.context.sentAt).toBe('2026-09-25T10:00:31.000Z');
      expect(edited.submissionId).toBe(reports[0]?.body.submissionId);
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps refused fields and attachments to the form', async () => {
    await fill();
    app.addChosen([new File([new Uint8Array(4)], 'a.png', { type: 'image/png' })]);
    answers = [
      { status: 400, body: { error: { code: 'invalid', message: 'x', fields: ['reporter.email'] } } },
      {
        status: 422,
        body: { error: { code: 'unsupported_attachment', message: 'x', fields: ['attachments.0'] } },
      },
      { status: 413, body: { error: { code: 'too_large', message: 'x' } } },
    ];
    await app.submit();
    expect($('#wb-email').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe($('#wb-email'));
    await app.submit();
    expect($('.file').dataset.invalid).toBe('true');
    expect($('.file .error').textContent).toMatch(/couldn’t be used/);
    expect($('.alert').textContent).toContain('One screenshot couldn’t be used.');
    await app.submit();
    expect($('.alert').textContent).toContain('too large to send together');
  });

  it('a receipt isn’t shown again when the panel is reopened', async () => {
    await fill();
    await app.submit();
    app.handle({ type: 'close', payload: {} });
    expect(app.view).toBe('form');
    app.handle({ type: 'open', payload: { type: 'bug', context: CONTEXT } });
    expect($<HTMLTextAreaElement>('#wb-description').value).toBe('');
  });

  it('copies the reference, or selects it when the clipboard is off limits', async () => {
    await fill();
    await app.submit();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
    });
    document.execCommand = vi.fn(() => false);
    $<HTMLButtonElement>('.reference-row button').click();
    await flush();
    expect($('.copy-status').textContent).toMatch(/Selected/);
    expect(document.getSelection()?.toString()).toBe('FB-7K3Q-9M2X');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => {}) },
    });
    $<HTMLButtonElement>('.reference-row button').click();
    await flush();
    expect($('.copy-status').textContent).toBe('Copied.');
  });
});
