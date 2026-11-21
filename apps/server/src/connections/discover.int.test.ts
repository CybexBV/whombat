/**
 * What is at an address and what is on the network (docs/decisions/connections-setup.md CS-13, CS-14) over REST against
 * a real Postgres: `connections.identify` names a self-signed Proxmox VE (its version and certificate) and a Home
 * Assistant over http, says why not when the address isn't what was asked, and refuses an address as connect does;
 * `connections.discover` scans a fake home network for managers only, reports its progress, finds Proxmox VE,
 * Portainer, Grafana, Home Assistant and a computer that answers SSH (not a router's, not the Proxmox VE host again:
 * connect-in-chat.md), marks the ones already connected (the same entry on that host, or a custom one
 * on that host and port: CS-52), answers a recent scan, rescans one at a time, looks in the networks asked for and,
 * with the local network closed, only in the home network list. `connections.hideFound` (CS-53) hides a found service
 * for the burrow's managers, signed, across scans, and shows it again.
 *
 * Synology DSM and QNAP (desk-found.md NS-01) are named through the same finder from what they answer before anyone
 * signs in (shapes from the vendors' documentation, NS-08).
 *
 * Nothing real is dialled: the services are stubs on 127.0.0.1 behind home-network addresses and their own ports
 * (`useDiscoveryNetForTests`), host names resolve through the Vault's seam, and every other address and port has
 * nothing listening.
 */
import { X509Certificate } from 'node:crypto';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { type AddressInfo, createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import { type AnyEndpoint, api, buildPath } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { events } from '../db/schema/index';
import { type FakeModbus, startFakeModbus } from '../devices/testing/fake-modbus';
import { IDS } from '../seed/test-world';
import { insertConnection } from '../test/connections';
import { useTestServer } from '../test/harness';
import { SELF_SIGNED_CERT_A, SELF_SIGNED_KEY_A } from '../test/self-signed';
import { sessionFor } from '../test/tokens';
import { useVaultNetForTests } from '../vault/net';
import { DISCOVERY_PORTS } from './discover';
import { useDiscoveryNetForTests } from './finder';

const t = useTestServer({ seed: true, app: true });
const cookies: Record<'mara', string> = { mara: '' };
const PIN_A = new X509Certificate(SELF_SIGNED_CERT_A).fingerprint256;

// biome-ignore lint/suspicious/noExplicitAny: untyped JSON answers in a test
type Json = Record<string, any>;

async function call(
  ep: AnyEndpoint,
  body: unknown,
  who: keyof typeof cookies = 'mara',
): Promise<{ status: number; body: Json }> {
  const res = await t.api.inject({
    method: ep.method,
    url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq' })}`,
    headers: { cookie: cookies[who] },
    payload: body as object,
  });
  return { status: res.statusCode, body: res.json() };
}

const identify = (body: { catalogId?: string; url: string }, who: keyof typeof cookies = 'mara') =>
  call(api.connections.identify, body, who);
const discover = (body: { networks?: string[]; rescan?: boolean } = {}, who: keyof typeof cookies = 'mara') =>
  call(api.connections.discover, body, who);
/** The texts of the signed events of a type. */
async function signed(type: string): Promise<(string | null)[]> {
  const rows = await t.services.db.select().from(events).where(eq(events.type, type));
  return rows.map((e) => e.text);
}
const hideFound = (
  body: { catalogId: string; url: string; hidden?: boolean },
  who: keyof typeof cookies = 'mara',
) => call(api.connections.hideFound, body, who);

/* The stubs ------------------------------------------------------------------------------------------ */

const PVE_INDEX = `<!DOCTYPE html>
<html><head><title>pve - Proxmox Virtual Environment</title>
<link rel="stylesheet" type="text/css" href="/pve2/ext6/theme-crisp/resources/theme-crisp-all.css?ver=7.0.0" />
<link rel="stylesheet" type="text/css" href="/pve2/css/ext6-pve.css?ver=9.0.10" />
</head><body></body></html>`;

let pve: HttpsServer;
let ha: HttpServer;
let portainer: HttpServer;
let grafana: HttpServer;
/** A Synology DSM and a QNAP, as they answer before anyone signs in (NS-01). */
let nas: HttpServer;
/** Computers that answer SSH (connect-in-chat.md): a Debian server's greeting, and a router's (Dropbear). */
let ssh: TcpServer;
let dropbear: TcpServer;
const ports = { pve: 0, ha: 0, portainer: 0, grafana: 0, modbus: 0, nas: 0, ssh: 0, dropbear: 0 };
/** Requests each stub saw. */
const hits = { pve: 0, ha: 0, portainer: 0, grafana: 0 };
/** A heat pump speaking Modbus TCP (one-whombat-devices.md ONE-DD14). */
let heatPump: FakeModbus;

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Where each home-network address and port really is; everything else has nothing listening. */
const DIAL: Record<string, keyof typeof ports> = {
  '192.168.77.10:8006': 'pve',
  '192.168.77.11:9000': 'portainer',
  '192.168.77.12:3000': 'grafana',
  '192.168.77.20:8123': 'ha',
  // Something else on Home Assistant's port (Grafana's stub, which has no manifest).
  '192.168.77.21:8123': 'grafana',
  '192.168.90.7:8006': 'pve',
  '192.168.77.42:502': 'modbus',
  '192.168.91.30:5000': 'nas',
  '192.168.91.31:8080': 'nas',
  // A computer to add as a server; the Proxmox VE host answers SSH too (its row stands for it); a router's SSH.
  '192.168.77.30:22': 'ssh',
  '192.168.77.10:22': 'ssh',
  '192.168.77.31:22': 'dropbear',
};
const HOSTS: Record<string, string[]> = {
  'pve.home.test': ['192.168.77.10'],
  'ha.home.test': ['192.168.77.20'],
  'other.home.test': ['192.168.77.21'],
  'printer.home.test': ['192.168.78.5'],
};
/** Every address a scan or probe dialled. */
const dialled = new Set<string>();

const iface = (address: string, cidr: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: '00:16:3e:00:00:01',
  internal,
  cidr,
});

