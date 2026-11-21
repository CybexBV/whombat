import { describe, expect, it } from 'vitest';
import { FakeShell, formatDate, type ShellEffect, type ShellTarget, splitWords, type TextProtocol } from './shell';

const AS_OF = Date.parse('2026-10-11T14:00:00Z');
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
const text = (effects: ShellEffect[]): string => strip(effects.map((e) => (e.type === 'output' ? e.data : '')).join(''));

const DEV_SHELL: ShellTarget = { name: 'dev-shell', image: 'nixos/26.05', platform: 'incus', kind: 'container', uptimeS: 1555200 };
const PIHOLE: ShellTarget = { name: 'pihole', image: 'debian 13', platform: 'pve', kind: 'container', uptimeS: 7603200 };
const CI_RUNNER: ShellTarget = { name: 'ci-runner', image: 'debian/13', platform: 'incus', kind: 'vm', uptimeS: 259200 };

function shell(target: ShellTarget, protocol: TextProtocol = 'shell'): FakeShell {
  return new FakeShell({ target, protocol, clock: () => AS_OF, now: () => 0 });
}

describe('fake shell: prompts and banners', () => {
  it('Incus NixOS container shell', () => {
    const out = text(shell(DEV_SHELL).start());
    expect(out).toContain('dev-shell (Incus container)');
    expect(out.endsWith('[jdoe@dev-shell:~/src/fleet-agent]$ ')).toBe(true);
  });

  it('Proxmox LXC shell prompt in green', () => {
    const effects = shell(PIHOLE).start();
    const raw = effects.map((e) => (e.type === 'output' ? e.data : '')).join('');
    expect(raw.endsWith('\x1b[32mroot@pihole\x1b[0m:~# ')).toBe(true);
  });

  it('serial: issue line, login echoed, password hidden, then a prompt', () => {
    const sh = shell(CI_RUNNER, 'serial');
    expect(text(sh.start())).toBe('Debian GNU/Linux 13 ci-runner ttyS0\r\n\r\nci-runner login: ');
    expect(text(sh.input('root\r'))).toBe('root\r\nPassword: ');
    const after = text(sh.input('s3cret\r'));
    expect(after).not.toContain('s3cret');
    expect(after).toContain('Last login:');
    expect(after.endsWith('root@ci-runner:~# ')).toBe(true);
  });

  it('tty: an empty user name asks again', () => {
    const sh = shell(PIHOLE, 'tty');
    sh.start();
    expect(text(sh.input('\r'))).toBe('\r\npihole login: ');
  });
});

