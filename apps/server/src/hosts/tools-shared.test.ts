import { describe, expect, it } from 'vitest';
import { type CallScope, changeOf, withDestination } from './tools-shared';
import { keptDestinations } from './undo';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

const scopeOf = (call: { target?: string; others?: Record<string, string> }) =>
  ({ call }) as unknown as CallScope;

describe('what a Servers change keeps of where it went', () => {
  const change = () =>
    changeOf('guest_config_set', 's', '101', 'Changed web', {
      inverse: { tool: 'guest_config_set', args: { server: 's' }, serverId: 's' },
    });

  it('keeps the Servers connection and every other connection the call acted through', () => {
    const kept = withDestination(scopeOf({ target: A, others: { con_nas: B } }), change());
    expect(kept.change?.undo?.payload).toMatchObject({ destination: A, otherDestinations: { con_nas: B } });
    const payload = kept.change?.undo?.payload as { otherDestinations?: unknown } | undefined;
    expect(keptDestinations(payload?.otherDestinations)).toEqual({ con_nas: B });
  });

  it('keeps no other destinations when the call acted through none', () => {
    const kept = withDestination(scopeOf({ target: A, others: {} }), change());
    expect(kept.change?.undo?.payload).toMatchObject({ destination: A });
    expect(kept.change?.undo?.payload).not.toHaveProperty('otherDestinations');
  });

  it('reads only well-formed destinations back', () => {
    expect(keptDestinations(undefined)).toEqual({});
    expect(keptDestinations(['x'])).toEqual({});
    expect(keptDestinations({ con_a: A, con_b: 'nope', con_c: 7 })).toEqual({ con_a: A });
  });
});
