import { ApplianceMessage, decodeApplianceMessage } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { decodeControl, LeanApplianceMessage } from './control-decode';

const encode = (m: unknown) => new TextEncoder().encode(JSON.stringify(m));
const ID = 'req_0000000000000001';

describe('answers decoded without walking their JSON twice', () => {
  it('knows every message the protocol has', () => {
    const types = (u: typeof ApplianceMessage) =>
      u.options.map((o) => ('shape' in o ? String(o.shape.t.value) : 'event')).sort();
    expect(types(LeanApplianceMessage)).toEqual(types(ApplianceMessage));
  });

  it('decodes what the protocol decodes, to the same message', () => {
    const output = { messages: [{ id: 'msg_1', text: 'Hi', tags: [1, 2.5, null, true, { deep: ['x'] }] }] };
    const messages = [
      { t: 'result', id: ID, kind: 'ok', output },
      { t: 'result', id: ID, kind: 'ok', output: null },
      {
        t: 'error',
        id: ID,
        code: 'blocked',
        message: 'Needs a key.',
        retryable: false,
        details: { keyNeeded: 'k' },
      },
      { t: 'outcome', id: ID, state: 'completed', result: { kind: 'ok', output } },
      { t: 'stream_done', stream: 1, size: 3, sha256: 'ab'.repeat(32), output: { id: 'att_1' } },
      { t: 'ping', n: 1 },
    ];
    for (const m of messages) expect(decodeControl(encode(m))).toEqual(decodeApplianceMessage(encode(m)));
  });

  it('still refuses an answer without its output, a bad message and bytes that aren’t UTF-8', () => {
    expect(decodeControl(encode({ t: 'result', id: ID, kind: 'ok' }))).toMatchObject({
      ok: false,
      kind: 'invalid',
    });
    expect(decodeControl(encode({ t: 'result', id: 'nope', kind: 'ok', output: 1 }))).toMatchObject({
      ok: false,
      kind: 'invalid',
    });
    expect(decodeControl(new Uint8Array([0x7b, 0xff, 0x7d]))).toMatchObject({ ok: false, kind: 'invalid' });
    expect(decodeControl(encode([1]))).toMatchObject({ ok: false, kind: 'invalid' });
  });
});
