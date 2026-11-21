/** Release signatures (docs/decisions/bp-distribution.md BP-F20; SEC2-F5). */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RELEASE_KEYS } from './keys';
import { generateReleaseKey, readReleaseKey, releaseKeyId, signSums, verifySums } from './signature';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whombat-sig-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SUMS = Buffer.from(`${'a'.repeat(64)}  whombat-0.1.0-linux-x64.tar.gz\n`);

describe('release signatures', () => {
  it('a signature checks out with its key only, and only for the exact bytes', () => {
    const a = generateReleaseKey();
    const b = generateReleaseKey();
    const sig = signSums(SUMS, a.privatePem);
    expect(sig).toHaveLength(64);
    expect(verifySums(SUMS, sig, [b.key, a.key])).toEqual(a.key);
    expect(verifySums(SUMS, sig, [b.key])).toBeNull();
    expect(verifySums(Buffer.from(SUMS.toString().replace('0.1.0', '0.1.1')), sig, [a.key])).toBeNull();
    expect(verifySums(SUMS, sig.subarray(0, 63), [a.key])).toBeNull();
    expect(verifySums(SUMS, sig, [{ id: 'x', publicKey: 'not a key' }])).toBeNull();
    expect(verifySums(SUMS, sig, [])).toBeNull();
  });

  it('reads a key as PEM public, PEM private or pinned base64', () => {
    const k = generateReleaseKey();
    writeFileSync(join(dir, 'pub.pem'), k.publicPem);
    writeFileSync(join(dir, 'key.pem'), k.privatePem);
    writeFileSync(join(dir, 'pinned.txt'), `${k.key.publicKey}\n`);
    for (const f of ['pub.pem', 'key.pem', 'pinned.txt'])
      expect(readReleaseKey(join(dir, f))).toMatchObject({ publicKey: k.key.publicKey, id: k.key.id });
    expect(k.key.id).toBe(releaseKeyId(k.key.publicKey));
    writeFileSync(join(dir, 'rsa.pem'), 'nonsense');
    expect(() => readReleaseKey(join(dir, 'rsa.pem'))).toThrow(/isn’t an Ed25519 key/);
  });

  it('is what OpenSSL verifies (the documented check before a first install)', () => {
    let openssl = true;
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' });
    } catch {
      openssl = false;
    }
    if (!openssl) return;
    const k = generateReleaseKey();
    writeFileSync(join(dir, 'SHA256SUMS'), SUMS);
    writeFileSync(join(dir, 'SHA256SUMS.sig'), signSums(SUMS, k.privatePem));
    writeFileSync(join(dir, 'pub.pem'), k.publicPem);
    const out = execFileSync(
      'openssl',
      [
        'pkeyutl',
        '-verify',
        '-pubin',
        '-inkey',
        'pub.pem',
        '-rawin',
        '-in',
        'SHA256SUMS',
        '-sigfile',
        'SHA256SUMS.sig',
      ],
      { cwd: dir, encoding: 'utf8' },
    );
    expect(out).toMatch(/Signature Verified Successfully/);
  });

  it('no test or placeholder key is pinned', () => {
    // A pinned key must be the project's release key; this build pins none yet (keys.ts).
    for (const key of RELEASE_KEYS) {
      expect(Buffer.from(key.publicKey, 'base64')).toHaveLength(32);
      expect(key.note ?? '').not.toMatch(/test|dev|placeholder|local/i);
    }
  });
});
