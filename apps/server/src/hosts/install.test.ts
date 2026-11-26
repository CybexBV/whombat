/**
 * The pure parts of Sign in once (server-signin-server.md SI-S04…SI-S07, SI-S12): the installer's lines, failures as
 * SI-11's codes and words, “More detail” without secrets, a level's switches and words, the command that runs the
 * installer, and `server_add`'s arguments, link and card.
 */
import { GuideCard, HOST_INSTALL_DETAIL_MAX } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { installCommand, KEEP_KEY_COMMAND, tailnetSource } from './install';
import {
  agentsPlace,
  hubSwitches,
  installChangeText,
  installDetail,
  installFailureText,
  installProblemOf,
  parseInstallOutput,
  REMOVED,
  systemLine,
} from './install-words';
import { addServerArgs, addServerCard, addServerHref } from './tools';
import { serversAskWords, serversDoneWords } from './words';

describe('the installer’s lines', () => {
  it('reads the result line and the OS line, whatever came around them', () => {
    const out = [
      'Downloading whombat-agent…',
      '\u001b[32mInstalled.\u001b[0m',
      'Added to Whombat as pve-03.',
      'whombat-agent: os Debian GNU/Linux 13 (trixie) · amd64 · Proxmox VE 9.0',
      'whombat-agent: added pve-03',
      '',
    ].join('\r\n');
    expect(parseInstallOutput(out)).toEqual({
      result: { kind: 'added', id: 'pve-03' },
      os: 'Debian GNU/Linux 13 (trixie) · amd64 · Proxmox VE 9.0',
    });
    expect(parseInstallOutput('whombat-agent: kept basalt\n').result).toEqual({ kind: 'kept', id: 'basalt' });
    expect(parseInstallOutput('whombat-agent: waiting en_1\n').result).toEqual({
      kind: 'waiting',
      id: 'en_1',
    });
    expect(parseInstallOutput('whombat-agent: other-whombat\n').result).toEqual({ kind: 'other-whombat' });
    expect(parseInstallOutput('whombat-agent: added\nwhombat-agent: addedx y\n').result).toBeNull();
  });

  it('puts the platform first in the system line', () => {
    expect(systemLine('Debian GNU/Linux 13 (trixie) · amd64 · Proxmox VE 9.0')).toBe(
      'Proxmox VE 9.0 · Debian GNU/Linux 13 (trixie) · amd64',
    );
    expect(systemLine('Alpine Linux v3.22 · arm64')).toBe('Alpine Linux v3.22 · arm64');
    expect(systemLine(null)).toBeNull();
  });

  it('maps the installer’s stable words to SI-11’s codes', () => {
    const p = (stderr: string, exitCode: number | null = 1, timedOut = false) =>
      installProblemOf({ stdout: '', stderr, exitCode, timedOut });
    expect(p('install.sh: curl or wget is required')).toBe('no_downloader');
    expect(p('install.sh: unsupported architecture: riscv64')).toBe('unsupported');
    expect(p('install.sh: unsupported init system')).toBe('unsupported');
    expect(p('install.sh: cannot reach https://10.100.1.160:8443/download/whombat-agent-linux-amd64')).toBe(
      'cant_reach_whombat',
    );
    expect(p('', 3)).toBe('other_whombat');
    expect(p('', null, true)).toBe('timed_out');
    expect(p('install.sh: something else')).toBe('failed');
    expect(
      installProblemOf({
        stdout: 'whombat-agent: other-whombat\n',
        stderr: '',
        exitCode: 3,
        timedOut: false,
      }),
    ).toBe('other_whombat');
  });

  it('keeps the last lines for More detail, without the password or the token', () => {
    const detail = installDetail(
      {
        stdout: 'step one\nusing token tok-secret-123\n',
        stderr: 'sudo: password hunter2 refused\nretry with --token tok-other\n',
      },
      ['hunter2', 'tok-secret-123', null],
    );
    expect(detail).toBe(
      `step one\nusing token ${REMOVED}\nsudo: password ${REMOVED} refused\nretry with --token ${REMOVED}`,
    );
    expect(installDetail({ stdout: '\n\n', stderr: '' }, [])).toBeNull();
    const long = installDetail({ stdout: `${'x'.repeat(300)}\n`.repeat(100), stderr: '' }, []);
    expect(Buffer.byteLength(long ?? '')).toBeLessThanOrEqual(HOST_INSTALL_DETAIL_MAX);
  });

  it('reads the agents’ address from the enrollment', () => {
    expect(agentsPlace('wss://10.100.1.160:8443')).toBe('10.100.1.160:8443');
    expect(agentsPlace('nonsense')).toBeNull();
    expect(agentsPlace(null)).toBeNull();
  });
});

