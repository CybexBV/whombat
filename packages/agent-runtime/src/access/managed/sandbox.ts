/**
 * `ManagedSandbox`: the enforced per-task boundary of managed mode (docs/decisions/managed-sandbox.md MSB-01 …
 * MSB-05). A provider process and everything it starts — shells, git, package managers, MCP servers,
 * repository hooks, the provider's own nested sandbox — run inside it together:
 *
 * ```
 * runner ─ cgroup wrapper (scope / delegated cgroup: memory, swap 0, pids, cpu weight; cgroup.kill)
 *          └ bwrap stage 1 — own user (uid 0 → runner uid; capabilities only inside it), net (loopback only),
 *            pid, ipc, uts, cgroup namespaces; the task's mounts + its control dir
 *            └ node shim.mjs — loopback bridges to the runner's egress proxy, MCP endpoint and resolver
 *              └ bwrap stage 2 — own user (uid 1000), pid, ipc, uts namespaces; no capabilities,
 *                no_new_privs, seccomp; the task's mounts only
 *                └ the provider CLI and its tools
 * ```
 *
 * Mounts: a read-only system (`/usr`, `/bin`, `/lib*`, `/nix/store`, an allowlist of `/etc`), the provider's
 * and Node's installs, generated `passwd` / `group` / `hosts` / `resolv.conf` / `nsswitch.conf`, a fresh
 * `/proc` of the task's own pid namespace, a minimal `/dev`, size-limited tmpfs `/tmp` and home. Writable: the
 * task's working directory (when it may write), what a commit needs, and the credential home of the run's
 * owner for that provider. Never mounted: `/run` (Docker, Podman, Postgres, SSH agent, D-Bus, the manager's and
 * helper's sockets), `/var`, `/home` and `/root` beyond the paths above, `/sys`, `/persist`, other identities'
 * credential homes, Whombat's home and secrets. A denied path that sits inside a mounted one is covered
 * (empty tmpfs or `/dev/null`).
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CgroupBackend, CgroupStats, TaskCgroup, TaskLimits } from './cgroup';
import { cgroupName } from './cgroup';
import {
  type EgressEvent,
  type EgressOptions,
  type EgressPolicy,
  type EgressService,
  startEgress,
} from './egress';
import { hostSeccompArch, seccompFilter } from './seccomp';

export const SHIM_PATH = fileURLToPath(new URL('./shim.mjs', import.meta.url));
/** A person's pod's payload (hermes-native.md HN-W01, HN-W02): Hermes's gateway, a spare `hermes acp`, the runner's socket. */
export const POD_INIT_PATH = fileURLToPath(new URL('./pod-init.mjs', import.meta.url));

/** Ports of the loopback services inside a task's network namespace. */
export const SANDBOX_PORTS = {
  proxy: 47101,
  mcp: 47100,
  gateway: 47104,
  browser: 47105,
} as const;
/**
 * Where a turn through the burrow's AI gateway sends its model requests inside the sandbox (Whombat ai-gateway.md
 * AIG-08): the bridge to the runner's gateway forwarder; the CLI's base URL is this plus `/ai-gateway/<provider>`.
 */
export const SANDBOX_GATEWAY_ORIGIN = `http://127.0.0.1:${SANDBOX_PORTS.gateway}`;
/**
 * Where Hermes's browser reaches the agent's Chromium inside the sandbox (Whombat hermes-engine.md HE-42; one-person.md
 * OP-S113): the bridge to the runner's CDP relay; Hermes's `browser.cdp_url`.
 */
export const SANDBOX_BROWSER_ORIGIN = `http://127.0.0.1:${SANDBOX_PORTS.browser}`;
/** The uid / gid a task's processes have inside their sandbox (mapped to the runner's uid). */
export const SANDBOX_UID = 1000;
/** The task's home inside the sandbox (tmpfs). */
export const SANDBOX_HOME = '/home/whombat-task';
/**
 * The runner's logins service inside the sandbox (Whombat hermes-engine.md HE-S141): the socket file alone, bound into
 * the tmpfs home, where Hermes's credential vault asks for a login's password when it fills one. Never a loopback port:
 * nothing else in the sandbox speaks to a unix socket path.
 */
export const SANDBOX_LOGINS_SOCKET = `${SANDBOX_HOME}/.whombat/logins.sock`;
/**
 * The runner's commands service inside the sandbox (one-person.md OP-07, OP-S107): the socket file alone, bound into the
 * tmpfs home, where `whombat-command` (Hermes's terminal environment) asks before each command. Never a loopback port.
 */
export const SANDBOX_COMMANDS_SOCKET = `${SANDBOX_HOME}/.whombat/commands.sock`;
/**
 * The proxy the agent's commands go through (OP-S106), its socket file alone in the tmpfs home, which the commands'
 * holder bridges to `127.0.0.1:3128` in their network: the commands-network daemon's for a person's pod
 * (`whombat-agent-net`), the task's own egress for an outsiders' turn (OP-17).
 */
export const SANDBOX_PROXY_SOCKET = `${SANDBOX_HOME}/.whombat/proxy.sock`;

/**
 * `env` with `pairs` added to its command-line git config (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n`),
 * after what is there; a set that doesn't hold together (a count without its keys) is replaced by `pairs` alone, so git
 * never meets a broken one.
 */
export function withGitConfig(
  env: Record<string, string>,
  pairs: readonly (readonly [string, string])[],
): Record<string, string> {
  const out = { ...env };
  const count = Number(out.GIT_CONFIG_COUNT ?? 0);
  const whole =
    Number.isInteger(count) &&
    count >= 0 &&
    Array.from({ length: count }).every(
      (_, i) => out[`GIT_CONFIG_KEY_${i}`] !== undefined && out[`GIT_CONFIG_VALUE_${i}`] !== undefined,
    );
  let n = whole ? count : 0;
  if (!whole)
    for (const k of Object.keys(out)) if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k)) delete out[k];
  for (const [key, value] of pairs) {
    out[`GIT_CONFIG_KEY_${n}`] = key;
    out[`GIT_CONFIG_VALUE_${n}`] = value;
    n++;
  }
  out.GIT_CONFIG_COUNT = String(n);
  return out;
}