describe('fake shell: line editing', () => {
  it('echoes, erases with Backspace and runs on Enter', () => {
    const sh = shell(PIHOLE);
    sh.start();
    expect(text(sh.input('whox'))).toBe('whox');
    expect(text(sh.input('\x7f'))).toBe('\b \b');
    const out = text(sh.input('ami\r'));
    expect(out).toBe('ami\r\nroot\r\nroot@pihole:~# ');
  });

  it('ignores Tab and escape sequences (arrows, bracketed paste markers)', () => {
    const sh = shell(PIHOLE);
    sh.start();
    expect(text(sh.input('\t\x1b[A\x1b[B\x1bOD\x1b[200~'))).toBe('');
    expect(text(sh.input('host\x1b[1;5Cname\x1b[201~\r'))).toBe('hostname\r\npihole\r\nroot@pihole:~# ');
  });

  it('keeps escape state across chunks', () => {
    const sh = shell(PIHOLE);
    sh.start();
    expect(text(sh.input('\x1b'))).toBe('');
    expect(text(sh.input('[1;'))).toBe('');
    expect(text(sh.input('2Dx'))).toBe('x');
  });

  it('Ctrl+C prints ^C and a fresh prompt', () => {
    const sh = shell(PIHOLE);
    sh.start();
    sh.input('rm -rf');
    expect(text(sh.input('\x03'))).toBe('^C\r\nroot@pihole:~# ');
    expect(text(sh.input('\r'))).toBe('\r\nroot@pihole:~# ');
  });

  it('runs every line of a multi-line paste (\\r\\n counts once)', () => {
    const sh = shell(PIHOLE);
    sh.start();
    const out = text(sh.input('whoami\r\nhostname\npwd\r'));
    expect(out.match(/root@pihole:~# /g)).toHaveLength(3);
    expect(out).toContain('root\r\n');
    expect(out).toContain('pihole\r\n');
    expect(out).toContain('/root\r\n');
  });
});

describe('fake shell: commands', () => {
  const run = (sh: FakeShell, line: string): string => {
    const out = text(sh.input(line + '\r'));
    return out.slice(line.length + 2, out.lastIndexOf('\r\n') + 2);
  };

  it('whoami, hostname, pwd, echo, date, stty size after resize', () => {
    const sh = shell(DEV_SHELL);
    sh.start();
    expect(run(sh, 'whoami')).toBe('jdoe\r\n');
    expect(run(sh, 'hostname')).toBe('dev-shell\r\n');
    expect(run(sh, 'pwd')).toBe('/home/jdoe/src/fleet-agent\r\n');
    expect(run(sh, 'echo "a  b" c')).toBe('a  b c\r\n');
    expect(run(sh, 'date')).toBe('Sun Oct 11 14:00:00 UTC 2026\r\n');
    expect(run(sh, 'stty size')).toBe('24 80\r\n');
    sh.resize(132, 36);
    expect(run(sh, 'stty size')).toBe('36 132\r\n');
  });

  it('uname, uptime, os-release, ls, cd', () => {
    const sh = shell(PIHOLE);
    sh.start();
    expect(run(sh, 'uname -a')).toMatch(/^Linux pihole 6\.14\.11-2-pve .* x86_64 GNU\/Linux\r\n$/);
    expect(run(sh, 'uptime')).toBe(' 14:00:00 up 88 days,  0:00,  1 user,  load average: 0.08, 0.12, 0.10\r\n');
    expect(run(sh, 'cat /etc/os-release')).toContain('PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\r\nNAME=');
    expect(run(sh, 'ls /')).toContain('etc');
    run(sh, 'cd /etc');
    expect(run(sh, 'pwd')).toBe('/etc\r\n');
    expect(run(sh, 'cd /nope')).toBe('bash: cd: /nope: No such file or directory\r\n');
  });

  it('clear and unknown commands', () => {
    const sh = shell(PIHOLE);
    sh.start();
    expect(run(sh, 'clear')).toBe('');
    expect(text(sh.input('clear\r')).startsWith('clear\r\n\x1b[H\x1b[2J')).toBe(true);
    expect(run(sh, 'frobnicate --now')).toBe('bash: frobnicate: command not found\r\n');
  });

  it('Ctrl+D on an empty line logs out and ends the session', () => {
    const sh = shell(PIHOLE);
    sh.start();
    expect(sh.input('ab\x04')).toEqual([{ type: 'output', data: 'ab' }]);
    sh.input('\x03');
    const effects = sh.input('\x04');
    expect(effects).toEqual([
      { type: 'output', data: 'logout\r\n' },
      { type: 'close', reason: 'ended' },
    ]);
    expect(sh.isClosed).toBe(true);
    expect(sh.input('whoami\r')).toEqual([]);
  });

  it('exit / logout end the session; input after it is ignored', () => {
    const sh = shell(DEV_SHELL);
    sh.start();
    const effects = sh.input('exit\rwhoami\r');
    expect(effects.at(-1)).toEqual({ type: 'close', reason: 'ended' });
    expect(text(effects)).toBe('exit\r\nlogout\r\n');
  });

  it('simulate-drop / -idle / -error', () => {
    const a = shell(PIHOLE);
    a.start();
    expect(a.input('simulate-drop\r').at(-1)).toEqual({ type: 'drop' });
    const b = shell(PIHOLE);
    b.start();
    expect(b.input('simulate-idle\r').at(-1)).toEqual({ type: 'close', reason: 'idle_timeout' });
    const c = shell(PIHOLE);
    c.start();
    const effects = c.input('simulate-error\r');
    expect(effects.map((e) => e.type)).toEqual(['output', 'error', 'output']);
    expect(effects[1]).toMatchObject({ type: 'error', code: 'agent_error' });
    expect(c.isClosed).toBe(false);
  });
});

describe('fake shell helpers', () => {
  it('splitWords handles quotes', () => {
    expect(splitWords(`echo 'a b'  "c"  d`)).toEqual(['echo', 'a b', 'c', 'd']);
    expect(splitWords(`echo ""`)).toEqual(['echo', '']);
  });
  it('formatDate pads single-digit days like GNU date', () => {
    expect(formatDate(Date.parse('2026-10-04T09:05:03Z'))).toBe('Sun Oct  4 09:05:03 UTC 2026');
  });
});
