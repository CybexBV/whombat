// Fake terminal for shell / tty / serial consoles in fixture mode. Pure and
// synchronous: feed it the bytes the browser typed (as a string), get back
// what the "guest" prints plus session effects (close, drop, error). The
// WebSocket side lives in console.ts.

import type { GuestKind, Platform } from '../../src/api/types.ts';

export type TextProtocol = 'shell' | 'tty' | 'serial';

export interface ShellTarget {
  name: string;
  image: string;
  platform: Platform;
  kind: GuestKind;
  /** Guest uptime when the session starts (s). */
  uptimeS: number | null;
}

export type ShellEffect =
  | { type: 'output'; data: string }
  | { type: 'close'; reason: string }
  | { type: 'drop' }
  | { type: 'error'; code: string; message: string };

export interface ShellOptions {
  target: ShellTarget;
  protocol: TextProtocol;
  /** Fixture clock in ms (date, uptime). */
  clock: () => number;
  /** Real clock in ms (uptime advances while connected). */
  now?: () => number;
  cols?: number;
  rows?: number;
}

const GREEN = '\x1b[32m';
const BLUE = '\x1b[1;34m';
const DIM = '\x1b[90m';
const RESET = '\x1b[0m';
const NL = '\r\n';

export type Os = 'nixos' | 'debian' | 'ubuntu' | 'alpine' | 'opnsense' | 'haos';

const OS_RELEASE: Record<Os, string> = {
  nixos: [
    'ANSI_COLOR="0;38;2;126;186;228"', 'BUG_REPORT_URL="https://github.com/NixOS/nixpkgs/issues"', 'BUILD_ID="26.05.20261008.3f1c2a7"',
    'DOCUMENTATION_URL="https://nixos.org/learn.html"', 'HOME_URL="https://nixos.org/"', 'ID=nixos', 'LOGO="nix-snowflake"', 'NAME=NixOS',
    'PRETTY_NAME="NixOS 26.05 (Yarara)"', 'VERSION="26.05 (Yarara)"', 'VERSION_CODENAME=yarara', 'VERSION_ID="26.05"',
  ].join('\n'),
  debian: [
    'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"', 'NAME="Debian GNU/Linux"', 'VERSION_ID="13"', 'VERSION="13 (trixie)"', 'VERSION_CODENAME=trixie',
    'DEBIAN_VERSION_FULL=13.1', 'ID=debian', 'HOME_URL="https://www.debian.org/"', 'SUPPORT_URL="https://www.debian.org/support"', 'BUG_REPORT_URL="https://bugs.debian.org/"',
  ].join('\n'),
  ubuntu: [
    'PRETTY_NAME="Ubuntu 24.04.3 LTS"', 'NAME="Ubuntu"', 'VERSION_ID="24.04"', 'VERSION="24.04.3 LTS (Noble Numbat)"', 'VERSION_CODENAME=noble', 'ID=ubuntu',
    'ID_LIKE=debian', 'HOME_URL="https://www.ubuntu.com/"', 'SUPPORT_URL="https://help.ubuntu.com/"', 'BUG_REPORT_URL="https://bugs.launchpad.net/ubuntu/"', 'UBUNTU_CODENAME=noble',
  ].join('\n'),
  alpine: [
    'NAME="Alpine Linux"', 'ID=alpine', 'VERSION_ID=3.22.1', 'PRETTY_NAME="Alpine Linux v3.22"', 'HOME_URL="https://alpinelinux.org/"',
    'BUG_REPORT_URL="https://gitlab.alpinelinux.org/alpine/aports/-/issues"',
  ].join('\n'),
  opnsense: [
    'NAME=FreeBSD', 'VERSION="14.3-RELEASE-p2"', 'VERSION_ID="14.3"', 'ID=freebsd', 'ANSI_COLOR="0;31"', 'PRETTY_NAME="FreeBSD 14.3-RELEASE-p2"',
    'CPE_NAME="cpe:/o:freebsd:freebsd:14.3"', 'HOME_URL="https://FreeBSD.org/"', 'BUG_REPORT_URL="https://bugs.FreeBSD.org/"',
  ].join('\n'),
  haos: [
    'NAME="Home Assistant OS"', 'VERSION="15.2"', 'ID=haos', 'VERSION_ID=15.2', 'PRETTY_NAME="Home Assistant OS 15.2"', 'HOME_URL=https://hass.io/',
    'VARIANT="Home Assistant generic-x86-64"', 'VARIANT_ID=generic-x86-64',
  ].join('\n'),
};

