/**
 * Looking for a Whombat's backups on the network right after the claim (backup-passkey.md): before onboarding a box has
 * no burrow or person and no scan has run, so it scans its network as itself, waits for it, and reads the kit files of
 * the backup apps on the hosts it found. Needs Postgres: the scan's plan reads the home network list and the local
 * network setting, and the look reads the places and connections Whombat knows.
 *
 * Nothing real is dialled: an SSH greeting on 127.0.0.1 stands behind a home-network address, and the backup app is a
 * fake `fetch`.
 */
import { createHash } from 'node:crypto';
import { type AddressInfo, createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import { PLACE_KIT_RECORD_KIND } from '@whombat/core/backup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boxFound } from '../connections/discover';
import { useDiscoveryNetForTests } from '../connections/finder';
import { burrows } from '../db/schema/index';
import { useTestServer } from '../test/harness';
import { findPlaceKits, kitFileBody, useKitNet } from './kit-copy';

const t = useTestServer({});
const NAS = '192.168.77.40';
const OLD = '12D3KooWBdXx3Cq9hpm8vNrLy8kgLe7Hx1WXDf5wSZ6aw9PUVQhE';
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const body = kitFileBody({
  kind: PLACE_KIT_RECORD_KIND,
  appliance: OLD,
  applianceName: 'Home',
  credentialId: 'Y3JlZA',
  salt: '2RI2EH8wqFcj9KLMi35oIHhH2q4fWvGu-Czr0iSrw-Y',
  envelope: 'wbkit1.oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3.PCcUYiW45pIXAPRmQggriWSM',
  generation: 3,
  createdAt: '2026-11-04T10:00:00.000Z',
});

const iface = (address: string, cidr: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: '00:16:3e:00:00:01',
  internal,
  cidr,
});

let ssh: TcpServer;
let sshPort = 0;
const asked: string[] = [];

beforeAll(async () => {
  ssh = createTcpServer((socket) => {
    socket.on('error', () => {});
    socket.end('SSH-2.0-OpenSSH_9.2p1 Debian-2+deb12u3\r\n');
  });
  await new Promise<void>((resolve) => ssh.listen(0, '127.0.0.1', resolve));
  sshPort = (ssh.address() as AddressInfo).port;
  useDiscoveryNetForTests(t.services, {
    interfaces: () => ({
      lo: [iface('127.0.0.1', '127.0.0.1/8', true)],
      eth0: [iface('192.168.77.5', '192.168.77.5/24')],
    }),
    dial: (address, port) =>
      address === NAS && port === 22 ? { address: '127.0.0.1', port: sshPort } : null,
  });
  t.services.config.WHOMBAT_LOCAL_NETWORK = 'on';
  // The NAS's backup app on its first port, with one kit file; nothing else answers.
  useKitNet(t.services, {
    scan: true,
    scanWaitMs: 20_000,
    fetch: async (url) => {
      const u = new URL(url);
      asked.push(`${u.host}${u.pathname}`);
      if (u.host !== `${NAS}:8747`) throw new TypeError('fetch failed');
      if (u.pathname === '/kit/keys/')
        return new Response(JSON.stringify([{ name: sha(body), size: body.length }]), { status: 200 });
      if (u.pathname === `/kit/keys/${sha(body)}`) return new Response(body, { status: 200 });
      return new Response(null, { status: 404 });
    },
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => ssh.close(() => resolve()));
});

describe('looking on the network right after the claim', () => {
  it('scans as the box when there is no burrow yet, waits for it, and finds the kit on the NAS', async () => {
    expect(await t.services.db.select().from(burrows)).toEqual([]);
    expect(boxFound(t.services).last).toBeNull();
    const found = await findPlaceKits(t.services);
    expect(found.places).toBe(1);
    expect(found.kits).toEqual([
      expect.objectContaining({ appliance: OLD, applianceName: 'Home', at: `${NAS}:8747` }),
    ]);
    // The scan it waited for is kept: a second look reads it rather than scanning again.
    expect(boxFound(t.services).last?.found.map((f) => f.host)).toContain(NAS);
    const before = asked.length;
    expect((await findPlaceKits(t.services)).kits).toHaveLength(1);
    expect(asked.length).toBeGreaterThan(before);
  });
});