export interface SandboxLimits extends TaskLimits {
  /** Size of the task's `/tmp` tmpfs (bytes; counted against its memory too). */
  tmpBytes: number;
  /** Size of the task's home tmpfs (bytes). */
  homeBytes: number;
  /** Bytes the provider may write to stdout + stderr before the task is killed. */
  outputBytes: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  memoryBytes: 4 * 1024 ** 3,
  pids: 1024,
  cpuWeight: 100,
  tmpBytes: 1024 ** 3,
  homeBytes: 512 * 1024 ** 2,
  outputBytes: 256 * 1024 ** 2,
};

/** System directories bound read-only when they exist (symlinks kept as symlinks). */
export const SYSTEM_PATHS = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/nix/store'];

/** `/etc` entries a task sees (read-only, when they exist); the rest of `/etc` is not there. */
export const ETC_ALLOWLIST = [
  'alternatives',
  'ssl',
  // NixOS: /etc/ssl's certificates link into /etc/static (the store's etc, readable in /nix/store anyway); Python's
  // TLS (Hermes, hermes-engine.md step 1) follows them.
  'static',
  'ca-certificates',
  'ca-certificates.conf',
  'pki',
  'crypto-policies',
  'ld.so.cache',
  'ld.so.conf',
  'ld.so.conf.d',
  'localtime',
  'timezone',
  'zoneinfo',
  'protocols',
  'services',
  'mime.types',
  'os-release',
  'debian_version',
  'lsb-release',
  'terminfo',
  'inputrc',
  'magic',
  'gai.conf',
  'host.conf',
  'static', // NixOS: /etc/ssl and friends point into it
  // The agent's Chromium (one-person.md OP-S113): fonts, and a distribution's own launcher settings (Debian's wrapper
  // reads /etc/chromium.d). Never /etc/chromium: its managed policies are the desk kiosk's (every URL blocked, no
  // DevTools), and Chromium reads them whatever profile it runs with (OP-S117).
  'fonts',
  'chromium.d',
];

export interface ManagedSandboxConfig {
  /** bubblewrap (absolute; the pinned one on the appliance). */
  bwrap: string;
  /** Node for the shim (default: this process's). */
  node?: string;
  /** util-linux's `nsenter` (absolute): how a command joins its holder (one-person.md OP-07). */
  nsenter?: string;
  cgroups: CgroupBackend;
  /** Runner-owned private directory for per-task control files (sockets, generated /etc, seccomp). */
  stateDir: string;
  /** The runner generation, e.g. `g12`: names control dirs; the cgroup backend is made for the same one. */
  prefix: string;
  limits?: Partial<SandboxLimits>;
  /** Extra read-only paths every task sees (toolchains: `WHOMBAT_SANDBOX_RO_PATHS`). */
  readOnlyPaths?: readonly string[];
  /** Paths never visible, even inside a mounted one (credentials root, Whombat home, secrets). */
  deniedPaths?: readonly string[];
  /**
   * Extra variable names a task may see (tests' fixtures, an operator's non-secret setting); a name that looks
   * like a secret or a login is dropped anyway (MSB-18).
   */
  passEnv?: readonly string[];
  /** Test hooks for the egress service (a fake resolver, local servers standing in for public ones). */
  egress?: Pick<EgressOptions, 'resolve' | 'dial'>;
}

export interface SandboxTask {
  /** Dispatch id (names the cgroup and control dir). */
  id: string;
  cwd: string;
  /** The working directory is writable (a coding turn with write access). */
  writeCwd: boolean;
  /** More writable paths (what a commit needs). */
  writable?: readonly string[];
  /** More read-only paths (skills, attachments, a clone's objects). */
  readable?: readonly string[];
  /** Read-only even inside a writable path (`.git` config, hooks, …). */
  readOnlyInside?: readonly string[];
  /** Never visible, even inside a mounted path (credentials, other workspaces). */
  denied?: readonly string[];
  /** The credential home of the run's owner for this provider: the only writable home it has. */
  credentialHome?: string;
  /** Where the provider keeps its own state (a person's Hermes profile, HE-S18): writable, whatever the cwd is. */
  stateDirs?: readonly string[];
  /** Variables the payload gets on top of the allowlisted environment (the runner's own values; no secret names). */
  env?: Readonly<Record<string, string>>;
  /** Folders first on the payload's `PATH`, after the stand-in gh's (a provider's helpers: agent-browser, HE-S300). */
  path?: readonly string[];
  /** Provider / toolchain installs the command needs (read-only). */
  installs?: readonly string[];
  /** Hermes's commands run beside it, each in a wrapper of its own (one-person.md OP-07): see `SandboxCommands`. */
  commands?: SandboxCommands;
  /** The turn goes through the burrow's AI gateway (Whombat ai-gateway.md AIG-08): the bridge to the runner's forwarder. */
  gateway?: SandboxGateway;
  /** The turn has a browser (Whombat hermes-engine.md HE-42): the bridge to the runner's CDP relay. */
  browser?: SandboxBridge;
  /** The turn's person has logins for the browser (HE-S141): the runner's logins service, its socket file bound alone. */
  logins?: SandboxBridge;
  egress: EgressPolicy;
  /** The Whombat MCP endpoint the provider uses (reached only through the sandbox's MCP bridge). */
  mcpUrl?: string;
  limits?: Partial<SandboxLimits>;
  onEgress?: (event: EgressEvent) => void;
  /**
   * A person's pod (hermes-native.md HN-W01…HN-W03) instead of one turn's task: it outlives turns, so its working
   * directory is the pod's own run directory (writable: `pod-init` serves the runner there), its output isn't counted
   * against a limit (its logs go to the runner for as long as it lives), and its defaults are the pod's limits.
   */
  pod?: true;
}

