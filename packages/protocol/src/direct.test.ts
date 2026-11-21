/** Contracts 1.0.0: the box's direct listener (CT-1250, CT-1251; Whombat hermes-engine.md HE-50). */
import { describe, expect, it } from 'vitest';
import {
  DIRECT_CLOSE,
  DIRECT_PATH,
  DIRECT_PORT,
  DIRECT_SUBPROTOCOL,
  parseDirectDownstream,
  parseDirectUpstream,
} from './direct.js';
import { RELAY_CLOSE, RELAY_PATH, RELAY_SUBPROTOCOL } from './relay.js';

describe('the direct listener (CT-1250)', () => {
  it('has its own path and subprotocol beside the relay’s', () => {
    expect(DIRECT_PATH).toBe('/v1/direct');
    expect(DIRECT_SUBPROTOCOL).toBe('whombat-direct.v1');
    expect(DIRECT_PATH).not.toBe(RELAY_PATH);
    expect(DIRECT_SUBPROTOCOL).not.toBe(RELAY_SUBPROTOCOL);
    expect(DIRECT_PORT).toBe(4480);
  });

  it('takes a hello without a ticket and answers a welcome', () => {
    const hello = parseDirectUpstream('{"t":"hello","v":1,"class":"interactive"}');
    expect(hello).toEqual({ ok: true, value: { t: 'hello', v: 1, class: 'interactive' } });
    // A relay hello's ticket is not part of it: stripped, never needed.
    const relayLike = parseDirectUpstream('{"t":"hello","v":1,"class":"bulk","ticket":"a.b.c"}');
    expect(relayLike.ok && relayLike.value).toEqual({ t: 'hello', v: 1, class: 'bulk' });
    const welcome = parseDirectDownstream('{"t":"welcome","v":1,"heartbeatMs":20000,"maxMessage":262144}');
    expect(welcome.ok).toBe(true);
  });

  it('closes a bad hello with 4400', () => {
    for (const text of [
      'nope',
      '{"t":"hello","v":2,"class":"bulk"}',
      '{"t":"refuse","session":"ses_12345678"}',
    ])
      expect(parseDirectUpstream(text)).toMatchObject({ ok: false, close: DIRECT_CLOSE.badHello });
    expect(
      parseDirectUpstream(`{"t":"hello","v":1,"class":"bulk","x":"${'a'.repeat(1_100)}"}`),
    ).toMatchObject({
      ok: false,
      close: 4400,
    });
  });

  it('uses the relay’s close numbers where they mean the same', () => {
    for (const [name, code] of Object.entries(DIRECT_CLOSE))
      expect(RELAY_CLOSE[name as keyof typeof RELAY_CLOSE], name).toBe(code);
  });
});