/** Guest OS family from its image / name (drives prompts, banners and thumbnails). */
export function detectOs(t: Pick<ShellTarget, 'image' | 'name'>): Os {
  const s = `${t.image} ${t.name}`.toLowerCase();
  if (s.includes('nixos')) return 'nixos';
  if (s.includes('ubuntu')) return 'ubuntu';
  if (s.includes('alpine')) return 'alpine';
  if (s.includes('freebsd') || s.includes('opnsense')) return 'opnsense';
  if (s.includes('home assistant') || s.includes('haos')) return 'haos';
  return 'debian';
}

function kernelOf(os: Os, t: ShellTarget): string {
  if (os === 'opnsense') return '14.3-RELEASE-p2';
  if (os === 'haos') return '6.12.40-haos';
  // Containers share the host's kernel (Incus on basalt, LXC on the Proxmox node).
  if (t.kind === 'container') return t.platform === 'pve' ? '6.14.11-2-pve' : '6.18.44';
  if (os === 'nixos') return '6.12.48';
  if (os === 'ubuntu') return '6.8.0-85-generic';
  return '6.12.43+deb13-amd64';
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n: number): string => String(n).padStart(2, '0');
const hms = (d: Date): string => `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;

/** GNU `date` default format in UTC: "Sun Oct 11 14:00:00 UTC 2026". */
export function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${hms(d)} UTC ${d.getUTCFullYear()}`;
}

/** Split a command line into words (single and double quotes). */
export function splitWords(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** A tiny read-only file tree for ls / cd / cat ("name/" = directory). */
function fileTree(os: Os, name: string, user: string): Record<string, string[]> {
  const tree: Record<string, string[]> = {
    '/': ['bin/', 'boot/', 'dev/', 'etc/', 'home/', 'lib/', 'media/', 'mnt/', 'opt/', 'proc/', 'root/', 'run/', 'sbin/', 'srv/', 'sys/', 'tmp/', 'usr/', 'var/'],
    '/root': ['backup.sh', 'notes.txt'],
    '/home': user === 'root' ? [] : [`${user}/`],
    '/etc': ['hostname', 'hosts', 'os-release', 'passwd', 'resolv.conf', 'ssh/', 'systemd/'],
    '/srv': [],
    '/tmp': [],
    '/var': ['cache/', 'lib/', 'log/', 'tmp/'],
  };
  if (user !== 'root') tree[`/home/${user}`] = ['notes.md', 'src/'];
  if (os === 'nixos') {
    tree['/'] = ['bin/', 'boot/', 'dev/', 'etc/', 'home/', 'nix/', 'proc/', 'root/', 'run/', 'srv/', 'sys/', 'tmp/', 'usr/', 'var/'];
    tree[`/home/${user}/src`] = ['dotfiles/', 'fleet-agent/'];
    tree[`/home/${user}/src/fleet-agent`] = ['Cargo.lock', 'Cargo.toml', 'README.md', 'flake.lock', 'flake.nix', 'src/', 'target/', 'tests/'];
    tree[`/home/${user}/src/fleet-agent/src`] = ['collector/', 'config.rs', 'main.rs', 'transport.rs'];
  }
  if (name === 'git-mirror') {
    tree['/srv'] = ['git/'];
    tree['/srv/git'] = ['agent.git/', 'infra.git/', 'dotfiles.git/', 'docs.git/'];
  }
  return tree;
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const p of path.split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') parts.pop();
    else parts.push(p);
  }
  return '/' + parts.join('/');
}

type Mode = 'login' | 'password' | 'shell' | 'closed';

export class FakeShell {
  cols: number;
  rows: number;
  readonly os: Os;
  readonly hostname: string;
  private readonly kernel: string;
  private readonly tty: string;
  private readonly opts: ShellOptions;
  private readonly startReal: number;
  private mode: Mode;
  private user: string;
  private cwd: string;
  private line = '';
  /** Escape sequence parser: 0 none, 1 after ESC, 2 CSI, 3 SS3, 4 OSC, 5 OSC after ESC. */
  private esc = 0;
  private lastCR = false;
  private buf = '';
  private effects: ShellEffect[] = [];

  constructor(opts: ShellOptions) {
    this.opts = opts;
    this.cols = opts.cols ?? 80;
    this.rows = opts.rows ?? 24;
    this.os = detectOs(opts.target);
    this.hostname = this.os === 'haos' ? 'homeassistant' : opts.target.name;
    this.kernel = kernelOf(this.os, opts.target);
    this.tty = opts.protocol === 'serial' ? (this.os === 'opnsense' ? 'ttyu0' : 'ttyS0') : 'console';
    this.startReal = (opts.now ?? Date.now)();
    this.mode = opts.protocol === 'shell' ? 'shell' : 'login';
    this.user = opts.protocol === 'shell' && this.os === 'nixos' ? 'jdoe' : 'root';
    this.cwd = this.home();
    if (opts.protocol === 'shell' && this.os === 'nixos') this.cwd = `/home/${this.user}/src/fleet-agent`;
  }

