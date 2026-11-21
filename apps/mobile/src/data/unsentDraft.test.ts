import { OutcomeRedactedError, OutcomeUnknownError } from '@whombat/client';
import { describe, expect, it } from 'vitest';
import { draftAfterSend, sendWasLost } from './unsentDraft';

describe('a message that didn’t go', () => {
  it('comes back into an empty box when the Whombat refused it', () => {
    expect(draftAfterSend({ result: { status: 'blocked' } }, 'Restart the NAS', '')).toBe('Restart the NAS');
  });

  it('comes back when the send failed outright', () => {
    expect(draftAfterSend({ error: new Error('boom') }, 'Restart the NAS', '  ')).toBe('Restart the NAS');
  });

  it('goes above what was typed since, which stays', () => {
    expect(draftAfterSend({ error: new Error('boom') }, 'first', 'second')).toBe('first\n\nsecond');
  });

  it('stays out of the box when it went, waits for approval, or may have arrived', () => {
    expect(draftAfterSend({ result: { status: 'ok' } }, 'hi', '')).toBeNull();
    expect(draftAfterSend({ result: { status: 'pending_approval' } }, 'hi', '')).toBeNull();
    expect(sendWasLost({ error: new OutcomeUnknownError('messages.send', 'req_1') as unknown })).toBe(false);
    expect(
      sendWasLost({ error: new OutcomeRedactedError('messages.send', 'req_1', 'completed') as unknown }),
    ).toBe(false);
  });
});
