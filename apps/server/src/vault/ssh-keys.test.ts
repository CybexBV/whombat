import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { vaultEntryKey, vaultSshFingerprint } from '@whombat/core';
import ssh2 from 'ssh2';
import { describe, expect, it } from 'vitest';
import { sshKeyPair } from '../test/ssh-keys';
import { CheckedTail, dropFormHead, hostKeyOf, SSH_ALGORITHMS } from './ssh';
import {
  alignedBase64,
  forgetPassphrase,
  generateSshKey,
  holdsSshKey,
  importSshKey,
  rawPrivateNumbers,
  rememberPassphrase,
  SSH_KEY_BCRYPT_ROUNDS_MAX,
  SSH_KEY_TOO_SLOW_TEXT,
  sshKeyForms,
  sshKeyWorkProblem,
} from './ssh-keys';

const { utils } = ssh2;
const ENTRY = 'vlt_01hzzzzzzzzzzzzzzzzzzzzzzz';

function parse(text: string) {
  const parsed = utils.parseKey(text);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || key instanceof Error) throw new Error(`unreadable: ${String(key)}`);
  return key;
}

describe('generated keys (docs/decisions/vault.md VT-S03, VT-D43)', () => {
  it('makes an ed25519 OpenSSH key ssh2 reads back, with the entry’s comment, and signs with it', () => {
    const made = generateSshKey(ENTRY);
    expect(made.auth).toMatchObject({ type: 'ssh_key', keyType: 'ed25519', origin: 'generated' });
    expect(made.auth.fingerprint).toBe(vaultSshFingerprint(made.auth.publicKey));
    expect(made.privateKey).toMatch(
      /^-----BEGIN OPENSSH PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END OPENSSH PRIVATE KEY-----\n$/,
    );
    const key = parse(made.privateKey);
    expect(key.comment).toBe(`whombat-${vaultEntryKey(ENTRY)}`);
    expect(`${key.type} ${key.getPublicSSH().toString('base64')}`).toBe(made.auth.publicKey);
    const signature = key.sign(Buffer.from('data'));
    expect(signature).toBeInstanceOf(Buffer);
    expect(key.verify(Buffer.from('data'), signature as Buffer)).toBe(true);
    expect(generateSshKey(ENTRY).auth.publicKey).not.toBe(made.auth.publicKey);
  });
});

