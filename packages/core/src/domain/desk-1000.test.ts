/**
 * Contracts 0.100.0, the desk display (Whombat desk-display.md DK-01…DK-15, CT-517…CT-527): the screen's settings, which
 * asks it may answer, its words, the status line and the power lines; 0.100.1 (CT-535, CT-536): the command a
 * connection call runs, and whose screen it is.
 */
import { describe, expect, it } from 'vitest';
import type { CommandCategory } from '../commands/commands.js';
import { REALTIME_EVENT_TOPICS, RealtimeEvent } from '../contracts/realtime.js';
import { DispatchContext } from '../contracts/runner.js';
import type { Approval, ApprovalAction } from './approval.js';
import {
  connectionCallDestroys,
  DEFAULT_DESK_SETTINGS,
  DESK_WORDS,
  DeskPin,
  DeskScreen,
  DeskSettings,
  DeskSettingsPatch,
  deskMayDecide,
  deskPinBackoffS,
  deskQuietNow,
  deskStatusLine,
  deskText,
  deskToneOf,
  deskTriesLeft,
  deskWrongPinText,
  fillDeskWords,
  formatPowerLeft,
  hostPowerText,
} from './desk.js';
import { DEFAULT_DESK_SHOW } from './desk-glance.js';
import { HUMAN_TONES } from './principal.js';

type Ask = Pick<Approval, 'action' | 'keyId'>;
const ask = (action: ApprovalAction, keyId: Ask['keyId'] = 'connections.write'): Ask => ({ action, keyId });
const call = (tool: string, words?: string): ApprovalAction => ({
  type: 'connection_call',
  params: {
    connectionId: 'con_servers01',
    handle: 'servers',
    tool,
    toolHash: 'a'.repeat(64),
    ...(words ? { words } : {}),
  },
});
const command = (category: CommandCategory) =>
  ask({ type: 'run_command', params: { command: 'x', category, target: null, reason: null } });
const reason = (a: Ask, args?: Record<string, unknown>) => {
  const d = deskMayDecide(a, args ? { args } : undefined);
  return d.ok ? 'screen' : d.reason;
};

describe('the screen’s settings (CT-517, CT-518)', () => {
  it('defaults to a summary, quiet 23:00–07:00, a dim clock and Talk on', () => {
    expect(DeskSettings.parse({})).toEqual(DEFAULT_DESK_SETTINGS);
    expect(DEFAULT_DESK_SETTINGS).toEqual({
      lockedView: 'summary',
      quietHours: { enabled: true, start: '23:00', end: '07:00' },
      night: 'dim',
      voice: true,
      // 0.103 (CT-592): Stay unlocked while you’re here, off until the person turns it on.
      presence: false,
      // 0.105 (CT-610): the voice the box spoke with before there was a choice.
      speechVoice: 'heart',
      // 0.107 (CT-640, CT-641): Lock again after 2 minutes, the camera off.
      stayUnlocked: false,
      cameraWake: false,
      // 3.2 (CT-1621): what the screen shows, every choice its default.
      show: DEFAULT_DESK_SHOW,
    });
  });

  it('is quiet overnight in the person’s zone, every day', () => {
    const tz = 'Europe/Amsterdam';
    // 2026-10-20 is a Tuesday; Amsterdam is UTC+2 until 25 October.
    expect(deskQuietNow(DEFAULT_DESK_SETTINGS, '2026-10-20T21:30:00Z', tz)).toBe(true); // 23:30
    expect(deskQuietNow(DEFAULT_DESK_SETTINGS, '2026-10-24T04:59:00Z', tz)).toBe(true); // Sat 06:59
    expect(deskQuietNow(DEFAULT_DESK_SETTINGS, '2026-10-20T05:00:00Z', tz)).toBe(false); // 07:00
    expect(deskQuietNow(DEFAULT_DESK_SETTINGS, '2026-10-20T12:34:00Z', tz)).toBe(false);
    expect(deskQuietNow(DEFAULT_DESK_SETTINGS, '2026-10-20T21:30:00Z', 'UTC')).toBe(false); // 21:30
    const off = { quietHours: { ...DEFAULT_DESK_SETTINGS.quietHours, enabled: false } };
    expect(deskQuietNow(off, '2026-10-20T21:30:00Z', tz)).toBe(false);
  });

  it('takes a patch of whole settings, nothing unknown', () => {
    expect(DeskSettingsPatch.safeParse({}).success).toBe(true);
    expect(DeskSettingsPatch.safeParse({ lockedView: 'time', night: 'black' }).success).toBe(true);
    expect(DeskSettingsPatch.safeParse({ quietHours: { enabled: false } }).success).toBe(false);
    expect(
      DeskSettingsPatch.safeParse({ quietHours: { enabled: true, start: '22:00', end: '24:00' } }).success,
    ).toBe(false);
    expect(DeskSettingsPatch.safeParse({ wakeWord: true }).success).toBe(false);
  });

  it('takes six ASCII digits as a PIN (4 to 6 since 0.103, CT-590)', () => {
    expect(DeskPin.safeParse('048213').success).toBe(true);
    for (const pin of ['048', '0482130', '04821a', '٠٤٨٢١٣', 48213])
      expect(DeskPin.safeParse(pin).success, String(pin)).toBe(false);
  });

  it('reads a screen nobody paired with the defaults', () => {
    const screen = DeskScreen.parse({
      paired: null,
      settings: {},
      pairing: { expiresAt: '2026-10-20T12:44:00Z' },
      unlockRequest: null,
      hasDisplay: true,
      hasMicrophone: true,
      hasSpeaker: true,
      hasBattery: true,
      voiceAvailable: false,
      display: { connected: true, real: false, builtIn: false, name: null },
      on: false,
      onChosen: false,
      presenceAvailable: false,
      lockAgain: ['idle', 'never'],
      cameraWakeAvailable: false,
    });
    expect(screen.settings).toEqual(DEFAULT_DESK_SETTINGS);
  });

  it('draws the person’s tone by its place', () => {
    expect(deskToneOf(HUMAN_TONES[0])).toBe(1);
    expect(deskToneOf(HUMAN_TONES[4].toUpperCase())).toBe(5);
    expect(deskToneOf('#123456')).toBe(1);
  });
});