/**
 * What a sandbox whose Hermes runs commands gets (one-person.md OP-07, OP-S105, OP-S107, OP-S108): the runner's
 * commands service (`SANDBOX_COMMANDS_SOCKET`), the commands' proxy (`SANDBOX_PROXY_SOCKET`), and a cgroup for the
 * commands under the task's (`<task>/commands/run`, each command `c-<id>` there), whose limits keep Hermes alive when a
 * command runs away; the task's own processes are in `<task>/main`. The rest — the holder, the wrapper's mounts — is the
 * runner's (`apps/runner/src/commands`).
 */
export interface SandboxCommands {
  /** The runner's commands service for this sandbox (a unix socket). */
  socket: string;
  /** The commands-network daemon's proxy socket; null: the task's own egress (an outsiders' turn). */
  proxy: string | null;
  /** The commands' share of the task's memory and pids (default: all but a reserve for the payload). */
  limits?: Partial<TaskLimits>;
}

/** A pod's limits (HN-W16; `WHOMBAT_POD_MEMORY_MB` sets the memory): several turns of one person at once. */
export const DEFAULT_POD_LIMITS: Partial<SandboxLimits> = {
  memoryBytes: 6 * 1024 ** 3,
  pids: 2048,
};
/**
 * What a turn through the burrow's AI gateway adds to its sandbox (Whombat ai-gateway.md AIG-08): the runner's forwarder
 * for the turn (a unix socket), bridged to `127.0.0.1:47104` by stage 1. Unlike gh's, the socket is never bound into
 * stage 2: only the CLI talks to the gateway, over the loopback bridge of the task's network namespace, and the
 * providers' own shell sandboxes have no reason to.
 */
export interface SandboxGateway {
  socket: string;
}

/**
 * A runner service for the turn (a unix socket): the browser's CDP relay, bridged to `127.0.0.1:47105` by stage 1 like
 * the gateway's (stage 2 never sees it); the logins service, whose socket file alone is bound into stage 2 at
 * `SANDBOX_LOGINS_SOCKET` (Whombat hermes-engine.md HE-S137, HE-S141).
 */
export interface SandboxBridge {
  socket: string;
}

export type SandboxViolation = 'output_limit' | 'memory_limit' | 'pids_limit';

export interface SandboxSession {
  readonly id: string;
  /** The MCP URL to give the provider (the in-sandbox bridge), or the original when there is none. */
  readonly mcpUrl: string | undefined;
  /** Starts `command` inside the sandbox; the returned process is the outermost wrapper (its group leader). */
  spawn(
    command: string,
    args: readonly string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv },
  ): ChildProcessWithoutNullStreams;
  /** Kills every process of the task (its cgroup) and waits for them to be gone. */
  kill(): Promise<void>;
  /** Kills, releases the cgroup and the egress sockets, removes the control dir. Idempotent. */
  close(): Promise<void>;
  /** What the limits and the network policy stopped. */
  violations(): Promise<SandboxViolation[]>;
  stats(): Promise<CgroupStats | null>;
  egressEvents(): readonly EgressEvent[];
  /** Replaces the network policy for what is asked from now on (a pod: its person's live turns, HN-W15). */
  setEgress(policy: EgressPolicy): void;
  /** The task's cgroup directory. */
  cgroupPath(): string;
  /** Where the task's commands get their cgroups (`<task>/commands/run`); null without commands. */
  commandsCgroup(): string | null;
}

export class SandboxUnavailable extends Error {
  constructor(readonly detail: string) {
    super(`The managed sandbox is unavailable on this host: ${detail}`);
    this.name = 'SandboxUnavailable';
  }
}

const within = (path: string, root: string) =>
  path === root || path.startsWith(root === '/' ? '/' : `${root}/`);

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Where Node is installed (its prefix: `bin/node` and `lib/node_modules`). */
export function nodeInstall(node: string = process.execPath): string {
  const real = realpathSync(node);
  return /\/bin\/node$/.test(real) ? dirname(dirname(real)) : dirname(real);
}

/** How a command is reached inside the sandbox: the path to exec, the links to recreate, the install to mount. */
export interface ResolvedCommand {
  /** Absolute path the payload execs (a link keeps its name: multi-call binaries dispatch on it). */
  path: string;
  /** Symbolic links on the way to the binary, recreated inside (`--symlink target link`). */
  links: { link: string; target: string }[];
  /** Read-only installs: the binary's directory, or an npm package for `…/node_modules/<pkg>/bin/*`. */
  installs: string[];
}

/**
 * Resolves `command` (absolute, or on `path`) for the sandbox. Links are followed hop by hop and recreated
 * inside, so `~/.local/bin/codex → ../lib/node_modules/@openai/codex/bin/codex.js` works as on the host; the
 * binary's install is mounted read-only. Null when the command can't be found (the turn fails: nothing runs).
 */
export function resolveCommand(command: string, path: string | undefined): ResolvedCommand | null {
  const candidates = isAbsolute(command)
    ? [command]
    : command.includes('/')
      ? []
      : (path ?? '')
          .split(':')
          .filter((d) => isAbsolute(d))
          .map((d) => join(d, command));
  for (const candidate of candidates) {
    let real: string;
    try {
      real = realpathSync(candidate);
      if (!statSync(real).isFile()) continue;
    } catch {
      continue;
    }
    const links: { link: string; target: string }[] = [];
    // The directory's links resolved (`…/node/24 → 24.18.0`); the name kept (multi-call binaries).
    const start = join(realpathSync(dirname(candidate)), basename(candidate));
    let at = start;
    for (let hops = 0; hops < 16; hops++) {
      let next: string;
      try {
        if (!lstatSync(at).isSymbolicLink()) break;
        next = resolve(realpathSync(dirname(at)), readlinkSync(at));
      } catch {
        break;
      }
      // Absolute targets: the link's directory may itself be a link on the host.
      links.push({ link: at, target: next });
      at = next;
    }
    const pkg = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\/(?:bin|dist|lib)\/[^/]+$/.exec(real);
    return { path: start, links, installs: [pkg?.[1] ?? dirname(real)] };
  }
  return null;
}