/** A server that only says its SSH greeting, as an SSH server does before anything is asked. */
function greeter(line: string): TcpServer {
  return createTcpServer((socket) => {
    socket.on('error', () => {});
    socket.end(`${line}\r\n`);
  });
}

async function listen(server: HttpServer | HttpsServer | TcpServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

beforeAll(async () => {
  pve = createHttpsServer({ cert: SELF_SIGNED_CERT_A, key: SELF_SIGNED_KEY_A }, (req, res) => {
    hits.pve++;
    if (req.url === '/api2/json/access/domains')
      return json(res, 200, {
        data: [
          { realm: 'pam', type: 'pam', comment: 'Linux PAM standard authentication' },
          { realm: 'pve', type: 'pve', comment: 'Proxmox VE authentication server' },
        ],
      });
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PVE_INDEX);
    }
    json(res, 501, { data: null });
  });
  ha = createHttpServer((req, res) => {
    hits.ha++;
    if (req.url === '/manifest.json')
      return json(res, 200, { name: 'Home Assistant', short_name: 'Assistant', display: 'standalone' });
    res.writeHead(404);
    res.end();
  });
  portainer = createHttpServer((req, res) => {
    hits.portainer++;
    if (req.url === '/api/system/status')
      return json(res, 200, { Version: '2.33.1', InstanceID: 'f0e1d2c3' });
    res.writeHead(404);
    res.end();
  });
  grafana = createHttpServer((req, res) => {
    hits.grafana++;
    // Slow enough that a scan is still running when the next call comes.
    setTimeout(() => {
      if (req.url === '/api/health')
        return json(res, 200, { database: 'ok', version: '12.2.0', commit: 'a1b2' });
      res.writeHead(404);
      res.end();
    }, 400).unref();
  });
  nas = createHttpServer((req, res) => {
    if (req.url === '/webapi/query.cgi?api=SYNO.API.Info&version=1&method=query&query=SYNO.API.Auth')
      return json(res, 200, {
        data: { 'SYNO.API.Auth': { maxVersion: 7, minVersion: 1, path: 'entry.cgi' } },
        success: true,
      });
    if (req.url === '/cgi-bin/authLogin.cgi') {
      res.writeHead(200, { 'content-type': 'text/xml' });
      return res.end(
        '<?xml version="1.0" encoding="UTF-8" ?>\n<QDocRoot version="1.0"><authPassed><![CDATA[0]]></authPassed><model><modelName><![CDATA[TS-464]]></modelName></model><firmware><version><![CDATA[h5.2.1]]></version></firmware></QDocRoot>',
      );
    }
    res.writeHead(404);
    res.end();
  });
  ports.nas = await listen(nas);
  ports.pve = await listen(pve);
  ports.ha = await listen(ha);
  ports.portainer = await listen(portainer);
  ports.grafana = await listen(grafana);
  ssh = greeter('SSH-2.0-OpenSSH_9.2p1 Debian-2+deb12u3');
  dropbear = greeter('SSH-2.0-dropbear_2022.83');
  ports.ssh = await listen(ssh);
  ports.dropbear = await listen(dropbear);
  heatPump = await startFakeModbus();
  ports.modbus = heatPump.port;

  useVaultNetForTests(t.services, {
    resolve: async (host) => {
      const list = HOSTS[host];
      if (!list) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return list.map((address) => ({ address, family: 4 }));
    },
  });
  useDiscoveryNetForTests(t.services, {
    interfaces: () => ({
      lo: [iface('127.0.0.1', '127.0.0.1/8', true)],
      eth0: [iface('192.168.77.5', '192.168.77.5/24')],
      // The container engine's bridge: never looked in.
      podman1: [iface('10.200.0.1', '10.200.0.1/24')],
    }),
    dial: (address, port) => {
      dialled.add(address);
      const stub = DIAL[`${address}:${port}`];
      return stub ? { address: '127.0.0.1', port: ports[stub] } : null;
    },
  });
  for (const who of ['mara'] as const) cookies[who] = (await sessionFor(t.services, IDS[who])).cookie;
  // The local network open (LN-01), as on an appliance.
  t.services.config.WHOMBAT_LOCAL_NETWORK = 'on';
});

