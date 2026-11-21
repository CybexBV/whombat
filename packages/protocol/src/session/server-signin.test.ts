import { describe, expect, it } from 'vitest';
import { parseRealtimeEvent } from './codec.js';
import type { EventMessage } from './messages.js';
import { OPERATION_SAFETY, resendAfterNotFound } from './operation-safety.js';
import { createOperationAllowlist, receiptDigest, SECRET_API_OPS } from './operations.js';

const BODY = {
  address: '10.100.0.14',
  username: 'root',
  auth: { kind: 'password', password: 'correct horse' },
  control: 'full',
};

describe('Sign in once over the session (CT-377, 0.85.0)', () => {
  it('keeps the server’s password out of receipts and never resends the install', () => {
    const allow = createOperationAllowlist();
    const start = allow.get('hosts.startInstall');
    expect(SECRET_API_OPS).toContain('hosts.startInstall');
    expect(start?.secret).toBe(true);
    expect(start?.mutating).toBe(true);
    expect(OPERATION_SAFETY['hosts.startInstall']).toEqual({ destructive: false, retry: 'never' });
    expect(resendAfterNotFound('hosts.startInstall')).toBe(false);
    // The receipt binds the op alone: two different passwords give the same digest.
    const input = { params: { burrow: 'lumio-bv' }, body: BODY };
    const other = { ...input, body: { ...BODY, auth: { kind: 'password', password: 'another one' } } };
    if (!start) throw new Error('no hosts.startInstall');
    expect(receiptDigest(start, input)).toBe(receiptDigest(start, other));
    expect(start.input.safeParse(input).success).toBe(true);
    expect(start.input.safeParse({ ...input, body: { ...BODY, extra: 1 } }).success).toBe(false);

    const get = allow.get('hosts.getInstall');
    expect(get?.secret).toBe(false);
    expect(get?.mutating).toBe(false);
    expect(OPERATION_SAFETY['hosts.getInstall']).toEqual({ destructive: false, retry: 'safe' });
  });

  it('keeps createEnrollment secret, with or without its new body', () => {
    const spec = createOperationAllowlist().get('hosts.createEnrollment');
    expect(spec?.secret).toBe(true);
    expect(spec?.input.safeParse({ params: { burrow: 'lumio-bv' } }).success).toBe(true);
    expect(spec?.input.safeParse({ params: { burrow: 'lumio-bv' }, body: {} }).success).toBe(true);
    expect(
      spec?.input.safeParse({ params: { burrow: 'lumio-bv' }, body: { control: 'watch', name: 'nas' } })
        .success,
    ).toBe(true);
    expect(spec?.input.safeParse({ params: { burrow: 'lumio-bv' }, body: { approve: true } }).success).toBe(
      false,
    );
  });

  it('names the feature, decodes the event and keeps the level', () => {
    const event = (state: string): EventMessage => ({
      t: 'event',
      ephemeral: false,
      sub: 's1',
      cursor: 'c1',
      topic: 'hosts:brw_1',
      event: { type: 'hosts.install', installId: 'inst_1', state },
    });
    expect(parseRealtimeEvent(event('installing'))).toEqual({
      type: 'hosts.install',
      installId: 'inst_1',
      state: 'installing',
    });
    // A state this client doesn't know (a newer runtime's) is skipped, not a failure.
    expect(parseRealtimeEvent(event('rebooting'))).toBeNull();
    // New ops, an optional body, a new event older clients skip: no level change (as 0.79, CT-335).
  });
});
