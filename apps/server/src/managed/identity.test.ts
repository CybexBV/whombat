import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytesToHex, generateKeypair, hexToBytes, signBytes, utf8ToBytes } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { loadContentIdentity, peerIdFromEd25519PublicKey, verifyEd25519Strict } from './identity';

// A test vector from a public seed, never a real box's key. Computed with @libp2p/crypto
// (`generateKeyPairFromSeed('Ed25519', SEED)`, `privateKeyToProtobuf`) and @libp2p/peer-id (`peerIdFromPrivateKey`).
const SEED = utf8ToBytes('whombat content key test vector!');
const PUBLIC_KEY = '3d63dfe0ce873133a7e47974154bfdf65b7f1f73fe8eab9c207f390235db7068';
const PEER_ID = '12D3KooWDx1NHu9Mv4arCv533dfNXwqLdKU2Bmk1W4SJMHF2QaLF';

describe('identities', () => {
  it('matches libp2p: the key file and PeerId written by @libp2p/crypto + @libp2p/peer-id', () => {
    // The libp2p protobuf of an Ed25519 private key: type 1, then 64 bytes of seed || public key.
    const file = join(mkdtempSync(join(tmpdir(), 'content-key-')), 'content.key');
    writeFileSync(file, new Uint8Array([0x08, 0x01, 0x12, 0x40, ...SEED, ...hexToBytes(PUBLIC_KEY)]));
    const id = loadContentIdentity(file);
    expect({ peerId: id.peerId, publicKey: bytesToHex(id.publicKey) }).toEqual({
      peerId: PEER_ID,
      publicKey: PUBLIC_KEY,
    });
    expect(SEED).toHaveLength(32);
    expect(peerIdFromEd25519PublicKey(id.publicKey)).toBe(id.peerId);
  });

  it('verifies Ed25519 strictly', () => {
    const pair = generateKeypair();
    const msg = utf8ToBytes('whombat');
    const sig = signBytes(msg, pair.secretKey);
    expect(verifyEd25519Strict(sig, msg, pair.publicKey)).toBe(true);
    expect(verifyEd25519Strict(sig, utf8ToBytes('other'), pair.publicKey)).toBe(false);
    expect(verifyEd25519Strict('00'.repeat(64), msg, pair.publicKey)).toBe(false);
  });
});