describe('wrong PINs (DK-04)', () => {
  it('waits a minute after five, doubling to an hour', () => {
    expect([0, 4].map(deskPinBackoffS)).toEqual([0, 0]);
    expect([5, 6, 7, 10, 11, 40].map(deskPinBackoffS)).toEqual([60, 120, 240, 1_920, 3_600, 3_600]);
    expect([0, 3, 5, 9].map(deskTriesLeft)).toEqual([5, 2, 0, 0]);
    expect(deskWrongPinText(3)).toBe('Wrong PIN. 3 tries left.');
    expect(deskWrongPinText(1)).toBe('Wrong PIN. 1 try left.');
  });
});

describe('what the screen may answer (CT-519)', () => {
  it('keeps money, releases, deleting, keys and the outside on the phone', () => {
    expect(
      reason(
        ask(
          { type: 'refund', params: { accountId: 'a1', amountCents: 100, currency: 'EUR' } },
          'refunds.issue',
        ),
      ),
    ).toBe('money');
    const deploy = { environment: 'staging', service: 'web', ref: 'main', sha: null };
    expect(reason(ask({ type: 'deploy', params: deploy }, 'deploy.staging'))).toBe('release');
    expect(reason(ask({ type: 'merge_pr', params: { prNumber: 4, base: 'feat/x' } }, 'merge'))).toBe(
      'release',
    );
    expect(
      reason(
        ask(
          { type: 'push_shared_branch', params: { repo: 'r', branch: 'main', sha: 'abcdef' } },
          'branch.main.push',
        ),
      ),
    ).toBe('release');
    expect(reason(command('deploy_production'))).toBe('release');
    expect(reason(command('merge'))).toBe('release');
    expect(reason(command('push_main'))).toBe('release');
    expect(reason(command('deploy'))).toBe('release');
    expect(reason(command('destructive'))).toBe('delete');
    expect(reason(command('message_external'))).toBe('outside');
    // A web lookup or the browser at Ask may be answered on the screen (CT-1236).
    expect(reason(command('web'))).toBe('screen');
    expect(reason(command('browser'))).toBe('screen');
    expect(
      reason(ask({ type: 'files_trash', params: { fileId: 'f1', fileName: 'a.pdf' } }, 'files.delete')),
    ).toBe('delete');
    expect(reason(ask({ type: 'grant_key', params: { keyId: 'tests.run' } }, 'tests.run'))).toBe('keys');
    expect(
      reason(ask({ type: 'message_external', params: { to: 'a@b.c', body: 'hi' } }, 'messages.external')),
    ).toBe('outside');
    const files = { fileId: 'f1', fileName: 'a.pdf', email: 'a@b.c', role: 'reader' as const };
    expect(reason(ask({ type: 'files_share', params: files }, 'files.share'))).toBe('outside');
  });

  it('keeps an ask about a risky key on the phone, whatever its kind', () => {
    const custom = (keyId: Ask['keyId'] & string) =>
      ask({ type: 'custom', params: { name: 'thing', keyId, data: {} } }, keyId);
    expect(reason(custom('deploy.production'))).toBe('release');
    expect(reason(custom('merge.main'))).toBe('release');
    expect(reason(custom('commands.destructive'))).toBe('delete');
    expect(reason(custom('messages.external'))).toBe('outside');
    expect(reason(custom('billing.write'))).toBe('money');
    expect(reason(custom('mail.send'))).toBe('outside');
    expect(reason(custom('agents.manage'))).toBe('keys');
    expect(reason(custom('tests.run'))).toBe('screen');
  });

  it('lets the everyday asks on the screen', () => {
    expect(
      reason(ask(call('server_command', 'Restart Plex on blackbox'), 'connections.write'), {
        server: 'blackbox',
        command: 'docker restart plex',
        reason: 'Plex stopped answering',
      }),
    ).toBe('screen');
    expect(reason(ask(call('guest_power', 'Restart web on pve-02'), 'connections.write'))).toBe('screen');
    expect(
      reason(
        ask(
          { type: 'push_shared_branch', params: { repo: 'r', branch: 'release', sha: 'abcdef' } },
          'branch.shared.push',
        ),
      ),
    ).toBe('screen');
  });

  it('keeps a call that deletes or destroys on the phone', () => {
    expect(reason(ask(call('guest_delete'), 'connections.write'))).toBe('delete');
    expect(reason(ask(call('HassShoppingListRemoveItem'), 'connections.write'))).toBe('delete');
    expect(reason(ask(call('guest_template'), 'connections.write'))).toBe('delete');
    expect(reason(ask(call('guest_snapshot', 'Delete the snapshot before-upgrade of web on pve-02')))).toBe(
      'delete',
    );
    expect(reason(ask(call('guest_backup', 'Restore the backup of web on pve-02')))).toBe('delete');
    // Known only from the arguments.
    expect(reason(ask(call('guest_snapshot')), { action: 'delete', snapshot: 'x' })).toBe('delete');
    expect(reason(ask(call('guest_snapshot')), { action: 'create', snapshot: 'x' })).toBe('screen');
    expect(reason(ask(call('request')), { method: 'DELETE', path: '/api/x' })).toBe('delete');
    expect(reason(ask(call('request')), { method: 'POST', path: '/api/x' })).toBe('screen');
    expect(reason(ask(call('call')), { method: 'pool.dataset.delete' })).toBe('delete');
    expect(connectionCallDestroys({ tool: 'guest_power', words: 'Restart web on pve-02' })).toBe(false);
  });
});

