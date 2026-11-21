import { describe, expect, it } from 'vitest';
import { CreateVaultEntryBody, SetVaultTotpBody } from '../contracts/vault.js';
import {
  parseVaultTotp,
  VAULT_TOTP_DEFAULTS,
  VAULT_TOTP_PROBLEM_TEXT,
  vaultBase32Decode,
  vaultTotpCanonical,
  vaultTotpCounter,
  vaultTotpCounterBytes,
  vaultTotpProblem,
  vaultTotpTruncate,
} from './totp.js';

/** RFC 6238's SHA-1 seed, "12345678901234567890", in base32. */
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const hex = (text: string) => Uint8Array.from(text.match(/../g) ?? [], (b) => Number.parseInt(b, 16));

describe('an authenticator key', () => {
  it('reads a setup key as sites show it, with the defaults', () => {
    const parsed = parseVaultTotp(' gezd gnbv-gy3t qojq gezd gnbv gy3t qojq== ');
    expect(parsed).toEqual({ ok: true, totp: { secret: RFC_SECRET, ...VAULT_TOTP_DEFAULTS } });
  });

  it('reads an otpauth:// link with its algorithm, digits and period', () => {
    const parsed = parseVaultTotp(
      `otpauth://totp/GitHub:mara?secret=${RFC_SECRET.toLowerCase()}&issuer=GitHub&algorithm=SHA256&digits=8&period=60`,
    );
    expect(parsed).toEqual({
      ok: true,
      totp: { secret: RFC_SECRET, algorithm: 'SHA256', digits: 8, period: 60 },
    });
    expect(parseVaultTotp(`otpauth://totp/x?secret=${RFC_SECRET}`)).toMatchObject({
      ok: true,
      totp: { algorithm: 'SHA1', digits: 6, period: 30 },
    });
  });

  it('refuses what isn’t a time-based key', () => {
    const problem = (text: string) => {
      const parsed = parseVaultTotp(text);
      return parsed.ok ? null : parsed.problem;
    };
    expect(problem('')).toBe('empty');
    expect(problem(`otpauth://hotp/x?secret=${RFC_SECRET}&counter=1`)).toBe('notTotp');
    expect(problem('otpauth://totp/x?issuer=GitHub')).toBe('link');
    expect(problem('not a key 0189')).toBe('key');
    expect(problem('JBSWY3DPEHPK3PX')).toBe('short');
    expect(problem('A'.repeat(200))).toBe('long');
    expect(problem(`otpauth://totp/x?secret=${RFC_SECRET}&algorithm=MD5`)).toBe('algorithm');
    expect(problem(`otpauth://totp/x?secret=${RFC_SECRET}&digits=4`)).toBe('digits');
    expect(problem(`otpauth://totp/x?secret=${RFC_SECRET}&period=1`)).toBe('period');
    expect(vaultTotpProblem('nope!')).toBe(VAULT_TOTP_PROBLEM_TEXT.key);
    expect(vaultTotpProblem(RFC_SECRET)).toBeNull();
  });

  it('seals one form, which reads back the same', () => {
    const parsed = parseVaultTotp(
      `otpauth://totp/a?secret=${RFC_SECRET}&digits=8&period=60&algorithm=sha512`,
    );
    if (!parsed.ok) throw new Error(parsed.message);
    const canonical = vaultTotpCanonical(parsed.totp);
    expect(canonical.startsWith('otpauth://totp/')).toBe(true);
    expect(parseVaultTotp(canonical)).toEqual(parsed);
  });

  it('decodes base32', () => {
    expect(String.fromCharCode(...vaultBase32Decode(RFC_SECRET))).toBe('12345678901234567890');
  });

  it('counts time steps as RFC 6238 does', () => {
    expect(vaultTotpCounter(59_000, 30)).toBe(1);
    expect(vaultTotpCounter(1_111_111_109_000, 30)).toBe(0x23523ec);
    expect([...vaultTotpCounterBytes(0x23523ec)]).toEqual([0, 0, 0, 0, 0x02, 0x35, 0x23, 0xec]);
  });

  it('truncates an HMAC to a code (RFC 4226 appendix D)', () => {
    expect(vaultTotpTruncate(hex('cc93cf18508d94934c64b65d8ba7667fb7cde4b0'), 6)).toBe('755224');
    expect(vaultTotpTruncate(hex('75a48a19d4cbe100644e8ac1397eea747a2d33ab'), 6)).toBe('287082');
    expect(vaultTotpTruncate(hex('0bacb7fa082fef30782211938bc1c5e70416ff44'), 6)).toBe('359152');
  });

  it('is settable on a website login only', () => {
    const login = {
      name: 'GitHub',
      kind: 'login',
      url: 'https://github.com/login',
      auth: { type: 'form', username: 'mara' },
      secret: 'hunter22',
    } as const;
    expect(CreateVaultEntryBody.safeParse({ ...login, totp: RFC_SECRET }).success).toBe(true);
    expect(CreateVaultEntryBody.safeParse({ ...login, totp: 'nope!' }).success).toBe(false);
    const token = CreateVaultEntryBody.safeParse({
      name: 'Cloudflare',
      kind: 'http',
      url: 'https://api.cloudflare.com',
      auth: { type: 'bearer' },
      secret: 'abc',
      totp: RFC_SECRET,
    });
    expect(token.success).toBe(false);
    expect(token.error?.issues.map((i) => i.path.join('.'))).toContain('totp');
    expect(SetVaultTotpBody.parse({ totp: null })).toEqual({ totp: null });
    expect(SetVaultTotpBody.safeParse({ totp: `otpauth://totp/x?secret=${RFC_SECRET}` }).success).toBe(true);
    expect(SetVaultTotpBody.safeParse({ totp: '' }).success).toBe(false);
  });
});
