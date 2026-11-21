/**
 * A Mac in the servers' fixture worlds (Whombat macos-servers.md; app MAC-36): `studio`, a Mac Studio on macOS 27.2.1
 * with an Apple M2 Ultra, Screen Sharing on, the Mac's password set for `mara`, Whombat Helper running and — so the page
 * shows its one chore — without Accessibility until someone opens the setting and switches it on. `createMacFixture`
 * answers its screen (`hosts.screen`, `hosts.screenLook`) as the Mac's agent does: the password is checked (“wrong” is
 * refused) and never kept, the lock, the helper, a look with a small picture of a desktop. `withMac(handle, ctx)` puts
 * its page in the web's fixture world (built from the-falcon's on every read); the phone's demo world uses the same
 * fixture. Listed in the fleet only when `localStorage['whombat.fixtures.mac']` is set, as kvm-lab is, so the mock's five
 * servers stay as drawn; its value picks a scenario (`setup`, `sharing-off`, `locked`, `failed`, `no-helper`, anything
 * else: as above). Not imported by production code.
 */
import {
  type HostMacosDetail,
  HostScreenBody,
  type HostScreenResult,
  type HostServer,
  type HostServerDetail,
  type HostUiApp,
} from '@whombat/core/domain';
import type { HostsFixtureAnswer, HostsFixtureRequest, HostsFixtureWorld } from './fixtures';

export const MAC_SERVER = 'studio';

/** The Mac's person (a stand-in name). */
const USER = 'mara';

/** A 320 × 180 picture of a Mac's desktop with System Settings and a dialog (made for the fixtures, no real screen). */
export const MAC_LOOK_PNG_B64 =
  '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';

export type MacScenario = 'ready' | 'setup' | 'sharing-off' | 'locked' | 'failed' | 'no-helper';

const SCENARIOS: readonly MacScenario[] = ['ready', 'setup', 'sharing-off', 'locked', 'failed', 'no-helper'];

/** A scenario from the stored setting (`1` or anything unknown: `ready`). */
export function macScenario(v: string | null | undefined): MacScenario {
  return SCENARIOS.includes(v as MacScenario) ? (v as MacScenario) : 'ready';
}

function setting(): string | null {
  try {
    return globalThis.localStorage?.getItem('whombat.fixtures.mac') ?? null;
  } catch {
    return null;
  }
}

interface State {
  sharing: boolean;
  account: string | null;
  signIn: 'ok' | 'failed' | null;
  signInAt: number | null;
  locked: boolean;
  installed: boolean;
  running: boolean;
  ax: boolean;
  /** When the person switches Accessibility on after “Open the setting on the Mac” (they do it in the screen). */
  axAt: number | null;
}

function seed(scenario: MacScenario, now: number): State {
  const s: State = {
    sharing: true,
    account: USER,
    signIn: 'ok',
    signInAt: now - 2 * 3_600_000,
    locked: false,
    installed: true,
    running: true,
    ax: false,
    axAt: null,
  };
  switch (scenario) {
    case 'setup':
      return { ...s, account: null, signIn: null, signInAt: null };
    case 'sharing-off':
      return { ...s, sharing: false, account: null, signIn: null, signInAt: null };
    case 'locked':
      return { ...s, locked: true, ax: true };
    case 'failed':
      return { ...s, signIn: 'failed' };
    case 'no-helper':
      return { ...s, installed: false, running: false };
    default:
      return s;
  }
}

export interface MacFixture {
  /** The Mac's facts, its screen and its helper as they are now. */
  macos(): HostMacosDetail;
  /** `POST …/servers/studio/screen`: one step. */
  screen(body: Record<string, unknown>): HostsFixtureAnswer;
  /** `GET …/servers/studio/screen`: a look. */
  look(query: Record<string, string>): HostsFixtureAnswer;
}

const SCREEN_W = 3840;
const SCREEN_H = 2160;

