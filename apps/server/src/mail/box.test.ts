import { describe, expect, it } from 'vitest';
import { fromHeader, mailTestOutcome } from './box';

describe('the person’s mail server (HE-S216, HE-S217)', () => {
  it('names a test’s outcome by the contract’s states, in its own words', () => {
    const of = (err: unknown) => mailTestOutcome(err, 'mail.home.test', 587).state;
    expect(of(Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 }))).toBe(
      'auth_failed',
    );
    expect(of(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNECTION' }))).toBe('unreachable');
    expect(of(Object.assign(new Error('Greeting never received'), { code: 'ETIMEDOUT' }))).toBe(
      'unreachable',
    );
    expect(of(Object.assign(new Error('self-signed certificate'), { code: 'ESOCKET' }))).toBe('tls_failed');
    expect(of(new Error('Missing STARTTLS support'))).toBe('tls_failed');
    expect(of(Object.assign(new Error('Recipient refused'), { code: 'EENVELOPE' }))).toBe('refused');
    expect(of(new Error('something else'))).toBe('failed');
    const said = mailTestOutcome(
      Object.assign(new Error('535 5.7.8 secret server words'), { code: 'EAUTH' }),
      'mail.home.test',
      587,
    );
    expect(said.detail).not.toContain('secret server words');
  });

  it('sends as the person’s name, or as Whombat', () => {
    expect(fromHeader({ from: 'box@home.test', fromName: 'Home Whombat' })).toBe(
      '"Home Whombat" <box@home.test>',
    );
    expect(fromHeader({ from: 'box@home.test', fromName: null })).toBe('Whombat <box@home.test>');
  });
});