afterAll(async () => {
  await heatPump?.close();
  for (const s of [ssh, dropbear])
    await new Promise<void>((resolve) => (s ? s.close(() => resolve()) : resolve()));
  for (const s of [pve, ha, portainer, grafana, nas]) {
    s?.closeAllConnections();
    await new Promise<void>((resolve) => (s ? s.close(() => resolve()) : resolve()));
  }
});

/* identify ------------------------------------------------------------------------------------------- */

describe('connections.identify (CS-13)', () => {
  it('names a self-signed Proxmox VE with its version and certificate, adding https and its port', async () => {
    const res = await identify({ catalogId: 'proxmox', url: 'pve.home.test' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      url: 'https://pve.home.test:8006',
      reachable: true,
      catalogId: 'proxmox',
      version: '9.0.10',
      certificate: { sha256: PIN_A, trusted: false },
      message: null,
    });
    // A browser's address: the fragment and trailing slash go.
    const browser = await identify({
      catalogId: 'proxmox',
      url: 'https://192.168.77.10:8006/#v1:0:18:4:::::::',
    });
    expect(browser.body).toMatchObject({ url: 'https://192.168.77.10:8006', catalogId: 'proxmox' });
    // Without an entry, every entry's probes are tried.
    const any = await identify({ url: '192.168.77.10:8006' });
    expect(any.body).toMatchObject({
      url: 'https://192.168.77.10:8006',
      catalogId: 'proxmox',
      version: '9.0.10',
    });
  });

  it('names a Home Assistant over http, without a certificate', async () => {
    const res = await identify({ catalogId: 'homeassistant', url: 'ha.home.test/' });
    expect(res.body).toEqual({
      url: 'http://ha.home.test:8123',
      reachable: true,
      catalogId: 'homeassistant',
      version: null,
      certificate: null,
      message: null,
    });
    const any = await identify({ url: 'http://ha.home.test:8123/lovelace/0?edit=1' });
    expect(any.body).toMatchObject({ url: 'http://ha.home.test:8123', catalogId: 'homeassistant' });
  });

  it('names a Synology DSM and a QNAP from what they answer before anyone signs in (NS-01)', async () => {
    const syno = await identify({ url: 'http://192.168.91.30:5000' });
    expect(syno.body).toMatchObject({
      url: 'http://192.168.91.30:5000',
      reachable: true,
      catalogId: 'synology',
    });
    const qnap = await identify({ catalogId: 'qnap', url: 'http://192.168.91.31:8080' });
    expect(qnap.body).toMatchObject({ catalogId: 'qnap', version: 'h5.2.1', message: null });
    // A DSM isn't a QNAP.
    const not = await identify({ catalogId: 'qnap', url: 'http://192.168.91.30:8080' });
    expect(not.body.catalogId).toBeNull();
  });

  it('says so when the address isn’t what was asked, or nothing answers', async () => {
    const other = await identify({ catalogId: 'homeassistant', url: 'other.home.test' });
    expect(other.body).toEqual({
      url: 'http://other.home.test:8123',
      reachable: true,
      catalogId: null,
      version: null,
      certificate: null,
      message: 'That address answered, but it isn’t a Home Assistant.',
    });
    const nothing = await identify({ catalogId: 'proxmox', url: 'other.home.test' });
    expect(nothing.body).toMatchObject({
      url: 'https://other.home.test:8006',
      reachable: false,
      catalogId: null,
      message: 'Nothing answered at that address.',
    });
  });

  it('refuses an address as connect does, before anything is sent', async () => {
    const before = { ...hits };
    t.services.config.WHOMBAT_LOCAL_NETWORK = 'off';
    try {
      // The person adds the network themselves (CT-1553).
      const refused = await identify({ catalogId: 'homeassistant', url: 'printer.home.test' });
      expect(refused.status).toBe(403);
      expect(refused.body.error.details).toMatchObject({
        code: 'destination_refused',
        cidr: '192.168.78.0/24',
        port: 8123,
      });
    } finally {
      t.services.config.WHOMBAT_LOCAL_NETWORK = 'on';
    }
    const loopback = await identify({ catalogId: 'homeassistant', url: 'http://127.0.0.1:8123' });
    expect(loopback.body.error.details).toMatchObject({ code: 'destination_refused', problem: 'never' });
    expect(hits).toEqual(before);

    const bad = await identify({ catalogId: 'proxmox', url: 'ftp://pve.home.test' });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.error.fields)).toEqual(['url']);
    const builtin = await identify({ catalogId: 'github', url: 'pve.home.test' });
    expect(builtin.body.error.details.code).toBe('not_supported');
  });
});