describe('imported keys (VT-S03)', () => {
  it('keeps the same key pair whatever the format it came in', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const a = importSshKey(ENTRY, pkcs1);
    const b = importSshKey(ENTRY, pkcs8);
    if (!a.ok || !b.ok) throw new Error('refused');
    expect(a.key.auth.publicKey).toBe(b.key.auth.publicKey);
    expect(a.key.auth).toMatchObject({ keyType: 'rsa', origin: 'imported' });
    // The stored key is the same private key: Node and ssh2 agree on its public half.
    const back = parse(a.key.privateKey);
    expect(createPrivateKey(back.getPrivatePEM()).export({ format: 'jwk' }).n).toBe(
      privateKey.export({ format: 'jwk' }).n,
    );
  });

  it('reads ECDSA P-256, P-384 and P-521 with their padded points', () => {
    for (const [curve, algorithm] of [
      ['P-256', 'ecdsa-sha2-nistp256'],
      ['P-384', 'ecdsa-sha2-nistp384'],
      ['P-521', 'ecdsa-sha2-nistp521'],
    ] as const) {
      for (let i = 0; i < 4; i++) {
        const pem = generateKeyPairSync('ec', { namedCurve: curve })
          .privateKey.export({ type: 'sec1', format: 'pem' })
          .toString();
        const made = importSshKey(ENTRY, pem);
        if (!made.ok) throw new Error(made.message);
        expect(made.key.auth.publicKey.startsWith(`${algorithm} `)).toBe(true);
        const key = parse(made.key.privateKey);
        const sig = key.sign(
          Buffer.from('x'),
          curve === 'P-256' ? 'sha256' : curve === 'P-384' ? 'sha384' : 'sha512',
        );
        expect(sig).toBeInstanceOf(Buffer);
      }
    }
  });

  it('refuses short RSA, other curves, DSA and broken text', () => {
    const short = generateKeyPairSync('rsa', { modulusLength: 1024 })
      .privateKey.export({ type: 'pkcs1', format: 'pem' })
      .toString();
    expect(importSshKey(ENTRY, short)).toMatchObject({
      ok: false,
      code: 'rsa_too_short',
      field: 'privateKey',
    });
    const k1 = generateKeyPairSync('ec', { namedCurve: 'secp256k1' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    expect(importSshKey(ENTRY, k1)).toMatchObject({ ok: false, code: 'unsupported_type' });
    const ed448 = generateKeyPairSync('ed448').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(importSshKey(ENTRY, ed448)).toMatchObject({ ok: false, code: 'unsupported_type' });
    expect(importSshKey(ENTRY, 'hello')).toMatchObject({ ok: false, code: 'not_a_key' });
    const garbled = '-----BEGIN PRIVATE KEY-----\nAAAAAAAA\n-----END PRIVATE KEY-----\n';
    expect(importSshKey(ENTRY, garbled)).toMatchObject({ ok: false, field: 'privateKey' });
  });

  it('asks for a passphrase, refuses a wrong one, and opens encrypted PEM keys', () => {
    const pem = generateKeyPairSync('ed25519')
      .privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'open sesame' })
      .toString();
    expect(importSshKey(ENTRY, pem)).toMatchObject({
      ok: false,
      code: 'passphrase_needed',
      field: 'passphrase',
    });
    expect(importSshKey(ENTRY, pem, 'not this one')).toMatchObject({ ok: false, code: 'wrong_passphrase' });
    expect(importSshKey(ENTRY, pem, 'open sesame')).toMatchObject({ ok: true });
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-128-cbc', passphrase: 'open sesame' })
      .toString();
    expect(importSshKey(ENTRY, rsa)).toMatchObject({ ok: false, code: 'passphrase_needed' });
    expect(importSshKey(ENTRY, rsa, 'nope nope')).toMatchObject({ ok: false, code: 'wrong_passphrase' });
    expect(importSshKey(ENTRY, rsa, 'open sesame')).toMatchObject({ ok: true });
  });

  it('calls a wrong passphrase wrong even when it decrypts to another kind of key (TS-05)', () => {
    // This wrong passphrase decrypts the key to bytes Node reads as an unsupported key (about one in 200 do).
    const pem = [
      '-----BEGIN ENCRYPTED PRIVATE KEY-----',
      'MIGjMF8GCSqGSIb3DQEFDTBSMDEGCSqGSIb3DQEFDDAkBBAjmc1Rbwohmm2TT8M7',
      'bWYAAgIIADAMBggqhkiG9w0CCQUAMB0GCWCGSAFlAwQBKgQQ7N8pBAEqaG3Do9E3',
      'rcnMfgRAojfX8cQWJN60KEbgGJUS+s5PKGLMmDbDOQIi0T82aNR0E5Bac7JrUYrK',
      'x7o/UQF3SFl1gYod9DPmwCCMSUs5jg==',
      '-----END ENCRYPTED PRIVATE KEY-----',
      '',
    ].join('\n');
    expect(importSshKey(ENTRY, pem, 'wrong 209')).toMatchObject({ ok: false, code: 'wrong_passphrase' });
    expect(importSshKey(ENTRY, pem, 'open sesame')).toMatchObject({ ok: true });
  });

  it('refuses a key whose passphrase protection would hold the server’s thread, before any KDF runs (VT-D55)', () => {
    // An OpenSSH key asking for 2^32 − 1 bcrypt rounds (ssh2's pure-JS bcrypt: ~8 ms a round, i.e. a year).
    const pair = sshKeyPair('ed25519', {
      passphrase: 'open sesame',
      cipher: 'aes256-ctr',
      rounds: 16,
    });
    const withRounds = (rounds: number) => {
      const lines = pair.private.trim().split('\n');
      const body = Buffer.from(lines.slice(1, -1).join(''), 'base64');
      // magic (15) · string cipher · string kdf · string kdfoptions (string salt · uint32 rounds)
      let p = 15;
      for (let i = 0; i < 2; i++) p += 4 + body.readUInt32BE(p);
      const salt = body.readUInt32BE(p + 4);
      body.writeUInt32BE(rounds, p + 8 + salt);
      const b64 = body.toString('base64').match(/.{1,70}/g) ?? [];
      return `${lines[0]}\n${b64.join('\n')}\n${lines.at(-1)}\n`;
    };
    const started = Date.now();
    for (const rounds of [0xffffffff, SSH_KEY_BCRYPT_ROUNDS_MAX + 1])
      expect(importSshKey(ENTRY, withRounds(rounds), 'open sesame')).toEqual({
        ok: false,
        code: 'unreadable',
        field: 'privateKey',
        message: SSH_KEY_TOO_SLOW_TEXT,
      });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(importSshKey(ENTRY, withRounds(16), 'open sesame')).toMatchObject({ ok: true });
    // What is checked is what ssh2 opens: a body Node's lenient base64 would read differently is refused unread.
    // (ssh2 reads a line with a colon in it, skipping the colon; a reader that drops such lines sees other bytes.)
    const huge = withRounds(0xffffffff).split('\n');
    huge[2] = `${huge[2]?.slice(0, 10)}:${huge[2]?.slice(10)}`;
    const smuggled = huge.join('\n');
    expect(sshKeyWorkProblem(smuggled, 'openssh')).toBe('unreadable');
    const before = Date.now();
    expect(importSshKey(ENTRY, smuggled, 'open sesame')).toMatchObject({ ok: false, field: 'privateKey' });
    expect(importSshKey(ENTRY, withRounds(16).replace(/\n(.)/, '\n*$1'), 'open sesame')).toMatchObject({
      ok: false,
      field: 'privateKey',
    });
    expect(Date.now() - before).toBeLessThan(1000);

    // A PKCS#8 key asking for 2^31 − 1 PBKDF2 iterations, and one derived with scrypt.
    const der = (tag: number, ...parts: Buffer[]) => {
      const content = Buffer.concat(parts);
      const n = content.length;
      const length = n < 0x80 ? Buffer.from([n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
      return Buffer.concat([Buffer.from([tag]), length, content]);
    };
    const oid = (hex: string) => der(0x06, Buffer.from(hex, 'hex'));
    const encrypted = (kdf: Buffer) =>
      `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${(
        der(
          0x30,
          der(
            0x30,
            oid('2a864886f70d01050d'),
            der(0x30, kdf, der(0x30, oid('60864801650304012a'), der(0x04, Buffer.alloc(16, 1)))),
          ),
          der(0x04, Buffer.alloc(48, 2)),
        )
          .toString('base64')
          .match(/.{1,64}/g) ?? []
      ).join('\n')}\n-----END ENCRYPTED PRIVATE KEY-----\n`;
    const pbkdf2 = (iterations: Buffer) =>
      der(
        0x30,
        oid('2a864886f70d01050c'),
        der(
          0x30,
          der(0x04, Buffer.alloc(8, 3)),
          der(0x02, iterations),
          der(0x30, oid('2a864886f70d0209'), der(0x05)),
        ),
      );
    const scrypt = der(
      0x30,
      oid('2b06010401da47040b'),
      der(
        0x30,
        der(0x04, Buffer.alloc(8, 3)),
        der(0x02, Buffer.from([0x40, 0])),
        der(0x02, Buffer.from([8])),
        der(0x02, Buffer.from([1])),
      ),
    );
    const again = Date.now();
    for (const pem of [encrypted(pbkdf2(Buffer.from([0x7f, 0xff, 0xff, 0xff]))), encrypted(scrypt)])
      expect(importSshKey(ENTRY, pem, 'open sesame')).toMatchObject({
        ok: false,
        message: SSH_KEY_TOO_SLOW_TEXT,
      });
    expect(Date.now() - again).toBeLessThan(1000);
    // Within the limit it is OpenSSL's to open (here: a wrong passphrase for made-up ciphertext).
    expect(importSshKey(ENTRY, encrypted(pbkdf2(Buffer.from([0x08, 0]))), 'open sesame')).toMatchObject({
      ok: false,
      code: 'wrong_passphrase',
    });
  });
});

describe('forms of a key (VT-S10, VT-D44)', () => {
  const made = generateSshKey(ENTRY);
  const forms = sshKeyForms(ENTRY, made.privateKey);

  it('finds the key text, any private line, the raw seed and the same key in another layout', () => {
    expect(holdsSshKey(made.privateKey, forms)).toBe(true);
    const lines = made.privateKey.split('\n').filter((l) => l && !l.startsWith('-----'));
    expect(holdsSshKey(`x ${lines.at(-1)} y`, forms)).toBe((lines.at(-1) ?? '').length >= 24);
    expect(holdsSshKey(`x ${lines[2]} y`, forms)).toBe(true);
    const [seed] = rawPrivateNumbers(made.privateKey);
    expect(holdsSshKey(`seed=${seed}`, forms)).toBe(true);
    const pkcs8 = createPrivateKey(parse(made.privateKey).getPrivatePEM())
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    expect(holdsSshKey(pkcs8, forms)).toBe(true);
    // The public key and an unrelated key are not the key.
    expect(holdsSshKey(made.auth.publicKey, forms)).toBe(false);
    expect(holdsSshKey(generateSshKey(ENTRY).privateKey, forms)).toBe(false);
  });

  it('looks for a passphrase seen at import until it is forgotten', () => {
    rememberPassphrase(ENTRY, 'a long passphrase');
    expect(holdsSshKey('echo a long passphrase', sshKeyForms(ENTRY, made.privateKey))).toBe(true);
    forgetPassphrase(ENTRY);
    expect(holdsSshKey('echo a long passphrase', sshKeyForms(ENTRY, made.privateKey))).toBe(false);
    rememberPassphrase(ENTRY, 'short');
    expect(holdsSshKey('short', sshKeyForms(ENTRY, made.privateKey))).toBe(false);
  });

  it('aligns raw bytes at every offset of a longer base64 text', () => {
    const bytes = Buffer.from('0123456789abcdefghijklmnopqrstuv');
    for (const pad of [0, 1, 2, 3, 4, 5]) {
      const around = Buffer.concat([Buffer.alloc(pad, 7), bytes, Buffer.alloc(5, 9)]).toString('base64');
      expect(alignedBase64(bytes).some((f) => around.includes(f))).toBe(true);
    }
  });

  it('checks what it keeps whole, whatever the chunks, and sees through UTF-16 (VT-D57)', () => {
    // The key with two spaces after every character, in 16-byte chunks: wider than any overlap window.
    const spread = [...made.privateKey].map((c) => `${c}  `).join('');
    const tail = new CheckedTail(256 * 1024, forms);
    const bytes = Buffer.from(spread);
    for (let i = 0; i < bytes.length; i += 16) tail.push(bytes.subarray(i, i + 16));
    expect(tail.text().text).toBe(spread);
    expect(tail.hit).toBe(true);
    // The key as UTF-16 (`iconv -t UTF-16LE`): its NULs don't hide it.
    expect(holdsSshKey(Buffer.from(made.privateKey, 'utf16le').toString('utf8'), forms)).toBe(true);
  });

  it('checks a stream across chunks and keeps its last bytes without a cut form', () => {
    const tail = new CheckedTail(64, forms);
    const lines = made.privateKey.split('\n');
    const line = lines[3] ?? '';
    tail.push(Buffer.from(`aaa ${line.slice(0, 10)}`));
    expect(tail.hit).toBe(false);
    tail.push(Buffer.from(`${line.slice(10)} bbb`));
    expect(tail.hit).toBe(true);
    const clean = new CheckedTail(8, forms);
    clean.push(Buffer.from('0123456789'));
    expect(clean.text()).toEqual({ text: '23456789', cut: true });
    // An edge only drops eight characters or more: shorter matches are chance, never part of a real form (VT-D59).
    const fixed = { forms: ['ABCDEFGHIJKLMNOPQRSTUVWX'], aligned: [], longest: 24 };
    expect(dropFormHead('WX hello', fixed)).toBe('WX hello');
    expect(dropFormHead('QRSTUVWX hello', fixed)).toBe(' hello');
    expect(dropFormHead(`${line.slice(-30)} ok`, forms)).toBe(' ok');
  });
});

describe('the connection (VT-S05, VT-S09)', () => {
  it('names a host key by its algorithm and SHA256 fingerprint', () => {
    const pub = sshKeyPair('ed25519').public;
    const blob = parse(pub).getPublicSSH();
    expect(hostKeyOf(blob)).toEqual({ algorithm: 'ssh-ed25519', fingerprint: vaultSshFingerprint(pub) });
  });

  it('offers only algorithms ssh2 supports, none of them SHA-1', () => {
    const c = createRequire(import.meta.url)('ssh2/lib/protocol/constants.js') as Record<string, string[]>;
    const supported = {
      kex: c.SUPPORTED_KEX,
      serverHostKey: c.SUPPORTED_SERVER_HOST_KEY,
      cipher: c.SUPPORTED_CIPHER,
      hmac: c.SUPPORTED_MAC,
      compress: c.SUPPORTED_COMPRESSION,
    } as const;
    for (const [kind, names] of Object.entries(SSH_ALGORITHMS)) {
      for (const name of names) {
        expect(supported[kind as keyof typeof supported], `${kind} ${name}`).toContain(name);
        expect(name).not.toMatch(/sha1|^ssh-rsa$|^ssh-dss$/);
      }
    }
  });
});
