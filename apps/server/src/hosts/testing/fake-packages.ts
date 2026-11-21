/**
 * The fake hosts service's package updates (server-updates.md SWU-01…SWU-06; the build brief §2 “Agent and hub”): each
 * server with a detail has a few updates waiting (shale's include a Proxmox kernel), which `inspect/updates` lists;
 * `packages/check` and `packages/install` run as agent tasks `pkg:<16 hex>` (`platform: host`) whose status carries
 * `packages` once they ended, and the server's report follows them — `system.package_task` while one runs,
 * `system.package_last` after, the counts, when they were checked, and a restart for a new kernel.
 *
 * Like the hub it checks the role (Check operator, Install admin), the manage switch, the body's fields, `confirm`, the
 * names, one package task at a time, and refuses where the agent does: Unraid (blackbox) and whatever a test puts in
 * `refuse`. Tests add what a Check finds (`found`), hold packages back or warn on the next Install (`keptBack`,
 * `warning`), keep the report from before a task's end (`staleReport`), and end tasks with a code through
 * `manage.taskOutcome(op, 'error', message, 'busy')`.
 */
import { type FakeAnswer, type FakeHandler, type FakeRequest, type Json, ok, problem } from './fake-http';
import type { FakeManage, ManageHost } from './fake-manage';

const NAME = /^[A-Za-z0-9][A-Za-z0-9+._:@~-]{0,127}$/;

/** A waiting update as the agent lists it. */
export interface FakeUpdate {
  name: string;
  current: string;
  new: string;
  security?: boolean;
  source?: string;
}

const KERNEL = /kernel|linux-image/;

/** The fixture world's waiting updates: three each (one for security), as `#fillIn`'s counts say. */
function initial(server: string): FakeUpdate[] {
  if (server === 'shale')
    return [
      {
        name: 'proxmox-kernel-6.8',
        current: '6.8.12-4',
        new: '6.8.12-5',
        source: 'pve-no-subscription',
      },
      {
        name: 'openssl',
        current: '3.0.15-1~deb12u1',
        new: '3.0.16-1~deb12u1',
        security: true,
        source: 'debian-security',
      },
      { name: 'pve-manager', current: '8.3.0', new: '8.3.1', source: 'pve-no-subscription' },
    ];
  return [
    {
      name: 'openssl',
      current: '3.0.15-1~deb12u1',
      new: '3.0.16-1~deb12u1',
      security: true,
      source: 'debian-security',
    },
    { name: 'curl', current: '7.88.1-10+deb12u8', new: '7.88.1-10+deb12u9', source: 'debian' },
    { name: 'tzdata', current: '2024a-0+deb12u1', new: '2025b-0+deb12u1', source: 'debian' },
  ];
}

export class FakePackages {
  /** What waits per server (`inspect/updates` and the counts). */
  readonly waiting = new Map<string, FakeUpdate[]>();
  /** What the next Check of a server finds besides. */
  readonly found = new Map<string, FakeUpdate[]>();
  /** Servers whose agent refuses both ops: the problem it answers (an old agent: `unsupported` “unknown operation”). */
  readonly refuse = new Map<string, { status: number; code: string; detail: string }>();
  /** What the next Install holds back (by name), and the warning it ends with. */
  keptBack: string[] = [];
  warning = '';
  /** The next package task's end leaves the report as it was (an agent that hasn't read its updates again yet). */
  staleReport = false;

  constructor(
    readonly host: ManageHost,
    readonly manage: FakeManage,
  ) {}

  /** The fixture world's updates (after the fake filled in its data). */
  init(): void {
    for (const server of ['basalt', 'shale', 'blackbox', 'kvm-lab']) {
      const system = this.#system(server);
      if (!system) continue;
      this.waiting.set(server, initial(server));
      system.package_task = null;
      system.package_last = null;
      this.#count(server);
    }
    // Unraid updates itself another way (SWU-01): its agent refuses.
    this.refuse.set('blackbox', {
      status: 501,
      code: 'unsupported',
      detail: 'Unraid installs its own updates on its Update OS page.',
    });
  }

