import { describe, expect, it } from 'vitest';
import { devRelayToken } from './registration';

describe('the development relay token', () => {
  it('names the device in FCM token characters', () => {
    expect(devRelayToken('BE2A.250530.026 F3/x')).toBe('dev-relay:BE2A.250530.026_F3_x');
  });
});
