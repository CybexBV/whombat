/**
 * What's protected in fixture mode (Whombat backup-trust.md): `protected.get` as the runtime answers it for Mara's world
 * — this Whombat copied to blackbox and off site, pve-02's machines backed up to pbs-01 or only to its own disks, the
 * servers themselves unseen, Home Assistant with its own cloud copy, Paperless riding on its machine — and
 * `restoreTests.set` / `restoreTests.run` kept in memory (a run finishes at once, as having worked). `tested`
 * (`VITE_FIXTURE_PROTECTED=tested`, or `localStorage['whombat:fixture-protected']` for the visual suite) starts with
 * pve-02's tests on and three results, one that failed, and shows each result on its machine's page; without it the
 * tests start off and the machines' pages stay as drawn.
 */
import type {
  HostGuestDetail,
  ProtectedRow,
  ProtectedView,
  RestoreTestResult,
  RestoreTestServer,
} from '@whombat/core';
import { API_ENDPOINTS, matchPath } from '@whombat/core/contracts';
import { burrow } from '@whombat/fixtures';

export type ProtectedFixtureKind = 'calm' | 'tested';

/** The visual suite's and a person's switch: `localStorage['whombat:fixture-protected']`. */
export const PROTECTED_FIXTURE_KEY = 'whombat:fixture-protected';

/** `option`, else `VITE_FIXTURE_PROTECTED`, else the switch in localStorage, else calm. */
export function protectedFixtureKind(option: ProtectedFixtureKind | undefined): ProtectedFixtureKind {
  if (option) return option;
  if (import.meta.env.VITE_FIXTURE_PROTECTED === 'tested') return 'tested';
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(PROTECTED_FIXTURE_KEY) === 'tested')
      return 'tested';
  } catch {
    // Storage may be shut: calm.
  }
  return 'calm';
}

const API_BASE = '/api/v1';
const HOUR = 3_600_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const guestHref = (server: string, guest: string) =>
  `/things/${encodeURIComponent(`server:${server}`)}?guest=${encodeURIComponent(guest)}`;

/** pve-02's machines with what Whombat sees of their backups. */
const MACHINES: readonly {
  id: string;
  name: string;
  kind: 'vm' | 'container';
  state: ProtectedRow['state'];
  hoursAgo?: number;
  where?: string;
  failedHoursAgo?: number;
}[] = [
  { id: 'pve:131', name: 'homeassistant', kind: 'vm', state: 'copied', hoursAgo: 5, where: 'pbs-01' },
  { id: 'pve:132', name: 'nextcloud', kind: 'container', state: 'copied', hoursAgo: 5, where: 'pbs-01' },
  { id: 'pve:133', name: 'paperless', kind: 'container', state: 'copied', hoursAgo: 5, where: 'pbs-01' },
  { id: 'pve:142', name: 'vaultwarden', kind: 'container', state: 'copied', hoursAgo: 5, where: 'pbs-01' },
  {
    id: 'pve:118',
    name: 'arnica-prod-nest-01',
    kind: 'vm',
    state: 'copied',
    hoursAgo: 53,
    where: 'pbs-01',
    failedHoursAgo: 5,
  },
  { id: 'pve:143', name: 'gitea', kind: 'container', state: 'local', hoursAgo: 29, where: 'local' },
  { id: 'pve:134', name: 'jellyfin', kind: 'container', state: 'local', hoursAgo: 29, where: 'local' },
  { id: 'pve:123', name: 'win11-test', kind: 'vm', state: 'none' },
  { id: 'pve:144', name: 'minecraft', kind: 'container', state: 'none' },
];

function seedResults(now: number): Map<string, RestoreTestResult> {
  const day = (daysAgo: number) => new Date(now - daysAgo * 24 * HOUR).toISOString();
  return new Map<string, RestoreTestResult>([
    [
      'pve:131',
      {
        serverId: 'pve-02',
        guestId: 'pve:131',
        guestName: 'homeassistant',
        at: day(2),
        outcome: 'worked',
        durationS: 240,
        booted: true,
      },
    ],
    [
      'pve:132',
      {
        serverId: 'pve-02',
        guestId: 'pve:132',
        guestName: 'nextcloud',
        at: day(9),
        outcome: 'worked',
        durationS: 180,
        booted: true,
      },
    ],
    [
      'pve:142',
      {
        serverId: 'pve-02',
        guestId: 'pve:142',
        guestName: 'vaultwarden',
        at: day(16),
        outcome: 'failed',
        reason: 'no_boot',
        durationS: 900,
        booted: false,
      },
    ],
  ]);
}

export interface ProtectedFixtures {
  handle(req: Request): Promise<Response | null>;
  /** A pve-02 machine's page carries its newest result (`tested` only). */
  decorate(req: Request, response: Response): Promise<Response>;
}

