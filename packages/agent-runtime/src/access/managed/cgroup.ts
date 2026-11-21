/**
 * One cgroup per managed task (docs/decisions/managed-sandbox.md MSB-05): the limits (memory, swap, pids, CPU
 * weight), the kill that reaches every process the task ever started (`cgroup.kill`, no pid lists), the
 * counters that say which limit stopped it, and the way a restarted runner finds what an earlier generation
 * left behind.
 *
 * Both backends manage a **delegated cgroup subtree** themselves — `<root>/tasks/<generation>-<dispatch>` — and
 * start a task inside its cgroup before it execs anything (`/bin/sh -c 'echo $$ > …/cgroup.procs; exec …'`, which
 * also raises the task's OOM score to `TASK_OOM_SCORE_ADJ`, memory-pool.md MP-02):
 * - `delegated` — the appliance: `root` is the runner's own unit cgroup (`Delegate=yes`); the runner moves its
 *   own processes into `<root>/supervisor` (the no-internal-processes rule) and enables the controllers.
 * - `systemd-user` — a development host whose runner runs in a user session: per runner generation one
 *   transient scope with `Delegate=yes` in a slice of the user manager (`systemd-run --user --scope`), held by
 *   an anchor process in `<scope>/anchor`; the scope is the root.
 *
 * Generations: every task cgroup and (systemd-user) every root scope carries the runner generation that made
 * it. `orphans(current)` finds the others; `destroy` kills them recursively (`cgroup.kill` on a parent kills
 * the whole subtree). No backend, no managed turn: the limits and the orphan kill are part of the boundary.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface TaskLimits {
  /** `memory.max` in bytes (swap is off for tasks). */
  memoryBytes: number;
  /** `pids.max`: processes and threads. */
  pids: number;
  /** `cpu.weight` (1 … 10000; 100 is the default share). */
  cpuWeight: number;
}

export interface CgroupStats {
  /** `memory.events` oom_kill: processes the kernel killed at the memory limit. */
  oomKills: number;
  /** `pids.events` max: forks refused at the pids limit. */
  pidsMaxHits: number;
  memoryPeak: number | null;
}

export interface TaskCgroup {
  readonly name: string;
  /** The cgroup directory. */
  path(): string;
  /**
   * Where the task's commands get cgroups of their own (one-person.md OP-S108): `<dir>/commands/run`, under the commands'
   * limits; null for a task made without commands.
   */
  commands(): string | null;
  /** The command line that starts `command` inside the cgroup (it joins, then execs). */
  wrap(command: string, args: readonly string[]): { command: string; args: string[] };
  /** Called with the pid of the spawned wrapper; resolves once the task is inside its cgroup. */
  attached(pid: number): Promise<void>;
  /** Kills every process in the cgroup and waits until it is empty (bounded). */
  kill(): Promise<void>;
  stats(): Promise<CgroupStats>;
  /** Kills and removes the cgroup. */
  remove(): Promise<void>;
}

export interface OrphanCgroup {
  /** What it is called (`g7-d123`, or a generation's root scope). */
  name: string;
  path: string;
}

export interface CgroupBackend {
  readonly kind: 'delegated' | 'systemd-user';
  /** Can this host run task cgroups? `detail` says what's missing. */
  probe(): Promise<{ ok: boolean; detail: string }>;
  /**
   * A task cgroup `<generation>-<name>`. With `commands` (one-person.md OP-S108) the task's own processes run in
   * `<dir>/main` and its commands under `<dir>/commands` (those limits), each in a cgroup it makes in `commands/run`.
   */
  create(name: string, limits: TaskLimits, options?: { commands?: TaskLimits }): Promise<TaskCgroup>;
  /** Cgroups of runner generations other than `generation` (tasks, or a whole generation's root). */
  orphans(generation: string): Promise<OrphanCgroup[]>;
  /** Kills everything in an orphan (recursively) and removes it. */
  destroy(cgroup: OrphanCgroup): Promise<void>;
  /** Kills every task of this generation and releases the root (runner shutdown). */
  close(): Promise<void>;
}

const CGROUP_FS = '/sys/fs/cgroup';

/**
 * A task's OOM score (docs/decisions/memory-pool.md MP-02): the provider CLI of a turn and everything it starts go
 * before Whombat itself (the runner's unit: -900) but after the agent's commands (500, one-person.md OP-S108) when the
 * machine runs out of memory. The task's wrapper raises its own score to it before it execs; raising needs no privilege, and a score
 * already higher (a development host, a runner unit at 500) stays as it is.
 */
export const TASK_OOM_SCORE_ADJ = -500;

/**
 * The wrapper's script (`sh -c <script> <cgroup dir> <command> <args…>`): joins the cgroup — or fails without running
 * anything — raises its OOM score to `oomScoreAdj` when it is lower (best effort), then execs the command.
 */
