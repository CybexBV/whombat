/**
 * Open to the internet in fixture mode (Whombat internet-exposure.md): `things.exposure` as the runtime answers it for
 * Mara's house (a proxy, a tunnel, the router and the tailnet), and This is meant through `things.setWatch` on the
 * check `exposure.new`, which the page reads back. Made-up names and the example ranges only.
 */
import { EXPOSURE_NEW_CHECK, type ExposureOpening, type ExposureView, type ThingWatch } from '@whombat/core';
import type { SetThingWatchBody } from '@whombat/core/contracts';

const NPM = 'connection:con_npm';
const CLOUDFLARE = 'connection:con_cloudflare';
const UNIFI = 'connection:con_unifi';

type Seed = Omit<ExposureOpening, 'meant' | 'isNew' | 'watch' | 'ask'> & { isNew?: boolean };

function opening(o: Seed): ExposureOpening {
  const { isNew = false, ...rest } = o;
  const name = o.how === 'port_forward' ? o.address.replace(/^Port /, '') : o.address;
  return {
    ...rest,
    meant: false,
    isNew,
    ask: `Is it safe that ${o.address} is open to the internet (${o.via})?`,
    watch: { thing: o.sourceThing, check: EXPOSURE_NEW_CHECK, subject: { id: `open:${o.id}`, name } },
  };
}

const SEEDS: readonly ExposureOpening[] = [
  opening({
    id: 'op_proxmox',
    source: 'nginx_proxy_manager',
    sourceThing: NPM,
    sourceName: 'Nginx Proxy Manager',
    how: 'proxy',
    address: 'pve.example.com',
    title: 'pve.example.com → pve-02',
    via: 'Through Nginx Proxy Manager',
    target: '10.100.0.12:8006',
    leadsTo: { thing: 'server:pve-02', name: 'pve-02', href: '/things/server%3Apve-02' },
    protection: { https: 'yes', guard: 'none', words: 'HTTPS · nothing in front of it' },
    risk: {
      kind: 'admin_open',
      words: 'pve-02 can be reached from the internet with nothing in front of it.',
    },
    firstSeen: '2026-11-02T09:12:00.000Z',
    manage: { label: 'Change it in Nginx Proxy Manager', url: 'https://npm.example.com/' },
  }),
  opening({
    id: 'op_photos',
    source: 'nginx_proxy_manager',
    sourceThing: NPM,
    sourceName: 'Nginx Proxy Manager',
    how: 'proxy',
    address: 'photos.example.com',
    title: 'photos.example.com → Immich on pve-02',
    via: 'Through Nginx Proxy Manager',
    target: '10.100.0.31:2283',
    protection: { https: 'yes', guard: 'access_list', words: 'HTTPS · access list ‘Family’' },
    isNew: true,
    firstSeen: '2026-11-28T08:40:00.000Z',
    manage: { label: 'Change it in Nginx Proxy Manager', url: 'https://npm.example.com/' },
  }),
  opening({
    id: 'op_home',
    source: 'cloudflare',
    sourceThing: CLOUDFLARE,
    sourceName: 'Cloudflare',
    how: 'tunnel',
    address: 'home.example.com',
    title: 'home.example.com → Home Assistant',
    via: 'Cloudflare tunnel ‘house’',
    target: 'http://10.100.0.40:8123',
    leadsTo: {
      thing: 'connection:con_home-assistant',
      name: 'Home Assistant',
      href: '/things/connection%3Acon_home-assistant',
    },
    protection: { https: 'yes', guard: 'cloudflare_access', words: 'HTTPS · Cloudflare Access' },
    firstSeen: '2026-10-14T18:03:00.000Z',
    manage: { label: 'Change it in Cloudflare', url: 'https://one.dash.cloudflare.com/' },
  }),
  opening({
    id: 'op_plex',
    source: 'unifi_network',
    sourceThing: UNIFI,
    sourceName: 'UniFi Network',
    how: 'port_forward',
    address: 'Port 32400',
    title: 'Port 32400 → Plex on pve-02',
    via: 'Port forward ‘Plex’ on UniFi Network · TCP',
    target: '10.100.0.30:32400',
    protection: { https: 'unknown', guard: 'none', words: 'Nothing in front of it' },
    firstSeen: '2026-09-21T11:30:00.000Z',
    manage: { label: 'Change it in UniFi Network', url: 'https://unifi.example.com/' },
  }),
  opening({
    id: 'op_wireguard',
    source: 'unifi_network',
    sourceThing: UNIFI,
    sourceName: 'UniFi Network',
    how: 'port_forward',
    address: 'Port 51820',
    title: 'Port 51820 → 10.100.0.20',
    via: 'Port forward ‘WireGuard’ on UniFi Network · UDP',
    target: '10.100.0.20:51820',
    protection: { https: 'unknown', guard: 'none', words: 'Nothing in front of it' },
    firstSeen: '2026-09-21T11:30:00.000Z',
    manage: { label: 'Change it in UniFi Network', url: 'https://unifi.example.com/' },
  }),
];