/** The install directories of `command` (see `resolveCommand`). */
export function commandInstall(command: string, path: string | undefined): string[] {
  return resolveCommand(command, path)?.installs ?? [];
}

type Bind = { src: string; dest: string; mode: 'ro' | 'rw' };

/** The payload's mounts as bubblewrap arguments (both stages build the same view). */
export function mountArgs(
  task: SandboxTask,
  config: Pick<ManagedSandboxConfig, 'readOnlyPaths' | 'deniedPaths'>,
  options: {
    etcDir: string;
    limits: SandboxLimits;
    nodeDir: string;
    bwrap: string;
    links?: readonly { link: string; target: string }[];
    /** The commands' proxy socket (`SandboxCommands.proxy`, or the task's egress). */
    proxySocket?: string;
    /** The commands' cgroup (`<task>/commands/run`). */
    commandsCgroup?: string | null;
  },
): string[] {
  const args: string[] = [];
  for (const path of SYSTEM_PATHS) {
    if (!exists(path)) continue;
    const st = lstatSync(path);
    if (st.isSymbolicLink()) args.push('--symlink', readlinkSync(path), path);
    else args.push('--ro-bind', path, path);
  }
  // NixOS: the system profile the PATH points into.
  if (exists('/run/current-system')) args.push('--ro-bind', '/run/current-system', '/run/current-system');
  args.push('--dir', '/etc');
  for (const name of ETC_ALLOWLIST) {
    const path = join('/etc', name);
    if (exists(path)) args.push('--ro-bind', path, path);
  }
  for (const name of ['passwd', 'group', 'hosts', 'resolv.conf', 'nsswitch.conf'])
    args.push('--ro-bind', join(options.etcDir, name), join('/etc', name));
  args.push('--proc', '/proc', '--dev', '/dev');
  args.push('--size', String(options.limits.tmpBytes), '--tmpfs', '/tmp');
  args.push('--symlink', '/tmp', '/var/tmp');
  args.push('--size', String(options.limits.homeBytes), '--tmpfs', SANDBOX_HOME);

  const binds: Bind[] = [];
  const add = (src: string, mode: 'ro' | 'rw') => {
    const p = normalize(src);
    if (isAbsolute(p) && exists(p)) binds.push({ src: p, dest: p, mode });
  };
  add(options.nodeDir, 'ro');
  add(dirname(options.bwrap), 'ro');
  for (const p of task.installs ?? []) add(p, 'ro');
  for (const p of config.readOnlyPaths ?? []) add(p, 'ro');
  for (const p of task.readable ?? []) add(p, 'ro');
  add(task.cwd, task.writeCwd ? 'rw' : 'ro');
  if (task.writeCwd) for (const p of task.writable ?? []) add(p, 'rw');
  if (task.credentialHome) add(task.credentialHome, 'rw');
  for (const p of task.stateDirs ?? []) add(p, 'rw');
  for (const p of task.readOnlyInside ?? []) add(p, 'ro');
  // Parents before children; on the same path read-only last (it wins).
  const depth = (p: string) => p.split('/').length;
  const order = { rw: 0, ro: 1 } as const;
  const sorted = binds
    .map((b, i) => ({ ...b, i }))
    .sort((a, b) => depth(a.dest) - depth(b.dest) || order[a.mode] - order[b.mode] || a.i - b.i);
  const system = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/nix/store', '/etc'];
  for (const b of sorted) {
    // Already visible read-only through the system mounts.
    if (b.mode === 'ro' && system.some((s) => within(b.dest, s))) continue;
    args.push(b.mode === 'rw' ? '--bind' : '--ro-bind', b.src, b.dest);
  }
  // Hermes's commands (one-person.md OP-07): the runner's service and the commands' proxy, their socket files alone in
  // the home (stage 2 binds them from stage 1's view, where their folders are); the commands' cgroup at its own path.
  if (task.commands) {
    args.push('--ro-bind', task.commands.socket, SANDBOX_COMMANDS_SOCKET);
    if (options.proxySocket) args.push('--ro-bind', options.proxySocket, SANDBOX_PROXY_SOCKET);
    if (options.commandsCgroup) args.push('--bind', options.commandsCgroup, options.commandsCgroup);
  }
  // The logins service (HE-S141): its socket file alone, where Hermes's credential vault asks for a password.
  if (task.logins) args.push('--ro-bind', task.logins.socket, SANDBOX_LOGINS_SOCKET);
  // The command's links (`~/.local/bin/codex → …/codex.js`), where nothing mounted has them already.
  const roots = [...SYSTEM_PATHS, '/etc', ...sorted.map((b) => b.dest)];
  for (const { link, target } of options.links ?? [])
    if (!roots.some((r) => within(link, r))) args.push('--symlink', target, link);
  // A denied path inside something mounted is covered, so it can't be read through its parent.
  const mounted = sorted.map((b) => b.dest);
  const denied = [...(task.denied ?? []), ...(config.deniedPaths ?? [])].map((p) => normalize(p));
  for (const d of [...new Set(denied)]) {
    if (!isAbsolute(d) || !exists(d)) continue;
    // The person's own credential home is the one exception, by design.
    if (task.credentialHome && within(normalize(task.credentialHome), d)) continue;
    if (!mounted.some((m) => within(d, m) && d !== m)) continue;
    if (statSync(d).isDirectory()) args.push('--tmpfs', d, '--remount-ro', d);
    else args.push('--ro-bind', '/dev/null', d);
  }
  return args;
}

