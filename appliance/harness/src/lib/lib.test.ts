import { describe, expect, it } from 'vitest';
import { base32, claimSecretHash, claimUrl, displaySecret, normalizeSecret } from '../dev/provision.ts';
import { fakeStorePath, schemaRange } from '../manifest/product.ts';
import { percentiles } from '../scenario-kit/report.ts';

describe('provisioning twin (IN-08)', () => {
  it('claim secret: 128 bits as 26 RFC 4648 base32 characters', () => {
    expect(base32(new Uint8Array(16))).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(base32(new Uint8Array(16).fill(255))).toMatch(/^[A-Z2-7]{26}$/);
    expect(base32(new TextEncoder().encode('foobar'))).toBe('MZXW6YTBOI'); // RFC 4648 §10
  });
  it('claim hash matches provisioning claim.SecretHash (domain tag, device id, normalized, b64url)', () => {
    // Independently: printf 'whombat-claim-secret/1\nwb-test\nABCD' | openssl dgst -sha256 -binary | base64url
    const h = claimSecretHash('wb-test', 'ab-cd');
    expect(h).toBe('3T2kdTDw28Ol8BumW6U5mOcWPbwb9USBweCsVjXNwBQ');
    expect(h).toBe(claimSecretHash('wb-test', 'ABCD'));
    expect(h).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h).not.toBe(claimSecretHash('wb-other', 'ABCD'));
  });
  it('card rendering', () => {
    expect(normalizeSecret(' abcd-efgh ')).toBe('ABCDEFGH');
    expect(displaySecret('ABCDEFGHIJ')).toBe('ABCD-EFGH-IJ');
    expect(claimUrl('http://localhost:5190/claim', 'wb-1', '12D3KooWx', 'abcd')).toBe(
      'http://localhost:5190/claim#v=1&d=wb-1&p=12D3KooWx&s=ABCD',
    );
  });
});

describe('manifest (IN-03)', () => {
  it('placeholder store paths are valid Nix store paths and deterministic', () => {
    const p = fakeStorePath('whombat-runtime-x');
    expect(p).toMatch(/^\/nix\/store\/[0-9a-df-np-sv-z]{32}-whombat-runtime-x$/);
    expect(fakeStorePath('whombat-runtime-x')).toBe(p);
  });
  it('schema versions are journal positions', () => {
    const compat = JSON.stringify({
      runtime: { readsFrom: '0001_b', writesFrom: '0002_c' },
      migrations: { '0000_a': {}, '0001_b': {}, '0002_c': {} },
    });
    expect(schemaRange(compat)).toEqual({ reads: 2, writes: 3 });
  });
  it('schema versions number on from the chain’s schemaBase', () => {
    // A chain whose baseline stands for an earlier chain's 76 migrations: its baseline is 77, the next 78.
    const compat = JSON.stringify({
      schemaBase: 76,
      runtime: { readsFrom: '0000_baseline', writesFrom: '0001_next' },
      migrations: { '0000_baseline': {}, '0001_next': {} },
    });
    expect(schemaRange(compat)).toEqual({ reads: 77, writes: 78 });
  });
});

describe('percentiles', () => {
  it('nearest rank', () => {
    const p = percentiles(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(p).toMatchObject({ n: 100, p50: 50, p95: 95, p99: 99, max: 100 });
  });
});

describe('fixture versions (IN-29)', () => {
  it('sort above the base, contract above expand', async () => {
    const { fixtureVersion } = await import('../dev/fixtures.ts');
    expect(fixtureVersion('0.1.0', 'expand')).toBe('0.1.1-fixture.1.expand');
    expect(fixtureVersion('0.1.0', 'contract')).toBe('0.1.1-fixture.2.contract');
    expect(() => fixtureVersion('dev', 'expand')).toThrow();
  });
});