describe('levels, commands and words', () => {
  it('sets exactly a level’s switches in the hub’s words', () => {
    expect(hubSwitches('watch')).toEqual({
      console: false,
      power: false,
      host_shell: false,
      host_power: false,
      manage: false,
      diagnose: true,
    });
    expect(Object.values(hubSwitches('full')).every(Boolean)).toBe(true);
    expect(hubSwitches('operate')).toMatchObject({
      console: true,
      power: true,
      manage: false,
      host_shell: false,
    });
  });

  it('runs the installer with the token on stdin and sudo always reading its own line', () => {
    expect(installCommand('root', '/tmp/tmp.abc', 'full')).toBe('sh /tmp/tmp.abc --token - --control full');
    expect(installCommand('sudo', '/tmp/tmp.abc', 'watch')).toBe(
      'sudo -n sh /tmp/tmp.abc --token - --control watch',
    );
    expect(installCommand('sudo_password', '/tmp/tmp.abc', 'operate')).toBe(
      "sudo -k -S -p '' sh /tmp/tmp.abc --token - --control operate",
    );
    // The key goes on stdin, never on the command line.
    expect(KEEP_KEY_COMMAND).not.toMatch(/ssh-ed25519/);
  });

  it('names the box’s end of a connection over the tailnet, and nothing for any other way in', () => {
    expect(tailnetSource('100.64.0.3')).toBe('100.64.0.3');
    expect(tailnetSource('::ffff:100.127.255.1')).toBe('100.127.255.1');
    expect(tailnetSource('fd7a:115c:a1e0::3')).toBe('fd7a:115c:a1e0::3');
    for (const local of [
      '10.100.0.2',
      '100.128.0.1',
      '100.63.255.255',
      'fd00::5',
      '127.0.0.1',
      'fe80::1%eth0',
      '',
      null,
      undefined,
    ])
      expect(tailnetSource(local)).toBeNull();
  });

  it('says what changed, plainly', () => {
    expect(installChangeText('pve-03', 'full', false)).toBe('Added pve-03 with full control');
    expect(installChangeText('pve-03', 'operate', false)).toBe('Added pve-03 with restart and consoles');
    expect(installChangeText('pve-03', 'watch', false)).toBe('Added pve-03 to watch only');
    expect(installChangeText('pve-03', 'full', true)).toBe('Updated pve-03’s agent and set full control');
  });

  it('words failures with the contract, and the server’s own where it knows better', () => {
    const facts = { address: '10.100.0.14', agents: '10.100.1.160:8443' };
    expect(installFailureText({ code: 'sign_in_failed' }, facts)).toBe(
      'Couldn’t sign in to 10.100.0.14: the user name or password isn’t right.',
    );
    expect(installFailureText({ code: 'sign_in_failed' }, { ...facts, withKey: true })).toBe(
      'Couldn’t sign in to 10.100.0.14: the user name or key isn’t right.',
    );
    expect(installFailureText({ code: 'cant_reach_whombat' }, facts)).toBe(
      '10.100.0.14 can’t reach this Whombat at 10.100.1.160:8443. Is it on another network?',
    );
    expect(installFailureText({ code: 'timed_out', installed: true }, facts)).toBe(
      'It’s installed, but its first report hasn’t come in yet. It shows up once it does.',
    );
    expect(installFailureText({ code: 'not_allowed', message: 'The rule’s words.' }, facts)).toBe(
      'The rule’s words.',
    );
  });
});

describe('server_add (SI-10)', () => {
  it('takes an address, and the rest only when given', () => {
    const ask = addServerArgs({ address: ' 10.100.0.40 ' });
    expect(ask).toEqual({ address: '10.100.0.40', username: null, control: null, name: null });
    expect(addServerHref(ask)).toBe('/things/servers?add=1&address=10.100.0.40');
    expect(
      addServerHref(
        addServerArgs({ address: 'pve-03.lan:2222', username: 'root', control: 'full', name: 'pve-03' }),
      ),
    ).toBe('/things/servers?add=1&address=pve-03.lan%3A2222&user=root&control=full&name=pve-03');
    expect(() => addServerArgs({})).toThrow(/address: required/);
    expect(() => addServerArgs({ address: 'not an address' })).toThrow(/address:/);
    expect(() => addServerArgs({ address: '10.100.0.40', control: 'all' })).toThrow(/watch, operate or full/);
  });

  it('makes one card with one link, valid for the contract', () => {
    const card = addServerCard(addServerArgs({ address: '10.100.0.40', username: 'root', control: 'full' }));
    expect(GuideCard.parse(card)).toEqual(card);
    expect(card).toMatchObject({
      guide: 'add_server',
      title: 'Add 10.100.0.40 as a server',
      body: 'Sign in to it once and Whombat puts its helper on it.',
      blocks: [
        {
          type: 'actions',
          actions: [
            {
              label: 'Sign in…',
              href: '/things/servers?add=1&address=10.100.0.40&user=root&control=full',
            },
          ],
        },
      ],
    });
  });

  it('has words for an approval', () => {
    expect(serversAskWords('server_add', { address: '10.100.0.40' })).toBe('add 10.100.0.40 as a server');
    expect(
      serversDoneWords('server_add', { address: '10.100.0.40' }, { ok: true, isError: false, content: '{}' }),
    ).toBe('Here’s the card to add 10.100.0.40 as a server.');
  });
});