export function taskWrapperScript(oomScoreAdj: number = TASK_OOM_SCORE_ADJ): string {
  const adj = Math.trunc(oomScoreAdj);
  return `echo $$ > "$0/cgroup.procs" || exit 1; { read -r a < /proc/self/oom_score_adj && [ "$a" -lt ${adj} ] && echo ${adj} > /proc/self/oom_score_adj; } 2>/dev/null; exec "$@"`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function run(
  file: string,
  args: string[],
  timeout = 10_000,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        out: String(stdout),
        err: error && typeof error.code !== 'number' ? error.message : String(stderr),
      });
    });
  });
}

/** The cgroup directory of a process (cgroup v2), or null. */
export async function cgroupOf(pid: number | 'self'): Promise<string | null> {
  const text = await readFile(`/proc/${pid}/cgroup`, 'utf8').catch(() => null);
  const line = text?.split('\n').find((l) => l.startsWith('0::'));
  return line ? join(CGROUP_FS, line.slice(3).trim()) : null;
}

async function populated(dir: string): Promise<boolean> {
  const events = await readFile(join(dir, 'cgroup.events'), 'utf8').catch(() => null);
  if (events === null) return false;
  return /^populated 1$/m.test(events);
}

/** `cgroup.kill` (the whole subtree), then wait for it to empty (SIGKILL can't be caught; exit takes a moment). */
export async function killCgroup(dir: string, timeoutMs = 5_000): Promise<void> {
  if (!existsSync(dir)) return;
  await writeFile(join(dir, 'cgroup.kill'), '1').catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && (await populated(dir))) await sleep(20);
}

/** Removes a cgroup and its (empty) children, deepest first. */
async function removeTree(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) if (e.isDirectory()) await removeTree(join(dir, e.name));
  await rmdir(dir).catch(() => {});
}

async function readStats(dir: string): Promise<CgroupStats> {
  const field = async (file: string, key: string) => {
    const text = await readFile(join(dir, file), 'utf8').catch(() => '');
    const m = new RegExp(`^${key} (\\d+)$`, 'm').exec(text);
    return m ? Number(m[1]) : 0;
  };
  const peak = await readFile(join(dir, 'memory.peak'), 'utf8').catch(() => null);
  return {
    oomKills: await field('memory.events', 'oom_kill'),
    pidsMaxHits: await field('pids.events', 'max'),
    memoryPeak: peak === null ? null : Number(peak.trim()),
  };
}

/** A cgroup name component: letters, digits, `_`; anything else becomes `_`. */
export function cgroupName(...parts: string[]): string {
  return parts.map((p) => p.replace(/[^A-Za-z0-9_]/g, '_')).join('-');
}

// --- a delegated subtree -------------------------------------------------------------------------------------

/** A cgroup's limits (swap off). */
async function setLimits(dir: string, limits: TaskLimits): Promise<void> {
  await writeFile(join(dir, 'memory.max'), String(limits.memoryBytes));
  await writeFile(join(dir, 'memory.swap.max'), '0').catch(() => {});
  await writeFile(join(dir, 'pids.max'), String(limits.pids));
  await writeFile(join(dir, 'cpu.weight'), String(limits.cpuWeight)).catch(() => {});
}

/** Task cgroups under a delegated root: `<root>/tasks/<generation>-<dispatch>`. */
export class DelegatedCgroups implements CgroupBackend {
  readonly kind: 'delegated' | 'systemd-user' = 'delegated';
  readonly #root: () => Promise<string>;
  readonly #sh: string;
  readonly #generation: string;
  readonly #script: string;
  #ready: Promise<string> | null = null;

  /**
   * `root`: the delegated cgroup (default: the one this process is in — the runner's unit). `generation`:
   * the runner generation its task cgroups are named after. `oomScoreAdj`: the tasks' OOM score (MP-02).
   */
  constructor(options: {
    root?: string | (() => Promise<string>);
    generation: string;
    sh?: string;
    oomScoreAdj?: number;
  }) {
    const root = options.root;
    this.#root =
      typeof root === 'function'
        ? root
        : async () => {
            if (root) return root;
            const own = await cgroupOf('self');
            if (!own) throw new Error('this process is not in a cgroup v2 hierarchy');
            // Already moved into `supervisor` by an earlier setup: the root is its parent.
            return own.endsWith('/supervisor') ? join(own, '..') : own;
          };
    this.#generation = options.generation;
    this.#sh = options.sh ?? '/bin/sh';
    this.#script = taskWrapperScript(options.oomScoreAdj);
  }

