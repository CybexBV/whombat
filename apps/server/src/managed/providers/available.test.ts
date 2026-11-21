import { describe, expect, it } from 'vitest';
import { signInsAvailable } from './service';

// SUB-56: the appliance gives the credentials root to the runner alone; the server still offers sign-ins through the
// runner's bridge.
describe('signInsAvailable', () => {
  it('without a root of its own: available through the runner', () => {
    expect(signInsAvailable({})).toBe(true);
    expect(signInsAvailable({ WHOMBAT_SIGNIN_EXECUTOR: 'runner' })).toBe(true);
  });
  it('with the local executor it needs a root', () => {
    expect(signInsAvailable({ WHOMBAT_SIGNIN_EXECUTOR: 'local' })).toBe(false);
    expect(
      signInsAvailable({
        WHOMBAT_SIGNIN_EXECUTOR: 'local',
        WHOMBAT_CREDENTIALS_ROOT: '/persist/whombat/credentials',
      }),
    ).toBe(true);
  });
});
