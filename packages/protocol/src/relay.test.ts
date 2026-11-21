import { describe, expect, it } from 'vitest';
import { parseRelayUpstream, RELAY_CLOSE } from './relay.js';

const ticket = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';

describe('relay protocol v1', () => {
  it('maps every bad hello to 4400', () => {
    for (const text of [
      'nope',
      JSON.stringify({ t: 'hello', v: 2, ticket, class: 'interactive' }),
      JSON.stringify({ t: 'hello', v: 1, ticket: 'x', class: 'interactive' }),
      JSON.stringify({ t: 'ready' }),
      'x'.repeat(10_000),
    ]) {
      const r = parseRelayUpstream(text);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.close).toBe(RELAY_CLOSE.badHello);
    }
  });
});