  get isClosed(): boolean {
    return this.mode === 'closed';
  }

  /** What the console shows right after connecting. */
  start(): ShellEffect[] {
    if (this.opts.protocol === 'shell') {
      const t = this.opts.target;
      const label = t.platform === 'pve' ? 'Proxmox LXC' : t.platform === 'incus' ? `Incus ${t.kind === 'vm' ? 'VM' : 'container'}` : t.platform;
      this.out(`${DIM}rackoon fixture shell · ${t.name} (${label}) · type "help" for commands${RESET}${NL}`);
      this.out(this.prompt());
    } else {
      this.out(this.issue() + NL + NL + this.loginPrompt());
    }
    return this.take();
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  /** Process typed or pasted input; returns output and session effects in order. */
  input(text: string): ShellEffect[] {
    for (const ch of text) {
      if (this.mode === 'closed') break;
      if (this.esc) {
        this.escape(ch);
        continue;
      }
      let c = ch;
      if (c === '\n') {
        // "\r\n" from a paste is one Enter.
        if (this.lastCR) {
          this.lastCR = false;
          continue;
        }
        c = '\r';
      }
      this.lastCR = c === '\r';
      switch (c) {
        case '\x1b':
          this.esc = 1;
          break;
        case '\r':
          this.enter();
          break;
        case '\x7f':
        case '\b':
          if (this.line) {
            const chars = [...this.line];
            chars.pop();
            this.line = chars.join('');
            if (this.mode !== 'password') this.out('\b \b');
          }
          break;
        case '\x03': // Ctrl+C
          this.line = '';
          if (this.mode === 'shell') this.out(`^C${NL}${this.prompt()}`);
          else {
            this.mode = 'login';
            this.out(`^C${NL}${NL}${this.loginPrompt()}`);
          }
          break;
        case '\x04': // Ctrl+D: logout on an empty line
          if (this.mode === 'shell' && !this.line) this.logout();
          break;
        case '\x0c': // Ctrl+L
          if (this.mode === 'shell') this.out(`\x1b[H\x1b[2J${this.prompt()}${this.line}`);
          break;
        case '\x15': // Ctrl+U
          if (this.mode !== 'password') this.out('\b \b'.repeat([...this.line].length));
          this.line = '';
          break;
        default:
          // Tab and other control characters are ignored.
          if (c.charCodeAt(0) < 0x20) break;
          this.line += c;
          if (this.mode !== 'password') this.out(c);
      }
    }
    return this.take();
  }

  // ---- internals

  private out(s: string): void {
    this.buf += s;
  }

  private effect(e: ShellEffect): void {
    if (this.buf) this.effects.push({ type: 'output', data: this.buf });
    this.buf = '';
    this.effects.push(e);
  }

  private take(): ShellEffect[] {
    if (this.buf) this.effects.push({ type: 'output', data: this.buf });
    this.buf = '';
    const e = this.effects;
    this.effects = [];
    return e;
  }

  private escape(ch: string): void {
    const code = ch.charCodeAt(0);
    switch (this.esc) {
      case 1:
        this.esc = ch === '[' ? 2 : ch === 'O' ? 3 : ch === ']' ? 4 : 0;
        break;
      case 2:
        if (code >= 0x40 && code <= 0x7e) this.esc = 0;
        break;
      case 3:
        this.esc = 0;
        break;
      case 4:
        if (ch === '\x07') this.esc = 0;
        else if (ch === '\x1b') this.esc = 5;
        break;
      default:
        this.esc = 0;
    }
  }

  private home(user = this.user): string {
    return user === 'root' ? '/root' : `/home/${user}`;
  }

  private display(path: string): string {
    const home = this.home();
    if (path === home) return '~';
    if (path.startsWith(home + '/')) return '~' + path.slice(home.length);
    return path;
  }

  private prompt(): string {
    const sig = this.user === 'root' ? '#' : '$';
    const cwd = this.display(this.cwd);
    switch (this.os) {
      case 'nixos':
        return `${GREEN}[${this.user}@${this.hostname}:${cwd}]${sig}${RESET} `;
      case 'alpine':
        return `${GREEN}${this.hostname}${RESET}:${cwd}${sig} `;
      case 'opnsense':
        return `${GREEN}${this.user}@${this.hostname}${RESET}:${cwd} ${sig} `;
      case 'haos':
        return `${GREEN}ha${RESET} > `;
      default:
        return `${GREEN}${this.user}@${this.hostname}${RESET}:${cwd}${sig} `;
    }
  }

  private issue(): string {
    const h = this.hostname;
    switch (this.os) {
      case 'nixos':
        return `${NL}${DIM}<<< Welcome to NixOS 26.05 (Yarara) - Linux ${this.kernel} (${this.tty}) >>>${RESET}`;
      case 'ubuntu':
        return `Ubuntu 24.04.3 LTS ${h} ${this.tty}`;
      case 'alpine':
        return `Welcome to Alpine Linux 3.22${NL}Kernel ${this.kernel} on an x86_64 (/dev/${this.tty})`;
      case 'opnsense':
        return `FreeBSD/amd64 (${h}.lan) (${this.tty})`;
      case 'haos':
        return 'Home Assistant OS 15.2';
      default:
        return `Debian GNU/Linux 13 ${h} ${this.tty}`;
    }
  }

  private loginPrompt(): string {
    return this.os === 'opnsense' ? 'login: ' : `${this.hostname} login: `;
  }

  private motd(): string {
    const last = new Date(this.opts.clock() - (4 * 3600 + 47 * 60 + 16) * 1000);
    const lastLogin = `${DIM}Last login: ${DAYS[last.getUTCDay()]} ${MONTHS[last.getUTCMonth()]} ${last.getUTCDate()} ${hms(last)} on ${this.tty}${RESET}${NL}`;
    switch (this.os) {
      case 'debian': {
        const build = this.kernel.endsWith('-pve') ? 'PMX 6.14.11-2 (2026-08-29T10:42Z)' : 'Debian 6.12.43-1 (2026-08-27)';
        return `${lastLogin}Linux ${this.hostname} ${this.kernel} #1 SMP PREEMPT_DYNAMIC ${build} x86_64${NL}${NL}`;
      }
      case 'ubuntu':
        return `${lastLogin}Welcome to Ubuntu 24.04.3 LTS (GNU/Linux ${this.kernel} x86_64)${NL}${NL}`;
      case 'alpine':
        return `${lastLogin}Welcome to Alpine!${NL}${NL}`;
      case 'opnsense':
        return `${lastLogin}*** ${this.hostname}.lan: OPNsense 25.7.4 (amd64) ***${NL}${NL}`;
      case 'haos':
        return `${NL}Welcome to Home Assistant${NL}${NL}`;
      default:
        return lastLogin;
    }
  }

  private enter(): void {
    const line = this.line;
    this.line = '';
    this.out(NL);
    if (this.mode === 'login') {
      const user = line.trim().split(/\s+/)[0] ?? '';
      if (!user) {
        this.out(this.loginPrompt());
        return;
      }
      this.user = user;
      this.mode = 'password';
      this.out('Password: ');
      return;
    }
    if (this.mode === 'password') {
      // Any password is accepted.
      this.mode = 'shell';
      this.cwd = this.home();
      this.out(this.motd() + this.prompt());
      return;
    }
    this.run(line);
    if (this.mode === 'shell') this.out(this.prompt());
  }

  private logout(): void {
    this.out(`logout${NL}`);
    this.mode = 'closed';
    this.effect({ type: 'close', reason: 'ended' });
  }

  private resolve(arg: string): string {
    if (arg === '~' || arg.startsWith('~/')) return normalize(this.home() + arg.slice(1));
    return normalize(arg.startsWith('/') ? arg : `${this.cwd}/${arg}`);
  }

  private entry(path: string): 'dir' | 'file' | null {
    const tree = fileTree(this.os, this.opts.target.name, this.user);
    if (tree[path]) return 'dir';
    const slash = path.lastIndexOf('/');
    const parent = tree[path.slice(0, slash) || '/'];
    const base = path.slice(slash + 1);
    if (parent?.includes(`${base}/`)) return 'dir';
    if (parent?.includes(base)) return 'file';
    return null;
  }

  private uptime(): string {
    const now = this.opts.clock();
    const up = (this.opts.target.uptimeS ?? 0) + Math.floor(((this.opts.now ?? Date.now)() - this.startReal) / 1000);
    const days = Math.floor(up / 86400);
    const h = Math.floor((up % 86400) / 3600);
    const m = Math.floor((up % 3600) / 60);
    const clock = h || days ? `${h}:${p2(m)}` : `${m} min`;
    const span = days ? `${days} day${days === 1 ? '' : 's'}, ${clock.padStart(5, ' ')}` : clock;
    return ` ${hms(new Date(now))} up ${span},  1 user,  load average: 0.08, 0.12, 0.10`;
  }

  private uname(flags: string[]): string {
    const bsd = this.os === 'opnsense';
    const sys = bsd ? 'FreeBSD' : 'Linux';
    const machine = bsd ? 'amd64' : 'x86_64';
    if (flags.includes('-a')) {
      return bsd
        ? `FreeBSD ${this.hostname}.lan ${this.kernel} FreeBSD ${this.kernel} stable/25.7-n271034-8c6a5b2f8e2 SMP amd64`
        : `Linux ${this.hostname} ${this.kernel} #1 SMP PREEMPT_DYNAMIC Thu Sep 25 10:12:31 UTC 2026 x86_64${this.os === 'alpine' ? ' Linux' : ' GNU/Linux'}`;
    }
    const parts: string[] = [];
    for (const f of flags) {
      if (f === '-s') parts.push(sys);
      else if (f === '-n') parts.push(this.hostname);
      else if (f === '-r') parts.push(this.kernel);
      else if (f === '-m') parts.push(machine);
    }
    return parts.length ? parts.join(' ') : sys;
  }

  private run(line: string): void {
    const words = splitWords(line);
    const cmd = words[0];
    if (!cmd) return;
    const args = words.slice(1);
    const say = (s: string) => this.out(s.split('\n').join(NL) + NL);
    switch (cmd) {
      case 'help':
        say(
          [
            'Fixture shell commands:',
            '  help  ls [path]  cd [dir]  pwd  whoami  hostname  uname [-a]  uptime  date',
            '  echo [text]  clear  stty size  cat /etc/os-release  exit  logout',
            'Testing:',
            '  simulate-drop    drop the connection without a close message',
            '  simulate-idle    end the session as if it had been idle too long',
            '  simulate-error   send an agent error message',
          ].join('\n'),
        );
        return;
      case 'ls': {
        const target = args.find((a) => !a.startsWith('-'));
        const path = this.resolve(target ?? '.');
        const kind = this.entry(path);
        if (!kind) return say(`ls: cannot access '${target}': No such file or directory`);
        if (kind === 'file') return say(target ?? path);
        const list = fileTree(this.os, this.opts.target.name, this.user)[path] ?? [];
        if (list.length) say(list.map((n) => (n.endsWith('/') ? `${BLUE}${n.slice(0, -1)}${RESET}` : n)).join('  '));
        return;
      }
      case 'cd': {
        const target = args[0];
        if (!target || target === '~') {
          this.cwd = this.home();
          return;
        }
        const path = this.resolve(target);
        const kind = this.entry(path);
        if (kind === 'dir') this.cwd = path;
        else say(`bash: cd: ${target}: ${kind === 'file' ? 'Not a directory' : 'No such file or directory'}`);
        return;
      }
      case 'pwd':
        return say(this.cwd);
      case 'whoami':
        return say(this.user);
      case 'hostname':
        return say(this.hostname);
      case 'uname':
        return say(this.uname(args));
      case 'uptime':
        return say(this.uptime());
      case 'date':
        return say(formatDate(this.opts.clock()));
      case 'echo':
        return say(args.join(' '));
      case 'clear':
        this.out('\x1b[H\x1b[2J');
        return;
      case 'stty':
        if (args[0] === 'size') return say(`${this.rows} ${this.cols}`);
        return say(`speed 38400 baud; rows ${this.rows}; columns ${this.cols}; line = 0;`);
      case 'cat': {
        for (const a of args) {
          const path = this.resolve(a);
          if (path === '/etc/os-release') say(OS_RELEASE[this.os]);
          else if (path === '/etc/hostname') say(this.hostname);
          else say(`cat: ${a}: ${this.entry(path) === 'dir' ? 'Is a directory' : 'No such file or directory'}`);
        }
        return;
      }
      case 'exit':
      case 'logout':
        this.logout();
        return;
      case 'simulate-drop':
        this.mode = 'closed';
        this.effect({ type: 'drop' });
        return;
      case 'simulate-idle':
        this.mode = 'closed';
        this.effect({ type: 'close', reason: 'idle_timeout' });
        return;
      case 'simulate-error':
        this.effect({ type: 'error', code: 'agent_error', message: 'The agent reported an error on this console (simulated by the fixture server).' });
        return;
      default:
        say(`bash: ${cmd}: command not found`);
    }
  }
}