  /**
   * Moves the processes in the root into `supervisor` (the no-internal-processes rule), enables the
   * controllers for the children and makes `tasks/`. Idempotent; returns the root.
   */
  setup(): Promise<string> {
    this.#ready ??= (async () => {
      const root = await this.#root();
      const procs = (await readFile(join(root, 'cgroup.procs'), 'utf8')).split('\n').filter(Boolean);
      if (procs.length) {
        const supervisor = join(root, 'supervisor');
        await mkdir(supervisor, { recursive: true });
        for (const pid of procs) await writeFile(join(supervisor, 'cgroup.procs'), pid).catch(() => {});
      }
      const available = (await readFile(join(root, 'cgroup.controllers'), 'utf8')).trim().split(/\s+/);
      const enable = ['memory', 'pids', 'cpu']
        .filter((c) => available.includes(c))
        .map((c) => `+${c}`)
        .join(' ');
      if (enable) await writeFile(join(root, 'cgroup.subtree_control'), enable);
      const tasks = join(root, 'tasks');
      await mkdir(tasks, { recursive: true });
      if (enable) await writeFile(join(tasks, 'cgroup.subtree_control'), enable);
      return root;
    })();
    this.#ready.catch(() => {
      this.#ready = null;
    });
    return this.#ready;
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    try {
      const root = await this.setup();
      const controllers = (await readFile(join(root, 'tasks', 'cgroup.subtree_control'), 'utf8')).split(
        /\s+/,
      );
      const missing = ['memory', 'pids'].filter((c) => !controllers.includes(c));
      if (missing.length)
        return { ok: false, detail: `the delegated cgroup ${root} lacks ${missing.join(' and ')}` };
      return { ok: true, detail: `delegated cgroup ${root}` };
    } catch (err) {
      return {
        ok: false,
        detail: `cannot manage task cgroups (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}); the runner's unit needs Delegate=yes`,
      };
    }
  }

  async create(
    name: string,
    limits: TaskLimits,
    options: { commands?: TaskLimits } = {},
  ): Promise<TaskCgroup> {
    const root = await this.setup();
    const full = cgroupName(this.#generation, name);
    const dir = join(root, 'tasks', full);
    if (existsSync(dir)) {
      await killCgroup(dir);
      await removeTree(dir);
    }
    await mkdir(dir);
    await setLimits(dir, limits);
    // Commands (one-person.md OP-S108): the task's processes in `main`, the commands under limits of their own beside
    // it, each in a cgroup it makes in `commands/run` (no controllers there: no rule against processes in it).
    let target = dir;
    let commands: string | null = null;
    if (options.commands) {
      const available = (await readFile(join(dir, 'cgroup.controllers'), 'utf8')).trim().split(/\s+/);
      const enable = ['memory', 'pids', 'cpu']
        .filter((c) => available.includes(c))
        .map((c) => `+${c}`)
        .join(' ');
      if (enable) await writeFile(join(dir, 'cgroup.subtree_control'), enable);
      target = join(dir, 'main');
      await mkdir(target);
      await mkdir(join(dir, 'commands'));
      await setLimits(join(dir, 'commands'), options.commands);
      commands = join(dir, 'commands', 'run');
      await mkdir(commands);
    }
    return {
      name: full,
      path: () => dir,
      commands: () => commands,
      // The wrapper joins the cgroup, then execs: nothing of the task ever runs outside it. On the way it takes the
      // tasks' OOM score (MP-02).
      wrap: (command, rest) => ({
        command: this.#sh,
        args: ['-c', this.#script, target, command, ...rest],
      }),
      attached: async (pid) => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const at = await cgroupOf(pid);
          if (at === null) return; // exited already (it ran, if at all, inside: the wrapper joins first)
          if (at === target) return;
          await sleep(5);
        }
        throw new Error(`The task did not reach its cgroup ${target}.`);
      },
      kill: () => killCgroup(dir),
      stats: () => readStats(dir),
      remove: async () => {
        await killCgroup(dir);
        await removeTree(dir);
      },
    };
  }

  async orphans(generation: string): Promise<OrphanCgroup[]> {
    const root = await this.setup();
    const entries = await readdir(join(root, 'tasks'), { withFileTypes: true }).catch(() => []);
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(`${generation}-`))
      .map((e) => ({ name: e.name, path: join(root, 'tasks', e.name) }));
  }

  async destroy(cgroup: OrphanCgroup): Promise<void> {
    await killCgroup(cgroup.path);
    await removeTree(cgroup.path);
  }

  async close(): Promise<void> {
    const root = await this.setup().catch(() => null);
    if (!root) return;
    const entries = await readdir(join(root, 'tasks'), { withFileTypes: true }).catch(() => []);
    for (const e of entries)
      if (e.isDirectory() && e.name.startsWith(`${this.#generation}-`))
        await this.destroy({ name: e.name, path: join(root, 'tasks', e.name) });
  }
}