export function createMacFixture(
  now: number,
  scenario: MacScenario = 'ready',
  clock: () => number = () => Date.now(),
): MacFixture {
  const st = seed(scenario, now);
  const ax = () => {
    if (!st.ax && st.axAt !== null && clock() >= st.axAt) st.ax = true;
    return st.ax;
  };
  const screen = () => ({
    sharing: st.sharing,
    account: st.account,
    signIn: st.signIn,
    signInAt: st.signInAt === null ? null : new Date(st.signInAt).toISOString(),
    locked: st.locked,
    w: SCREEN_W,
    h: SCREEN_H,
  });
  const helper = () => ({
    installed: st.installed,
    version: st.installed ? '1.0.0' : null,
    running: st.running,
    ax: st.running ? ax() : null,
    user: st.running ? USER : null,
  });
  const answer = (op: string, more: Partial<HostScreenResult> = {}): HostsFixtureAnswer => ({
    status: 200,
    body: { server: MAC_SERVER, op, ok: true, ...more },
  });
  const refuse = (op: string, code: HostScreenResult['code'], message = ''): HostsFixtureAnswer => ({
    status: 200,
    body: { server: MAC_SERVER, op, ok: false, code, ...(message ? { message } : {}) },
  });
  /** What a step by position or a look needs: Screen Sharing and a password the Mac takes. */
  const blocked = (op: string): HostsFixtureAnswer | null => {
    if (!st.sharing) return refuse(op, 'no_screen');
    if (!st.account) return refuse(op, 'no_account');
    if (st.signIn === 'failed') return refuse(op, 'sign_in_failed');
    return null;
  };
  const picture = (op: string, maxW?: number): HostsFixtureAnswer => {
    const w = Math.min(320, maxW || 320);
    return answer(op, {
      imageB64: MAC_LOOK_PNG_B64,
      format: 'png',
      w,
      h: Math.round((w * 9) / 16),
      screenW: SCREEN_W,
      screenH: SCREEN_H,
    });
  };
  const apps: HostUiApp[] = [
    {
      name: 'System Settings',
      bundleId: 'com.apple.systempreferences',
      pid: 812,
      active: true,
      windows: ['Privacy & Security'],
    },
    { name: 'Finder', bundleId: 'com.apple.finder', pid: 401, active: false, windows: [] },
  ];

  return {
    macos: () => ({
      version: '27.2.1',
      build: '26B131',
      model: 'Mac14,14',
      modelName: 'Mac Studio',
      chip: 'Apple M2 Ultra',
      sip: true,
      filevault: false,
      autoLogin: USER,
      consoleUser: USER,
      screen: screen(),
      helper: helper(),
    }),
    look: (query) => blocked('look') ?? picture('look', Number(query.maxW) || undefined),
    screen(raw) {
      const parsed = HostScreenBody.safeParse(raw);
      if (!parsed.success)
        return {
          status: 400,
          body: {
            error: {
              code: 'bad_request',
              message: parsed.error.issues[0]?.message ?? 'That isn’t a screen step.',
              details: { code: 'invalid_value' },
            },
          },
        };
      const b = parsed.data;
      const op = b.op;
      switch (op) {
        case 'status':
          return answer(op, { status: screen(), helper: helper() });
        case 'account.set':
          if (!st.sharing) return refuse(op, 'no_screen');
          // The Mac's own check; the password is never kept here.
          if (b.account?.password === 'wrong') return refuse(op, 'sign_in_failed');
          st.account = b.account?.user ?? USER;
          st.signIn = 'ok';
          st.signInAt = clock();
          return answer(op, { status: screen(), auditId: 'au_mac_set' });
        case 'account.check': {
          const no = blocked(op);
          if (no) return no;
          st.signInAt = clock();
          return answer(op, { status: screen() });
        }
        case 'account.clear':
          st.account = null;
          st.signIn = null;
          st.signInAt = null;
          return answer(op, { status: screen(), auditId: 'au_mac_clear' });
        case 'unlock': {
          const no = blocked(op);
          if (no) return no;
          st.locked = false;
          return answer(op, { status: screen(), auditId: 'au_mac_unlock' });
        }
        case 'look':
          return blocked(op) ?? picture(op, b.maxW);
        default:
          break;
      }
      if (op.startsWith('ui.')) {
        if (!st.installed || !st.running) return refuse(op, 'no_helper');
        if (op === 'ui.open') {
          // The person switches Whombat Helper on in the screen a little later.
          if (b.target === 'accessibility' && !st.ax) st.axAt = clock() + 8_000;
          return answer(op, { auditId: 'au_mac_open' });
        }
        if (!ax()) return refuse(op, 'no_access');
        if (st.locked) return refuse(op, 'locked');
        if (op === 'ui.apps') return answer(op, { apps });
        if (op === 'ui.list') return answer(op, { elements: [], truncated: false });
        if (op === 'ui.press' || op === 'ui.set' || op === 'ui.menu')
          return refuse(op, 'not_found', 'Close: Allow, Don’t Allow.');
        return answer(op, { auditId: 'au_mac_ui' });
      }
      return blocked(op) ?? answer(op, { auditId: 'au_mac_step' });
    },
  };
}

/* The web's fixture world ------------------------------------------------------------------------- */

type Handle = (req: HostsFixtureRequest) => HostsFixtureAnswer | null;

export interface MacFixtureContext {
  world: HostsFixtureWorld;
  now: number;
  /** studio in the fleet's list; default: `localStorage['whombat.fixtures.mac']` is set. */
  listed?: boolean;
  scenario?: MacScenario;
  clock?: () => number;
}

