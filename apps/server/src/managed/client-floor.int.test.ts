/**
 * The client security floor (contracts 0.5.3 CT-53; docs/decisions/managed-runtime.md MR-41): a `hello` below the
 * running release's floor gets `unsupported_version` with `client_below_security_floor` and the floor, and the
 * session closes — on both channels; a missing build number counts as 0; the floor survives a restart.
 */
import { SESSION_PROTOCOL } from '@whombat/protocol/session';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { applianceEndpoints } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';
import { ManagedRuntime } from './runtime';
import { TestSessionClient, testIdentity } from './testing';

const m = useManagedRuntime({ seed: true });
const FLOOR = { web: 200, android: 140, ios: 0, desktop: 0, cli: 0 };

async function hello(
  client: { platform: 'web' | 'android' | 'ios'; buildNumber?: number; build?: string },
  identity = testIdentity(),
  runtime: ManagedRuntime = m.runtime,
) {
  const c = new TestSessionClient(runtime, identity);
  c.send({
    t: 'hello',
    versions: [SESSION_PROTOCOL],
    capabilities: ['events', 'enroll'],
    client: { build: 'test', ...client },
  });
  const first = await c.waitFor((x) => x.t === 'welcome' || x.t === 'error');
  return { c, first };
}

describe('which app build a device runs', () => {
  it('is kept with when it was last seen, from each session’s hello', async () => {
    const mara = await m.enroll(IDS.mara);
    const build = async () =>
      (
        await m.t.services.db
          .select({ appBuild: applianceEndpoints.appBuild, lastSeenAt: applianceEndpoints.lastSeenAt })
          .from(applianceEndpoints)
          .where(eq(applianceEndpoints.peerId, mara.peerId))
      )[0];
    expect((await build())?.appBuild).toBeNull();
    await hello({ platform: 'android', buildNumber: 393010, build: 'android 3.93.1 (393010)' }, mara);
    expect(await build()).toMatchObject({
      appBuild: 'android 3.93.1 (393010)',
      lastSeenAt: expect.any(Date),
    });
    await hello({ platform: 'android', buildNumber: 393020, build: 'android 3.93.2 (393020)' }, mara);
    expect((await build())?.appBuild).toBe('android 3.93.2 (393020)');
  });
});

describe('client security floor', () => {
  it('refuses a build below the floor on the enrollment channel and on the app channel, then closes', async () => {
    await m.runtime.trust.setClientFloor(FLOOR);
    const low = await hello({ platform: 'web', buildNumber: 199 });
    expect(low.first).toMatchObject({
      t: 'error',
      code: 'unsupported_version',
      details: {
        code: 'client_below_security_floor',
        floor: { platform: 'web', minBuild: 200 },
        supported: { min: SESSION_PROTOCOL.major, max: SESSION_PROTOCOL.major },
      },
    });
    expect(await low.c.closed).toBe('protocol_error');
    // No build number counts as 0.
    expect((await hello({ platform: 'android' })).first).toMatchObject({
      details: { code: 'client_below_security_floor', floor: { platform: 'android', minBuild: 140 } },
    });
    // An enrolled device below the floor too.
    const mara = await m.enroll(IDS.mara);
    expect((await hello({ platform: 'web', buildNumber: 10 }, mara)).first).toMatchObject({
      t: 'error',
      details: { code: 'client_below_security_floor' },
    });
    // At the floor, and on a platform without one: served.
    expect((await hello({ platform: 'web', buildNumber: 200 }, mara)).first).toMatchObject({
      t: 'welcome',
      channel: 'app',
    });
    expect((await hello({ platform: 'ios' })).first).toMatchObject({ t: 'welcome', channel: 'enroll' });
    expect(m.runtime.counters.count('sessionsRefusedVersion')).toBe(3);
  });

  it('appliance.status shows the floor, and a restarted runtime keeps it', async () => {
    const mara = await m.enroll(IDS.mara);
    const { c } = await hello({ platform: 'web', buildNumber: 300 }, mara);
    expect(await c.request('appliance.status', {})).toMatchObject({ output: { clientFloor: FLOOR } });
    const again = new ManagedRuntime(m.t.services, {
      manager: m.manager,
      appliancePeerId: m.appliance.peerId,
    });
    await again.start();
    try {
      expect(again.trust.clientFloor).toEqual(FLOOR);
      expect((await hello({ platform: 'web', buildNumber: 1 }, testIdentity(), again)).first).toMatchObject({
        details: { code: 'client_below_security_floor' },
      });
    } finally {
      await again.close();
    }
    // No floor any more (a rollback to a release without one): everyone is served.
    await m.runtime.trust.setClientFloor(null);
    expect((await hello({ platform: 'web', buildNumber: 1 })).first).toMatchObject({ t: 'welcome' });
  });
});