describe('a command a connection call runs (CT-535)', () => {
  const serverCommand = ask(call('server_command', 'Run a command on blackbox'), 'connections.write');
  const run = (command: string) =>
    reason(serverCommand, { server: 'blackbox', command, reason: 'Asked for it' });

  it('keeps a destructive command on the phone, through sudo and after &&', () => {
    expect(run('rm -rf /srv/backups')).toBe('delete');
    expect(run('sudo rm -rf /srv/backups')).toBe('delete');
    expect(run('cd /srv && rm -rf backups')).toBe('delete');
    expect(run('docker compose -f /srv/plex.yml down')).toBe('delete');
    expect(run('systemctl stop nginx')).toBe('delete');
  });

  it('keeps releases and the outside on the phone', () => {
    expect(run('git push origin main')).toBe('release');
    expect(run('cd /srv/app && git push origin HEAD:main')).toBe('release');
    expect(run('kubectl apply -f app.yml')).toBe('release');
    expect(run('gh pr merge 12')).toBe('release');
    expect(run('sendmail ops@example.com < note.txt')).toBe('outside');
  });

  it('keeps whatever deletes something on the phone, the desk’s own reading', () => {
    for (const c of [
      'rm /srv/plex/old.log',
      'rm -r /srv/old',
      'rmdir /srv/empty',
      'shred -u secrets.txt',
      'unlink /srv/link',
      'truncate -s 0 /var/log/plex.log',
      'find /srv/backups -mtime +30 -delete',
      'find /srv -name "*.tmp" -exec rm {} \\;',
      'find /srv -name "*.tmp" | xargs rm',
      'dd if=/dev/zero of=/srv/disk.img bs=1M count=1',
      'mkfs.ext4 /dev/sdb1',
      'wipefs -a /dev/sdb',
      'sgdisk --zap-all /dev/sdb',
      'sfdisk /dev/sdb < layout',
      'fdisk -l',
      'parted /dev/sdb print',
      'zfs destroy -r tank/media',
      'zfs rollback tank/media@monday',
      'zpool destroy tank',
      'zpool labelclear /dev/sdb',
      'lvremove -y vg0/data',
      'vgremove vg0',
      'pvremove /dev/sdb',
      'btrfs subvolume delete /srv/@old',
      'btrfs sub del /srv/@old',
      'docker rm -f plex',
      'docker rmi plexinc/pms-docker',
      'docker -H unix:///var/run/docker.sock container rm plex',
      'docker volume rm plex-config',
      'docker volume prune -f',
      'docker system prune -af',
      'docker container prune',
      'docker image prune -a',
      'docker network rm media',
      'podman rm plex',
      'docker compose -f /srv/plex.yml down -v',
      'docker compose down --volumes',
      'docker-compose down --rmi all',
      'docker compose rm -f plex',
      'podman-compose down -v',
      'kubectl -n media delete pod plex-0',
      'helm uninstall plex',
      'pct destroy 105',
      'qm destroy 104 --purge',
      'virsh undefine web --remove-all-storage',
      'incus delete web --force',
      'lxc delete web',
      'incus storage volume delete default data',
      'pvesm free local-lvm:vm-104-disk-0',
      'psql -c "DROP TABLE users"',
      'mysql -e "truncate orders" shop',
      'echo "DROP DATABASE app;" | mysql',
      'redis-cli -n 0 FLUSHALL',
      'redis-cli flushdb',
      'echo "" > /etc/plex/Preferences.xml',
      'sudo bash -c "rm -rf /srv/cache"',
    ])
      expect(run(c), c).toBe('delete');
  });

  it('lets everyday commands on the screen', () => {
    for (const c of [
      'docker restart plex',
      'systemctl restart nginx',
      'docker ps',
      'sudo journalctl -u plex -n 50',
      'docker logs --tail 50 plex 2>&1',
      'docker ps -a > /dev/null',
      'docker run --rm alpine echo hi',
      'docker volume ls',
      'systemctl status nginx',
      'journalctl -u plex --since "1 hour ago" | tail -n 20',
      'apt list --upgradable 2>/dev/null',
      'df -h',
      'du -sh /srv/*',
      'find /srv -name "*.log" -mtime +30',
      'echo started >> /var/log/plex-notes',
      'zfs list -t snapshot',
      'kubectl get pods -n media',
      'psql -c "SELECT count(*) FROM users"',
      'redis-cli info',
      'pct list',
    ])
      expect(run(c), c).toBe('screen');
  });

  it('keeps a server command it can’t read on the phone', () => {
    expect(reason(serverCommand)).toBe('delete');
    expect(deskMayDecide(serverCommand, { args: null })).toEqual({ ok: false, reason: 'delete' });
    expect(deskMayDecide(serverCommand, {})).toEqual({ ok: false, reason: 'delete' });
    expect(reason(serverCommand, { server: 'blackbox', reason: 'Asked for it' })).toBe('delete');
    expect(reason(serverCommand, { server: 'blackbox', command: ['rm', '-rf', '/'] })).toBe('delete');
  });

  it('reads the command of any call that carries one', () => {
    expect(reason(ask(call('exec'), 'connections.write'), { command: 'rm -rf /data' })).toBe('delete');
    expect(reason(ask(call('exec'), 'connections.write'), { command: 'uptime' })).toBe('screen');
    expect(reason(ask(call('guest_power', 'Restart web on pve-02'), 'connections.write'))).toBe('screen');
  });
});

