/**
 * The fake hosts service's unRAID side (blackbox; the Incus and unRAID build brief §2.3, hosts/docs/MANAGE.md §2.6):
 * the array, parity, disks, the mover, plugins, unRAID's own notifications, and Docker the unRAID way (update from a
 * template, autostart, the update check), plus libvirt autostart everywhere. Its commands run as agent tasks
 * `unraid:<16 hex>` whose log is the command's output; their state lives on the server's detail (`unraid`, its
 * guests), so `GET /servers/blackbox` shows every change, and the unRAID hints follow it.
 *
 * Tests set `parityErrors` (what the next parity check finds) and steer tasks with `manage.taskMs`, `holdTasks`,
 * `finishTask` and `taskOutcome` like the Proxmox ones. It owns all of its routes (`/unraid/…`, a guest's `/update`
 * and `/autostart`), so it never passes one on.
 */
import { randomBytes } from 'node:crypto';
import { type FakeAnswer, type FakeHandler, type FakeRequest, type Json, ok, problem } from './fake-http';
import type { FakeManage, ManageHost } from './fake-manage';

type Role = 'operator' | 'admin';

interface UnraidDisk {
  name: string;
  slot: string;
  device: string | null;
  model: string | null;
  size_bytes: number;
  temp_c: number | null;
  spun_down: boolean;
  errors: number;
}

interface ParityRun {
  at: string;
  duration_s: number | null;
  speed_mbs: number | null;
  errors: number;
  result: 'ok' | 'errors' | 'cancelled' | 'failed';
  action: string | null;
}

interface Unraid {
  version: string;
  name: string;
  os_update: { version: string } | null;
  array: {
    state: 'started' | 'stopped' | 'starting' | 'stopping' | 'invalid';
    state_raw: string;
    mover_running: boolean;
    parity: {
      state: 'idle' | 'running' | 'paused';
      action: string | null;
      pct: number | null;
      speed_mbs: number | null;
      eta_s: number | null;
      errors: number;
      last: ParityRun | null;
      history: ParityRun[];
    };
    disks: UnraidDisk[];
  };
  pools: { name: string; size_bytes: number; used_bytes: number; disks: UnraidDisk[] }[];
  shares: { name: string; primary: string; secondary: string | null; mover_action: string | null }[];
  plugins: { name: string; file: string; version: string; update: string | null }[];
  notifications: {
    id: string;
    importance: 'alert' | 'warning' | 'normal';
    subject: string;
    description: string;
  }[];
}

/** The parity check a server runs now (its task, and what it will find). */
interface RunningCheck {
  task: string;
  started: number;
  action: 'check' | 'correct';
  errors: number;
  cancelled: boolean;
}

/** How fast the fixture's disks read during a parity check (MB/s). */
const PARITY_SPEED_MBS = 178.5;

const audit = () => `au_${randomBytes(6).toString('hex')}`;
const tb = (bytes: number) => `${(bytes / 1e12).toFixed(1)} TB`;
const taskIdOf = (a: FakeAnswer) =>
  String(((a.body as Json | undefined)?.task as Json | undefined)?.id ?? '');

export class FakeUnraid {
  /** The errors the next parity check finds (a test knob). */
  parityErrors = 0;
  readonly #checks = new Map<string, RunningCheck>();
  /** A disk's temperature before it spun down (`<server>/<disk>`), back when it spins up. */
  readonly #temps = new Map<string, number | null>();

  constructor(
    readonly host: ManageHost,
    readonly manage: FakeManage,
  ) {}

