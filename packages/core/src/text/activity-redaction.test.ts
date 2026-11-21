import { describe, expect, it } from 'vitest';
import { redactActivitySecrets } from './activity-redaction.js';

describe('activity credential redaction', () => {
  it.each([
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'token [redacted]'],
    ['github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz', '[redacted]'],
    ['OPENAI=sk-proj-abcdefghijklmnop1234', 'OPENAI=[redacted]'],
    ['key sk-ant-api03-abcdefghijklmnopqrstu', 'key [redacted]'],
    ['slack xoxb-1234567890-abcdefghij', 'slack [redacted]'],
    ['aws AKIAIOSFODNN7EXAMPLE here', 'aws [redacted] here'],
    [
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'jwt [redacted]',
    ],
    ['curl -H "Authorization: Bearer abc.def.ghi" x', 'curl -H "Authorization: [redacted]'],
    ['auth Bearer abcdefghijklmnop', 'auth Bearer [redacted]'],
    ['GITHUB_TOKEN=abc123 pnpm x', 'GITHUB_TOKEN=[redacted] pnpm x'],
    ['export DB_PASSWORD="hunter2 two"', 'export DB_PASSWORD=[redacted]'],
    ['{"api_key": "abc", "n": 1}', '{"api_key": [redacted], "n": 1}'],
    ['MY_SECRET_VALUE: s3cr3t', 'MY_SECRET_VALUE: [redacted]'],
    [
      'git clone https://x-access-token:ghs_abc@github.com/o/r',
      'git clone https://[redacted]@github.com/o/r',
    ],
    ['psql postgres://user:pa55@db:5432/x', 'psql postgres://[redacted]@db:5432/x'],
    ['https://short-token@example.test/path', 'https://[redacted]@example.test/path'],
    ['agent wat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'agent [redacted]'],
    ["password='päss word'\nnext line", 'password=[redacted]\nnext line'],
    ['AUTHORIZATION="Custom one two"\nnext line', 'AUTHORIZATION=[redacted]\nnext line'],
  ])('%s', (input, expected) => {
    expect(redactActivitySecrets(input)).toBe(expected);
  });

  const tokenFamilies: [string, number][] = [
    ...['p', 'o', 'u', 's', 'r'].map((kind): [string, number] => [`gh${kind}_`, 20]),
    ['github_pat_', 20],
    ['sk-', 16],
    ...['a', 'b', 'p', 'o', 's', 'r', 'e'].map((kind): [string, number] => [`xox${kind}-`, 10]),
    ...['AKIA', 'ASIA', 'AGPA', 'AIDA', 'AROA', 'ANPA'].map((prefix): [string, number] => [prefix, 16]),
    ...['wat', 'wt', 'ws', 'whk', 'ml'].map((prefix): [string, number] => [`${prefix}_`, 32]),
  ];

  it.each(tokenFamilies)('keeps the %s family length boundary at %i characters', (prefix, length) => {
    const secret = `${prefix}${'A'.repeat(length)}`;
    const shorter = `${prefix}${'A'.repeat(length - 1)}`;
    expect(redactActivitySecrets(`before ${secret} after`)).toBe('before [redacted] after');
    expect(redactActivitySecrets(shorter)).toBe(shorter);
  });

  it.each(['Bearer', 'Basic', 'Token'])('keeps the %s scheme and redacts its value', (scheme) => {
    expect(redactActivitySecrets(`${scheme} abcdefgh`)).toBe(`${scheme} [redacted]`);
    expect(redactActivitySecrets(`${scheme} abcdefg`)).toBe(`${scheme} abcdefg`);
  });

  it('removes a private key block, even one cut off at the end', () => {
    const block =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----';
    expect(redactActivitySecrets(`before\n${block}\nafter`)).toBe('before\n[redacted]\nafter');
    expect(redactActivitySecrets('x -----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA')).toBe('x [redacted]');
  });

  it('redacts all matches on repeated calls without keeping pattern state', () => {
    const first = `ghp_${'A'.repeat(20)}`;
    const second = `ghp_${'B'.repeat(20)}`;
    const input = `first ${first}, second ${second}; DB_PASSWORD='päss two'`;
    const expected = 'first [redacted], second [redacted]; DB_PASSWORD=[redacted]';
    expect(redactActivitySecrets(input)).toBe(expected);
    expect(redactActivitySecrets(input)).toBe(expected);
    expect(redactActivitySecrets(expected)).toBe(expected);
  });

  it('leaves ordinary text, Unicode and whitespace alone', () => {
    const text = 'FAIL src/invoice.test.ts > renders totals (expected 3, got 2)\nCafé · €12 − 🦔\t';
    expect(redactActivitySecrets(text)).toBe(text);
    expect(redactActivitySecrets('')).toBe('');
  });
});
