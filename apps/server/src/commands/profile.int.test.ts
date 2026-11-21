/** Settings → Profile: `PATCH /me/profile` across the account and its burrows. */
import { describe, expect, it } from 'vitest';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';

const t = useTestServer({ seed: true });

const patchProfile = (cookie: string, payload: Record<string, unknown>) =>
  t.api.inject({ method: 'PATCH', url: '/api/v1/me/profile', headers: { cookie }, payload });

describe('PATCH /me/profile', () => {
  it('refuses empty names, empty bodies and callers without a session', async () => {
    const { cookie } = await sessionFor(t.services, IDS.mara);
    expect((await patchProfile(cookie, { name: '   ' })).statusCode).toBe(400);
    expect((await patchProfile(cookie, {})).statusCode).toBe(400);
    const anonymous = await t.api.inject({
      method: 'PATCH',
      url: '/api/v1/me/profile',
      payload: { name: 'X' },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