describe('the person’s screen (CT-536; since 3.0 without `you`, CT-1510)', () => {
  const screen = (paired: Record<string, unknown>) => ({
    paired: {
      personId: 'prn_john0001',
      name: 'John Doe',
      pairedAt: '2026-10-20T12:00:00Z',
      hasPin: true,
      self: false,
      ...paired,
    },
    settings: {},
    pairing: null,
    unlockRequest: null,
    hasDisplay: true,
    hasMicrophone: false,
    hasSpeaker: false,
    hasBattery: false,
    voiceAvailable: false,
    display: { connected: true, real: false, builtIn: false, name: null },
    on: false,
    onChosen: false,
    presenceAvailable: false,
    lockAgain: ['idle', 'never'],
    cameraWakeAvailable: false,
  });

  it('is the person’s: no `you` to say whose it is', () => {
    expect(DeskScreen.parse(screen({})).paired?.personId).toBe('prn_john0001');
    expect(DeskScreen.parse(screen({ you: true })).paired).not.toHaveProperty('you');
  });
});

describe('the words (CT-520)', () => {
  const holes = (t: string) => t.match(/\{[a-z]+\}/g) ?? [];
  const all = (o: unknown): string[] =>
    typeof o === 'string' ? [o] : typeof o === 'object' && o ? Object.values(o).flatMap(all) : [];

  it('says the mockups’ words, with the assistant’s name filled in, never written in', () => {
    expect(DESK_WORDS.locked).toBe('Locked · touch to use');
    expect(fillDeskWords(DESK_WORDS.unlockedAs, { name: 'John', n: 2 })).toBe(
      'Unlocked as John · locks in 2 min',
    );
    expect(fillDeskWords(DESK_WORDS.slow, { assistant: 'Neo' })).toContain('Neo');
    expect(fillDeskWords('{x} and {y}', { x: 1 })).toBe('1 and {y}');
    for (const text of all(DESK_WORDS)) {
      expect(text, text).not.toMatch(/Neo|Banjo/);
      expect(text, text).not.toMatch(/['"]/);
      for (const hole of holes(text))
        expect([
          '{name}',
          '{n}',
          '{m}',
          '{assistant}',
          '{server}',
          '{doing}',
          '{title}',
          '{time}',
          '{clock}',
          '{date}',
          // 0.101 (CT-541): This Whombat's figures.
          '{unit}',
          '{total}',
          '{tone}',
          '{down}',
          '{up}',
          // 0.115 (CT-868): a server's screen.
          '{used}',
          '{running}',
          '{off}',
          // 0.116 (CT-890): a wider choice's label.
          '{choice}',
          // 0.118 (CT-971): why a look needs the person.
          '{reason}',
          // 3.2 (CT-1624): the calm glance's muted line, a hero's detail and age, a disk's forecast, a scenario.
          '{things}',
          '{a}',
          '{b}',
          '{ago}',
          '{days}',
          '{scenario}',
        ]).toContain(hole);
    }
  });

  it('makes any text one clean line of at most its length', () => {
    expect(deskText('  All\nfine.\u00a0Really\u200b ', 200)).toBe('All fine. Really');
    expect(deskText('🎉'.repeat(130), 120)).toBe(`${'🎉'.repeat(119)}…`);
    expect([...deskText('x'.repeat(500), 120)].length).toBe(120);
  });
});

describe('the status line (CT-520)', () => {
  const base = { needsYou: 0, worst: null };

  it('only the time: fine or something needs you', () => {
    expect(deskStatusLine({ ...base, view: 'time' }).text).toBe(DESK_WORDS.status.allFine);
    expect(deskStatusLine({ ...base, view: 'time', needsYou: 2 }).text).toBe(
      DESK_WORDS.status.somethingNeedsYou,
    );
    expect(deskStatusLine({ ...base, view: 'time', worst: { name: 'pve-02', down: false } }).text).toBe(
      DESK_WORDS.status.somethingNeedsYou,
    );
  });

  it('a summary: counts and the worst server, no titles', () => {
    const summary = (patch: object) =>
      deskStatusLine({ ...base, view: 'summary', firstAsk: 'Plex', ...patch });
    expect(summary({}).text).toBe('Everything’s fine.');
    expect(summary({ needsYou: 1 }).text).toBe('1 thing needs you.');
    expect(summary({ needsYou: 3 }).text).toBe('3 things need you.');
    expect(summary({ worst: { name: 'pve-02', down: false } }).text).toBe('pve-02 needs a look.');
    expect(summary({ worst: { name: 'pve-02', down: true } }).text).toBe('pve-02 is down.');
    expect(summary({ needsYou: 2, worst: { name: 'pve-02', down: true } }).text).toBe(
      'pve-02 is down. 2 things need you.',
    );
    expect(summary({ needsYou: 2, worst: { name: 'pve-02', down: false } }).text).toBe(
      '2 things need you. pve-02 needs a look.',
    );
    expect(summary({ needsYou: 2 }).more).toBeUndefined();
    expect(summary({ needsYou: 2 }).text).not.toContain('Plex');
  });

  it('everything: the assistant’s own line and the first ask, muted', () => {
    const line = deskStatusLine({
      view: 'everything',
      needsYou: 2,
      doing: 'Updating your server agents, two of four are done.',
      firstAsk: 'Plex on blackbox',
    });
    expect(line).toEqual({
      text: 'Everything’s fine. I’m updating your server agents, two of four are done.',
      more: 'Plex on blackbox needs a decision.',
    });
    const down = deskStatusLine({ view: 'everything', needsYou: 0, worst: { name: 'pve-02', down: true } });
    expect(down).toEqual({ text: 'pve-02 is down.' });
    expect(deskStatusLine({ view: 'everything', needsYou: 1, doing: 'NAS check' }).text).toContain(
      'I’m NAS check.',
    );
  });
});

describe('power (CT-521)', () => {
  const nbsp = '\u00a0';
  const ac = {
    source: 'ac' as const,
    percent: 80,
    charging: false,
    minutesLeft: null,
    chargeLimit: 80,
    since: null,
  };
  const battery = {
    ...ac,
    source: 'battery' as const,
    percent: 72,
    minutesLeft: 190,
    since: '2026-10-20T00:14:00Z',
  };

  it('says where the power comes from in one line', () => {
    expect(hostPowerText.line(ac)).toBe(`Plugged in · battery kept at 80${nbsp}%`);
    expect(hostPowerText.line({ ...ac, charging: true, percent: 64 })).toBe(
      `Plugged in · charging · 64${nbsp}%`,
    );
    expect(hostPowerText.line({ ...ac, chargeLimit: null, percent: 100 })).toBe(`Plugged in · 100${nbsp}%`);
    expect(hostPowerText.line(battery)).toBe(`On battery · 72${nbsp}% · about 3 h 10 min left`);
    expect(hostPowerText.line({ ...battery, minutesLeft: null })).toBe(`On battery · 72${nbsp}%`);
    expect([45, 60, 190, 0.2].map(formatPowerLeft)).toEqual(['45 min', '1 h', '3 h 10 min', '1 min']);
  });

  it('tells owners in Chat and shows the banner of mockup 4', () => {
    expect(hostPowerText.out(battery)).toBe(
      'The power is out. Whombat is running on its battery, about 3 h 10 min left.',
    );
    expect(hostPowerText.out({ minutesLeft: null })).toBe(
      'The power is out. Whombat is running on its battery.',
    );
    expect(hostPowerText.back()).toBe('The power is back.');
    expect(hostPowerText.low({ percent: 15 })).toContain(`15${nbsp}%`);
    const banner = hostPowerText.banner(battery, { assistant: 'Neo', timeZone: 'Europe/Amsterdam' });
    expect(banner.title).toBe('The power has been out since 02:14.');
    expect(banner.text).toContain('3 h 10 min');
    expect(banner.text).toContain('Neo');
  });
});

describe('desk.changed and a turn from the desk (CT-527)', () => {
  it('tells the person’s own devices to read the screen again', () => {
    expect(RealtimeEvent.parse({ type: 'desk.changed' })).toEqual({ type: 'desk.changed' });
    expect(REALTIME_EVENT_TOPICS['desk.changed']).toEqual(['me']);
  });

  it('marks a turn that came from the desk, spoken or typed', () => {
    const desk = DispatchContext.shape.desk;
    expect(desk.parse({ spoken: true })).toEqual({ spoken: true });
    expect(desk.parse(undefined)).toBeUndefined();
    expect(desk.parse(null)).toBeNull();
    expect(desk.safeParse({}).success).toBe(false);
  });
});
