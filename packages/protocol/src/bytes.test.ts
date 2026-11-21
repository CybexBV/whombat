import { describe, expect, it } from 'vitest';
// Core's strict UTF-8 corpus, so protocol's decoder is held to the same cases and offsets as core's.
import { UTF8_BYTE_LENGTHS, UTF8_INVALID, UTF8_VALID } from '../../core/src/__fixtures__/utf8-corpus.js';
import {
  base64urlDecode,
  ed25519PublicKeyFromPeerId,
  peerIdFromEd25519PublicKey,
  Utf8Error,
  utf8ByteLength,
  utf8Decode,
  utf8Encode,
} from './bytes.js';

describe('bytes', () => {
  it('decodes UTF-8 strictly', () => {
    for (const s of ['', 'abc', 'é€', '𝄞 music', 'x'.repeat(20_000)]) {
      expect(utf8Decode(utf8Encode(s))).toBe(s);
      expect(utf8ByteLength(s)).toBe(utf8Encode(s).length);
    }
    for (const bad of [
      [0xc0, 0x80],
      [0xed, 0xa0, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
      [0xe2, 0x82],
      [0x80],
      [0xff],
    ])
      expect(() => utf8Decode(new Uint8Array(bad))).toThrowError(/invalid UTF-8/);
  });

  it('agrees with the UTF-8 corpus, offsets included', () => {
    for (const c of UTF8_VALID) expect(utf8Decode(c.bytes), c.name).toBe(c.text);
    for (const c of UTF8_INVALID) {
      let error: unknown;
      try {
        utf8Decode(c.bytes);
      } catch (e) {
        error = e;
      }
      expect(error, c.name).toBeInstanceOf(Utf8Error);
      // The offset is the message's last number.
      expect(Number((error as Error).message.match(/(\d+)\D*$/)?.[1]), c.name).toBe(c.offset);
    }
    for (const [text, n] of UTF8_BYTE_LENGTHS) expect(utf8ByteLength(text), JSON.stringify(text)).toBe(n);
  });

  it('decodes base64url strictly', () => {
    expect([...base64urlDecode('AQI')]).toEqual([1, 2]);
    expect(() => base64urlDecode('AQI=')).toThrow();
    expect(() => base64urlDecode('AQ+')).toThrow();
  });
});

describe('PeerIds', () => {
  it('match libp2p for Ed25519 keys', () => {
    // Reference computed with @libp2p/peer-id (peerIdFromPublicKey(publicKeyFromRaw(key))).
    const key = 'c1ac9ebba9e19031eb7fef77aa1d3f410cd3bcfd103ef6b6b8fcad2681628831';
    const bytes = Uint8Array.from(key.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
    expect(peerIdFromEd25519PublicKey(bytes)).toBe('12D3KooWNrPX9JcmH7DQVJDVr2AXRBHGLAE2Bowcs2hFgaBStMDa');
    expect(ed25519PublicKeyFromPeerId('12D3KooWNrPX9JcmH7DQVJDVr2AXRBHGLAE2Bowcs2hFgaBStMDa')).toEqual(bytes);
    expect(ed25519PublicKeyFromPeerId('QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N')).toBeNull();
  });
});
