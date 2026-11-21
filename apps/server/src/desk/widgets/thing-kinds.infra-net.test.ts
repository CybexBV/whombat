/**
 * Cloudflare's, OPNsense's and Tailscale's pages in slots as widgets (desk-display-server.md “Every connection's
 * widgets”): OPNsense's figures lead with the internet and its VPN devices stay off a locked screen; Tailscale's Online
 * now is a list without the owners and Who's on it is private; Cloudflare's figures are its tunnels and sites. Pure:
 * the kinds' own builders, laid out as a page, through the widgets' runtime.
 */
import { describe, expect, it } from 'vitest';
import type { CatalogConnectionRow } from '../../connections/types';
import {
  type CfSnapshot,
  cloudflareView,
  parseConnections,
  parseTraffic,
  parseTunnels,
  parseZones,
} from '../../things/kinds/infra/cloudflare';
import {
  CF_CONNECTIONS,
  CF_GRAPHQL_HOURLY,
  CF_TUNNELS,
  CF_ZONES,
} from '../../things/kinds/infra/fixtures/cloudflare';
import {
  OPN_ACTIVITY,
  OPN_FIRMWARE,
  OPN_GATEWAY_SEARCH,
  OPN_GATEWAYS,
  OPN_RESOURCES,
  OPN_SERVICES,
  OPN_STATES,
  OPN_SYSTEM_STATUS,
  OPN_TIME,
  OPN_WIREGUARD,
} from '../../things/kinds/infra/fixtures/opnsense';
import {
  opnsenseView,
  parseCpu,
  parseDefaultGateway,
  parseFirmware,
  parseGateways,
  parseMemory,
  parsePeers,
  parseServices,
  parseStates,
  parseSystemStatus,
  uptimeWords,
} from '../../things/kinds/infra/opnsense';
import { parseDevices, parseUsers, tailscaleView } from '../../things/kinds/infra/tailscale';
import { as, NOW, pageOf, panelOn, TZ, viewsOn } from './thing-testing';

const row = (catalogId: string) =>
  ({
    id: `con_${catalogId}`,
    access: 'manage',
    label: catalogId,
    catalogId,
    fields: {},
  }) as unknown as CatalogConnectionRow;

function opnsensePage() {
  const view = opnsenseView({
    snapshot: {
      readAt: NOW,
      gateways: parseGateways(OPN_GATEWAYS),
      defaultGateway: parseDefaultGateway(OPN_GATEWAY_SEARCH),
      services: parseServices(OPN_SERVICES),
      notices: parseSystemStatus(OPN_SYSTEM_STATUS),
      firmware: parseFirmware(OPN_FIRMWARE),
      cpuPct: parseCpu(OPN_ACTIVITY),
      memory: parseMemory(OPN_RESOURCES),
      states: parseStates(OPN_STATES),
      peers: parsePeers(OPN_WIREGUARD),
      uptime: uptimeWords(OPN_TIME),
    },
    lines: null,
    now: NOW,
    timeZone: TZ,
    url: 'https://192.168.1.1',
    row: row('opnsense'),
  });
  return pageOf(view, { catalogId: 'opnsense', name: 'OPNsense' });
}

function tailscalePage() {
  const device = (id: string, name: string, user: string, online: boolean) => ({
    nodeId: id,
    name: `${name}.tail1234.ts.net`,
    user,
    os: 'macOS',
    clientVersion: '1.90.1',
    connectedToControl: online,
    lastSeen: '2026-10-21T18:00:00Z',
    keyExpiryDisabled: true,
    authorized: true,
    tags: [],
  });
  const snapshot = {
    readAt: NOW,
    devices: parseDevices(
      {
        devices: [
          device('n1', 'laptop', 'anna@example.com', true),
          device('n2', 'phone', 'anna@example.com', true),
          device('n3', 'desktop', 'sam@example.com', false),
        ],
      },
      NOW,
    ),
    users: parseUsers({ users: [{ loginName: 'anna@example.com', displayName: 'Anna de Vries' }] }),
  };
  return pageOf(tailscaleView({ snapshot, now: NOW, row: row('tailscale') }), {
    catalogId: 'tailscale',
    name: 'Tailscale',
  });
}

function cloudflarePage() {
  const { zones, total } = parseZones(CF_ZONES);
  const tunnels = parseTunnels(CF_TUNNELS, 'acc');
  Object.assign(tunnels[0] as object, parseConnections(CF_CONNECTIONS));
  const snapshot: CfSnapshot = {
    readAt: NOW,
    zones,
    zonesTotal: total,
    traffic: parseTraffic(CF_GRAPHQL_HOURLY, NOW),
    tunnels,
    certificates: [],
  };
  return pageOf(cloudflareView({ snapshot, now: NOW, timeZone: TZ, row: row('cloudflare') }), {
    catalogId: 'cloudflare',
    name: 'Cloudflare',
  });
}

describe('OPNsense', () => {
  it('leads its figures with the internet, under the figure’s old key', async () => {
    const got = await viewsOn(opnsensePage(), [{ id: 'w_fig', type: 'figures', opts: {} }]);
    const items = as(got.get('w_fig'), 'figures').items;
    expect(items[0]).toMatchObject({ label: 'Internet', value: '4.2 ms' });
  });

  it('keeps the VPN devices off a locked screen', async () => {
    expect((await panelOn(opnsensePage(), 'wireguard')).private).toBe(true);
  });
});

describe('Tailscale', () => {
  it('lists what’s online without the owners, and keeps Who’s on it private', async () => {
    const page = tailscalePage();
    const online = await panelOn(page, 'online');
    expect(online.private).toBe(false);
    expect(as(online, 'list').rows.map((r) => r.title)).toEqual(['laptop', 'phone', 'desktop']);
    expect(JSON.stringify(online.view)).not.toContain('Anna');
    expect((await panelOn(page, 'people')).private).toBe(true);
    // The Devices table in its tab is still the desk's.
    const devices = await panelOn(page, 'devices');
    expect(as(devices, 'list').rows[0]).toMatchObject({ title: 'laptop', meta: 'Online' });
  });
});

describe('Cloudflare', () => {
  it('gives its tunnels and sites as figures', async () => {
    const got = await viewsOn(cloudflarePage(), [{ id: 'w_fig', type: 'figures', opts: {} }]);
    const items = as(got.get('w_fig'), 'figures').items;
    expect(items.map((i) => i.label)).toEqual(['office', 'home', 'example.com', 'example.org']);
    expect(items[0]?.tone).toBe('bad');
  });
});
