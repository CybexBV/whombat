/**
 * The bubblewrap command lines of the agent's commands (docs/decisions/one-person.md OP-07, OP-S105, OP-S109), kept pure
 * so tests read them. Two kinds, both run inside the pod (or an outsiders' task sandbox), where every path below is at
 * its real path:
 *
 * - The holder (`holderArgs`): one long-lived sandbox per pod with its own user, network, pid, ipc and uts namespaces,
 *   running `commands-net.mjs` (the proxy bridge, the agent's services, the runner's way in). It sees everything a
 *   command may get, so a command can bind it from the holder's mount namespace; its `/proc` is the commands' own.
 * - One command (`commandArgs`): after `nsenter` into the holder's namespaces, a sandbox of its own (mount, ipc and uts
 *   namespaces) with a read-only system, the agent's home at its real path, the commands' `/tmp` (kept between
 *   commands: Hermes's snapshots, a background job's log), what of its turn it may have (the checkout and its git
 *   folders, `~/files` read-only, a step's folder), the profile's `skills/` read-only, the helpers at
 *   `/run/whombat/bin`, the helper, gh and container sockets at `/run/whombat/*.sock`, and the turn's key files on a
 *   tmpfs at `/run/whombat/keys`. Nothing else: no Hermes home, no sign-in, no policy file, none of the pod's sockets.
 */
import { lstatSync, readlinkSync } from 'node:fs';
import { posix } from 'node:path';
import type { KeyFile } from '@whombat/commands';

/** Where things are inside a command's wrapper. */
export const IN = {
  run: '/run/whombat',
  bin: '/run/whombat/bin',
  agentSocket: '/run/whombat/agent.sock',
  gh: '/run/whombat/gh.sock',
  docker: '/run/whombat/docker.sock',
  keys: '/run/whombat/keys',
  /** The commands' proxy socket, in the holder only. */
  proxy: '/run/whombat/net/proxy.sock',
} as const;
/** Where commands reach the proxy (HTTP and CONNECT) inside their network. */
export const PROXY_PORT = 3128;
/** The agent's services (OP-19, I-5): tunnelled from the commands' loopback to this host's. */
export const SERVICE_PORTS = [20000, 20099] as const;
/** The agent's name inside its commands (`/etc/passwd`). */
export const AGENT_USER = 'agent';
/** Every process of a command has this uid inside (the runner's own outside). */
export const COMMAND_UID = 1000;

/** What a sandbox shows read-only when the host has it (links stay links). */
export const SYSTEM_PATHS = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/libx32',
  '/nix/store',
] as const;

export interface Bind {
  src: string;
  dest: string;
  mode: 'ro' | 'rw';
}

type Kind = 'dir' | 'file' | { link: string } | null;

function kindOf(path: string): Kind {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return { link: readlinkSync(path) };
    return st.isDirectory() ? 'dir' : 'file';
  } catch {
    return null;
  }
}

/** The system read-only (or the same links): what the host lacks is left out; NixOS's system profile as its link. */
export function systemArgs(kind: (p: string) => Kind = kindOf): string[] {
  const out: string[] = [];
  for (const path of SYSTEM_PATHS) {
    const k = kind(path);
    if (k === null) continue;
    if (typeof k === 'object') out.push('--symlink', k.link, path);
    else out.push('--ro-bind', path, path);
  }
  const current = kind('/run/current-system');
  if (current && typeof current === 'object') out.push('--symlink', current.link, '/run/current-system');
  return out;
}

const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** Binds as arguments: parents first, so a nested one (read-only inside read-write) lands on top. */
export function bindArgs(binds: readonly Bind[]): string[] {
  const seen = new Map<string, Bind>();
  for (const b of binds) {
    const had = seen.get(b.dest);
    // The same path twice: read-only wins (a control file inside a writable checkout).
    if (!had || b.mode === 'ro') seen.set(b.dest, b);
  }
  return [...seen.values()]
    .sort((a, b) => a.dest.split('/').length - b.dest.split('/').length)
    .flatMap((b) => [b.mode === 'ro' ? '--ro-bind' : '--bind', b.src, b.dest]);
}

export interface HolderPlan {
  /** Everything a command may bind (union of every turn's), at its own path. */
  binds: readonly Bind[];
  /** The pinned Node (absolute) and `commands-net.mjs`. */
  node: string;
  netScript: string;
  /** The proxy socket as the pod sees it (`SANDBOX_PROXY_SOCKET`). */
  proxy: string;
  /** The runner's way in (a socket in the commands' folder). */
  inbound: string;
  /** Tunnel the agent's services (a person's pod only). */
  services: boolean;
}

/** The holder: its namespaces, its view, `commands-net.mjs`. Without `--info-fd` (`commands-host.mjs` adds it). */
export function holderArgs(p: HolderPlan, kind?: (path: string) => Kind): string[] {
  const config = {
    proxy: IN.proxy,
    inbound: p.inbound,
    port: PROXY_PORT,
    services: p.services ? SERVICE_PORTS : null,
  };
  return [
    '--unshare-user',
    '--unshare-net',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--hostname',
    'whombat',
    '--die-with-parent',
    '--new-session',
    ...systemArgs(kind),
    '--ro-bind',
    '/etc',
    '/etc',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    ...bindArgs(p.binds),
    '--dir',
    posix.dirname(IN.proxy),
    '--ro-bind',
    p.proxy,
    IN.proxy,
    '--chdir',
    '/',
    '--',
    p.node,
    p.netScript,
    JSON.stringify(config),
  ];
}

