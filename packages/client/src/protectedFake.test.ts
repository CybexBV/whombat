import { ProtectedView, RestoreTestServer } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { createFakeProtected } from './protectedFake';

describe('the fake What’s protected', () => {
  it('answers as the contract says, with results only when tested', () => {
    const tested = createFakeProtected({ kind: 'tested' }).call('protected.get', { params: {} });
    const view = ProtectedView.parse(tested?.body);
    expect(view.restoreTests[0]).toMatchObject({ serverId: 'pve-02', on: true });
    expect(view.rows.some((r) => r.restoreTest?.outcome === 'failed')).toBe(true);
    const calm = ProtectedView.parse(createFakeProtected().call('protected.get', { params: {} })?.body);
    expect(calm.restoreTests[0]?.on).toBe(false);
    expect(calm.rows.some((r) => r.restoreTest)).toBe(false);
  });

  it('turns tests on, runs one and shows it on the machine', () => {
    const fake = createFakeProtected();
    const on = fake.call('restoreTests.set', { params: { serverId: 'pve-02' }, body: { on: true } });
    expect(RestoreTestServer.parse(on?.body).on).toBe(true);
    const run = fake.call('restoreTests.run', { params: { serverId: 'pve-02' }, body: { guest: 'pve:133' } });
    expect(RestoreTestServer.parse(run?.body).last).toMatchObject({ guestId: 'pve:133', outcome: 'worked' });
    expect(fake.guestResult('pve-02', 'pve:133')?.outcome).toBe('worked');
    expect(fake.call('restoreTests.run', { params: { serverId: 'pve-01' }, body: {} })?.status).toBe(404);
    expect(fake.call('things.list', { params: {} })).toBeNull();
  });
});
