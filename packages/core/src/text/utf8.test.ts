import { describe, expect, it } from 'vitest';
import { UTF8_BYTE_LENGTHS, UTF8_INVALID, UTF8_VALID } from '../__fixtures__/utf8-corpus.js';
import { utf8Decode as backupUtf8Decode } from '../backup/bytes.js';
import { utf8ByteLength } from '../domain/signins.js';
import { decodeDropPlaintext, encodeDropPlaintext, FeedbackDropError } from '../feedback/drop.js';
import { decodeText } from '../skills/files.js';
import { decodeUtf8, decodeUtf8OrNull, utf8ByteLength as sharedUtf8ByteLength } from './utf8.js';

/** A feedback drop plaintext carrying exactly `bytes` (its padding comes from the length alone). */
function dropPlaintext(bytes: Uint8Array): Uint8Array {
  const padded = encodeDropPlaintext('x'.repeat(bytes.length));
  padded.set(bytes, 4);
  return padded;
}

const BOM = [0xef, 0xbb, 0xbf];

describe('strict UTF-8 in core', () => {
  it('reports where malformed bytes fail', () => {
    for (const c of UTF8_VALID) expect(decodeUtf8(c.bytes), c.name).toBe(c.text);
    for (const c of UTF8_INVALID) expect(decodeUtf8(c.bytes), c.name).toEqual({ offset: c.offset });
  });

  it('decodes every valid case to its text', () => {
    for (const c of UTF8_VALID) {
      expect(decodeUtf8OrNull(c.bytes), c.name).toBe(c.text);
      expect(backupUtf8Decode(c.bytes), c.name).toBe(c.text);
      expect(decodeDropPlaintext(dropPlaintext(c.bytes)), c.name).toBe(c.text);
    }
  });

  it('refuses every malformed case', () => {
    for (const c of UTF8_INVALID) {
      expect(decodeUtf8OrNull(c.bytes), c.name).toBeNull();
      expect(backupUtf8Decode(c.bytes), c.name).toBeNull();
      expect(() => decodeDropPlaintext(dropPlaintext(c.bytes)), c.name).toThrow(FeedbackDropError);
      expect(decodeText(c.bytes), c.name).toBeNull();
    }
  });

  it('reads a skill file without its leading byte order mark and refuses NUL', () => {
    for (const c of UTF8_VALID) {
      const expected = c.text.includes('\u0000') ? null : c.text.replace(/^\ufeff/, '');
      expect(decodeText(c.bytes), c.name).toBe(expected);
    }
    expect(decodeText(Uint8Array.from([...BOM, 0x68, 0x69]))).toBe('hi');
    expect(decodeText(Uint8Array.from([...BOM, ...BOM]))).toBe('\ufeff');
    expect(decodeText(Uint8Array.from(BOM.slice(0, 2)))).toBeNull();
    expect(decodeText(Uint8Array.from([...BOM, 0xff]))).toBeNull();
    expect(decodeText(Uint8Array.from([0x61, 0x00]))).toBeNull();
  });

  it('measures UTF-8 lengths without encoding', () => {
    for (const measure of [utf8ByteLength, sharedUtf8ByteLength]) {
      for (const [text, n] of UTF8_BYTE_LENGTHS) expect(measure(text), JSON.stringify(text)).toBe(n);
      for (const c of UTF8_VALID) expect(measure(c.text), c.name).toBe(c.bytes.length);
    }
  });
});