/* discover ------------------------------------------------------------------------------------------- */

async function untilDone(): Promise<Json> {
  for (let i = 0; i < 400; i++) {
    const res = await discover();
    if (res.body.state === 'done') return res.body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the scan didn’t finish');
}

describe('connections.discover (CS-14)', () => {
  let pveConnection = '';
  let grafanaConnection = '';
  let firstStart = '';

  beforeAll(async () => {
    // Proxmox VE connected by its name, Grafana by its address.
    pveConnection = await insertConnection(t.services, {
      catalogId: 'proxmox',
      burrowId: t.burrowId,
      fields: { url: 'https://pve.home.test:8006' },
      secret: 'x',
    });
    grafanaConnection = await insertConnection(t.services, {
      catalogId: 'grafana',
      burrowId: t.burrowId,
      fields: { url: 'http://192.168.77.12:3000' },
      secret: 'x',
    });
  });

  it('checks the networks asked for', async () => {
    for (const network of ['10.0.0.0/16', '8.8.8.0/24', 'fd00::/120', '127.0.0.0/24', 'nope']) {
      const res = await discover({ networks: ['192.168.80.0/24', network] });
      expect(res.status, network).toBe(400);
      expect(Object.keys(res.body.error.fields)).toEqual(['networks.1']);
    }
  });

  it('scans this Whombat’s network, finds the services and marks the ones already connected', async () => {
    const idle = { ...hits };
    // What identify dialled before is not the scan's.
    dialled.clear();
    const first = await discover();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      state: 'scanning',
      finishedAt: null,
      networks: ['192.168.77.0/24'],
      progress: { total: 253 * DISCOVERY_PORTS.length },
    });
    expect(first.body.progress.done).toBeLessThan(first.body.progress.total);
    firstStart = first.body.startedAt;
    // A call during the scan answers the running one.
    const during = await discover({ rescan: true });
    expect(during.body).toMatchObject({ state: 'scanning', startedAt: firstStart });

    const done = await untilDone();
    expect(done).toMatchObject({ state: 'done', progress: null, startedAt: firstStart });
    expect(done.finishedAt).toEqual(expect.any(String));
    expect(done.found).toEqual([
      {
        catalogId: 'proxmox',
        url: 'https://192.168.77.10:8006',
        host: '192.168.77.10',
        version: '9.0.10',
        certificate: { sha256: PIN_A, trusted: false },
        connectionIds: [pveConnection],
        hidden: false,
        serverIds: [],
      },
      {
        catalogId: 'portainer',
        url: 'http://192.168.77.11:9000',
        host: '192.168.77.11',
        version: '2.33.1',
        certificate: null,
        connectionIds: [],
        hidden: false,
        serverIds: [],
      },
      {
        catalogId: 'grafana',
        url: 'http://192.168.77.12:3000',
        host: '192.168.77.12',
        version: '12.2.0',
        certificate: null,
        connectionIds: [grafanaConnection],
        hidden: false,
        serverIds: [],
      },
      {
        catalogId: 'homeassistant',
        url: 'http://192.168.77.20:8123',
        host: '192.168.77.20',
        version: null,
        certificate: null,
        connectionIds: [],
        hidden: false,
        serverIds: [],
      },
      // A computer that answers SSH, named by its system (connect-in-chat.md); the Proxmox VE host's SSH and a
      // router's Dropbear aren't rows of their own.
      {
        catalogId: 'server',
        url: 'ssh://192.168.77.30',
        host: '192.168.77.30',
        version: 'Debian',
        certificate: null,
        connectionIds: [],
        hidden: false,
        serverIds: [],
      },
      // A Modbus TCP device on 502, a device Whombat can learn; asked only to read (FC3, FC43).
      {
        catalogId: 'device',
        url: 'modbus://192.168.77.42:502',
        host: '192.168.77.42',
        version: 'Daikin EKRHH',
        certificate: null,
        connectionIds: [],
        hidden: false,
        serverIds: [],
      },
    ]);
    expect(heatPump.requests.map((r) => r.fc)).toEqual([3, 0x2b]);
    expect(hits.pve).toBeGreaterThan(idle.pve);
    // Never this Whombat itself, never the container engine's bridge, nothing outside the network.
    expect(dialled.has('192.168.77.5')).toBe(false);
    expect([...dialled].every((a) => a.startsWith('192.168.77.'))).toBe(true);
    expect(dialled.has('192.168.77.0')).toBe(false);
    expect(dialled.has('192.168.77.255')).toBe(false);
  });

  it('answers a recent scan instead of starting another', async () => {
    const again = await discover();
    expect(again.body).toMatchObject({ state: 'done', startedAt: firstStart });
    expect(again.body.found).toHaveLength(6);
  });

  it('rescans one at a time, keeping what was found until the new scan finishes', async () => {
    const started = await discover({ rescan: true });
    expect(started.body.state).toBe('scanning');
    expect(started.body.startedAt).not.toBe(firstStart);
    expect(started.body.found.map((f: Json) => f.catalogId)).toEqual([
      'proxmox',
      'portainer',
      'grafana',
      'homeassistant',
      'server',
      'device',
    ]);
    const twice = await discover({ rescan: true });
    expect(twice.body).toMatchObject({ state: 'scanning', startedAt: started.body.startedAt });
    const done = await untilDone();
    expect(done.startedAt).toBe(started.body.startedAt);
    expect(done.found).toHaveLength(6);
  });

  it('looks in a network asked for, and again on the next scans', async () => {
    const asked = await discover({ networks: ['192.168.90.0/24'] });
    expect(asked.body).toMatchObject({ state: 'scanning', networks: ['192.168.77.0/24', '192.168.90.0/24'] });
    expect(asked.body.progress.total).toBe((253 + 254) * DISCOVERY_PORTS.length);
    const done = await untilDone();
    expect(done.found.map((f: Json) => f.url)).toContain('https://192.168.90.7:8006');
    const rescan = await discover({ rescan: true });
    expect(rescan.body.networks).toEqual(['192.168.77.0/24', '192.168.90.0/24']);
    await untilDone();
  });

  it('with the local network closed, looks only in the home network list, on its listed ports', async () => {
    t.services.config.WHOMBAT_LOCAL_NETWORK = 'off';
    try {
      const listed = await call(
        api.connections.allowNetwork,
        { cidr: '192.168.77.0/24', port: 8006 },
        'mara',
      );
      expect(listed.status).toBe(200);
      const closed = await discover({ rescan: true });
      // The asked network isn't on the list, so it isn't looked in.
      expect(closed.body).toMatchObject({
        state: 'scanning',
        networks: ['192.168.77.0/24'],
        progress: { total: 253 },
      });
      const done = await untilDone();
      expect(done.found.map((f: Json) => `${f.catalogId} ${f.url}`)).toEqual([
        'proxmox https://192.168.77.10:8006',
      ]);
      // A network asked for must lie inside the list now.
      const outside = await discover({ networks: ['192.168.77.128/25', '192.168.91.0/24'] });
      expect(outside.status).toBe(400);
      expect(outside.body.error.fields).toEqual({
        'networks.1': [
          'With the local network closed, Whombat looks only in the home network list. Add this network there first.',
        ],
      });
      const inside = await discover({ networks: ['192.168.77.128/25'] });
      expect(inside.body).toMatchObject({
        state: 'scanning',
        networks: ['192.168.77.0/24', '192.168.77.128/25'],
        progress: { total: 253 },
      });
      await untilDone();
    } finally {
      t.services.config.WHOMBAT_LOCAL_NETWORK = 'on';
    }
  });

  it('counts a connection there only for its own entry on that host, or a custom one on that port (CS-52)', async () => {
    const shared = (catalogId: string, url: string) =>
      insertConnection(t.services, {
        catalogId,
        burrowId: t.burrowId,
        fields: { url },
        secret: 'x',
      });
    // Unraid on Proxmox VE's address and port isn't Proxmox VE; Portainer on another port of its host is.
    const unraid = await shared('unraid', 'https://192.168.77.10:8006');
    const portainerTls = await shared('portainer', 'https://192.168.77.11:9443');
    const custom = await shared('custom_api', 'http://192.168.77.20:8123');
    await discover({ rescan: true });
    const done = await untilDone();
    const ids = Object.fromEntries(done.found.map((f: Json) => [f.url, f.connectionIds]));
    expect(ids['https://192.168.77.10:8006']).toEqual([pveConnection]);
    expect(ids['http://192.168.77.11:9000']).toEqual([portainerTls]);
    expect(ids['http://192.168.77.20:8123']).toEqual([custom]);
    expect(unraid).not.toBe('');
  });

  it('hides a found service until it is shown again (CS-53)', async () => {
    const grafana = { catalogId: 'grafana', url: 'http://192.168.77.12:3000' };
    for (const bad of [
      { catalogId: 'notion', url: grafana.url },
      { catalogId: 'grafana', url: 'http://8.8.8.8:3000' },
      { catalogId: 'grafana', url: 'nope' },
    ]) {
      const res = await hideFound(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }

    const hidden = await hideFound(grafana);
    expect(hidden.status).toBe(200);
    expect(hidden.body.state).toBe('done');
    const flags = (body: Json) => Object.fromEntries(body.found.map((f: Json) => [f.url, f.hidden]));
    expect(flags(hidden.body)).toMatchObject({ [grafana.url]: true, 'https://192.168.77.10:8006': false });
    expect(await signed('connection.found_hidden')).toEqual([
      'Hid Grafana at http://192.168.77.12:3000 from Found on your network',
    ]);
    // Hiding it again changes nothing and signs nothing.
    expect((await hideFound(grafana)).status).toBe(200);
    expect(await signed('connection.found_hidden')).toHaveLength(1);

    // Kept across scans.
    await discover({ rescan: true });
    expect(flags(await untilDone())[grafana.url]).toBe(true);

    const shown = await hideFound({ ...grafana, hidden: false });
    expect(flags(shown.body)[grafana.url]).toBe(false);
    expect(await signed('connection.found_shown')).toEqual([
      'Showed Grafana at http://192.168.77.12:3000 in Found on your network again',
    ]);

    // A Modbus device hides the same way (one-whombat-devices.md ONE-DD14).
    const pump = await hideFound({ catalogId: 'device', url: 'modbus://192.168.77.42:502' });
    expect(pump.status).toBe(200);
    expect(flags(pump.body)['modbus://192.168.77.42:502']).toBe(true);
    expect((await signed('connection.found_hidden')).at(-1)).toBe(
      'Hid Device at modbus://192.168.77.42:502 from Found on your network',
    );
  });
});
