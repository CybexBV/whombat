import { describe, expect, it } from 'vitest';
import {
  newPhoneHandoffKey,
  parsePhoneSignInLink,
  phoneHandoffMac,
  phoneSignInLink,
  verifyPhoneHandoffReport,
} from './phone-handoff';

const UI = ['https://dev.whombat.com'];
const PEER = '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH';
const token = 'T'.repeat(43);

describe('phone sign-in by QR code (AP-520)', () => {
  it('keys are 32 random bytes in base64url, never the same twice', () => {
    const a = newPhoneHandoffKey();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newPhoneHandoffKey()).not.toBe(a);
  });

  it('the link round-trips, with and without a Whombat', () => {
    const key = newPhoneHandoffKey();
    const appliance = { device: 'wb-6cx4-j9hs-3e85', peerId: PEER };
    const link = phoneSignInLink('https://dev.whombat.com/', { token, key, appliance });
    expect(link.startsWith('https://dev.whombat.com/auth/phone#t=')).toBe(true);
    expect(parsePhoneSignInLink(link, UI)).toEqual({ token, key, appliance });
    const bare = phoneSignInLink('https://dev.whombat.com', { token, key, appliance: null });
    expect(parsePhoneSignInLink(bare, UI)).toEqual({ token, key, appliance: null });
    // The app's own scheme too.
    expect(parsePhoneSignInLink(bare.replace('https://dev.whombat.com/', 'whombat://'), UI)).toEqual({
      token,
      key,
      appliance: null,
    });
  });

  it('refuses other hosts, other paths and malformed parts', () => {
    const key = newPhoneHandoffKey();
    const good = phoneSignInLink('https://dev.whombat.com', { token, key, appliance: null });
    expect(parsePhoneSignInLink(good.replace('dev.whombat.com', 'evil.example'), UI)).toBeNull();
    expect(parsePhoneSignInLink(good.replace('/auth/phone', '/auth/verify'), UI)).toBeNull();
    expect(parsePhoneSignInLink(good.replace(`k=${key}`, 'k=short'), UI)).toBeNull();
    expect(parsePhoneSignInLink(good.replace(`t=${token}`, 't=a+b'), UI)).toBeNull();
    // A device without a valid identity is refused, not opened unpinned.
    expect(parsePhoneSignInLink(`${good}&d=wb-1&p=nope`, UI)).toBeNull();
    expect(parsePhoneSignInLink(`${good}&d=wb-1`, UI)).toBeNull();
    expect(parsePhoneSignInLink('not a link', UI)).toBeNull();
  });

  it('the report MAC verifies only with the same key, handoff, code and fingerprint', () => {
    const key = newPhoneHandoffKey();
    const report = {
      code: '1234-5678',
      fingerprint: 'AB12-CD34-EF56',
      mac: phoneHandoffMac(key, 'ph_1234abcd', '1234-5678', 'AB12-CD34-EF56'),
    };
    expect(report.mac).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifyPhoneHandoffReport(key, 'ph_1234abcd', report)).toBe(true);
    expect(verifyPhoneHandoffReport(newPhoneHandoffKey(), 'ph_1234abcd', report)).toBe(false);
    expect(verifyPhoneHandoffReport(key, 'ph_other000', report)).toBe(false);
    expect(verifyPhoneHandoffReport(key, 'ph_1234abcd', { ...report, code: '1234-5679' })).toBe(false);
    expect(verifyPhoneHandoffReport(key, 'ph_1234abcd', { ...report, fingerprint: 'AB12-CD34-EF57' })).toBe(
      false,
    );
    expect(verifyPhoneHandoffReport(key, 'ph_1234abcd', { ...report, mac: '!' })).toBe(false);
  });

  it('matches a fixed vector (both apps compute the same bytes)', () => {
    const key = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
    // HMAC-SHA256(bytes 0…31, "whombat-phone-handoff/1\nph_vector1\n0000-0001\n0000-0000-0001"), from Node's crypto.
    expect(phoneHandoffMac(key, 'ph_vector1', '0000-0001', '0000-0000-0001')).toBe(
      'lzJLf7cr589MtF7fhg3uyWlig_zi_lqKROLkOHsdudM',
    );
  });
});

describe('base64url of the key', () => {
  it('decodes what Node encodes', () => {
    // Bytes 0…31 in base64url, as Node's `Buffer.toString('base64url')` writes them.
    const key = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
    const mac = phoneHandoffMac(key, 'ph_vector1', '0000-0001', '0000-0000-0001');
    expect(mac).toBe('lzJLf7cr589MtF7fhg3uyWlig_zi_lqKROLkOHsdudM');
  });
});
