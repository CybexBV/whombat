/**
 * `@whombat/core/text/utf8` — strict UTF-8 without `TextDecoder` or `TextEncoder`, which Hermes and workers may lack:
 * the one decoder core and protocol share, and the byte length of a string's encoding. Its own subpath, with no
 * imports, so protocol's byte helpers and the feedback widget take only this.
 */

/** Where strict decoding stopped: the offset of the byte that can't be read. */
export interface Utf8Failure {
  offset: number;
}

/**
 * Strict UTF-8 (no overlong forms, surrogates, code points above U+10FFFF or truncation): the text, or where it failed.
 * The offset is that of a bad continuation byte, else the start of the sequence (a sequence running past the end is
 * reported at its start).
 */
export function decodeUtf8(bytes: Uint8Array): string | Utf8Failure {
  const parts: string[] = [];
  let units: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i] as number;
    let cp: number;
    let len: number;
    if (b0 < 0x80) {
      cp = b0;
      len = 1;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      len = 2;
      cp = b0 & 0x1f;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      len = 3;
      cp = b0 & 0x0f;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      len = 4;
      cp = b0 & 0x07;
    } else return { offset: i };
    if (i + len > bytes.length) return { offset: i };
    for (let k = 1; k < len; k++) {
      const b = bytes[i + k] as number;
      if ((b & 0xc0) !== 0x80) return { offset: i + k };
      cp = (cp << 6) | (b & 0x3f);
    }
    if (
      (len === 3 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))) ||
      (len === 4 && (cp < 0x10000 || cp > 0x10ffff))
    )
      return { offset: i };
    if (cp >= 0x10000) {
      const v = cp - 0x10000;
      units.push(0xd800 | (v >> 10), 0xdc00 | (v & 0x3ff));
    } else units.push(cp);
    // `fromCharCode(...units)` passes every unit as an argument; chunks keep it below engines' argument limits.
    if (units.length >= 8192) {
      parts.push(String.fromCharCode(...units));
      units = [];
    }
    i += len;
  }
  parts.push(String.fromCharCode(...units));
  return parts.join('');
}

/** {@link decodeUtf8}'s text, or null when the bytes aren't strict UTF-8. */
export function decodeUtf8OrNull(bytes: Uint8Array): string | null {
  const text = decodeUtf8(bytes);
  return typeof text === 'string' ? text : null;
}

/** UTF-8 length of a string, without `TextEncoder`; lone surrogates count as U+FFFD (3 bytes), like TextEncoder. */
export function utf8ByteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/** A string's UTF-8 bytes, without `TextEncoder`; a lone surrogate becomes U+FFFD, like TextEncoder. */
export function encodeUtf8(s: string): Uint8Array {
  const out = new Uint8Array(utf8ByteLength(s));
  let at = 0;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) {
      const d = c <= 0xdbff && i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      } else c = 0xfffd;
    }
    if (c < 0x80) out[at++] = c;
    else if (c < 0x800) {
      out[at++] = 0xc0 | (c >> 6);
      out[at++] = 0x80 | (c & 63);
    } else if (c < 0x10000) {
      out[at++] = 0xe0 | (c >> 12);
      out[at++] = 0x80 | ((c >> 6) & 63);
      out[at++] = 0x80 | (c & 63);
    } else {
      out[at++] = 0xf0 | (c >> 18);
      out[at++] = 0x80 | ((c >> 12) & 63);
      out[at++] = 0x80 | ((c >> 6) & 63);
      out[at++] = 0x80 | (c & 63);
    }
  }
  return out;
}
