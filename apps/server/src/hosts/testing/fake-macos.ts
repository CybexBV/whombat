/**
 * The fake hosts service's Macs (docs/decisions/macos-servers.md; the assignment's §3): `addMac` puts a Mac
 * in the fleet (`detail_view` and `os_family` `macos`, the `macos` block on its detail), and `POST /servers/{id}/screen`
 * answers as the hub and the Mac's agent do — 501 `unsupported` on a server that isn't a Mac, the role (operator for
 * `status`, admin for the rest, a look too), the host-shell switch on both sides, `agent_offline`, unknown fields
 * refused, and the agent's own refusals as `{ok: false, code, message}`: no Screen Sharing, no account, a locked screen
 * for `ui.*`, no helper, no Accessibility, a name that matches nothing (with close names), a password prompt it can't
 * answer for a screen user who isn't an administrator (`notAdmin`). `note` is the Mac's own word on the next step that
 * works (`message` on success).
 *
 * The Mac's password is checked against `password` and never kept: the steps record `account.user` only. A look answers
 * a few bytes of “JPEG” with the sizes the agent would give (scaled to `max_w`).
 */
import { randomBytes } from 'node:crypto';
import { type FakeAnswer, type FakeHandler, type FakeRequest, type Json, ok, problem } from './fake-http';

/** What the fake needs of the hub it lives in. */
export interface MacHost {
  fleet: Json;
  details: Record<string, Json>;
  emit(event: string, data: unknown): number;
}

/** A Mac's state on its agent (snake_case, as the hub reports it). */
export interface FakeMac {
  screen: {
    sharing: boolean;
    account: string;
    sign_in: string;
    locked: boolean;
    w: number;
    h: number;
  };
  helper: { installed: boolean; version: string; running: boolean; ax: boolean; user: string };
}

/** Only the Mac's state reads at operator; a look and the UI lists show the whole desktop. */
const READ_OPS = new Set(['status']);
const ROLE_RANK: Record<string, number> = { viewer: 0, operator: 1, admin: 2 };
const FIELDS = new Set([
  'op',
  'x',
  'y',
  'to_x',
  'to_y',
  'button',
  'clicks',
  'dx',
  'dy',
  'text',
  'keys',
  'max_w',
  'format',
  'app',
  'window',
  'name',
  'role',
  'index',
  'path',
  'limit',
  'target',
  'account',
]);
const OPS = new Set([
  ...READ_OPS,
  'look',
  'ui.apps',
  'ui.list',
  'password',
  'click',
  'drag',
  'scroll',
  'type',
  'keys',
  'unlock',
  'account.set',
  'account.check',
  'account.clear',
  'ui.press',
  'ui.set',
  'ui.menu',
  'ui.focus',
  'ui.open',
]);

/** A few bytes that stand for a JPEG (start and end markers): the tools pass pictures on without reading them. */
export const FAKE_JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');

/** The dialog the fake Mac shows: System Settings asking to allow something, as Whombat Helper lists it. */
function dialog(): Json[] {
  const el = (id: string, role: string, title: string, x: number, y: number): Json => ({
    id,
    role,
    subrole: null,
    title,
    desc: '',
    value: '',
    ident: '',
    enabled: true,
    focused: false,
    x,
    y,
    w: 160,
    h: 48,
    actions: ['AXPress'],
    app: 'System Settings',
    window: 'Privacy & Security',
  });
  return [el('w0.1', 'AXButton', 'Don’t Allow', 1600, 1100), el('w0.2', 'AXButton', 'Allow', 1800, 1100)];
}

export class FakeMacos {
  /** The Macs by server id. */
  readonly macs = new Map<string, FakeMac>();
  /** The Mac's password, the one Screen Sharing takes (tests only). */
  password = 'mac-screen-pass-4471';
  /** `password` answers `not_admin`: the screen user isn't an administrator (tests only). */
  notAdmin = false;
  /** The Mac's own note on the next step that works, as the agent adds one (tests only). */
  note: string | null = null;
  /** Every screen step the hub got (the password replaced), in order. */
  readonly steps: { server: string; body: Json; role: string | null; actor: string | null }[] = [];

  constructor(readonly host: MacHost) {}