/** Generated `/etc` files: one task user, loopback names, the sandbox resolver. */
export async function writeEtc(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const shell = '/bin/sh';
  const files: Record<string, string> = {
    passwd: `root:x:0:0:root:/root:/bin/sh\ntask:x:${SANDBOX_UID}:${SANDBOX_UID}:Whombat task:${SANDBOX_HOME}:${shell}\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n`,
    group: `root:x:0:\ntask:x:${SANDBOX_UID}:\nnogroup:x:65534:\n`,
    hosts: '127.0.0.1 localhost\n::1 localhost ip6-localhost ip6-loopback\n',
    'resolv.conf': 'nameserver 127.0.0.1\noptions attempts:2 timeout:3\n',
    'nsswitch.conf':
      'passwd: files\ngroup: files\nshadow: files\nhosts: files dns\nnetworks: files\nprotocols: files\nservices: files\n',
  };
  for (const [name, content] of Object.entries(files))
    await writeFile(join(dir, name), content, { mode: 0o644 });
}

/**
 * What a managed task's environment may carry (MSB-18): an **allowlist** — nothing is inherited because it happens
 * to be in the runner's or the provider's environment. Credentials come only from the credential owner's home
 * (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`, mounted), never from a variable; the per-dispatch MCP token is the one
 * secret a task gets. Everything else below is configuration.
 */
const ALLOWED_ENV = new Set([
  'PATH',
  'LANG',
  'LANGUAGE',
  'TERM',
  'COLORTERM',
  'TZ',
  'NO_COLOR',
  'FORCE_COLOR',
  'CI',
  'RUST_LOG',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  // The per-dispatch MCP bearer token (the provider's MCP client reads it; scoped to this dispatch).
  'WHOMBAT_MCP_TOKEN',
  // The agent's commit identity, and its workspace repo in direct mode (a worktree's `.git` file names it otherwise).
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_TERMINAL_PROMPT',
  'GIT_CONFIG_COUNT',
  // gh without a login.
  'GH_CONFIG_DIR',
  'GH_PROMPT_DISABLED',
  'GH_NO_UPDATE_NOTIFIER',
  // The credential owner's home (the only login).
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  // Provider behaviour switches (no credentials). Not CLAUDE_CODE_ENTRYPOINT: Claude Code names its own entrypoint,
  // and a value inherited from whatever started Whombat would mislabel every request.
  'DISABLE_AUTOUPDATER',
  'DISABLE_TELEMETRY',
  'DISABLE_ERROR_REPORTING',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'API_TIMEOUT_MS',
]);
const ALLOWED_ENV_PATTERN = /^(LC_[A-Z]+|GIT_CONFIG_(KEY|VALUE)_\d+)$/;
/** The git settings the runner itself sets through `GIT_CONFIG_*` (agentEnvExtras); nothing else rides there. */
const ALLOWED_GIT_CONFIG = new Set(['credential.helper', 'gc.auto', 'maintenance.auto']);
/** Names that look like a secret are never passed, whatever allows them (`passEnv` included). */
const SECRET_NAME =
  /(TOKEN|SECRET|PASSW|API_?KEY|ACCESS_?KEY|PRIVATE|CREDENTIAL|AUTH|SESSION|COOKIE|BEARER|SIGNATURE|CERT_?KEY)/i;
/** Provider and cloud login families, denied as a whole (endpoints and routing included: no other login path). */
const LOGIN_FAMILY =
  /^(ANTHROPIC_|OPENAI_|AZURE_|AWS_|GOOGLE_|GCLOUD_|GCP_|CLOUDSDK_|VERTEX_|CLOUD_ML_|GITHUB_|GH_(?!CONFIG_DIR$|PROMPT_DISABLED$|NO_UPDATE_NOTIFIER$)|CODEX_(?!HOME$)|CLAUDE_CODE_USE_|HF_|HUGGING|NPM_|YARN_|PIP_|TWINE_|DOCKER_|KUBE|VAULT_|DATABASE_|PG|MYSQL|REDIS|SMTP_|RUNNER_|WHOMBAT_(?!MCP_TOKEN$)|SSH_|DBUS_|XDG_RUNTIME_DIR$|DISPLAY$|WAYLAND_DISPLAY$|KRB5|GNOME_KEYRING|GPG_AGENT|DOCKER_HOST$|CONTAINER_HOST$)/;

/** Whether `key` may reach a managed task (`pass`: extra names the operator or a test listed; secrets never). */
export function managedEnvAllowed(key: string, pass: ReadonlySet<string> = new Set()): boolean {
  if (key === 'WHOMBAT_MCP_TOKEN') return true;
  if (SECRET_NAME.test(key) || LOGIN_FAMILY.test(key)) return false;
  return ALLOWED_ENV.has(key) || ALLOWED_ENV_PATTERN.test(key) || pass.has(key);
}