export interface CommandView {
  /** The system's `/etc` entries a command sees (the sandbox's allowlist, as the pod has them). */
  etcNames: readonly string[];
  /** The commands' generated `/etc` files (`etcFiles`), their `/tmp`, the helpers' launchers. */
  etc: string;
  tmp: string;
  bin: string;
  /** What else of the box and the turn it sees, at its own path. */
  binds: readonly Bind[];
  /** The helper socket (`whombat notify`), a person's commands only. */
  agentSocket: string | null;
  /** The turn's gh service. */
  gh: string | null;
  /** The container engine's socket (OP-16), a person's commands only. */
  docker: string | null;
  /** The turn's key files (fd 3 + index). */
  keys: readonly KeyFile[];
  /** With a terminal the command keeps its session (no `--new-session`). */
  tty: boolean;
  cwd: string;
}

/** The `/etc` files every command gets from `etcFiles` (`ssh_config` goes to `/etc/ssh`). */
export const GENERATED_ETC = ['passwd', 'group', 'hosts', 'resolv.conf', 'nsswitch.conf'];

/** A key file's folders under the keys tmpfs, parents first. */
function keyDirs(keys: readonly KeyFile[]): string[] {
  const dirs = new Set<string>();
  for (const k of keys) {
    const parts = k.path.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return [...dirs].sort((a, b) => a.split('/').length - b.split('/').length);
}

/** One command's sandbox, run after `nsenter` into the holder (`commands-host.mjs` adds the `--` and the argv). */
export function commandArgs(v: CommandView, kind?: (path: string) => Kind): string[] {
  const keys: string[] = [];
  if (v.keys.length) {
    keys.push('--perms', '0700', '--tmpfs', IN.keys);
    for (const d of keyDirs(v.keys)) keys.push('--perms', '0700', '--dir', posix.join(IN.keys, d));
    v.keys.forEach((k, i) => {
      keys.push(
        '--perms',
        (k.mode & 0o700).toString(8).padStart(4, '0'),
        '--file',
        String(3 + i),
        posix.join(IN.keys, k.path),
      );
    });
  }
  return [
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--hostname',
    'whombat',
    '--die-with-parent',
    // Without a terminal the command gets no controlling terminal to inject into (TIOCSTI).
    ...(v.tty ? [] : ['--new-session']),
    ...systemArgs(kind),
    '--dir',
    '/etc',
    ...v.etcNames
      .filter((name) => !GENERATED_ETC.includes(name) && name !== 'ssh')
      .flatMap((name) => ['--ro-bind', posix.join('/etc', name), posix.join('/etc', name)]),
    ...GENERATED_ETC.flatMap((name) => ['--ro-bind', posix.join(v.etc, name), posix.join('/etc', name)]),
    '--dir',
    '/etc/ssh',
    '--ro-bind',
    posix.join(v.etc, 'ssh_config'),
    '/etc/ssh/ssh_config',
    // The holder's `/proc`: the commands' pid namespace (never Hermes's).
    '--bind',
    '/proc',
    '/proc',
    '--dev',
    '/dev',
    '--bind',
    v.tmp,
    '/tmp',
    '--dir',
    '/var',
    '--symlink',
    '../tmp',
    '/var/tmp',
    ...bindArgs(v.binds),
    '--dir',
    IN.run,
    '--ro-bind',
    v.bin,
    IN.bin,
    ...(v.agentSocket ? ['--ro-bind', v.agentSocket, IN.agentSocket] : []),
    ...(v.gh ? ['--ro-bind', v.gh, IN.gh] : []),
    ...(v.docker ? ['--ro-bind', v.docker, IN.docker] : []),
    ...keys,
    '--remount-ro',
    '/',
    '--chdir',
    v.cwd,
  ];
}

/**
 * The commands' `/etc` files: the agent as `agent` with its home, loopback names, no resolver of their own (names go
 * through the proxy), and ssh through the proxy with the turn's keys' settings (`/run/whombat/keys/ssh_config`).
 */
export function etcFiles(o: { home: string; shell: string }): Record<string, string> {
  return {
    passwd: [
      'root:x:0:0:root:/root:/bin/sh',
      `${AGENT_USER}:x:${COMMAND_UID}:${COMMAND_UID}:Whombat agent:${o.home}:${o.shell}`,
      'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin',
      '',
    ].join('\n'),
    group: ['root:x:0:', `${AGENT_USER}:x:${COMMAND_UID}:`, 'nogroup:x:65534:', ''].join('\n'),
    hosts: '127.0.0.1 localhost\n::1 localhost ip6-localhost ip6-loopback\n',
    'resolv.conf': 'nameserver 127.0.0.1\noptions attempts:1 timeout:1\n',
    'nsswitch.conf':
      'passwd: files\ngroup: files\nshadow: files\nhosts: files dns\nnetworks: files\nprotocols: files\nservices: files\n',
    ssh_config: [
      `Include ${IN.keys}/ssh_config`,
      '',
      'Host *',
      `  ProxyCommand ${IN.bin}/whombat-connect %h %p`,
      '',
    ].join('\n'),
  };
}

/**
 * A shell script that runs `script` on `node` with its arguments (a helper's launcher in `/run/whombat/bin`). The
 * helpers make their own connections (their sockets, the proxy) and use no HTTP client, so Node starts without
 * `NODE_USE_ENV_PROXY`: with it and the commands' proxy variables Node loads its whole HTTP client stack first, about
 * 15 ms per call (ssh's `whombat-connect`, every `gh`). The command keeps it for its own programs.
 */
export function launcher(node: string, script: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh\nunset NODE_USE_ENV_PROXY\nexec ${q(node)} ${q(script)} "$@"\n`;
}

/** Whether `path` lies inside one of `roots`. */
export function inside(path: string, roots: readonly string[]): boolean {
  return roots.some((r) => within(path, r));
}