  routes(): { method: string; path: string; handler: FakeHandler }[] {
    const S = '/api/v1/servers/*';
    const s = (p: string[]) => p[0] as string;
    return [
      { method: 'GET', path: `${S}/inspect/updates`, handler: (r, p) => this.#list(r, s(p)) },
      { method: 'POST', path: `${S}/packages/check`, handler: (r, p) => this.#start(r, s(p), 'check') },
      { method: 'POST', path: `${S}/packages/install`, handler: (r, p) => this.#start(r, s(p), 'install') },
    ];
  }

  #system(server: string): Json | null {
    return (this.host.detailOf(server)?.system as Json | undefined) ?? null;
  }

  /** The report's counts from what waits. */
  #count(server: string): void {
    const system = this.#system(server);
    const list = this.waiting.get(server);
    if (!system || !list) return;
    system.updates = list.length;
    system.security_updates = list.filter((u) => u.security).length;
  }

  #list(_r: FakeRequest, server: string): FakeAnswer {
    if (!this.host.serverExists(server)) return problem(404, 'server_not_found', 'No such server.');
    const rc = this.host.switchesOf(server);
    // SWU-11: diagnose or console lets the list be read.
    if (rc && rc.diagnose === false && rc.console === false)
      return problem(403, 'diagnose_disabled', 'Read-only checks are turned off for this server');
    return ok({
      kind: 'updates',
      as_of: new Date().toISOString(),
      truncated: false,
      items: (this.waiting.get(server) ?? []).map((u) => ({ ...u })),
    });
  }

  #start(r: FakeRequest, server: string, op: 'check' | 'install'): FakeAnswer {
    const refused = this.manage.check(r, server, op === 'install' ? 'admin' : 'operator');
    if (refused) return refused;
    const bc = this.manage.body(r, op === 'install' ? ['packages', 'confirm'] : []);
    if (!('fields' in bc)) return bc;
    const b = bc.fields;
    if (op === 'install' && b.confirm !== true)
      return problem(400, 'confirm_required', 'Installing updates needs confirm: true.');
    let named: string[] | null = null;
    if (b.packages !== undefined) {
      if (
        !Array.isArray(b.packages) ||
        b.packages.length === 0 ||
        b.packages.length > 200 ||
        b.packages.some((p) => typeof p !== 'string' || !NAME.test(p))
      )
        return this.manage.invalid({ packages: 'Package names, 1 to 200.' });
      named = b.packages as string[];
    }
    const agentRefuses = this.refuse.get(server);
    if (agentRefuses) return problem(agentRefuses.status, agentRefuses.code, agentRefuses.detail);
    const system = this.#system(server);
    if (!system) return problem(501, 'unsupported', 'no supported package manager');
    if (system.package_task) return problem(409, 'busy', 'A package task is already running on this server.');
    const list = this.waiting.get(server) ?? [];
    const answer = this.manage.startTask(r, server, `packages.${op}`, {
      type: op === 'install' ? 'packages-install' : 'packages-check',
      idKind: 'pkg',
      cancellable: op === 'check',
      plan:
        op === 'check'
          ? ['Hit:1 http://deb.debian.org/debian bookworm InRelease', 'Reading package lists...']
          : [
              'Reading package lists...',
              'The following packages will be upgraded:',
              `  ${(named ?? list.map((u) => u.name)).join(' ')}`,
              'Setting up packages ...',
            ],
      ended: (result, message, code) => this.#ended(server, op, named, result, message, code),
    });
    const id = String(((answer.body as Json | undefined)?.task as Json | undefined)?.id ?? '');
    system.package_task = { id, op, started_at: new Date().toISOString() };
    return answer;
  }

  /** A package task ended: the report follows it, and the status gets `packages`. */
  #ended(
    server: string,
    op: 'check' | 'install',
    named: string[] | null,
    result: 'ok' | 'warning' | 'error',
    message: string,
    code: string | null,
  ): Json {
    const system = this.#system(server) as Json;
    const finished = new Date().toISOString();
    let installed = 0;
    let kept: string[] = [];
    const warning = this.warning;
    if (result !== 'error') {
      const list = this.waiting.get(server) ?? [];
      if (op === 'check') {
        const extra = this.found.get(server) ?? [];
        this.found.delete(server);
        this.waiting.set(server, [...list, ...extra.filter((u) => !list.some((w) => w.name === u.name))]);
      } else {
        kept = this.keptBack.filter((n) => list.some((u) => u.name === n));
        this.keptBack = [];
        this.warning = '';
        const done = list.filter((u) => !kept.includes(u.name) && (!named || named.includes(u.name)));
        installed = done.length;
        this.waiting.set(
          server,
          list.filter((u) => !done.includes(u)),
        );
        const kernel = done.find((u) => KERNEL.test(u.name));
        if (kernel) {
          system.reboot_required = true;
          system.reboot_reason = `Kernel ${kernel.new}-pve is installed, ${kernel.current}-pve runs`;
        }
      }
      this.#count(server);
    }
    system.package_task = null;
    system.package_last = {
      op,
      status: result === 'error' ? 'failed' : 'ok',
      finished_at: finished,
      installed: op === 'install' && result !== 'error' ? installed : null,
      message: result === 'error' ? message : '',
      code,
    };
    // The agent reads the updates and the reboot check again at once (SWU-05).
    if (this.staleReport) this.staleReport = false;
    else system.updates_checked_at = new Date().toISOString();
    return result === 'error' ? {} : { packages: { installed, kept_back: kept, warning } };
  }
}