  /**
   * Makes a server the agent just added (`claim`) a Mac, as a macOS agent reports one: Screen Sharing on, no screen
   * account yet, the helper running with Accessibility. Its switches stay the enrollment's.
   */
  makeMac(id: string): FakeMac {
    const card = (this.host.fleet.servers as Json[]).find((s) => s.id === id);
    const detail = this.host.details[id];
    if (!card || !detail) throw new Error(`no server ${id}`);
    const mac = this.#newMac('');
    this.macs.set(id, mac);
    Object.assign(card, { os: 'macOS 27.2.1', os_family: 'macos', detail_view: 'macos' });
    Object.assign(detail.server as Json, { os_family: 'macos', detail_view: 'macos' });
    detail.macos = this.block(id);
    return mac;
  }

  #newMac(account: string): FakeMac {
    return {
      screen: { sharing: true, account, sign_in: account ? 'ok' : '', locked: false, w: 3840, h: 2160 },
      helper: { installed: true, version: '1.0.0', running: true, ax: true, user: 'john' },
    };
  }

  /** Puts a Mac in the fleet with everything on (Screen Sharing, an account, the helper with Accessibility). */
  addMac(id = 'studio', options: { account?: string; level?: Json } = {}): FakeMac {
    const now = new Date().toISOString();
    const mac: FakeMac = {
      screen: {
        sharing: true,
        account: options.account ?? 'john',
        sign_in: 'ok',
        locked: false,
        w: 3840,
        h: 2160,
      },
      helper: { installed: true, version: '1.0.0', running: true, ax: true, user: 'john' },
    };
    this.macs.set(id, mac);
    const card: Json = {
      id,
      hostname: id,
      group: 'Desk',
      status: 'online',
      status_note: null,
      os: 'macOS 27.2.1',
      os_family: 'macos',
      cpu: { model: 'Apple M2 Ultra', cores: 24, threads: 24 },
      memory_total_gb: 192,
      storage_capacity_tb: 2,
      last_seen: now,
      current: { cpu_pct: 7, mem_pct: 41, disk_used_pct: 38, temp_max_c: 48 },
      last_known: null,
      workloads: {},
      hypervisor: null,
      detail_view: 'macos',
      agent_connected: true,
      open_alerts: 0,
      console_on: true,
      maintenance: null,
      parent: null,
    };
    (this.host.fleet.servers as Json[]).push(card);
    const on = (k: string) => ({ [k]: true, [`agent_${k}`]: true });
    this.host.details[id] = {
      as_of: now,
      range: '24h',
      server: {
        id,
        group: 'Desk',
        status: 'online',
        status_note: null,
        roles: [],
        os: { name: 'macOS', version: '27.2.1', kernel: 'Darwin 26.2.0' },
        os_family: 'macos',
        cpu: card.cpu,
        memory: { total_gb: 192, type: null },
        uptime_s: 86_400,
        last_boot: null,
        address: '10.100.0.9',
        location: null,
        agent: { version: '0.30.0', last_sync_s_ago: 4, connected: true },
        detail_view: 'macos',
        remote_control: options.level ?? {
          ...on('console'),
          ...on('power'),
          ...on('host_shell'),
          ...on('host_power'),
          ...on('manage'),
          ...on('diagnose'),
        },
        collectors: [],
        maintenance: null,
        parent: null,
      },
      live: null,
      banner: null,
      sensors: [],
      virtualization: null,
      disks: [],
      workloads: {},
      hints: [],
      macos: this.block(id),
    };
    this.host.emit('server.online', { id, at: now });
    return mac;
  }

  /** The `macos` block of a Mac's detail as it stands. */
  block(id: string): Json | null {
    const mac = this.macs.get(id);
    if (!mac) return null;
    return {
      version: '27.2.1',
      build: '26B131',
      model: 'Mac14,14',
      model_name: 'Mac Studio',
      chip: 'Apple M2 Ultra',
      sip: true,
      filevault: false,
      auto_login: 'john',
      console_user: 'john',
      screen: { ...mac.screen, sign_in_at: '0001-01-01T00:00:00Z' },
      helper: { ...mac.helper },
    };
  }

  /** Brings a Mac's detail up to date after a step changed it. */
  #refresh(id: string): void {
    const d = this.host.details[id];
    if (d) d.macos = this.block(id);
  }

  routes(): { method: string; path: string; handler: FakeHandler }[] {
    return [
      {
        method: 'POST',
        path: '/api/v1/servers/*/screen',
        handler: (r, [id]) => this.#screen(id as string, r),
      },
    ];
  }

  #screen(id: string, r: FakeRequest): FakeAnswer {
    const card = (this.host.fleet.servers as Json[]).find((s) => s.id === id);
    if (!card) return problem(404, 'server_not_found', 'No such server.');
    const body = (r.body ?? {}) as Json;
    const op = String(body.op ?? '');
    const account = body.account as Json | undefined;
    this.steps.push({
      server: id,
      body: account ? { ...body, account: { user: account.user, password: '•••' } } : body,
      role: r.role,
      actor: r.actor,
    });
    const mac = this.macs.get(id);
    if (!mac) return problem(501, 'unsupported', 'This server isn’t a Mac.');
    for (const k of Object.keys(body))
      if (!FIELDS.has(k)) return problem(400, 'invalid_value', `Unknown field ${k}.`);
    if (!OPS.has(op)) return problem(400, 'invalid_value', `Unknown op ${op}.`);
    const rank = r.role === null ? 2 : (ROLE_RANK[r.role] ?? -1);
    if (rank < (READ_OPS.has(op) ? 1 : 2)) return problem(403, 'insufficient_role', 'Requires more access.');
    const rc = ((this.host.details[id]?.server as Json | undefined)?.remote_control ?? {}) as Json;
    if (
      !(rc.host_shell === true && rc.agent_host_shell === true) &&
      !(op === 'status' && rc.diagnose === true)
    )
      return problem(403, 'host_shell_disabled', 'Host shell is disabled for this server.');
    if (card.agent_connected !== true) return problem(409, 'agent_offline', 'The agent is not connected.');
    const audit = READ_OPS.has(op) ? {} : { audit_id: `au_${randomBytes(6).toString('hex')}` };
    const refuse = (code: string, message = '') => ok({ server: id, op, ok: false, code, message });
    const done = (more: Json = {}) => {
      this.#refresh(id);
      const note = this.note;
      this.note = null;
      return ok({ server: id, op, ok: true, ...audit, ...(note ? { message: note } : {}), ...more });
    };
    const status = () => ({ status: { ...mac.screen, sign_in_at: new Date().toISOString() } });

    if (op === 'status') return done({ ...status(), helper: { ...mac.helper } });
    if (op === 'account.set') {
      if (!mac.screen.sharing) return refuse('no_screen', 'Screen Sharing is off.');
      if (account?.password !== this.password) return refuse('sign_in_failed', 'Screen Sharing refused it.');
      mac.screen.account = String(account.user);
      mac.screen.sign_in = 'ok';
      return done(status());
    }
    if (op === 'account.clear') {
      mac.screen.account = '';
      mac.screen.sign_in = '';
      return done(status());
    }
    if (op.startsWith('ui.')) {
      if (!mac.helper.installed || !mac.helper.running)
        return refuse('no_helper', 'Whombat Helper isn’t running.');
      if (op === 'ui.open') return done();
      if (!mac.helper.ax) return refuse('no_access', 'Whombat Helper has no Accessibility.');
      if (mac.screen.locked) return refuse('locked', 'The screen is locked.');
      if (op === 'ui.apps')
        return done({
          apps: [
            {
              name: 'System Settings',
              bundle_id: 'com.apple.systempreferences',
              pid: 812,
              active: true,
              windows: ['Privacy & Security'],
            },
            { name: 'Finder', bundle_id: 'com.apple.finder', pid: 401, active: false, windows: [] },
          ],
        });
      if (op === 'ui.list') return done({ elements: dialog(), truncated: false });
      if (op === 'ui.press') {
        const name = String(body.name ?? '').toLowerCase();
        const hit = dialog().find((e) => String(e.title).toLowerCase() === name);
        if (!hit) return refuse('not_found', 'Close: Allow, Don’t Allow.');
        return done({ element: hit });
      }
      return done();
    }
    if (!mac.screen.sharing) return refuse('no_screen', 'Screen Sharing is off.');
    if (!mac.screen.account) return refuse('no_account', 'No screen account.');
    if (mac.screen.sign_in === 'failed')
      return refuse('sign_in_failed', 'Screen Sharing refused the account.');
    if (op === 'unlock') {
      mac.screen.locked = false;
      return done(status());
    }
    if (op === 'account.check') return done(status());
    if (op === 'password')
      return this.notAdmin
        ? refuse('not_admin', 'The screen user isn’t an administrator.')
        : refuse('no_prompt', 'No password prompt is in front.');
    if (op === 'look') {
      const maxW = typeof body.max_w === 'number' && body.max_w > 0 ? body.max_w : mac.screen.w;
      const w = Math.min(maxW, mac.screen.w);
      const h = Math.round((mac.screen.h * w) / mac.screen.w);
      return done({
        image_b64: FAKE_JPEG_B64,
        format: body.format === 'jpeg' ? 'jpeg' : 'png',
        w,
        h,
        screen_w: mac.screen.w,
        screen_h: mac.screen.h,
      });
    }
    return done();
  }
}
