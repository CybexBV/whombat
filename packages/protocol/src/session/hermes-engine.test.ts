/** Contracts 0.124.0: Hermes is the only engine over the session (CT-1170…CT-1179; Whombat hermes-engine.md). */
import { describe, expect, it } from 'vitest';
import { APP_ERROR_CODES } from './errors.js';
import { OPERATION_SAFETY } from './operation-safety.js';
import { API_OPERATIONS } from './operations.js';

describe('Hermes is the only engine (CT-1179)', () => {
  it('sets and tests the local model as secret ops, never resent, and clears it as a destructive one', () => {
    for (const op of ['burrows.setLocalModel', 'burrows.testLocalModel']) {
      expect(API_OPERATIONS.get(op)?.secret, op).toBe(true);
      expect(OPERATION_SAFETY[op as keyof typeof OPERATION_SAFETY], op).toEqual({
        destructive: false,
        retry: 'never',
      });
    }
    expect(API_OPERATIONS.get('burrows.clearLocalModel')?.secret).toBe(false);
    expect(OPERATION_SAFETY['burrows.clearLocalModel']).toEqual({ destructive: true, retry: 'receipt' });
  });

  it('has no ACP refusal', () => {
    expect(Object.keys(APP_ERROR_CODES)).not.toContain('managed.acp_runtimes');
  });
});
