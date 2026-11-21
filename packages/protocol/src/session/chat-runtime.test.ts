/** Contracts 0.96.0: what answers in Chat over the session (CT-461, CT-467). */
import { describe, expect, it } from 'vitest';
import { operationSafety } from './operation-safety.js';
import { API_OPERATIONS } from './operations.js';

describe('what answers in Chat over the session (CT-461, CT-467)', () => {
  it('reads as a read and sets a thread’s choice under a receipt', () => {
    expect(API_OPERATIONS.get('chats.runtime')?.mutating).toBe(false);
    expect(operationSafety('chats.runtime')).toEqual({ destructive: false, retry: 'safe' });
    expect(API_OPERATIONS.get('chats.setThreadRuntime')?.mutating).toBe(true);
    expect(operationSafety('chats.setThreadRuntime')).toEqual({ destructive: false, retry: 'receipt' });
  });
});
