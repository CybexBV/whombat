import { FeedbackPublicConfig, FeedbackSubmission } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { WidgetContext } from '../shared/protocol';
import { parseConfig } from './config';
import {
  buildSubmission,
  type DraftFile,
  displayName,
  draftKey,
  emptyDraft,
  fileProblem,
  validateDraft,
} from './draft';
import { CONFIG, CONTEXT } from './fixtures';

const file = (name: string, type = 'image/png', size = 1000): DraftFile => ({
  key: name,
  name,
  type,
  size,
  blob: new Blob([new Uint8Array(size)], { type }),
});

describe('config', () => {
  it('parses what the server’s contract allows and refuses the rest', () => {
    expect(FeedbackPublicConfig.parse(CONFIG)).toEqual(CONFIG);
    expect(parseConfig(CONFIG)).toEqual(CONFIG);
    expect(parseConfig({ ...CONFIG, reportTypes: [] })).toBeNull();
    expect(parseConfig({ ...CONFIG, reportTypes: ['question'] })).toBeNull();
    expect(parseConfig({ ...CONFIG, privacyUrl: 'javascript:alert(1)' })).toBeNull();
    expect(parseConfig({ ...CONFIG, attachments: { ...CONFIG.attachments, types: 'image/png' } })).toBeNull();
    expect(parseConfig(null)).toBeNull();
    expect(parseConfig({ error: { code: 'unavailable' } })).toBeNull();
  });

  it('reads what only a newer server sends tolerantly (AP-262)', () => {
    expect(parseConfig({ ...CONFIG, reportTypes: ['bug', 'question'] })?.reportTypes).toEqual(['bug']);
    expect(
      parseConfig({
        ...CONFIG,
        attachments: { ...CONFIG.attachments, types: ['image/png', 'image/svg+xml'] },
      })?.attachments.types,
    ).toEqual(['image/png']);
    expect(
      parseConfig({ ...CONFIG, theme: 'sepia', position: 'top-right', launcher: 'inline' }),
    ).toMatchObject({ theme: 'auto', position: 'bottom-right', launcher: 'custom' });
    expect(
      parseConfig({ ...CONFIG, contactFields: { name: 'required', email: 'off' } })?.contactFields,
    ).toEqual({ name: 'optional', email: 'off' });
  });
});