// --- systemd --user: one delegated scope per runner generation -----------------------------------------------

export class SystemdUserCgroups implements CgroupBackend {
  readonly kind = 'systemd-user' as const;
  readonly #slice: string;
  readonly #base: string;
  readonly #generation: string;
  readonly #systemdRun: string;
  readonly #systemctl: string;
  readonly #tasks: DelegatedCgroups;
  #scope: Promise<string> | null = null;

  /** `slice`: a slice name without dashes of its own (a dash means a parent slice in systemd). */
  constructor(options: { slice: string; generation: string; systemdRun?: string; systemctl?: string }) {
    if (!/^[A-Za-z0-9_]+\.slice$/.test(options.slice))
      throw new Error(`Invalid slice name ${options.slice} (letters, digits, _; ending in .slice).`);
    this.#slice = options.slice;
    this.#base = options.slice.replace(/\.slice$/, '');
    this.#generation = options.generation;
    this.#systemdRun = options.systemdRun ?? 'systemd-run';
    this.#systemctl = options.systemctl ?? 'systemctl';
    this.#tasks = new DelegatedCgroups({ root: () => this.#rootScope(), generation: options.generation });
  }

  get unit(): string {
    return `${this.#base}-${cgroupName(this.#generation)}.scope`;
  }

  /** The generation's delegated scope, started once: an anchor process in `<scope>/anchor` holds it. */
  #rootScope(): Promise<string> {
    this.#scope ??= (async () => {
      const unit = this.unit;
      const anchor = spawn(
        this.#systemdRun,
        [
          '--user',
          '--scope',
          '--quiet',
          '--collect',
          `--slice=${this.#slice}`,
          `--unit=${unit}`,
          '-p',
          'Delegate=yes',
          '--',
          '/bin/sh',
          '-c',
          'CG=/sys/fs/cgroup$(sed -n "s/^0:://p" /proc/self/cgroup); mkdir -p "$CG/supervisor" && echo $$ > "$CG/supervisor/cgroup.procs" && echo "$CG" && exec sleep infinity',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
      );
      anchor.unref();
      let out = '';
      let err = '';
      anchor.stdout.on('data', (d: Buffer) => {
        out += d.toString();
      });
      anchor.stderr.on('data', (d: Buffer) => {
        err += d.toString();
      });
      const dir = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the generation scope did not start')), 10_000);
        anchor.once('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        anchor.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(err.trim().split('\n').pop() || `systemd-run exited ${code}`));
        });
        anchor.stdout.on('data', () => {
          const line = out.split('\n')[0];
          if (out.includes('\n') && line) {
            clearTimeout(timer);
            resolve(line.trim());
          }
        });
      });
      anchor.stdout.destroy();
      anchor.stderr.destroy();
      return dir;
    })();
    this.#scope.catch(() => {
      this.#scope = null;
    });
    return this.#scope;
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    const r = await this.#tasks.probe();
    if (!r.ok) {
      const why = r.detail.replace(/; the runner's unit needs Delegate=yes$/, '');
      return { ok: false, detail: `systemd --user scopes: ${why}` };
    }
    return { ok: true, detail: `systemd --user scope ${this.unit} (delegated)` };
  }

  create(name: string, limits: TaskLimits, options: { commands?: TaskLimits } = {}): Promise<TaskCgroup> {
    return this.#tasks.create(name, limits, options);
  }

  async #sliceDir(): Promise<string | null> {
    const r = await run(this.#systemctl, ['--user', 'show', '-p', 'ControlGroup', '--value', this.#slice]);
    const path = r.out.trim();
    return r.code === 0 && path ? join(CGROUP_FS, path) : null;
  }

  async orphans(generation: string): Promise<OrphanCgroup[]> {
    const dir = await this.#sliceDir();
    if (!dir) return [];
    const mine = `${this.#base}-${cgroupName(generation)}.scope`;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    return entries
      .filter(
        (e) =>
          e.isDirectory() &&
          e.name.startsWith(`${this.#base}-`) &&
          e.name.endsWith('.scope') &&
          e.name !== mine,
      )
      .map((e) => ({ name: e.name.slice(this.#base.length + 1, -'.scope'.length), path: join(dir, e.name) }));
  }

  async destroy(cgroup: OrphanCgroup): Promise<void> {
    await killCgroup(cgroup.path);
    await run(this.#systemctl, ['--user', 'stop', `${this.#base}-${cgroup.name}.scope`]);
  }

  async close(): Promise<void> {
    if (!this.#scope) return;
    const dir = await this.#scope.catch(() => null);
    this.#scope = null;
    if (!dir) return;
    await killCgroup(dir);
    await run(this.#systemctl, ['--user', 'stop', this.unit]);
  }
}
