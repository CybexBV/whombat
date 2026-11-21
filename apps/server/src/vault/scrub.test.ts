import { describe, expect, it } from 'vitest';
import {
  bytesHoldSecret,
  cutText,
  holdsSecret,
  jsonHoldsSecret,
  scrubJson,
  scrubText,
  secretForms,
  startTail,
  withCredentialHeaders,
} from './scrub';

const secret = 'tok+en/=1<é>';

describe('secret forms (docs/decisions/vault.md VT-42, VT-D21)', () => {
  it('adds the JSON escapes servers write: \\/, \\uXXXX for non-ASCII, HTML characters or everything', () => {
    const forms = secretForms({ secret });
    for (const form of [
      secret,
      'tok+en\\/=1<é>',
      'tok+en/=1<\\u00e9>',
      'tok+en\\/=1<\\u00E9>',
      'tok+en/=1\\u003cé\\u003e',
      'tok+en\\/=1\\u003c\\u00e9\\u003e',
      [...secret].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''),
      Buffer.from(secret).toString('base64'),
      encodeURIComponent(secret),
    ])
      expect(forms, form).toContain(form);
    expect(
      holdsSecret(`{"t":"${JSON.stringify(secret).slice(1, -1).replace(/\//g, '\\/')}"}`, [{ secret }]),
    ).toBe(true);
    expect(jsonHoldsSecret({ deep: [{ [secret]: 1 }] }, [{ secret }])).toBe(true);
    expect(bytesHoldSecret(Buffer.concat([Buffer.from([0, 255]), Buffer.from(secret)]), [{ secret }])).toBe(
      true,
    );
  });

  it('still scrubs text and JSON (text the person sees, and a second line)', () => {
    const basic = Buffer.from(`me:${secret}`).toString('base64');
    expect(scrubText(`Basic ${basic} and ${secret}`, [{ secret, username: 'me' }])).toBe(
      'Basic [secret] and [secret]',
    );
    expect(scrubJson({ [secret]: [secret] }, [{ secret }])).toEqual({ '[secret]': ['[secret]'] });
  });
});

describe('cutting after the check (VT-D20)', () => {
  it('finds the longest tail that starts a form, in linear time', () => {
    expect(startTail('xxxxtok+', 'tok+en')).toBe(4);
    expect(startTail('xxxx', 'tok+en')).toBe(0);
    expect(startTail('aaaa', 'aaab')).toBe(3);
    expect(startTail('\u0000ab', 'ab\u0000abz')).toBe(2);
    const long = 'x'.repeat(40_000);
    const started = Date.now();
    expect(startTail(`${long}${long.slice(0, 100)}`, `${long}y`)).toBe(40_000);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('cuts text to the cap and drops a tail that starts the secret', () => {
    expect(cutText(`${'q'.repeat(10)}tok+`, 12, [{ secret }])).toEqual({ text: 'q'.repeat(10), cut: true });
    expect(cutText('short', 12, [{ secret }])).toEqual({ text: 'short', cut: false });
  });
});

describe('request headers (VT-41)', () => {
  it('adds the credential last, replacing any header of its name whatever the case', () => {
    expect(
      withCredentialHeaders(
        { authorization: 'Bearer mine', Accept: 'application/json', 'user-agent': 'agent' },
        { Authorization: 'Bearer real' },
      ),
    ).toEqual({ 'user-agent': 'agent', Accept: 'application/json', Authorization: 'Bearer real' });
    expect(withCredentialHeaders({}, { 'User-Agent': 'secret-ua' })).toEqual({ 'User-Agent': 'secret-ua' });
  });
});