describe('validateDraft', () => {
  it('requires a description and checks the limits', () => {
    const d = emptyDraft('bug');
    expect(validateDraft(d, CONFIG)).toEqual({ description: 'Describe what went wrong.' });
    expect(validateDraft({ ...d, type: 'feature' }, CONFIG).description).toMatch(/you’d like/);
    expect(validateDraft({ ...d, description: '   ' }, CONFIG).description).toBeTruthy();
    expect(validateDraft({ ...d, description: 'x'.repeat(51) }, CONFIG).description).toMatch(/50 characters/);
    expect(validateDraft({ ...d, description: 'ok', expected: 'x'.repeat(21) }, CONFIG)).toEqual({
      expected: expect.stringMatching(/20/),
    });
    // Bug-only fields don't count for a feature request.
    expect(
      validateDraft({ ...d, type: 'feature', description: 'ok', expected: 'x'.repeat(21) }, CONFIG),
    ).toEqual({});
  });

  it('checks the optional contact details and screenshots', () => {
    const d = { ...emptyDraft('bug'), description: 'Broken' };
    expect(validateDraft({ ...d, email: 'nope' }, CONFIG).email).toMatch(/email address/);
    expect(validateDraft({ ...d, email: 'a@b.co' }, CONFIG)).toEqual({});
    expect(
      validateDraft({ ...d, email: 'nope' }, { ...CONFIG, contactFields: { name: 'off', email: 'off' } }),
    ).toEqual({});
    expect(validateDraft({ ...d, name: 'x'.repeat(121) }, CONFIG).name).toBeTruthy();
    const three = [file('a.png'), file('b.png'), file('c.png')];
    expect(validateDraft({ ...d, files: three }, CONFIG).attachments).toMatch(/up to 2/);
    expect(validateDraft({ ...d, files: [file('a.gif', 'image/gif')] }, CONFIG)['attachments.0']).toMatch(
      /PNG or JPEG/,
    );
    expect(validateDraft({ ...d, type: 'question' as 'bug' }, CONFIG).type).toBeTruthy();
  });

  it('explains why a file is refused', () => {
    expect(fileProblem(file('a.png'), CONFIG)).toBeNull();
    expect(fileProblem(file('a.jpg', 'image/jpeg'), CONFIG)).toBeNull();
    expect(fileProblem(file('a.svg', 'image/svg+xml'), CONFIG)).toBe('“a.svg” isn’t a PNG or JPEG image.');
    expect(fileProblem(file('big.png', 'image/png', 2 * 1024 * 1024), CONFIG)).toBe(
      '“big.png” is larger than 1 MB.',
    );
    expect(fileProblem(file('empty.png', 'image/png', 0), CONFIG)).toMatch(/empty/);
    expect(displayName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(displayName('\u0000')).toBe('screenshot');
  });
});

describe('the submission', () => {
  it('drops bug-only fields for a feature and contact fields that are off', () => {
    const body = buildSubmission({
      submissionId: 'abcdefghijklmnopqrstuv',
      parentOrigin: 'https://shop.example.com',
      values: {
        ...emptyDraft('feature'),
        description: 'Dark mode',
        expected: 'x',
        name: 'Ann',
        email: 'a@b.co',
      },
      context: null,
      config: { ...CONFIG, contactFields: { name: 'off', email: 'off' } },
      attachments: [],
      sentAt: '2026-09-25T10:00:00.000Z',
    });
    expect(body).toMatchObject({ expected: '', steps: '', reporter: { name: '', email: '' } });
    expect(FeedbackSubmission.parse(body)).toEqual(body);
  });
});

describe('the navigation trail and reporter sign-in (CT-161, CT-162)', () => {
  const trail = [
    { url: 'https://shop.example.com/', title: 'Shop', at: '2026-09-30T09:50:00.000Z' },
    {
      url: 'https://shop.example.com/customers/acme/orders',
      title: 'Orders',
      at: '2026-09-30T09:55:00.000Z',
    },
    {
      url: 'https://shop.example.com/customers/acme/invoices',
      title: 'Invoices',
      at: '2026-09-30T09:58:00.000Z',
    },
  ];
  const context: WidgetContext = { ...CONTEXT, trail };
  const build = (config = CONFIG, signedInEmail: string | null = null) =>
    buildSubmission({
      submissionId: 'abcdefghijklmnopqrstuv',
      parentOrigin: 'https://shop.example.com',
      values: { ...emptyDraft('bug'), description: 'Wrong total', email: 'typed@example.com' },
      context,
      config,
      attachments: [],
      sentAt: '2026-09-30T10:00:00.000Z',
      signedInEmail,
    });

  it('sends the trail with the site’s redact rules applied to every step, only when the config allows', () => {
    const body = build({ ...CONFIG, trail: true });
    expect(body.context.trail).toEqual([
      trail[0],
      { ...trail[1], url: 'https://shop.example.com/customers/:id/orders' },
      { ...trail[2], url: 'https://shop.example.com/customers/:id/invoices' },
    ]);
    expect(FeedbackSubmission.parse(body)).toEqual(body);
    expect(build().context).not.toHaveProperty('trail');
    expect(build({ ...CONFIG, trail: true, redactPaths: [] }).context.trail?.[1]?.url).toBe(
      'https://shop.example.com/customers/acme/orders',
    );
  });

  it('never sends steps to reproduce', () => {
    expect(build().steps).toBe('');
  });

  it('signed in, the session’s address is the reporter’s email and the email field isn’t checked', () => {
    expect(build(CONFIG, 'ann@example.com').reporter.email).toBe('ann@example.com');
    expect(
      build({ ...CONFIG, contactFields: { name: 'off', email: 'off' } }, 'ann@example.com').reporter,
    ).toEqual({ name: '', email: 'ann@example.com' });
    expect(build().reporter.email).toBe('typed@example.com');
    const d = { ...emptyDraft('bug'), description: 'x', email: 'not an email' };
    expect(validateDraft(d, CONFIG).email).toBeTruthy();
    expect(validateDraft(d, CONFIG, true)).toEqual({});
    expect(draftKey(d, 'ann@example.com')).not.toBe(draftKey(d));
  });

  it('parses the config’s switches; absent means off (an older server)', () => {
    expect(parseConfig({ ...CONFIG, trail: true, reporters: true })).toMatchObject({
      trail: true,
      reporters: true,
    });
    const { trail: _t, reporters: _r, ...old } = CONFIG;
    expect(parseConfig(old)).toMatchObject({ trail: false, reporters: false });
    expect(parseConfig({ ...CONFIG, trail: 'yes' })?.trail).toBe(false);
  });
});
