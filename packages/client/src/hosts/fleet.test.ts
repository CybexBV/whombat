import { type HostGuest, HostGuestPage, type HostHint, HostServerDetail } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { bulkAction, bulkDoneText, bulkPlan, bulkQuestion, runLimited } from './bulk';
import { createHostsFixtures } from './fixtures';
import { fleetFootText, fleetGuestQuery, nextGuestSort, parseGuestSort, tagFacet } from './fleet';
import { hintFixes, hintGuests } from './hints';
import { agentUpdateNeed, allowCommand, compareVersions, pveActivity, updateCommand } from './system';

const NOW = Date.parse('2026-10-17T12:02:00Z');
const { handle } = createHostsFixtures(NOW);
const get = (path: string, query: Record<string, string> = {}) =>
  handle({ method: 'GET', path, query, body: {} })?.body;

const g = (
  name: string,
  platform: HostGuest['platform'],
  kind: HostGuest['kind'],
  state: HostGuest['state'],
) => ({
  id: `${platform}:${name}`,
  name,
  platform,
  kind,
  state,
});

describe('bulk power', () => {
  it('gives each guest the action its platform and state allow', () => {
    expect(bulkAction('shutdown', g('a', 'pve', 'vm', 'running'))).toBe('shutdown');
    expect(bulkAction('shutdown', g('a', 'docker', 'container', 'running'))).toBe('stop');
    expect(bulkAction('shutdown', g('a', 'pve', 'vm', 'paused'))).toBeNull();
    expect(bulkAction('reboot', g('a', 'docker', 'container', 'running'))).toBe('restart');
    expect(bulkAction('stop', g('a', 'pve', 'vm', 'running'))).toBe('force_stop');
    expect(bulkAction('stop', g('a', 'pve', 'vm', 'paused'))).toBe('stop');
    expect(bulkAction('start', g('a', 'pve', 'vm', 'running'))).toBeNull();
    expect(bulkAction('start', g('a', 'pve', 'container', 'stopped'))).toBe('start');
  });

  it('skips guests it doesn’t apply to and servers without power', () => {
    const plan = bulkPlan('start', [
      { server: 'pve-02', guest: g('a', 'pve', 'vm', 'stopped'), power: true },
      { server: 'pve-02', guest: g('b', 'pve', 'vm', 'running'), power: true },
      { server: 'pve-01', guest: g('c', 'pve', 'vm', 'stopped'), power: false },
    ]);
    expect(plan.run.map((r) => r.item.guest.name)).toEqual(['a']);
    expect(plan.skipped.map((r) => r.guest.name)).toEqual(['b', 'c']);
  });

  it('asks with the count and ends in one toast', () => {
    expect(bulkQuestion('stop', 1).title).toBe('Stop 1 guest?');
    expect(bulkQuestion('reboot', 3).action).toBe('Restart 3 guests');
    expect(bulkDoneText('start', 3, [])).toBe('Starting 3 guests.');
    expect(bulkDoneText('reboot', 3, [{ name: 'web', message: 'The agent isn’t connected.' }])).toBe(
      'Restarting 2 of 3 guests. Not web: The agent isn’t connected.',
    );
    expect(bulkDoneText('stop', 1, [{ name: 'web', message: '' }])).toBe('Nothing happened. Not web.');
  });

  it('runs three at a time, in order', async () => {
    let running = 0;
    let most = 0;
    const done: number[] = [];
    await runLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 1));
      done.push(n);
      running--;
    });
    expect(most).toBe(3);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('the fleet’s guests', () => {
  it('sorts by a column and flips it', () => {
    expect(parseGuestSort(undefined)).toEqual({ key: 'cpu', desc: true });
    expect(parseGuestSort('-name')).toEqual({ key: 'name', desc: true });
    expect(nextGuestSort('cpu', 'cpu')).toBe('+cpu');
    expect(nextGuestSort('+cpu', 'cpu')).toBe('cpu');
    expect(nextGuestSort('cpu', 'name')).toBe('name');
    expect(nextGuestSort('name', 'name')).toBe('-name');
  });

  it('asks for what the filters say', () => {
    expect(fleetGuestQuery({ q: ' web ', state: 'running', tag: 'lab', sort: 'cpu' }, '100')).toEqual({
      q: 'web',
      state: 'running',
      tag: 'lab',
      limit: 100,
      cursor: '100',
    });
    expect(fleetGuestQuery({ state: 'nonsense', server: 'pve-01' })).toEqual({
      server: 'pve-01',
      limit: 100,
    });
  });

  it('lists every server’s guests with tags across servers', () => {
    const page = HostGuestPage.parse(get('/guests', { tag: 'lab' }));
    expect(new Set(page.guests.map((x) => x.serverId))).toEqual(new Set(['pve-01', 'pve-02']));
    expect(page.guests.every((x) => x.tags?.includes('lab'))).toBe(true);
    const all = HostGuestPage.parse(get('/guests'));
    expect(tagFacet(all.tags).find((t) => t.tag === 'lab')?.count).toBe(page.total);
    expect(all.nextCursor).toBe('100');
    expect(fleetFootText(0, all.guests, all.total, undefined)).toMatch(
      /^1–100 of \d+ guests on \d servers, by CPU$/,
    );
    const byName = HostGuestPage.parse(get('/guests', { server: 'pve-02', sort: 'name' }));
    const names = byName.guests.map((x) => x.name.toLowerCase());
    expect(names).toEqual([...names].sort());
  });
});

