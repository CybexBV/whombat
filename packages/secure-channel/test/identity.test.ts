import { chmod, mkdtemp, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairFromSeed, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { describe, expect, it } from 'vitest';
import {
  deserializeIdentity,
  fingerprint,
  generateIdentity,
  generateWebCryptoIdentity,
  loadOrCreateIdentity,
  MemoryKeyStore,
  normalizeFingerprint,
  parsePeerId,
  peerIdFromEd25519PublicKey,
  serializeIdentity,
} from '../src/index.js';
import { FileKeyStore } from '../src/node/index.js';
import { connectPair, dec, enc } from './support.js';

describe('identity', () => {
  it('generates Ed25519 identities with libp2p PeerIds and round-trips serialization', async () => {
    const id = await generateIdentity();
    expect(id.peerId).toMatch(/^12D3KooW[1-9A-HJ-NP-Za-km-z]{44}$/);
    expect(id.publicKey.byteLength).toBe(32);
    expect(peerIdFromEd25519PublicKey(id.publicKey)).toBe(id.peerId);
    const bytes = serializeIdentity(id);
    const back = deserializeIdentity(bytes);
    expect(back.peerId).toBe(id.peerId);
    expect(parsePeerId(id.peerId).type).toBe('Ed25519');
    expect(() => deserializeIdentity(new Uint8Array([1, 2, 3]))).toThrow(/not a valid/);
    expect(() => parsePeerId('QmNotAPeer')).toThrow();
  });

  it('formats a stable 125-bit claim-card fingerprint and normalizes typed input', async () => {
    const id = await generateIdentity();
    const fp = fingerprint(id.peerId);
    expect(fp).toMatch(/^[A-Z2-7]{5}(-[A-Z2-7]{5}){4}$/);
    expect(fingerprint(id.peerId)).toBe(fp);
    expect(fingerprint((await generateIdentity()).peerId)).not.toBe(fp);
    expect(normalizeFingerprint(fp.toLowerCase().replaceAll('-', ' '))).toBe(fp);
    expect(() => normalizeFingerprint('ABC')).toThrow();
  });

  it('matches the fingerprint known-answer vector (for the Go claim-card printer)', async () => {
    // Ed25519 seed 00 01 .. 1f. Cross-checked with an independent Python hashlib/base64 computation.
    const key = await generateKeyPairFromSeed(
      'Ed25519',
      new Uint8Array(32).map((_, i) => i),
    );
    const id = deserializeIdentity(privateKeyToProtobuf(key));
    expect(Buffer.from(id.publicKey).toString('hex')).toBe(
      '03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8',
    );
    expect(id.peerId).toBe('12D3KooWA4Xop1JaT3MHxwYMkCepYsv4iPVopMXwCz5iHYdBfeSB');
    expect(fingerprint(id.peerId)).toBe('KDTHE-HLBVV-XVMQ2-JPJX6-CMTJX');
  });

  it('WebCrypto identities are non-extractable and complete a handshake', async () => {
    const { identity: client } = await generateWebCryptoIdentity();
    const { identity: appliance } = await generateWebCryptoIdentity();
    expect(client.extractable).toBe(false);
    expect(() => serializeIdentity(client)).toThrow(/non-extractable/);
    expect(() => client.privateKey.raw).toThrow();
    const { c, a } = await connectPair({ client, appliance });
    expect(a.remotePeerId).toBe(client.peerId);
    await c.send(enc('webcrypto'));
    expect(dec(await a.receive())).toBe('webcrypto');
    await c.close();
  });
});

describe('key stores', () => {
  it('concurrent processes creating the same key all end up with the identity on disk (review L-4)', async () => {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const worker = fileURLToPath(new URL('./fixtures/keystore-worker.ts', import.meta.url));
    const tsx = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));
    for (let round = 0; round < 6; round++) {
      const base = await mkdtemp(join(tmpdir(), 'wb-keystore-race-'));
      const dir = join(base, 'identity');
      const go = join(base, 'go');
      const ready: Promise<void>[] = [];
      const runs = Array.from({ length: 6 }, () => {
        let isReady: () => void = () => {};
        ready.push(new Promise<void>((r) => (isReady = r)));
        return new Promise<string>((resolve, reject) => {
          const p = spawn(tsx, [worker, dir, go], { stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '';
          let err = '';
          p.stdout.on('data', (d) => {
            out += d;
            if (out.startsWith('ready\n')) isReady();
          });
          p.stderr.on('data', (d) => {
            err += d;
          });
          p.on('exit', (code) =>
            code === 0 ? resolve(out.slice('ready\n'.length)) : reject(new Error(err)),
          );
        });
      });
      // Every worker is loaded and polling before the race starts (and one that failed lets the others go).
      await Promise.race([Promise.all(ready), Promise.all(runs)]).finally(() => writeFile(go, ''));
      const ids = await Promise.all(runs);
      const onDisk = (await new FileKeyStore(dir).get('content'))?.peerId;
      expect(new Set(ids)).toEqual(new Set([onDisk]));
      expect(await readdir(dir)).toEqual(['content.key']);
    }
  }, 60_000);

  it('memory store refuses to overwrite a different identity', async () => {
    const store = new MemoryKeyStore();
    const a = await loadOrCreateIdentity(store, 'endpoint');
    expect((await loadOrCreateIdentity(store, 'endpoint')).peerId).toBe(a.peerId);
    await expect(store.put('endpoint', await generateIdentity())).rejects.toMatchObject({
      code: 'KEY_STORE',
    });
    await expect(store.get('../x')).rejects.toMatchObject({ code: 'KEY_STORE' });
  });

  it('file store writes 0600 files in a 0700 directory and fails closed on unsafe files', async () => {
    const base = await mkdtemp(join(tmpdir(), 'wb-keystore-'));
    const dir = join(base, 'identity');
    const store = new FileKeyStore(dir);
    const id = await loadOrCreateIdentity(store, 'content');
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'content.key'))).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['content.key']);
    expect((await new FileKeyStore(dir).get('content'))?.peerId).toBe(id.peerId);
    await expect(store.put('content', await generateIdentity())).rejects.toMatchObject({ code: 'KEY_STORE' });
    await store.put('content', id);
    expect(await store.get('missing')).toBeUndefined();

    await chmod(join(dir, 'content.key'), 0o644);
    await expect(store.get('content')).rejects.toThrow(/expected 600/);
    await chmod(join(dir, 'content.key'), 0o600);

    await writeFile(join(base, 'elsewhere.key'), serializeIdentity(id), { mode: 0o600 });
    await symlink(join(base, 'elsewhere.key'), join(dir, 'linked.key'));
    await expect(store.get('linked')).rejects.toThrow(/not a regular file/);

    // A key file is ~68 bytes; anything above 4 KiB is refused before reading it.
    await writeFile(join(dir, 'huge.key'), new Uint8Array(8192), { mode: 0o600 });
    await expect(store.get('huge')).rejects.toThrow(/too large/);

    await store.delete('content');
    expect(await store.get('content')).toBeUndefined();
  });
});