export function createProtectedFixtures(kind: ProtectedFixtureKind, now = Date.now()): ProtectedFixtures {
  const ago = (hours: number) => new Date(now - hours * HOUR).toISOString();
  const results = kind === 'tested' ? seedResults(now) : new Map<string, RestoreTestResult>();
  const tests: RestoreTestServer = {
    serverId: 'pve-02',
    serverName: 'pve-02',
    on: kind === 'tested',
    guests: [],
    eligible: MACHINES.map((m) => ({ id: m.id, name: m.name, kind: m.kind })),
    last: null,
    running: null,
    next: null,
  };
  const nextSunday = () => {
    const d = new Date(now);
    d.setDate(d.getDate() + ((7 - d.getDay()) % 7 || 7));
    d.setHours(3, 0, 0, 0);
    return d.toISOString();
  };
  const testServer = (): RestoreTestServer => {
    const newest = [...results.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
    return { ...tests, last: newest, next: tests.on ? nextSunday() : null };
  };

  const view = (): ProtectedView => {
    const machine = (m: (typeof MACHINES)[number]): ProtectedRow => ({
      key: `guest:pve-02:${m.id}`,
      kind: m.kind,
      name: m.name,
      on: 'pve-02',
      href: guestHref('pve-02', m.id),
      state: m.state,
      lastAt: m.hoursAgo ? ago(m.hoursAgo) : null,
      where: m.state === 'copied' ? (m.where ?? null) : null,
      ...(m.failedHoursAgo ? { failedAt: ago(m.failedHoursAgo) } : {}),
      restoreTest: results.get(m.id) ?? null,
      serverId: 'pve-02',
      guestId: m.id,
    });
    const server = (id: string): ProtectedRow => ({
      key: `server:${id}`,
      kind: 'server',
      name: id,
      href: `/things/${encodeURIComponent(`server:${id}`)}`,
      state: 'unseen',
      lastAt: null,
      where: null,
      serverId: id,
    });
    return {
      rows: [
        {
          key: 'whombat',
          kind: 'whombat',
          name: 'Whombat',
          href: '/settings?tab=appliance&section=backups',
          state: 'copied',
          lastAt: ago(3),
          where: 'blackbox',
          offsite: { name: 'Backblaze', lastAt: ago(2) },
        },
        ...MACHINES.map(machine),
        {
          key: 'connection:con_home-assistant',
          kind: 'service',
          name: 'Home Assistant',
          catalogId: 'homeassistant',
          href: `/things/${encodeURIComponent('connection:con_home-assistant')}`,
          state: 'copied',
          lastAt: ago(7),
          where: 'Home Assistant Cloud',
        },
        {
          key: 'connection:con_plex',
          kind: 'service',
          name: 'Plex',
          catalogId: 'plex',
          href: `/things/${encodeURIComponent('connection:con_plex')}`,
          state: 'unseen',
          lastAt: null,
          where: null,
        },
        server('pve-02'),
        server('pve-01'),
        server('blackbox'),
      ],
      restoreTests: [testServer()],
      unread: ['the-falcon'],
      at: new Date(now).toISOString(),
    };
  };

  const match = (req: Request) => {
    const url = new URL(req.url, 'http://fixtures.local');
    const path = url.pathname.startsWith(API_BASE) ? url.pathname.slice(API_BASE.length) : url.pathname;
    for (const ep of API_ENDPOINTS) {
      if (ep.method !== req.method) continue;
      const params = matchPath(ep.path, path);
      if (params && (params.burrow === burrow.slug || !('burrow' in params))) return { id: ep.id, params };
    }
    return null;
  };

  return {
    async handle(req) {
      const m = match(req);
      if (!m) return null;
      if (m.id === 'protected.get') return json(view());
      if (m.id !== 'restoreTests.set' && m.id !== 'restoreTests.run') return null;
      if (m.params.serverId !== 'pve-02')
        return json({ error: { code: 'not_found', message: 'That server isn’t here.' } }, 404);
      const body = (await req.clone().json()) as { on?: boolean; guests?: string[]; guest?: string };
      if (m.id === 'restoreTests.set') {
        tests.on = !!body.on;
        if (body.guests) tests.guests = body.guests;
        return json(testServer());
      }
      // A run in fixture mode is over at once: the machine whose turn it is (or the one asked for) worked.
      const pick =
        MACHINES.find((x) => x.id === body.guest) ??
        MACHINES.filter(
          (x) => x.state !== 'none' && (!tests.guests.length || tests.guests.includes(x.id)),
        ).sort(
          (a, b) => Date.parse(results.get(a.id)?.at ?? '1970') - Date.parse(results.get(b.id)?.at ?? '1970'),
        )[0];
      if (!pick) return json({ error: { code: 'conflict', message: 'That machine can’t be tested.' } }, 409);
      results.set(pick.id, {
        serverId: 'pve-02',
        guestId: pick.id,
        guestName: pick.name,
        at: new Date().toISOString(),
        outcome: 'worked',
        durationS: 200,
        booted: true,
      });
      return json(testServer());
    },

    async decorate(req, response) {
      if (!results.size || !response.ok) return response;
      const m = match(req);
      if (m?.id !== 'hosts.getGuest' || m.params.serverId !== 'pve-02') return response;
      const result = results.get(decodeURIComponent(m.params.guestId ?? ''));
      if (!result) return response;
      const guest = (await response.clone().json()) as HostGuestDetail;
      return json({ ...guest, restoreTest: result }, response.status);
    },
  };
}