describe('hints with their way out', () => {
  const d = HostServerDetail.parse(get('/servers/pve-02'));
  const guests = [...(d.proxmox?.guests.vm?.guests ?? []), ...(d.proxmox?.guests.container?.guests ?? [])];
  const hint = (kind: string) => d.hints.find((h) => h.kind === kind) as HostHint;

  it('names the guests a folded hint lists', () => {
    expect(
      hintGuests({ detail: 'minecraft, test-ct (2 changes), nobody, …' }, guests).map((x) => x.name),
    ).toEqual(['minecraft', 'test-ct']);
  });

  it('open what fixes them', () => {
    expect(hintFixes(hint('storage.overcommit'), guests)).toEqual([
      { kind: 'tab', tab: 'storage', label: 'Open Storage' },
    ]);
    expect(hintFixes(hint('guest.no_backup_job'), guests)).toEqual([
      { kind: 'tab', tab: 'backups', label: 'Add to a backup plan' },
    ]);
    expect(hintFixes(hint('guest.pending_changes'), guests)).toEqual([
      { kind: 'guest', guestId: 'pve:118', label: 'See arnica-prod-nest-01’s changes' },
      { kind: 'guest', guestId: 'pve:123', label: 'See win11-test’s changes' },
    ]);
    expect(hintFixes(hint('sensor.near_limit'), guests)).toEqual([
      { kind: 'tab', tab: 'sensors', label: 'Open Sensors' },
    ]);
    const old: HostHint = {
      ...hint('guest.no_backup_job'),
      kind: 'guest.backup_old',
      detail: 'minecraft (12 days)',
    };
    expect(hintFixes(old, guests)).toEqual([
      { kind: 'backup', guestId: 'pve:144', label: 'Back up minecraft now' },
    ]);
  });
});

describe('the System tab', () => {
  it('lists failed tasks of the last 48 hours', () => {
    const d = HostServerDetail.parse(get('/servers/pve-02'));
    const tasks = pveActivity(d, NOW);
    expect(tasks.map((t) => t.type)).toEqual(['vzdump', 'qmigrate']);
    expect(d.health?.pveReplication?.length).toBe(2);
  });

  it('says the command for a switch the server blocks', () => {
    expect(allowCommand('hostShell')).toBe('sudo whombat-agent allow host_shell');
    expect(allowCommand('manage', 'unraid')).toBe('whombat-agent allow manage');
  });

  it('updates the agent first when it may be older', () => {
    expect(compareVersions('0.9.1', '0.10.0')).toBe(-1);
    expect(compareVersions('v1.2', '1.2.0')).toBe(0);
    expect(compareVersions('dev', '1.0')).toBeNull();
    expect(agentUpdateNeed({ agentVersion: '0.15.2', serviceVersion: '0.16.0' })).toBe('yes');
    expect(agentUpdateNeed({ agentVersion: '0.16.0', serviceVersion: '0.16.0' })).toBe('no');
    expect(agentUpdateNeed({ agentVersion: '0.16.0', serviceVersion: null })).toBe('maybe');
    expect(agentUpdateNeed({ agentVersion: '0.16.0', serviceVersion: '0.16.0', updateAvailable: true })).toBe(
      'yes',
    );
  });

  it('turns the install command into an update', () => {
    const cmd =
      "curl -fsS --pinnedpubkey 'sha256//X=' https://10.100.1.5:8443/install.sh | sudo sh -s -- --token AB-CD";
    expect(updateCommand(cmd)).toBe(
      "curl -fsS --pinnedpubkey 'sha256//X=' https://10.100.1.5:8443/install.sh | sudo sh",
    );
    expect(updateCommand(cmd.replace('--token', '--enroll'), 'unraid')).toBe(
      "curl -fsS --pinnedpubkey 'sha256//X=' https://10.100.1.5:8443/install.sh | sh",
    );
    // The enrollment's control level would write over what the server allows (AP-2994).
    expect(updateCommand(`${cmd} --control full`)).toBe(updateCommand(cmd));
    expect(updateCommand(`${cmd} --control=watch`)).toBe(updateCommand(cmd));
  });
});

describe('the fixture world', () => {
  it('creates a guest from all the form’s fields', () => {
    const w = createHostsFixtures(NOW);
    const out = w.handle({
      method: 'POST',
      path: '/servers/pve-02/manage',
      query: {},
      body: {
        op: 'guest.create',
        params: {
          platform: 'pve',
          kind: 'container',
          name: 'dns-2',
          start: true,
          set: { ostemplate: 'local:vztmpl/x.tar.zst', memory: '512', cores: '1' },
        },
      },
    });
    expect(out?.body).toMatchObject({ ok: true, newId: 'pve:146' });
    const d = HostServerDetail.parse(
      w.handle({ method: 'GET', path: '/servers/pve-02', query: {}, body: {} })?.body,
    );
    expect(d.proxmox?.guests.container?.guests.some((x) => x.name === 'dns-2' && x.state === 'running')).toBe(
      true,
    );
    const refused = w.handle({
      method: 'POST',
      path: '/servers/pve-02/manage',
      query: {},
      body: { op: 'guest.create', params: { kind: 'container', name: 'x', set: {} } },
    });
    expect(refused?.status).toBe(400);
  });
});