/** The payload's environment: the allowlisted part of the provider's, re-pointed at the sandbox's home, tmp, proxy and PATH. */
export function sandboxEnv(
  env: NodeJS.ProcessEnv,
  mountedPath: (dir: string) => boolean,
  pass: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || !managedEnvAllowed(k, pass)) continue;
    out[k] = v;
  }
  // `GIT_CONFIG_*`: only the runner's own settings, with their index intact; anything else drops the lot.
  const count = Number(out.GIT_CONFIG_COUNT ?? 0);
  const gitKeys = Object.keys(out).filter((k) => /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k));
  const ok =
    Number.isInteger(count) &&
    count >= 0 &&
    count <= 8 &&
    Array.from({ length: count }, (_, i) => out[`GIT_CONFIG_KEY_${i}`]).every(
      (k) => k !== undefined && ALLOWED_GIT_CONFIG.has(k),
    ) &&
    gitKeys.every((k) => Number(k.split('_').pop()) < count);
  if (!ok) {
    delete out.GIT_CONFIG_COUNT;
    for (const k of gitKeys) delete out[k];
  }
  const proxy = `http://127.0.0.1:${SANDBOX_PORTS.proxy}`;
  Object.assign(out, {
    HOME: SANDBOX_HOME,
    USER: 'task',
    LOGNAME: 'task',
    TMPDIR: '/tmp',
    TMP: '/tmp',
    TEMP: '/tmp',
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    ALL_PROXY: proxy,
    all_proxy: proxy,
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
    NODE_USE_ENV_PROXY: '1',
  });
  const path = (env.PATH ?? '').split(':').filter((d) => isAbsolute(d) && mountedPath(d));
  out.PATH = [...new Set([...path, '/usr/local/bin', '/usr/bin', '/bin'])].join(':');
  for (const key of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
    const v = out[key];
    if (v && !mountedPath(v)) delete out[key];
  }
  return out;
}

async function runBwrap(
  bwrap: string,
  args: string[],
  timeoutMs = 15_000,
): Promise<{ code: number | null; err: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(bwrap, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
    let err = '';
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolvePromise({ code: null, err: e.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, err });
    });
  });
}

export class ManagedSandbox {
  readonly config: ManagedSandboxConfig;
  readonly limits: SandboxLimits;
  #probe: Promise<{ ok: boolean; detail: string }> | null = null;

  constructor(config: ManagedSandboxConfig) {
    this.config = config;
    this.limits = { ...DEFAULT_SANDBOX_LIMITS, ...config.limits };
  }

  get node(): string {
    return this.config.node ?? process.execPath;
  }

  /**
   * Can this host enforce the boundary? bubblewrap present, unprivileged user namespaces, a nested sandbox
   * (the providers' own), the seccomp filter for this architecture, and task cgroups. Cached.
   */
  probe(): Promise<{ ok: boolean; detail: string }> {
    this.#probe ??= (async () => {
      const bwrap = this.config.bwrap;
      if (!isAbsolute(bwrap) || !existsSync(bwrap))
        return { ok: false, detail: `bubblewrap is not installed at ${bwrap}` };
      if (!hostSeccompArch()) return { ok: false, detail: `no seccomp filter for ${process.arch}` };
      if (!existsSync(this.node)) return { ok: false, detail: `node is missing at ${this.node}` };
      const base = ['--die-with-parent', '--new-session'];
      for (const p of SYSTEM_PATHS)
        if (exists(p))
          base.push(
            ...(lstatSync(p).isSymbolicLink() ? ['--symlink', readlinkSync(p), p] : ['--ro-bind', p, p]),
          );
      base.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
      const outer = [
        '--unshare-user',
        '--unshare-net',
        '--unshare-pid',
        '--uid',
        '0',
        '--gid',
        '0',
        '--cap-add',
        'ALL',
        ...base,
        ...(within(bwrap, '/usr') ? [] : ['--ro-bind', dirname(bwrap), dirname(bwrap)]),
        '--',
        bwrap,
        '--unshare-user',
        '--unshare-pid',
        '--uid',
        String(SANDBOX_UID),
        '--gid',
        String(SANDBOX_UID),
        '--cap-drop',
        'ALL',
        ...base,
        '--',
        '/bin/sh',
        '-c',
        'true',
      ];
      const r = await runBwrap(bwrap, outer);
      if (r.code !== 0)
        return {
          ok: false,
          detail: `bubblewrap cannot build a nested sandbox here (${r.err.trim().split('\n').pop() || `exit ${r.code}`}); unprivileged user namespaces may be off`,
        };
      const cg = await this.config.cgroups.probe();
      if (!cg.ok) return { ok: false, detail: `no task cgroups: ${cg.detail}` };
      return { ok: true, detail: `bubblewrap ${bwrap} (nested), seccomp ${process.arch}, ${cg.detail}` };
    })();
    return this.#probe;
  }

  /** Forget the cached probe (tests; a host that gained bubblewrap). */
  resetProbe(): void {
    this.#probe = null;
  }

  /** Prepares one task: its cgroup, its egress service and control files. Throws `SandboxUnavailable`. */
  async open(task: SandboxTask): Promise<SandboxSession> {
    const probe = await this.probe();
    if (!probe.ok) throw new SandboxUnavailable(probe.detail);
    const limits = { ...this.limits, ...(task.pod ? DEFAULT_POD_LIMITS : {}), ...task.limits };
    const name = cgroupName(this.config.prefix, task.id);
    const control = join(this.config.stateDir, name);
    await rm(control, { recursive: true, force: true });
    await mkdir(control, { recursive: true, mode: 0o700 });
    await chmod(this.config.stateDir, 0o700).catch(() => {});
    const etcDir = join(control, 'etc');
    await writeEtc(etcDir);
    const seccompFile = join(control, 'seccomp.bpf');
    await writeFile(seccompFile, seccompFilter(hostSeccompArch() as 'x64' | 'arm64'), { mode: 0o600 });
    let egress: EgressService | null = null;
    let cgroup: TaskCgroup | null = null;
    try {
      egress = await startEgress({
        dir: join(control, 'net'),
        policy: task.egress,
        ...(task.mcpUrl ? { mcp: task.mcpUrl } : {}),
        ...(task.onEgress ? { onEvent: task.onEgress } : {}),
        ...this.config.egress,
      });
      cgroup = await this.config.cgroups.create(
        task.id,
        limits,
        task.commands ? { commands: commandsLimits(limits, task.commands.limits) } : {},
      );
    } catch (err) {
      await egress?.close().catch(() => {});
      await rm(control, { recursive: true, force: true });
      throw err;
    }
    return new Session(this, task, { name, control, etcDir, seccompFile, egress, cgroup, limits });
  }

  /**
   * Kills what earlier runner generations left behind (their task cgroups, or whole generation scopes) and
   * returns their names. Called once at start, before the first claim.
   */
  async killOrphans(): Promise<string[]> {
    const found = await this.config.cgroups.orphans(this.config.prefix);
    for (const c of found) await this.config.cgroups.destroy(c);
    return found.map((c) => c.name);
  }

  /** Kills every task of this generation and releases the cgroup root (runner shutdown). */
  async shutdown(): Promise<void> {
    await this.config.cgroups.close();
  }
}