/** studio's page from the-falcon's (sensors, history, network) with a Mac's facts. */
function macDetail(t: HostServerDetail, mac: MacFixture, now: number): HostServerDetail {
  const DAY = 86_400_000;
  return {
    ...t,
    asOf: new Date(now).toISOString(),
    server: {
      ...t.server,
      id: MAC_SERVER,
      status: 'ok',
      statusNote: null,
      roles: [],
      os: { name: 'macOS', version: '27.2.1', kernel: 'Darwin 26.2.0' },
      osFamily: 'macos',
      cpu: { model: 'Apple M2 Ultra', cores: 24, threads: 24 },
      memory: { totalGb: 192, type: 'LPDDR5' },
      uptimeS: 6 * 86_400 + 5 * 3600,
      lastBoot: new Date(now - 6 * DAY).toISOString(),
      address: '10.100.1.50',
      location: 'Desk',
      platform: 'macos',
    },
    live: t.live
      ? {
          ...t.live,
          cpuPct: 7,
          cpuUserPct: 4.9,
          cpuSystemPct: 1.8,
          cpuIowaitPct: 0,
          loadAvg: [2.4, 2.1, 1.9],
          memPct: 41,
          memUsedGb: 78.7,
          memCacheGb: 31.2,
          zfsArcGb: null,
          memFreeGb: 82.1,
          swapUsedGb: 0,
          swapTotalGb: 2,
        }
      : null,
    banner: null,
    sensors: [
      {
        id: 'cpu_package',
        label: 'CPU',
        group: 'cpu',
        source: 'SMC · CPU die',
        nowC: 48,
        maxC: 61,
        limitC: 105,
      },
      { id: 'ssd', label: 'SSD', group: 'disk', source: 'SMC · NAND', nowC: 39, maxC: 44, limitC: 85 },
    ],
    disks: [
      {
        device: 'disk0',
        type: 'nvme',
        model: 'APPLE SSD AP2048Z',
        role: 'system',
        capacityGb: 2000,
        usedGb: 760,
        wearPct: 2,
        tempC: 39,
        health: 'healthy',
        smart: { passed: true },
      },
    ],
    virtualization: null,
    hints: [],
    alerts: [],
    health: t.health
      ? {
          ...t.health,
          system: t.health.system
            ? {
                ...t.health.system,
                packageManager: null,
                updates: 1,
                securityUpdates: 0,
                initSystem: 'launchd',
                failedCount: 0,
                failedUnits: [],
                timeSource: 'timed',
                processes: 612,
                pressure: null,
              }
            : t.health.system,
          network: [
            {
              name: 'en0',
              kind: 'ethernet',
              up: true,
              carrier: true,
              speedMbps: 10_000,
              mtu: 1500,
              addresses: ['10.100.1.50/24'],
              master: null,
              members: [],
              rxMbps: 18,
              txMbps: 6,
              errors: 0,
              drops: 0,
            },
          ],
          volumes: [
            {
              entity: 'fs:/',
              kind: 'fs',
              label: 'Macintosh HD',
              usedGb: 760,
              totalGb: 1995,
              usedPct: 38,
              fullInDays: null,
              fsType: 'apfs',
              device: '/dev/disk3s1s1',
            },
          ],
          arrays: [],
          ups: [],
          gpus: [],
          tasks: [],
        }
      : t.health,
    workloads: {},
    proxmox: undefined,
    incus: undefined,
    unraid: undefined,
    libvirt: undefined,
    macos: mac.macos(),
  };
}

function macRow(t: HostServer): HostServer {
  return {
    ...t,
    id: MAC_SERVER,
    name: MAC_SERVER,
    status: 'ok',
    statusNote: null,
    platform: 'macos',
    osFamily: 'macos',
    os: 'macOS 27.2.1',
    cpu: { model: 'Apple M2 Ultra', cores: 24, threads: 24 },
    uptimeS: 6 * 86_400 + 5 * 3600,
    cpuPct: 7,
    memory: { usedPct: 41, usedGb: 78.7, totalGb: 192 },
    storage: { usedPct: 38, usedTb: 0.76, capacityTb: 2 },
    temperature: { maxC: 48, limitC: 105 },
    guests: [],
    alerts: { critical: 0, warning: 0 },
  };
}

/** Puts studio in the web's fixture world and answers its page and screen; the rest goes on to `next`. */
export function withMac(next: Handle, ctx: MacFixtureContext): Handle {
  const { world, now } = ctx;
  const stored = setting();
  const listed = ctx.listed ?? !!stored;
  const mac = createMacFixture(now, ctx.scenario ?? macScenario(stored), ctx.clock);
  const template = world.details.get('the-falcon');
  const templateRow = world.servers.find((s) => s.id === 'the-falcon');
  if (!template || !templateRow) return next;
  if (!world.details.has(MAC_SERVER)) {
    world.details.set(MAC_SERVER, macDetail(template, mac, now));
    world.settings.set(MAC_SERVER, {
      ...(world.settings.get('the-falcon') ?? {
        id: MAC_SERVER,
        group: 'Home lab',
        location: null,
        remoteControl: { console: true, power: true },
        agentPolicy: { console: true, power: true },
      }),
      id: MAC_SERVER,
      location: 'Desk',
    });
    if (listed) world.servers.push(macRow(templateRow));
  }
  return (req) => {
    const seg = req.path.split('/').filter(Boolean).map(decodeURIComponent);
    if (seg[0] !== 'servers' || seg[1] !== MAC_SERVER) return next(req);
    if (seg.length === 3 && seg[2] === 'screen')
      return req.method === 'POST' ? mac.screen(req.body) : mac.look(req.query);
    // Its page says how the screen is now (a step changed it, or Accessibility came on).
    world.details.set(MAC_SERVER, macDetail(template, mac, now));
    return next(req);
  };
}
