/** Contracts 0.122.0: quiet notices over the session (CT-1063). */
import { describe, expect, it } from 'vitest';
import { operationSafety } from './operation-safety.js';
import { API_OPERATIONS } from './operations.js';

describe('quiet notices over the session (CT-1063)', () => {
  it('reads What Whombat watches again freely; never resends a quiet or a switch by itself', () => {
    expect(API_OPERATIONS.get('things.watch')?.mutating).toBe(false);
    expect(operationSafety('things.watch')).toEqual({ destructive: false, retry: 'safe' });
    for (const op of ['things.quiet', 'things.setWatch']) {
      expect(API_OPERATIONS.get(op)?.mutating, op).toBe(true);
      // A server's is a call to the hosts service outside the receipt; Undo takes either back.
      expect(operationSafety(op), op).toEqual({ destructive: false, retry: 'never' });
    }
  });
});
