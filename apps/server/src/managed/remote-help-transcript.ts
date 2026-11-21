/**
 * A visit's command line as the person reads it (docs/decisions/remote-help.md RH-07; remote-help-server.md RH-S07): the
 * support service keeps the raw output of support's command-line sessions, and the runtime cleans it on the way out —
 * terminal escape sequences (colours, cursor moves, titles, hyperlinks) and every control character but newline and tab
 * go, and so do the bidirectional overrides that could make one line read as another. A sequence that never ends stops
 * hiding text after a bound, so output can't hide what follows it from the person. Works chunk by chunk: a sequence or a
 * character split across chunks is handled.
 */

/** An escape sequence longer than this ends there and what follows shows again. */
export const SEQUENCE_MAX_CHARS = 4096;
const CSI_MAX_CHARS = 64;

type State = 'text' | 'esc' | 'esc_inter' | 'csi' | 'string' | 'string_esc';

/** Bidi embeddings, overrides and isolates (U+202A–U+202E, U+2066–U+2069). */
const isBidi = (c: number) => (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);

export class TranscriptCleaner {
  readonly #decoder = new TextDecoder('utf-8', { fatal: false });
  #state: State = 'text';
  /** Characters in the current sequence. */
  #length = 0;
  /** A string sequence (OSC, DCS, SOS, PM, APC) ends on BEL too; DCS and the others only on ST. */
  #bellEnds = false;

  /** The clean text of the next chunk. */
  push(bytes: Uint8Array): string {
    return this.#clean(this.#decoder.decode(bytes, { stream: true }));
  }

  /** What is left at the end (an unfinished sequence is dropped). */
  end(): string {
    return this.#clean(this.#decoder.decode());
  }

  #clean(text: string): string {
    let out = '';
    for (const ch of text) {
      const c = ch.codePointAt(0) ?? 0;
      switch (this.#state) {
        case 'text':
          out += this.#text(ch, c);
          break;
        case 'esc':
          this.#escape(c);
          break;
        case 'esc_inter':
          // A character set's designation (`ESC ( B`): one more character, then text.
          this.#state = 'text';
          break;
        case 'csi':
          if (c >= 0x40 && c <= 0x7e) this.#state = 'text';
          else if (c < 0x20 || c > 0x3f || ++this.#length > CSI_MAX_CHARS) {
            // Not a parameter or an intermediate (or far too long): the sequence ends; the character is text again.
            this.#state = 'text';
            if (c < 0x20 || c > 0x7e) out += this.#text(ch, c);
          }
          break;
        case 'string':
          if (c === 0x1b) this.#state = 'string_esc';
          else if (c === 0x9c || (c === 0x07 && this.#bellEnds)) this.#state = 'text';
          else if (++this.#length > SEQUENCE_MAX_CHARS) this.#state = 'text';
          break;
        case 'string_esc':
          // ST is `ESC \`; any other escape ends the string and starts its own sequence.
          if (c === 0x5c) this.#state = 'text';
          else this.#escape(c);
          break;
      }
    }
    return out;
  }

  #start(state: 'csi' | 'string', bellEnds = false): void {
    this.#state = state;
    this.#length = 0;
    this.#bellEnds = bellEnds;
  }

  #escape(c: number): void {
    if (c === 0x5b) this.#start('csi');
    else if (c === 0x5d) this.#start('string', true);
    else if (c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f) this.#start('string');
    else if (c >= 0x20 && c <= 0x2f) this.#state = 'esc_inter';
    else this.#state = 'text';
  }

  #text(ch: string, c: number): string {
    if (c === 0x09 || c === 0x0a) return ch;
    if (c === 0x1b) {
      this.#state = 'esc';
      return '';
    }
    // C1 forms of CSI, OSC and the string sequences.
    if (c === 0x9b) this.#start('csi');
    else if (c === 0x9d) this.#start('string', true);
    else if (c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f) this.#start('string');
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || isBidi(c)) return '';
    return ch;
  }
}

/** Cleans a whole text at once (tests, the fake). */
export function cleanTranscript(text: string): string {
  const cleaner = new TranscriptCleaner();
  return cleaner.push(new TextEncoder().encode(text)) + cleaner.end();
}

/**
 * The raw stream as clean UTF-8 chunks, at most `maxBytes` of them (the visit's limit); reading stops there and the
 * source is let go.
 */
export async function* cleanTranscriptStream(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
): AsyncGenerator<Uint8Array> {
  const cleaner = new TranscriptCleaner();
  const encoder = new TextEncoder();
  let sent = 0;
  const take = (text: string): Uint8Array | null => {
    if (!text || sent >= maxBytes) return null;
    let bytes: Uint8Array = encoder.encode(text);
    if (sent + bytes.length > maxBytes) bytes = cutUtf8(bytes, maxBytes - sent);
    sent += bytes.length;
    return bytes.length ? bytes : null;
  };
  for await (const chunk of source) {
    const bytes = take(cleaner.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)));
    if (bytes) yield bytes;
    if (sent >= maxBytes) return;
  }
  const rest = take(cleaner.end());
  if (rest) yield rest;
}

/** The first `max` bytes of UTF-8, never cutting a character in two. */
export function cutUtf8(bytes: Uint8Array, max: number): Uint8Array {
  if (bytes.length <= max) return bytes;
  let end = Math.max(0, max);
  // Back off continuation bytes (10xxxxxx) to the start of the character that doesn't fit.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}
