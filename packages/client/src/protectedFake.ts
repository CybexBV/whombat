/**
 * What's protected as a fake Whombat answers it (Whombat backup-trust.md), for the web's fixture mode and the phone's
 * demo world: Mara's world — this Whombat copied to blackbox and off site, pve-02's machines backed up to pbs-01 or only
 * to its own disks, the servers themselves unseen, Home Assistant with its own cloud copy, Plex unseen — and
 * `restoreTests.set` / `restoreTests.run` kept in memory (a run is over at once, as having worked). `tested` starts with
 * pve-02's tests on and three results, one that failed, and the off-site copy failing; `calm` with the tests off, no
 * results and the off-site copy fine.
 */
import type { ProtectedRow, ProtectedView, RestoreTestResult, RestoreTestServer } from '@whombat/core';

export type ProtectedFakeKind = 'calm' | 'tested';

/** The ops it answers. */
export const PROTECTED_FAKE_OPS = ['protected.get', 'restoreTests.set', 'restoreTests.run'] as const;

export interface FakeProtected {
  /** `protected.get`, `restoreTests.set`, `restoreTests.run`; null for any other op. */
  call(
    op: string,
    input: { params: Record<string, string | undefined>; body?: unknown },
  ): { status: number; body: unknown } | null;
  /** A machine's newest result, for its page (`hosts.getGuest`); null when it has none. */
  guestResult(serverId: string, guestId: string): RestoreTestResult | null;
}

const HOUR = 3_600_000;

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

export function createFakeProtected({
  kind = 'calm',
  now = Date.now(),
}: {
  kind?: ProtectedFakeKind;
  now?: number;
} = {}): FakeProtected {
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
          // `tested` shows the things that went wrong, the off-site copy failing among them.
          offsite: {
            name: 'Backblaze B2',
            lastAt: ago(2),
            ...(kind === 'tested' ? { failedAt: ago(1) } : {}),
          },
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

  return {
    call(op, { params, body: raw }) {
      if (op === 'protected.get') return { status: 200, body: view() };
      if (op !== 'restoreTests.set' && op !== 'restoreTests.run') return null;
      if (params.serverId !== 'pve-02')
        return { status: 404, body: { error: { code: 'not_found', message: 'That server isn’t here.' } } };
      const body = (raw ?? {}) as { on?: boolean; guests?: string[]; guest?: string };
      if (op === 'restoreTests.set') {
        tests.on = !!body.on;
        if (body.guests) tests.guests = body.guests;
        return { status: 200, body: testServer() };
      }
      // A run here is over at once: the machine whose turn it is (or the one asked for) worked.
      const pick =
        MACHINES.find((x) => x.id === body.guest) ??
        MACHINES.filter(
          (x) => x.state !== 'none' && (!tests.guests.length || tests.guests.includes(x.id)),
        ).sort(
          (a, b) => Date.parse(results.get(a.id)?.at ?? '1970') - Date.parse(results.get(b.id)?.at ?? '1970'),
        )[0];
      if (!pick)
        return {
          status: 409,
          body: { error: { code: 'conflict', message: 'That machine can’t be tested.' } },
        };
      results.set(pick.id, {
        serverId: 'pve-02',
        guestId: pick.id,
        guestName: pick.name,
        at: new Date().toISOString(),
        outcome: 'worked',
        durationS: 200,
        booted: true,
      });
      return { status: 200, body: testServer() };
    },

    guestResult(serverId, guestId) {
      return serverId === 'pve-02' ? (results.get(guestId) ?? null) : null;
    },
  };
}
