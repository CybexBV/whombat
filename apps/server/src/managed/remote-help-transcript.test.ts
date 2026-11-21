import { describe, expect, it } from 'vitest';
import {
  cleanTranscript,
  cleanTranscriptStream,
  cutUtf8,
  SEQUENCE_MAX_CHARS,
  TranscriptCleaner,
} from './remote-help-transcript';

const ESC = '\u001b';

async function collect(source: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: Uint8Array[] = [];
  for await (const p of source) parts.push(p);
  return new TextDecoder().decode(Buffer.concat(parts));
}

async function* chunks(...parts: (string | Uint8Array)[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield typeof p === 'string' ? new TextEncoder().encode(p) : p;
}

describe('a visit’s command line as the person reads it (RH-S07)', () => {
  it('drops colours, cursor moves, titles, links and charset changes, keeping the words', () => {
    const raw = [
      `${ESC}[1;32mroot@whombat${ESC}[0m:~# ls\r\n`,
      `${ESC}]0;root@whombat: ~\u0007${ESC}]8;;https://x.example${ESC}\\link${ESC}]8;;${ESC}\\\r\n`,
      `${ESC}(Bplain${ESC}[2K${ESC}[1A done${ESC}=\tend\n`,
    ].join('');
    expect(cleanTranscript(raw)).toBe('root@whombat:~# ls\nlink\nplain done\tend\n');
  });

  it('keeps newlines and tabs; drops every other control, DEL, C1 and bidi overrides', () => {
    const raw = 'a\u0000b\u0007c\bd\u007fe\u0085f‮g⁦h⁩i\r\n\tj';
    expect(cleanTranscript(raw)).toBe('abcdefghi\n\tj');
  });

  it('handles the C1 forms of CSI, OSC and DCS', () => {
    expect(cleanTranscript('a\u009b31mb\u009d0;title\u0007c\u0090q#data\u009cd')).toBe('abcd');
  });

  it('keeps sequences and characters split across chunks', () => {
    const cleaner = new TranscriptCleaner();
    const euro = new TextEncoder().encode('€');
    const out = [
      cleaner.push(new TextEncoder().encode(`x${ESC}`)),
      cleaner.push(new TextEncoder().encode('[3')),
      cleaner.push(new TextEncoder().encode('1my')),
      cleaner.push(euro.subarray(0, 1)),
      cleaner.push(euro.subarray(1)),
      cleaner.end(),
    ].join('');
    expect(out).toBe('xy€');
  });

  it('shows text again after a sequence that never ends, so output can’t hide what follows', () => {
    const hidden = `${ESC}]0;${'x'.repeat(SEQUENCE_MAX_CHARS + 10)}`;
    const out = cleanTranscript(`${hidden}rm -rf /tmp/a\n`);
    expect(out).toContain('rm -rf /tmp/a');
    expect(out.length).toBeLessThan(40);
    // A runaway CSI ends at the first character that can't be part of it.
    expect(cleanTranscript(`${ESC}[${'1;'.repeat(100)}visible`)).toContain('visible');
  });

  it('streams at most the limit, never cutting a character', async () => {
    const out = await collect(cleanTranscriptStream(chunks('ab', `${ESC}[0m€€`, 'never'), 5));
    expect(out).toBe('ab€');
    expect(cutUtf8(new TextEncoder().encode('€'), 2)).toHaveLength(0);
    expect(await collect(cleanTranscriptStream(chunks(`a\r\n${ESC}[1mb`), 1000))).toBe('a\nb');
  });
});
