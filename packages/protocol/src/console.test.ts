import { describe, expect, it } from 'vitest';
import { utf8Encode } from './bytes.js';
import { ConsoleMessageDecoder, consoleDataPayloads, encodeConsoleMessages } from './console.js';
import { CONSOLE_MAX_MESSAGE_BYTES } from './limits.js';
import { decodeApplianceMessage, decodeClientMessage, encodeSessionMessage } from './session/codec.js';
import { APP_ERROR_CODES, SessionErrorCode } from './session/errors.js';
import { ALL_CAPABILITIES, CAPABILITIES } from './session/version.js';

/** A hosts-service console message: `kind | channel (u16 BE) | payload`. */
function frame(kind: number, channel: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(3 + payload.length);
  out.set([kind, channel >> 8, channel & 0xff]);
  out.set(payload, 3);
  return out;
}

describe('console streams (CT-350)', () => {
  it('opens with the console token and answers with the protocol', () => {
    const open = {
      t: 'open',
      stream: 3,
      spec: { kind: 'console', burrow: 'home', sessionId: 'cs_1', token: 'tok-abc' },
    } as const;
    expect(decodeClientMessage(encodeSessionMessage(open))).toEqual({ ok: true, message: open });
    const opened = { t: 'opened', stream: 3, meta: { kind: 'console', protocol: 'shell' } } as const;
    expect(decodeApplianceMessage(encodeSessionMessage(opened))).toEqual({ ok: true, message: opened });
    const missing = { ...open, spec: { kind: 'console', burrow: 'home', sessionId: 'cs_1' } };
    expect(decodeClientMessage(utf8Encode(JSON.stringify(missing))).ok).toBe(false);
    expect(CAPABILITIES.console).toBe('stream.console');
    expect(ALL_CAPABILITIES).toContain('stream.console');
    expect(APP_ERROR_CODES.console_refused).toBeTruthy();
    expect(APP_ERROR_CODES.hosts_unavailable).toBeTruthy();
  });

  it('frames console messages like collab, across any DATA split', () => {
    const messages = [
      frame(1, 0, utf8Encode('{"type":"activity"}')),
      frame(0, 0, new Uint8Array(150_000).fill(65)),
      frame(0, 2, Uint8Array.of(13)),
    ];
    const encoded = encodeConsoleMessages(messages);
    for (const size of [1, 7, 4096, 65_536]) {
      const d = new ConsoleMessageDecoder();
      const out = consoleDataPayloads(encoded, Math.min(size, 65_536)).flatMap((p) => d.push(p));
      expect(out).toEqual(messages);
    }
  });

  it('refuses a console message above its bound', () => {
    expect(() => encodeConsoleMessages([new Uint8Array(CONSOLE_MAX_MESSAGE_BYTES + 1)])).toThrowError(
      /bytes/,
    );
    const d = new ConsoleMessageDecoder();
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, CONSOLE_MAX_MESSAGE_BYTES + 1);
    expect(() => d.push(header)).toThrowError(/bytes/);
  });

  it('lists `unavailable` once among the session codes (CT-346)', () => {
    expect(SessionErrorCode.options.filter((c) => c === 'unavailable')).toHaveLength(1);
  });
});
