import { randomBytes } from 'node:crypto';
import type { OnePasswordProjection } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { KeyCustody } from '../../keys/custody';
import { onePasswordDigests, onePasswordFieldDigest, storedBase } from './digests';

const custody = new KeyCustody(randomBytes(32).toString('base64'));
const login: OnePasswordProjection = {
  kind: 'login',
  name: 'Bank',
  url: 'https://bank.example/login',
  username: 'mara',
  secret: 'hunter2',
  totp: null,
};

describe('the base’s digests', () => {
  it('are the same for the same values of the same entry, compared by meaning', () => {
    const a = onePasswordDigests(custody, 'vlt_aaaaaaaaaaaa', login);
    const b = onePasswordDigests(custody, 'vlt_aaaaaaaaaaaa', {
      ...login,
      name: '  Bank ',
      url: 'https://bank.example/login/',
    });
    expect(b).toEqual(a);
  });

  it('differ by entry, by field and by the box’s key, and hold no value', () => {
    const a = onePasswordDigests(custody, 'vlt_aaaaaaaaaaaa', login);
    const other = onePasswordDigests(custody, 'vlt_bbbbbbbbbbbb', login);
    expect(other.secret).not.toBe(a.secret);
    // The same text in two fields: two digests.
    expect(onePasswordFieldDigest(custody, 'vlt_aaaaaaaaaaaa', 'name', 'x')).not.toBe(
      onePasswordFieldDigest(custody, 'vlt_aaaaaaaaaaaa', 'username', 'x'),
    );
    const elsewhere = onePasswordDigests(
      new KeyCustody(randomBytes(32).toString('base64')),
      'vlt_aaaaaaaaaaaa',
      login,
    );
    expect(elsewhere.secret).not.toBe(a.secret);
    expect(JSON.stringify(a)).not.toContain('hunter2');
    expect(JSON.stringify(a)).not.toContain('mara');
    // A changed secret changes only its own digest.
    const changed = onePasswordDigests(custody, 'vlt_aaaaaaaaaaaa', { ...login, secret: 'hunter3' });
    expect(changed.secret).not.toBe(a.secret);
    expect({ ...changed, secret: '' }).toEqual({ ...a, secret: '' });
  });

  it('a stored base with a field missing counts as none', () => {
    const a = onePasswordDigests(custody, 'vlt_aaaaaaaaaaaa', login);
    expect(storedBase(a)).toEqual(a);
    expect(storedBase({ ...a, totp: undefined })).toBeNull();
    expect(storedBase(null)).toBeNull();
    expect(storedBase('x')).toBeNull();
  });
});