interface SessionState {
  name: string;
  control: string;
  etcDir: string;
  seccompFile: string;
  egress: EgressService;
  cgroup: TaskCgroup;
  limits: SandboxLimits;
}

class Session implements SandboxSession {
  readonly id: string;
  readonly mcpUrl: string | undefined;
  readonly #sandbox: ManagedSandbox;
  readonly #task: SandboxTask;
  readonly #s: SessionState;
  readonly #violations = new Set<SandboxViolation>();
  readonly #children: ChildProcessWithoutNullStreams[] = [];
  #closing: Promise<void> | null = null;
  #spawned = 0;

  constructor(sandbox: ManagedSandbox, task: SandboxTask, s: SessionState) {
    this.#sandbox = sandbox;
    this.#task = task;
    this.#s = s;
    this.id = task.id;
    if (task.mcpUrl) {
      const u = new URL(task.mcpUrl);
      this.mcpUrl = `http://127.0.0.1:${SANDBOX_PORTS.mcp}${u.pathname}${u.search}`;
    } else this.mcpUrl = undefined;
  }

  spawn(
    command: string,
    args: readonly string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv },
  ): ChildProcessWithoutNullStreams {
    if (this.#closing) throw new Error('The sandbox is closed.');
    const config = this.#sandbox.config;
    const bwrap = config.bwrap;
    const nodeDir = nodeInstall(this.#sandbox.node);
    const env = options.env ?? {};
    const resolved = resolveCommand(command, env.PATH);
    const installs = [...(this.#task.installs ?? []), ...(resolved?.installs ?? [])];
    const task = { ...this.#task, installs };
    const commands = this.#task.commands;
    const commandsCgroup = commands ? this.#s.cgroup.commands() : null;
    const plan = (etcDir: string) =>
      mountArgs(task, config, {
        etcDir,
        limits: this.#s.limits,
        nodeDir,
        bwrap,
        ...(resolved ? { links: resolved.links } : {}),
        ...(commands ? { proxySocket: commands.proxy ?? this.#s.egress.proxySocket, commandsCgroup } : {}),
      });
    const cwd = options.cwd ?? this.#task.cwd;
    const mountedRoots = [
      ...SYSTEM_PATHS,
      nodeDir,
      dirname(bwrap),
      ...installs,
      ...(config.readOnlyPaths ?? []),
      this.#task.cwd,
    ].map((p) => normalize(p));
    const payloadEnv = sandboxEnv(
      env,
      (dir) => mountedRoots.some((r) => within(normalize(dir), r)),
      new Set(config.passEnv ?? []),
    );
    // The pinned Node first: `#!/usr/bin/env node` scripts (Codex's launcher) find it, not a host shim.
    payloadEnv.PATH = [
      ...(this.#task.path ?? []),
      join(nodeDir, 'bin'),
      ...(payloadEnv.PATH ?? '').split(':'),
    ]
      .filter((d, i, a) => d && a.indexOf(d) === i)
      .join(':');
    // The provider's own variables (a Hermes profile's `HERMES_HOME`, the commands' settings), set here like the logins
    // socket below: the runner's values, past the allowlist, but never a name that looks like a secret.
    for (const [key, value] of Object.entries(this.#task.env ?? {}))
      if (!SECRET_NAME.test(key)) payloadEnv[key] = value;
    // The logins service as Hermes's credential vault finds it (HE-S141).
    if (this.#task.logins) payloadEnv.WHOMBAT_LOGINS_SOCKET = SANDBOX_LOGINS_SOCKET;
    // How `whombat-command` reaches the runner and puts a command in its wrapper (OP-07).
    if (commands) {
      payloadEnv.WHOMBAT_COMMANDS_SOCKET = SANDBOX_COMMANDS_SOCKET;
      payloadEnv.WHOMBAT_COMMANDS_BWRAP = bwrap;
      payloadEnv.WHOMBAT_COMMANDS_NODE = this.#sandbox.node;
      if (config.nsenter) payloadEnv.WHOMBAT_COMMANDS_NSENTER = config.nsenter;
      if (commandsCgroup) payloadEnv.WHOMBAT_COMMANDS_CGROUP = commandsCgroup;
    }
    const n = this.#spawned++;
    // With commands, no cgroup namespace of its own: a command moves from `<task>/main` to `<task>/commands/run/c-…`,
    // which a namespace rooted at `main` would hide (`nsdelegate`).
    const cgroupNs = commands ? [] : ['--unshare-cgroup-try'];
    const stage2 = [
      '--unshare-user',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      ...cgroupNs,
      '--die-with-parent',
      '--new-session',
      '--hostname',
      'whombat-task',
      '--uid',
      String(SANDBOX_UID),
      '--gid',
      String(SANDBOX_UID),
      '--cap-drop',
      'ALL',
      '--seccomp',
      '3',
      ...plan('/etc'),
      // The sandbox's own root (where bubblewrap made the mount points) is read-only too: only the mounts
      // are writable, and only those marked so.
      '--remount-ro',
      '/',
      '--chdir',
      cwd,
      '--',
      resolved?.path ?? command,
      ...args,
    ];
    const stage1Config = join(this.#s.control, `stage1-${n}.json`);
    const shimConfig = {
      proxyPort: SANDBOX_PORTS.proxy,
      mcpPort: SANDBOX_PORTS.mcp,
      proxySocket: this.#s.egress.proxySocket,
      dnsSocket: this.#s.egress.dnsSocket,
      mcpSocket: this.#s.egress.mcpSocket,
      gatewayPort: SANDBOX_PORTS.gateway,
      gatewaySocket: this.#task.gateway?.socket ?? null,
      browserPort: SANDBOX_PORTS.browser,
      browserSocket: this.#task.browser?.socket ?? null,
      seccompFile: this.#s.seccompFile,
      bwrap,
      stage2,
      env: payloadEnv,
    };
    // Written synchronously: the providers' spawn hooks are synchronous.
    writeFileSync(stage1Config, JSON.stringify(shimConfig), { mode: 0o600 });
    const stage1 = [
      '--unshare-user',
      '--unshare-net',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      ...cgroupNs,
      '--die-with-parent',
      '--new-session',
      '--hostname',
      'whombat-task',
      '--uid',
      '0',
      '--gid',
      '0',
      '--cap-add',
      'ALL',
      ...plan(this.#s.etcDir),
      '--ro-bind',
      this.#s.control,
      this.#s.control,
      '--ro-bind',
      dirname(SHIM_PATH),
      dirname(SHIM_PATH),
      // The commands' service and proxy (OP-07): stage 2 binds their socket files from stage 1's view.
      ...(commands
        ? [
            '--ro-bind',
            dirname(commands.socket),
            dirname(commands.socket),
            ...(commands.proxy ? ['--ro-bind', dirname(commands.proxy), dirname(commands.proxy)] : []),
          ]
        : []),
      // The AI gateway forwarder's socket (AIG-08): stage 1 bridges it; stage 2 never sees it, not even the socket file.
      ...(this.#task.gateway
        ? ['--ro-bind', dirname(this.#task.gateway.socket), dirname(this.#task.gateway.socket)]
        : []),
      // The browser's CDP relay (HE-S137): the same, bridged by stage 1 only.
      ...(this.#task.browser
        ? ['--ro-bind', dirname(this.#task.browser.socket), dirname(this.#task.browser.socket)]
        : []),
      // The logins service (HE-S141): stage 2 binds its socket file from stage 1's view.
      ...(this.#task.logins
        ? ['--ro-bind', dirname(this.#task.logins.socket), dirname(this.#task.logins.socket)]
        : []),
      '--remount-ro',
      '/',
      '--chdir',
      '/',
      '--',
      this.#sandbox.node,
      SHIM_PATH,
      stage1Config,
    ];
    const wrapped = this.#s.cgroup.wrap(bwrap, stage1);
    const hostEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    // systemd-run --user talks to the user manager.
    for (const key of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'])
      if (process.env[key]) hostEnv[key] = process.env[key];
    const child = spawn(wrapped.command, wrapped.args, {
      cwd: '/',
      env: hostEnv,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#children.push(child);
    if (child.pid !== undefined) {
      this.#s.cgroup.attached(child.pid).catch(() => {
        // Never let a task run outside its cgroup.
        child.kill('SIGKILL');
      });
    }
    // A pod's output is its log for as long as it lives (HN-W01): no limit on it.
    if (this.#task.pod) return child;
    let bytes = 0;
    const count = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > this.#s.limits.outputBytes && !this.#violations.has('output_limit')) {
        this.#violations.add('output_limit');
        void this.kill();
      }
    };
    child.stdout.on('data', count);
    child.stderr.on('data', count);
    return child;
  }

  async kill(): Promise<void> {
    await this.#s.cgroup.kill().catch(() => {});
    for (const c of this.#children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      const stats = await this.#s.cgroup.stats().catch(() => null);
      if (stats?.oomKills) this.#violations.add('memory_limit');
      if (stats?.pidsMaxHits) this.#violations.add('pids_limit');
      this.#finalStats = stats;
      await this.kill();
      await this.#s.cgroup.remove().catch(() => {});
      await this.#s.egress.close().catch(() => {});
      await rm(this.#s.control, { recursive: true, force: true });
    })();
    return this.#closing;
  }

  #finalStats: CgroupStats | null = null;

  async violations(): Promise<SandboxViolation[]> {
    if (!this.#closing) {
      const stats = await this.#s.cgroup.stats().catch(() => null);
      if (stats?.oomKills) this.#violations.add('memory_limit');
      if (stats?.pidsMaxHits) this.#violations.add('pids_limit');
    }
    return [...this.#violations];
  }

  async stats(): Promise<CgroupStats | null> {
    if (this.#closing) return this.#finalStats;
    return this.#s.cgroup.stats().catch(() => null);
  }

  egressEvents(): readonly EgressEvent[] {
    return this.#s.egress.events;
  }

  setEgress(policy: EgressPolicy): void {
    this.#s.egress.setPolicy(policy);
  }

  cgroupPath(): string {
    return this.#s.cgroup.path();
  }

  commandsCgroup(): string | null {
    return this.#task.commands ? this.#s.cgroup.commands() : null;
  }
}

/**
 * The commands' share of a task's limits (one-person.md OP-S108): its memory but a reserve for the payload (a quarter,
 * at most 1 GiB), its pids but a quarter, unless the task says.
 */
export function commandsLimits(task: TaskLimits, own: Partial<TaskLimits> = {}): TaskLimits {
  const reserve = Math.min(1024 ** 3, Math.floor(task.memoryBytes / 4));
  return {
    memoryBytes: own.memoryBytes ?? task.memoryBytes - reserve,
    pids: own.pids ?? Math.max(64, task.pids - Math.floor(task.pids / 4)),
    cpuWeight: own.cpuWeight ?? task.cpuWeight,
  };
}