const NOTE =
  'Whombat reads these from the settings of what it’s connected to. It never checks from outside your house, so something set up elsewhere can still be open.';

function summary(list: readonly ExposureOpening[]): string {
  const looks = list.filter((o) => o.risk).length;
  const fresh = list.filter((o) => o.isNew).length;
  return [
    `${list.length} openings`,
    ...(looks ? [`${looks} worth a look`] : []),
    ...(fresh ? [`${fresh} new`] : []),
  ].join(' · ');
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function createExposureFixtures() {
  /** The openings the person said are meant (`open:<id>`). */
  const meant = new Set<string>();

  function view(now: number): ExposureView {
    const openings = SEEDS.map((o): ExposureOpening => {
      if (!meant.has(o.watch.subject.id)) return o;
      const { risk: _risk, ...rest } = o;
      return { ...rest, meant: true, isNew: false };
    });
    return {
      openings,
      sources: [
        {
          thing: NPM,
          name: 'Nginx Proxy Manager',
          state: 'read',
          words: '2 openings',
          href: '/things/connection%3Acon_npm',
        },
        {
          thing: CLOUDFLARE,
          name: 'Cloudflare',
          state: 'partly',
          words:
            '1 opening. Tunnel ‘office’ is set up on its own server: Whombat can’t see its public names.',
          href: '/things/connection%3Acon_cloudflare',
        },
        {
          thing: UNIFI,
          name: 'UniFi Network',
          state: 'partly',
          words:
            '2 openings. UPnP is on: devices in the house can open ports by themselves, and Whombat can’t see which.',
          href: '/things/connection%3Acon_unifi',
        },
        {
          thing: 'connection:con_tailscale',
          name: 'Tailscale',
          state: 'read',
          words: 'Funnel is off in your tailnet’s policy: nothing is shared through it.',
          href: '/things/connection%3Acon_tailscale',
        },
      ],
      summary: summary(openings),
      note: NOTE,
      readAt: new Date(now).toISOString(),
    };
  }

  /** The page, or This is meant on one opening; anything else goes on. */
  async function fetch(req: Request, inner: (req: Request) => Promise<Response>): Promise<Response> {
    const path = new URL(req.url, 'http://fixtures.local').pathname;
    if (req.method === 'GET' && /^\/api\/v1\/burrows\/[^/]+\/exposure$/.test(path))
      return json(view(Date.now()));
    if (req.method === 'POST' && /^\/api\/v1\/burrows\/[^/]+\/things\/[^/]+\/watch$/.test(path)) {
      const body = (await req.clone().json()) as SetThingWatchBody;
      if (body.check === EXPOSURE_NEW_CHECK && body.subject) {
        if (body.watched) meant.delete(body.subject.id);
        else meant.add(body.subject.id);
        const answer: ThingWatch = { checks: [], mayChange: true };
        return json(answer);
      }
    }
    return inner(req);
  }

  return { fetch };
}
