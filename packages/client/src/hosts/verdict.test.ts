import type { ThingPageNotice } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { guestVerdict, machineVerdict, runningWords, serverVerdict } from './verdict';

type Line = Pick<ThingPageNotice, 'title' | 'tone' | 'nature' | 'link' | 'quiet'>;

const problem = (title: string, tone: 'bad' | 'warn' = 'warn'): Line => ({ title, tone, nature: 'problem' });
const yours = (title: string): Line => ({ title, tone: 'warn', nature: 'you' });
const fyi = (title: string): Line => ({ title, tone: 'info', nature: 'fyi' });
const running = { apps: { running: 33, total: 40 }, machines: { running: 6, total: 9 } };

describe('runningWords', () => {
  it('names apps and machines, one of each in the singular', () => {
    expect(runningWords(running)).toBe('33 apps and 6 machines are running');
    expect(runningWords({ apps: { running: 0, total: 0 }, machines: { running: 1, total: 2 } })).toBe(
      '1 machine is running',
    );
    expect(runningWords({ apps: { running: 0, total: 3 }, machines: { running: 0, total: 0 } })).toBe(
      'Nothing on it is running',
    );
    expect(runningWords({ apps: { running: 0, total: 0 }, machines: { running: 0, total: 0 } })).toBeNull();
  });
});

describe('serverVerdict', () => {
  it('is fine with what runs on it when nothing asks; heads-ups and quiet lines never count', () => {
    const v = serverVerdict({
      name: 'thetitan',
      status: 'ok',
      lines: [
        fyi('4 updates waiting'),
        { ...problem('Disk 1 is 89 % full'), quiet: { state: 'ignored' } as never },
      ],
      running,
    });
    expect(v.tone).toBe('ok');
    expect(v.sentence).toMatch(/^thetitan is fine/);
    expect(v.sentence).toContain('33 apps and 6 machines are running');
  });

  it('says how many things need the person, the one by its title', () => {
    const one = serverVerdict({
      name: 'thetitan',
      status: 'ok',
      lines: [yours('2 machines have no restore points.')],
      running,
    });
    expect(one.sentence).toMatch(/^thetitan is fine/);
    expect(one.sentence).toContain('One thing needs you: 2 machines have no restore points.');
    expect(one.sentence).not.toContain('..');
    const three = serverVerdict({
      name: 'pve-02',
      status: 'ok',
      lines: [yours('a'), yours('b'), yours('c')],
    });
    expect(three.sentence).toContain('3 things need you');
  });

  it('names the worst problem, and how many more lines ask', () => {
    const v = serverVerdict({
      name: 'blackbox',
      status: 'bad',
      statusNote: 'disk array failed',
      lines: [
        problem('Disk 1 runs warm'),
        problem('The disk array failed', 'bad'),
        yours('2 apps have updates'),
      ],
    });
    expect(v.tone).toBe('bad');
    expect(v.sentence).toMatch(/^blackbox has a problem: The disk array failed\./);
    expect(v.sentence).toContain('2 more things');
  });

  it('says the status in words when it isn’t ok and nothing names why', () => {
    const v = serverVerdict({
      name: 'pve-02',
      status: 'warn',
      statusNote: 'running warm',
      lines: [yours('x'), yours('y')],
    });
    expect(v.tone).toBe('warn');
    expect(v.sentence).toBe('pve-02 is running warm. 2 things need you.');
    const other = serverVerdict({ name: 'nas', status: 'bad', statusNote: 'pool degraded', lines: [] });
    expect([other.tone, other.sentence]).toEqual(['bad', 'nas needs a look: Pool degraded.']);
  });

  it('says an offline server isn’t checking in, with when Whombat last heard from it', () => {
    const v = serverVerdict({
      name: 'pve-01',
      status: 'offline',
      lines: [problem('x')],
      lastHeard: '2 h ago',
    });
    expect(v.tone).toBe('bad');
    expect(v.sentence).toContain('isn’t checking in');
    expect(v.sentence).toContain('2 h ago');
    expect(serverVerdict({ name: 'new', status: 'pending', lines: [] }).tone).toBe('mut');
  });
});

describe('guestVerdict', () => {
  it('says its state, then what needs the person', () => {
    expect(guestVerdict({ name: 'nextcloud', state: 'running', lines: [] }).sentence).toBe(
      'nextcloud is running fine.',
    );
    const v = guestVerdict({
      name: 'frigate',
      state: 'running',
      lines: [{ title: 'Restart to apply 1 change', tone: 'warn' }],
    });
    expect(v.tone).toBe('warn');
    expect(v.sentence).toContain('One thing needs you: Restart to apply 1 change.');
    expect(guestVerdict({ name: 'web', state: 'stopped', lines: [] }).sentence).toBe('web is stopped.');
    expect(guestVerdict({ name: 'web', state: 'unhealthy', lines: [] }).tone).toBe('bad');
    expect(
      guestVerdict({ name: 'web', state: 'running', serverOffline: true, lines: [] }).sentence,
    ).toContain('can’t reach');
  });
});

describe('machineVerdict', () => {
  const base = {
    id: 'pve:131',
    serverId: 'pve-02',
    name: 'homeassistant',
    platform: 'pve' as const,
    kind: 'container' as const,
    image: '',
    state: 'running' as const,
    cpuPct: 2,
    memoryUsedMb: 1900,
    memoryLimitMb: 4096,
    uptimeS: 3600,
    console: { available: true },
  } as Parameters<typeof machineVerdict>[0];

  it('reads its own hints and its server’s warnings about it, not heads-ups', () => {
    const now = Date.parse('2026-10-30T10:00:00Z');
    expect(machineVerdict(base, [], now).sentence).toBe('homeassistant is running fine.');
    const noJob = machineVerdict({ ...base, backupJob: false }, [], now);
    expect(noJob.tone).toBe('warn');
    expect(noJob.sentence).toContain('One thing needs you');
    const hints = [
      { entity: 'pve:131', title: 'Its disk is 92 % full', severity: 'warning' as const },
      { entity: 'homeassistant', title: 'An update is out', severity: 'info' as const },
      { entity: 'pve:140', title: 'Not this one', severity: 'warning' as const },
    ];
    expect(machineVerdict(base, hints, now).sentence).toContain('Its disk is 92 % full');
    expect(machineVerdict({ ...base, backupJob: false }, hints, now).sentence).toContain('2 things need you');
  });
});
