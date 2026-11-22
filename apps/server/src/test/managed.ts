/**
 * Session-runtime test harness: a test server as a box (throwaway database, optionally the seeded world, the test
 * hosted UI and the licence on with the test key set), the runtime with a fake manager, and helpers to enroll the
 * seeded person's endpoints.
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll } from 'vitest';
import { createBurrow } from '../commands/burrows';
import { applianceEndpoints, principals } from '../db/schema/index';
import { localId } from '../managed/audit';
import type { SessionTransport } from '../managed/direct/transport';
import { ManagedRuntime } from '../managed/runtime';
import type { SessionLimits } from '../managed/session/registry';
import {
  FakeManager,
  pakeClaim,
  type TestIdentity,
  TestSessionClient,
  testIdentity,
} from '../managed/testing';
import type { Services } from '../services';
import { BOX_TEST_ENV, type TestServer, useTestServer } from './harness';

export interface ManagedTest {
  t: TestServer;
  manager: FakeManager;
  /** The appliance content identity these sessions run under. */
  appliance: TestIdentity;
  readonly runtime: ManagedRuntime;
  /** Enrolls a new endpoint key for a seeded person's account (fixture shortcut, not the ceremony). */
  enroll(principalId: string): Promise<TestIdentity & { accountId: string; endpointId: string }>;
  /**
   * A connected session client that already said hello. `doorPeer`: at the box's own address, the visitor's address;
   * `claimLink`: the claim link's secret its hello shows; `minor`: the session minor it speaks (an older app's is lower).
   */
  client(
    identity?: TestIdentity,
    options?: { transport?: SessionTransport; doorPeer?: string; claimLink?: string; minor?: number },
  ): Promise<TestSessionClient>;
  /**
   * The console letters, after giving the runtime a lookup lease as the manager would (`POST /claim-lookup`).
   * Provisioning must have named the device first.
   */
  letters(lookup?: string): string;
  /**
   * Claims the appliance with the console code (provisions `deviceId` first): the whole ceremony, as a client does.
   */
  claim(
    client: TestSessionClient,
    options: { deviceId: string; name: string; email?: string; label?: string; claimId?: string },
  ): Promise<Awaited<ReturnType<typeof pakeClaim>>>;
}

export function useManagedRuntime(
  options: {
    seed?: boolean;
    env?: Record<string, string>;
    events?: { maxAgeMs?: number; maxCount?: number };
    sessions?: Partial<SessionLimits>;
    /** Sets up the manager before the runtime starts (Whombat Link's state, the channel). */
    prepare?: (manager: FakeManager) => void;
    /** The content key's signature for turning Whombat Link on (the boot's, from `device.json`). */
    contentProof?: () => Promise<string | null>;
  } = {},
): ManagedTest {
  const t = useTestServer({
    ...(options.seed ? { seed: true } : {}),
    env: { ...BOX_TEST_ENV, ...options.env },
  });
  const manager = new FakeManager();
  const appliance = testIdentity();
  let runtime: ManagedRuntime | undefined;
  const clients: TestSessionClient[] = [];
  beforeAll(async () => {
    options.prepare?.(manager);
    runtime = new ManagedRuntime(t.services, {
      manager,
      appliancePeerId: appliance.peerId,
      ...(options.contentProof ? { contentProof: options.contentProof } : {}),
      ...(options.events ? { events: options.events } : {}),
      ...(options.sessions ? { sessions: options.sessions } : {}),
    });
    await runtime.start();
  });
  afterAll(async () => {
    for (const c of clients) c.close();
    await runtime?.close();
  });
  const get = () => {
    if (!runtime) throw new Error('useManagedRuntime: not ready');
    return runtime;
  };
  return {
    t,
    manager,
    appliance,
    get runtime() {
      return get();
    },
    async enroll(principalId) {
      const db = t.services.db;
      const [p] = await db.select().from(principals).where(eq(principals.id, principalId));
      if (!p?.accountId) throw new Error(`no account for ${principalId}`);
      const identity = testIdentity();
      const endpointId = localId('ep');
      await db.insert(applianceEndpoints).values({
        id: endpointId,
        peerId: identity.peerId,
        publicKey: identity.publicKey,
        accountId: p.accountId,
        label: `${principalId} test`,
        platform: 'web',
        enrolledVia: 'pairing',
      });
      return { ...identity, accountId: p.accountId, endpointId };
    },
    letters(lookup = '4821') {
      const ceremony = get().trust.ceremony;
      const now = t.services.clock();
      if (ceremony.liveLease(now)?.lookup !== lookup)
        ceremony.setLease({ lookup, expiresAt: new Date(now.getTime() + 3600_000) });
      const code = ceremony.codePassword(now);
      if (!code) throw new Error('letters: no claim code (is the device provisioned and unclaimed?)');
      return code.password;
    },
    async claim(client, o) {
      await get().trust.provisionClaim({ deviceId: o.deviceId, secretHash: null });
      return pakeClaim(
        client,
        {
          method: 'code',
          password: this.letters(),
          deviceId: o.deviceId,
          appliancePeerId: appliance.peerId,
          ...(o.claimId ? { claimId: o.claimId } : {}),
        },
        {
          account: { name: o.name, email: o.email ?? `${o.name.toLowerCase()}@example.com` },
          endpoint: { label: o.label ?? o.name, platform: 'web' },
        },
      );
    },
    async client(identity, options) {
      // Unenrolled sessions have a small cap (MR-28): tests that open many make room like a real device going
      // away — the oldest unenrolled test client closes first.
      while (get().sessions.unenrolledSize >= get().sessions.limits.maxUnenrolled) {
        const oldest = clients.find((x) => x.connection.principal && !x.connection.principal.endpoint);
        if (!oldest) break;
        clients.splice(clients.indexOf(oldest), 1);
        oldest.close();
        await oldest.closed;
      }
      const { claimLink, minor, ...connection } = options ?? {};
      const c = new TestSessionClient(get(), identity ?? testIdentity(), connection);
      clients.push(c);
      const welcome = await c.hello(claimLink ? { claimLink } : {}, minor);
      if (welcome.t !== 'welcome') throw new Error(`no welcome: ${JSON.stringify(welcome)}`);
      return c;
    },
  };
}

/**
 * Another burrow in a test's database (one-agent.md OA-01: an appliance makes one burrow; tests of what reads several
 * still need them), with its own agent.
 */
export function extraBurrow(services: Services, accountId: string, name: string) {
  return createBurrow(services, accountId, name, { besideOwn: true });
}
