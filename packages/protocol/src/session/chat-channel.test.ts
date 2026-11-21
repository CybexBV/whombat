/** Contracts 0.93.0: Chat's session parts (CT-443, CT-446). */
import { describe, expect, it } from 'vitest';
import { operationSafety } from './operation-safety.js';
import { API_OPERATIONS } from './operations.js';

describe('Chat over the session (CT-443, CT-446)', () => {
  it('lists threads as a read a client may ask again', () => {
    const spec = API_OPERATIONS.get('chats.threads');
    expect(spec?.mutating).toBe(false);
    expect(operationSafety('chats.threads')).toEqual({ destructive: false, retry: 'safe' });
    expect(operationSafety('chats.start')?.retry).toBe('receipt');
  });
});
