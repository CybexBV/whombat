/** Contracts 0.119.0: clearing Chat over the session (CT-992, CT-994). */
import { describe, expect, it } from 'vitest';
import { operationSafety } from './operation-safety.js';
import { API_OPERATIONS } from './operations.js';

describe('Clearing Chat over the session (CT-992, CT-994)', () => {
  it('is a mutation its receipt covers, not a destructive one', () => {
    expect(API_OPERATIONS.get('chats.clear')?.mutating).toBe(true);
    expect(operationSafety('chats.clear')).toEqual({ destructive: false, retry: 'receipt' });
  });
});