  /** The fixture world's unRAID state (after the fake filled in its data). */
  init(): void {
    // libvirt reports autostart wherever it runs.
    for (const server of ['basalt', 'shale', 'blackbox'])
      for (const g of this.host.guestsOf(server))
        if (g.platform === 'libvirt' && typeof g.autostart !== 'boolean') g.autostart = g.state === 'running';
    if (!this.#unraid('blackbox')) return;
    this.manage.pastTask('blackbox', 'plugin.check', 'plugin-check', null, 'unraid', 'ok');
    this.manage.pastTask(
      'blackbox',
      'container.update',
      'container-update',
      'docker:immich',
      'unraid',
      'error',
      'update_container immich: pulling ghcr.io/imagegenius/immich:latest failed (connection reset by peer)',
    );
    this.#hints('blackbox');
  }

  routes(): { method: string; path: string; handler: FakeHandler }[] {
    const S = '/api/v1/servers/*';
    const U = `${S}/unraid`;
    const G = `${S}/guests/*`;
    const s = (p: string[]) => p[0] as string;
    const second = (p: string[]) => p[1] as string;
    return [
      { method: 'POST', path: `${U}/array/start`, handler: (r, p) => this.#arrayStart(r, s(p)) },
      { method: 'POST', path: `${U}/array/stop`, handler: (r, p) => this.#arrayStop(r, s(p)) },
      { method: 'POST', path: `${U}/parity/start`, handler: (r, p) => this.#parityStart(r, s(p)) },
      { method: 'POST', path: `${U}/parity/pause`, handler: (r, p) => this.#parityStep(r, s(p), 'pause') },
      { method: 'POST', path: `${U}/parity/resume`, handler: (r, p) => this.#parityStep(r, s(p), 'resume') },
      { method: 'POST', path: `${U}/parity/cancel`, handler: (r, p) => this.#parityStep(r, s(p), 'cancel') },
      {
        method: 'POST',
        path: `${U}/disks/*/spin-up`,
        handler: (r, p) => this.#spin(r, s(p), second(p), false),
      },
      {
        method: 'POST',
        path: `${U}/disks/*/spin-down`,
        handler: (r, p) => this.#spin(r, s(p), second(p), true),
      },
      { method: 'POST', path: `${U}/mover`, handler: (r, p) => this.#mover(r, s(p)) },
      { method: 'POST', path: `${U}/plugins/check`, handler: (r, p) => this.#pluginCheck(r, s(p)) },
      {
        method: 'POST',
        path: `${U}/plugins/*/update`,
        handler: (r, p) => this.#pluginUpdate(r, s(p), second(p)),
      },
      { method: 'POST', path: `${U}/notifications/archive`, handler: (r, p) => this.#archive(r, s(p)) },
      { method: 'POST', path: `${U}/containers/check`, handler: (r, p) => this.#containersCheck(r, s(p)) },
      { method: 'POST', path: `${G}/update`, handler: (r, p) => this.#containerUpdate(r, s(p), second(p)) },
      { method: 'PUT', path: `${G}/autostart`, handler: (r, p) => this.#autostart(r, s(p), second(p)) },
    ];
  }

  /* Checks and tasks ------------------------------------------------------------------------------------------------ */

  #unraid(server: string): Unraid | null {
    const u = this.host.detailOf(server)?.unraid;
    return u && typeof u === 'object' ? (u as Unraid) : null;
  }

  /** A host route's checks (server, role, the manage switch, unRAID, the body's fields). */
  #hostOp(
    r: FakeRequest,
    server: string,
    role: Role,
    fields: readonly string[] = [],
  ): { u: Unraid; b: Json } | FakeAnswer {
    const refused = this.manage.check(r, server, role);
    if (refused) return refused;
    const u = this.#unraid(server);
    if (!u) return problem(501, 'unsupported', 'This server doesn’t run Unraid.');
    const bc = this.manage.body(r, fields);
    if (!('fields' in bc)) return bc;
    return { u, b: bc.fields };
  }

  /** A guest route's checks; the guest when they pass. */
  #guestOp(r: FakeRequest, server: string, guestId: string, role: Role): { guest: Json } | FakeAnswer {
    const refused = this.manage.check(r, server, role);
    if (refused) return refused;
    const guest = this.host.guest(server, guestId);
    if (!guest) return problem(404, 'guest_not_found', 'No such guest.');
    return { guest };
  }

  /** Starts an agent task `unraid:<16 hex>`; the hints follow when it ends. */
  #task(
    r: FakeRequest,
    server: string,
    op: string,
    type: string,
    plan: string[],
    apply: ((good: boolean) => void) | null,
    guest: string | null = null,
  ): FakeAnswer {
    return this.manage.startTask(r, server, op, {
      type,
      guest,
      plan,
      idKind: 'unraid',
      apply: (good) => {
        apply?.(good);
        this.#hints(server);
      },
    });
  }

  /* The array ------------------------------------------------------------------------------------------------------- */

  #arrayStart(r: FakeRequest, server: string): FakeAnswer {
    const c = this.#hostOp(r, server, 'admin');
    if (!('u' in c)) return c;
    const a = c.u.array;
    if (a.state === 'invalid')
      return problem(409, 'busy', 'The array’s disk setup isn’t valid, so it can’t start.');
    if (a.state !== 'stopped')
      return problem(
        409,
        'busy',
        a.state === 'started' ? 'The array is already started.' : 'The array is starting or stopping.',
      );
    a.state = 'starting';
    const pools = c.u.pools.map((p) => p.name).join(', ');
    return this.#task(
      r,
      server,
      'array.start',
      'array-start',
      [
        'emcmd cmdStart=Start',
        ...a.disks
          .filter((d) => d.slot === 'data')
          .map((d) => `Mounting ${d.name} (/dev/${d.device ?? '?'})`),
        ...(pools ? [`Importing pools: ${pools}`] : []),
        'Starting Docker',
        'Starting VMs',
        'The array is started.',
      ],
      (good) => {
        a.state = good ? 'started' : 'stopped';
        a.state_raw = good ? 'STARTED' : 'STOPPED';
      },
    );
  }

  #arrayStop(r: FakeRequest, server: string): FakeAnswer {
    const c = this.#hostOp(r, server, 'admin', ['confirm']);
    if (!('u' in c)) return c;
    if (c.b.confirm !== true)
      return problem(
        400,
        'confirm_required',
        'Stopping the array stops shares, Docker and VMs: send "confirm": true.',
      );
    const a = c.u.array;
    if (a.state !== 'started')
      return problem(
        409,
        'busy',
        a.state === 'stopped' ? 'The array is already stopped.' : 'The array is starting or stopping.',
      );
    a.state = 'stopping';
    return this.#task(
      r,
      server,
      'array.stop',
      'array-stop',
      [
        'emcmd cmdStop=Stop',
        'Stopping VMs',
        'Stopping Docker',
        ...(a.parity.state !== 'idle' ? ['Cancelling the parity check'] : []),
        'Unmounting shares, pools and disks',
        'The array is stopped.',
      ],
      (good) => {
        if (!good) {
          a.state = 'started';
          return;
        }
        // Parity stops with the array.
        this.#endCheck(server);
        a.state = 'stopped';
        a.state_raw = 'STOPPED';
      },
    );
  }

  /* Parity ---------------------------------------------------------------------------------------------------------- */

  #parityStart(r: FakeRequest, server: string): FakeAnswer {
    const c = this.#hostOp(r, server, 'operator', ['correct']);
    if (!('u' in c)) return c;
    const correct = c.b.correct ?? false;
    if (typeof correct !== 'boolean') return this.manage.invalid({ correct: 'Send true or false.' });
    const a = c.u.array;
    const p = a.parity;
    if (a.state !== 'started') return problem(409, 'busy', 'The array isn’t started.');
    if (p.state !== 'idle' || this.#checks.has(server))
      return problem(409, 'busy', 'A parity check is already running.');
    const errors = this.parityErrors;
    const action = correct ? 'correct' : 'check';
    const answer = this.#task(
      r,
      server,
      'parity.start',
      'parity-check',
      [
        `emcmd cmdCheck=Check${correct ? '&optionCorrect=correct' : ''}`,
        `mdcmd check ${correct ? 'CORRECT' : 'NOCORRECT'}`,
        `Parity check started (${correct ? 'writing corrections' : 'no corrections'})`,
        `25% done at ${PARITY_SPEED_MBS} MB/s`,
        `50% done at ${PARITY_SPEED_MBS} MB/s`,
        `75% done at ${PARITY_SPEED_MBS} MB/s`,
        `Parity check finished: ${errors === 0 ? 'no errors' : `${errors} ${errors === 1 ? 'error' : 'errors'}`}`,
      ],
      (good) => this.#checkEnded(server, good),
    );
    if (answer.status !== 202) return answer;
    this.#checks.set(server, {
      task: taskIdOf(answer),
      started: Date.now(),
      action,
      errors,
      cancelled: false,
    });
    Object.assign(p, { state: 'running', action, pct: 0, speed_mbs: null, eta_s: null, errors: 0 });
    return answer;
  }

  #parityStep(r: FakeRequest, server: string, step: 'pause' | 'resume' | 'cancel'): FakeAnswer {
    const c = this.#hostOp(r, server, 'operator');
    if (!('u' in c)) return c;
    const p = c.u.array.parity;
    const allowed =
      step === 'pause'
        ? p.state === 'running'
        : step === 'resume'
          ? p.state === 'paused'
          : p.state !== 'idle';
    if (!allowed)
      return problem(
        409,
        'busy',
        step === 'resume' && p.state === 'running'
          ? 'The parity check isn’t paused.'
          : 'No parity check is running.',
      );
    const commands = {
      pause: 'emcmd cmdCheckPause=',
      resume: 'emcmd cmdCheckResume=',
      cancel: 'emcmd cmdCheckCancel=',
    };
    const words = { pause: 'paused', resume: 'resumed', cancel: 'cancelled' };
    return this.#task(
      r,
      server,
      `parity.${step}`,
      `parity-${step}`,
      [commands[step], `The parity check is ${words[step]}.`],
      (good) => {
        const check = this.#checks.get(server);
        if (!good || !check) return;
        const t = this.manage.tasks.get(check.task);
        if (step === 'pause' && p.state === 'running') {
          Object.assign(p, { state: 'paused', speed_mbs: null, eta_s: null });
          // A paused check doesn't end on its own.
          if (t?.timer) clearTimeout(t.timer);
          if (t) t.timer = null;
        } else if (step === 'resume' && p.state === 'paused') {
          p.state = 'running';
          if (t?.status === 'running' && !t.timer && !this.manage.holdTasks)
            t.timer = setTimeout(() => this.manage.finishTask(check.task, 'ok'), this.manage.taskMs);
        } else if (step === 'cancel') this.#endCheck(server);
      },
    );
  }

  /** Cancels the running check: its task ends with an error, the run is kept as cancelled. */
  #endCheck(server: string): void {
    const check = this.#checks.get(server);
    if (!check) return;
    check.cancelled = true;
    if (this.manage.tasks.get(check.task)?.status === 'running')
      this.manage.finishTask(check.task, 'error', 'cancelled');
    else this.#checkEnded(server, false);
  }

  /** The parity task ended: the run goes first in the history. */
  #checkEnded(server: string, good: boolean): void {
    const check = this.#checks.get(server);
    this.#checks.delete(server);
    const u = this.#unraid(server);
    if (!u || !check) return;
    const p = u.array.parity;
    const result: ParityRun['result'] = check.cancelled
      ? 'cancelled'
      : !good
        ? 'failed'
        : check.errors > 0
          ? 'errors'
          : 'ok';
    const done = result === 'ok' || result === 'errors';
    // A whole check reads the biggest parity (or data) disk at the fixture's speed.
    const size = Math.max(0, ...u.array.disks.map((d) => d.size_bytes));
    const run: ParityRun = {
      at: new Date().toISOString(),
      duration_s: done
        ? Math.round(size / (PARITY_SPEED_MBS * 1e6))
        : Math.max(1, Math.round((Date.now() - check.started) / 1000)),
      speed_mbs: done ? PARITY_SPEED_MBS : null,
      errors: done ? check.errors : 0,
      result,
      action: check.action,
    };
    p.last = run;
    p.history = [run, ...p.history].slice(0, 10);
    Object.assign(p, { state: 'idle', action: null, pct: null, speed_mbs: null, eta_s: null, errors: 0 });
  }

  /* Disks and the mover --------------------------------------------------------------------------------------------- */

  #spin(r: FakeRequest, server: string, disk: string, down: boolean): FakeAnswer {
    const c = this.#hostOp(r, server, 'operator');
    if (!('u' in c)) return c;
    const disks = [...c.u.array.disks, ...c.u.pools.flatMap((p) => p.disks)];
    const targets = disk === 'all' ? disks : disks.filter((d) => d.name === disk);
    if (!targets.length) return this.manage.invalid({ disk: 'No disk of that name.' });
    const verb = down ? 'down' : 'up';
    return this.#task(
      r,
      server,
      down ? 'disk.spin_down' : 'disk.spin_up',
      down ? 'spin-down' : 'spin-up',
      [
        disk === 'all' ? `emcmd cmdSpin${verb}All=true` : `emcmd cmdSpin${verb}=${disk}`,
        ...targets.map((d) => `Spinning ${verb} ${d.name} (/dev/${d.device ?? '?'})`),
      ],
      (good) => {
        if (!good) return;
        for (const d of targets) {
          const key = `${server}/${d.name}`;
          if (down && !d.spun_down) {
            this.#temps.set(key, d.temp_c);
            Object.assign(d, { spun_down: true, temp_c: null });
          } else if (!down && d.spun_down) {
            Object.assign(d, { spun_down: false, temp_c: this.#temps.get(key) ?? 35 });
            this.#temps.delete(key);
          }
        }
      },
    );
  }

  #mover(r: FakeRequest, server: string): FakeAnswer {
    const c = this.#hostOp(r, server, 'operator');
    if (!('u' in c)) return c;
    const a = c.u.array;
    if (a.state !== 'started') return problem(409, 'busy', 'The array isn’t started.');
    if (a.mover_running) return problem(409, 'busy', 'The mover is already running.');
    a.mover_running = true;
    const moves = c.u.shares
      .filter((sh) => sh.mover_action && sh.secondary)
      .map((sh) =>
        sh.mover_action === 'to_array'
          ? `mover: moving ${sh.name} from ${sh.primary} to ${sh.secondary}`
          : `mover: moving ${sh.name} from ${sh.secondary} to ${sh.primary}`,
      );
    return this.#task(
      r,
      server,
      'mover.start',
      'mover',
      ['/usr/local/sbin/mover start', 'mover: started', ...moves, 'mover: finished'],
      () => {
        a.mover_running = false;
      },
    );
  }

  /* Plugins and notifications --------------------------------------------------------------------------------------- */

  #pluginCheck(r: FakeRequest, server: string): FakeAnswer {
    const c = this.#hostOp(r, server, 'operator');
    if (!('u' in c)) return c;
    return this.#task(
      r,
      server,
      'plugin.check',
      'plugin-check',
      [
        'plugin checkall',
        ...c.u.plugins.map((pl) =>
          pl.update ? `plugin: ${pl.file}: ${pl.update} is available` : `plugin: ${pl.file}: up to date`,
        ),
      ],
      null,
    );
  }

  #pluginUpdate(r: FakeRequest, server: string, file: string): FakeAnswer {
    const c = this.#hostOp(r, server, 'admin', ['confirm']);
    if (!('u' in c)) return c;
    if (file === 'unRAIDServer.plg')
      return problem(403, 'not_allowed', 'Unraid itself is updated in Unraid.');
    const targets =
      file === 'all' ? c.u.plugins.filter((pl) => pl.update) : c.u.plugins.filter((pl) => pl.file === file);
    if (file !== 'all' && !targets.length) return problem(404, 'not_found', 'No such plugin.');
    if (c.b.confirm !== true) return problem(400, 'confirm_required', 'Confirm this action.');
    const plan = targets.flatMap((pl) =>
      pl.update
        ? [
            `plugin update ${pl.file}`,
            `plugin: downloading: ${pl.name}-${pl.update}.txz`,
            `plugin: ${pl.file} updated to ${pl.update}`,
          ]
        : [`plugin update ${pl.file}`, `plugin: ${pl.file} is up to date`],
    );
    return this.#task(
      r,
      server,
      'plugin.update',
      'plugin-update',
      plan.length ? plan : ['plugin: nothing to update'],
      (good) => {
        if (!good) return;
        for (const pl of targets) if (pl.update) Object.assign(pl, { version: pl.update, update: null });
      },
    );
  }

  #archive(r: FakeRequest, server: string): FakeAnswer {
    const c = this.#hostOp(r, server, 'operator', ['id']);
    if (!('u' in c)) return c;
    const id = c.b.id ?? null;
    if (id !== null && (typeof id !== 'string' || !id))
      return this.manage.invalid({ id: 'A notification’s id.' });
    const list = c.u.notifications;
    if (typeof id === 'string') {
      const i = list.findIndex((n) => n.id === id);
      if (i < 0) return problem(404, 'not_found', 'No such notification.');
      list.splice(i, 1);
    } else list.splice(0);
    this.#hints(server);
    return ok({ ok: true, audit_id: audit() });
  }

  /* Docker the unRAID way, autostart -------------------------------------------------------------------------------- */

  #containersCheck(r: FakeRequest, server: string): FakeAnswer {
    const c = this.#hostOp(r, server, 'operator');
    if (!('u' in c)) return c;
    const stale = this.host
      .guestsOf(server)
      .filter((g) => g.platform === 'docker' && g.update_available === true);
    return this.#task(
      r,
      server,
      'containers.check',
      'containers-check',
      [
        '/usr/local/emhttp/plugins/dynamix.docker.manager/scripts/dockerupdate check',
        'Updating info...',
        ...stale.map((g) => `${String(g.name)}: an update is available`),
        'Done.',
      ],
      null,
    );
  }

  #containerUpdate(r: FakeRequest, server: string, guestId: string): FakeAnswer {
    const gc = this.#guestOp(r, server, guestId, 'admin');
    if (!('guest' in gc)) return gc;
    const guest = gc.guest;
    if (guest.platform !== 'docker')
      return problem(501, 'unsupported', 'Only Docker containers on Unraid are updated this way.');
    if (!this.#unraid(server))
      return problem(501, 'unsupported', 'Containers are updated this way on Unraid only.');
    if (guest.template !== true)
      return problem(403, 'not_allowed', 'There’s no template for this container.');
    const bc = this.manage.body(r, ['confirm']);
    if (!('fields' in bc)) return bc;
    if (bc.fields.confirm !== true) return problem(400, 'confirm_required', 'Confirm this action.');
    const name = String(guest.name ?? guestId);
    const image = String(guest.image ?? name);
    const tagged = image.includes(':') ? image : `${image}:latest`;
    const running = guest.state === 'running';
    return this.#task(
      r,
      server,
      'container.update',
      'container-update',
      [
        `update_container ${name}`,
        `Pulling image: ${tagged}`,
        `Status: Downloaded newer image for ${tagged}`,
        ...(running ? [`Stopping container: ${name}`] : []),
        `Removing container: ${name}`,
        `Command execution: docker create --name='${name}' … '${tagged}'`,
        ...(running ? [`Starting container: ${name}`] : []),
        'The command finished successfully!',
      ],
      (good) => {
        if (!good) return;
        guest.update_available = false;
        if (guest.state === 'running') guest.uptime_s = 0;
      },
      guestId,
    );
  }

  #autostart(r: FakeRequest, server: string, guestId: string): FakeAnswer {
    const gc = this.#guestOp(r, server, guestId, 'operator');
    if (!('guest' in gc)) return gc;
    const guest = gc.guest;
    if (guest.platform === 'docker' && !this.#unraid(server))
      return problem(501, 'unsupported', 'Autostart for Docker containers is set here on Unraid only.');
    if (guest.platform !== 'docker' && guest.platform !== 'libvirt')
      return problem(501, 'unsupported', 'Set this in the guest’s settings.');
    if (guest.self === true) return problem(409, 'self_guest', 'That’s this Whombat itself.');
    const bc = this.manage.body(r, ['on']);
    if (!('fields' in bc)) return bc;
    const on = bc.fields.on;
    if (typeof on !== 'boolean') return this.manage.invalid({ on: 'Send true or false.' });
    const old = guest.autostart === true;
    guest.autostart = on;
    return ok({
      ok: true,
      changes: [{ key: 'autostart', old: String(old), new: String(on) }],
      audit_id: audit(),
    });
  }

  /* Hints (the build brief §2.4) ------------------------------------------------------------------------------------ */

  /** The unRAID hints as the hub's rules would raise them from the server's state now. */
  #hints(server: string): void {
    const u = this.#unraid(server);
    if (!u) return;
    const hint = (kind: string, h: Json | null) =>
      this.host.setHint(server, kind, h ? { server, kind, ...h } : null);
    const a = u.array;
    hint(
      'unraid.array_stopped',
      a.state === 'stopped'
        ? {
            severity: 'warning',
            entity: 'array',
            title: 'Array stopped',
            detail: 'Shares, Docker and VMs are off until it starts.',
            link: '#array',
          }
        : null,
    );
    const last = a.parity.last;
    hint(
      'unraid.parity_errors',
      last && last.errors > 0
        ? {
            severity: 'warning',
            entity: 'parity',
            title: `The last parity check found ${last.errors} ${last.errors === 1 ? 'error' : 'errors'}`,
            detail: `Checked ${last.at.slice(0, 10)}`,
            link: '#array',
          }
        : null,
    );
    const sick = [...a.disks, ...u.pools.flatMap((p) => p.disks)].find((d) => d.errors > 0);
    hint(
      'unraid.disk_errors',
      sick
        ? {
            severity: 'warning',
            entity: `disk:${sick.name}`,
            title: `${sick.name} has ${sick.errors} read ${sick.errors === 1 ? 'error' : 'errors'}`,
            detail: `${sick.model ?? 'Disk'} (${sick.device ?? '?'})`,
            link: '#array',
          }
        : null,
    );
    const full = u.pools.find((p) => p.size_bytes > 0 && p.used_bytes / p.size_bytes >= 0.9);
    hint(
      'unraid.pool_full',
      full
        ? {
            severity: 'warning',
            entity: `pool:${full.name}`,
            title: `Storage “${full.name}” ${Math.round((full.used_bytes / full.size_bytes) * 100)}% full`,
            detail: `${tb(full.used_bytes)} of ${tb(full.size_bytes)} used`,
            link: '#array',
          }
        : null,
    );
    const updates = u.plugins.filter((pl) => pl.update);
    hint(
      'unraid.plugin_updates',
      updates.length
        ? {
            severity: 'info',
            entity: 'plugins',
            title: `${updates.length} plugin ${updates.length === 1 ? 'update' : 'updates'}`,
            detail: updates.map((pl) => pl.name).join(', '),
            link: '#plugins',
          }
        : null,
    );
    const note =
      u.notifications.find((n) => n.importance === 'alert') ??
      u.notifications.find((n) => n.importance === 'warning');
    hint(
      'unraid.notification',
      note
        ? {
            severity: note.importance === 'alert' ? 'warning' : 'info',
            entity: note.id,
            title: note.subject,
            detail: note.description,
            link: '#summary',
          }
        : null,
    );
    hint(
      'unraid.os_update',
      u.os_update
        ? {
            severity: 'info',
            entity: 'unraid',
            title: `Unraid ${u.os_update.version} has come out`,
            detail: `This server runs Unraid ${u.version}.`,
            link: '#plugins',
          }
        : null,
    );
    const stale = this.host
      .guestsOf(server)
      .filter((g) => g.platform === 'docker' && g.update_available === true);
    const first = stale[0];
    hint(
      'docker.update_available',
      first
        ? {
            severity: 'info',
            entity: String(first.id),
            title:
              stale.length === 1
                ? `An update for ${String(first.name)}`
                : `Updates for ${stale.length} containers`,
            detail: stale.map((g) => String(g.name)).join(', '),
            link: '#guests',
          }
        : null,
    );
  }
}
