import { HostFleet, type HostGuest, HostServerDetail, HostTask } from '@whombat/core/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { createHostsFixtures } from './fixtures';
import {
  arrayGroups,
  arrayStopWords,
  canUpdateContainer,
  fsWords,
  guestWebUi,
  hasAutostart,
  isUnraidServer,
  parityRunWords,
  parityView,
  pluginRows,
  poolWords,
  shareWhere,
  unraidAbilities,
  unraidChangeWords,
  unraidDiskName,
  unraidDiskRow,
  unraidHintFixes,
  unraidPageUrl,
  unraidVersionView,
} from './unraid';

const NOW = Date.parse('2026-10-17T12:00:00Z');

function world(scenario?: string) {
  const store = globalThis as { localStorage?: unknown };
  if (scenario) store.localStorage = { getItem: () => scenario };
  const { handle } = createHostsFixtures(NOW);
  const get = (path: string, query: Record<string, string> = {}) =>
    handle({ method: 'GET', path, query, body: {} });
  const manage = (body: Record<string, unknown>) =>
    handle({ method: 'POST', path: '/servers/blackbox/manage', query: {}, body });
  const detail = () => HostServerDetail.parse(get('/servers/blackbox')?.body);
  /** Reads a task until it ends (its log grows a line per read). */
  const finish = (id: string) => {
    let last: HostTask | undefined;
    for (let i = 0; i < 20 && last?.status !== 'ok' && last?.status !== 'error'; i++)
      last = HostTask.parse(get(`/servers/blackbox/tasks/${encodeURIComponent(id)}`)?.body);
    return last;
  };
  const taskId = (a: ReturnType<typeof manage>) =>
    (a?.body as { task?: { id: string } } | undefined)?.task?.id ?? '';
  return { get, manage, detail, finish, taskId };
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('BlackBox in the fixture world', () => {
  it('is an Unraid server with the real shape, valid by the contracts', () => {
    const { get, detail } = world();
    const d = detail();
    expect(isUnraidServer(d)).toBe(true);
    const u = d.unraid;
    expect(u?.version).toBe('7.3.1');
    expect(u?.array.disks.map((x) => x.name)).toEqual(['parity', 'parity2', 'disk1']);
    expect(u?.pools.map((p) => `${p.name}:${p.disks.length}`)).toEqual(['apps:4', 'data:9', 'storage:2']);
    expect(u?.shares).toHaveLength(17);
    expect(d.workloads?.libvirt?.guests.map((g) => [g.name, g.autostart])).toEqual([['pbs', true]]);
    const plex = d.workloads?.docker?.guests.find((g) => g.name === 'plex');
    expect(plex).toMatchObject({ autostart: true, template: true, updateAvailable: true });
    const fleet = HostFleet.parse(get('/fleet')?.body);
    expect(fleet.servers.find((s) => s.id === 'blackbox')?.platform).toBe('unraid');
  });

  it('refuses a parity check while parity is disabled, and stops the array only when confirmed', () => {
    const { manage, detail, finish, taskId } = world();
    expect(manage({ op: 'parity.start', platform: 'unraid', params: {} })?.status).toBe(409);
    expect(manage({ op: 'array.stop', platform: 'unraid', params: {} })?.status).toBe(400);
    const id = taskId(manage({ op: 'array.stop', platform: 'unraid', params: {}, confirm: true }));
    expect(id).toMatch(/^unraid:[0-9a-f]{16}$/);
    expect(detail().unraid?.array.state).toBe('stopping');
    expect(finish(id)?.status).toBe('ok');
    const d = detail();
    expect(d.unraid?.array.state).toBe('stopped');
    expect(d.workloads?.docker?.running).toBe(0);
    expect(d.hints.some((h) => h.kind === 'unraid.array_stopped')).toBe(true);
    finish(taskId(manage({ op: 'array.start', platform: 'unraid', params: {} })));
    // What starts with the server starts again.
    expect(detail().workloads?.docker?.guests.find((g) => g.name === 'plex')?.state).toBe('running');
    expect(detail().workloads?.docker?.guests.find((g) => g.name === 'immich_redis')?.state).toBe('stopped');
  });

  it('runs, pauses and cancels a parity check where parity works', () => {
    const { manage, detail, finish, taskId } = world('parity-ok');
    finish(taskId(manage({ op: 'parity.start', platform: 'unraid', params: { correct: false } })));
    expect(detail().unraid?.array.parity).toMatchObject({ state: 'running', action: 'check' });
    finish(taskId(manage({ op: 'parity.pause', platform: 'unraid', params: {} })));
    expect(detail().unraid?.array.parity.state).toBe('paused');
    expect(manage({ op: 'parity.cancel', platform: 'unraid', params: {} })?.status).toBe(400);
    finish(taskId(manage({ op: 'parity.cancel', platform: 'unraid', params: {}, confirm: true })));
    const p = detail().unraid?.array.parity;
    expect(p?.state).toBe('idle');
    expect(p?.last?.result).toBe('cancelled');
  });

  it('updates plugins (never Unraid itself), archives notifications and switches autostart', () => {
    const { manage, detail, finish, taskId } = world();
    expect(
      manage({
        op: 'plugin.update',
        platform: 'unraid',
        params: { plugin: 'unRAIDServer.plg' },
        confirm: true,
      })?.status,
    ).toBe(403);
    finish(
      taskId(manage({ op: 'plugin.update', platform: 'unraid', params: { plugin: 'all' }, confirm: true })),
    );
    const u = detail().unraid;
    expect(u?.plugins.filter((p) => p.update)).toEqual([]);
    expect(u?.plugins.find((p) => p.name === 'fix.common.problems')?.version).toBe('2026.10.16');
    expect(detail().hints.some((h) => h.kind === 'unraid.plugin_updates')).toBe(false);

    const first = detail().unraid?.notifications[0]?.id;
    expect(manage({ op: 'notification.archive', platform: 'unraid', params: { id: first } })?.status).toBe(
      200,
    );
    expect(detail().unraid?.notifications.some((n) => n.id === first)).toBe(false);
    manage({ op: 'notification.archive', platform: 'unraid', params: {} });
    expect(detail().unraid?.notifications).toEqual([]);

    expect(manage({ op: 'guest.autostart', guestId: 'libvirt:pbs', params: { on: false } })?.status).toBe(
      200,
    );
    expect(detail().workloads?.libvirt?.guests[0]?.autostart).toBe(false);
    finish(taskId(manage({ op: 'container.update', guestId: 'docker:plex', params: {}, confirm: true })));
    expect(detail().workloads?.docker?.guests.find((g) => g.name === 'plex')?.updateAvailable).toBe(false);
    expect(
      manage({ op: 'container.update', guestId: 'docker:immich_redis', params: {}, confirm: true })?.status,
    ).toBe(409);
  });

  it('spins one disk or all of them down; SSDs and the flash drive don’t spin', () => {
    const { manage, detail, finish, taskId } = world();
    expect(manage({ op: 'disk.spin_down', platform: 'unraid', params: { disk: 'disk1' } })?.status).toBe(400);
    finish(taskId(manage({ op: 'disk.spin_down', platform: 'unraid', params: { disk: 'data3' } })));
    const data = detail().unraid?.pools.find((p) => p.name === 'data');
    expect(data?.disks.find((x) => x.name === 'data3')).toMatchObject({ spunDown: true, tempC: null });
    expect(data?.disks.find((x) => x.name === 'data4')?.spunDown).toBe(false);
    finish(taskId(manage({ op: 'disk.spin_up', platform: 'unraid', params: { disk: 'all' } })));
    expect(detail().unraid?.pools.every((p) => p.disks.every((x) => !x.spunDown))).toBe(true);
  });
});

describe('Unraid words', () => {
  const real = () => {
    const d = world().detail();
    const u = d.unraid;
    if (!u) throw new Error('no Unraid detail');
    return { d, u };
  };

  it('name slots and file systems as Unraid does', () => {
    expect(['parity', 'parity2', 'disk1', 'apps3', 'flash'].map(unraidDiskName)).toEqual([
      'Parity',
      'Parity 2',
      'Disk 1',
      'Apps 3',
      'Flash',
    ]);
    expect(fsWords('luks:btrfs')).toBe('btrfs, encrypted');
    expect(fsWords('auto')).toBe('—');
  });

  it('read the array table like Unraid’s Main page', () => {
    const { u } = real();
    const { parity, data } = arrayGroups(u.array);
    expect(parity.map((x) => unraidDiskRow(x).status.text)).toEqual([
      'Disabled, no disk',
      'Disabled, no disk',
    ]);
    const d1 = unraidDiskRow(data[0] as never);
    expect(d1).toMatchObject({
      label: 'Disk 1',
      device: 'sdi',
      tempText: '31\u00a0°C',
      fsText: 'xfs',
      spin: 'SSD',
    });
    expect(d1.sizeText).toBe('2\u00a0TB');
    const data2 = u.pools[1]?.disks[1];
    expect(data2 && unraidDiskRow(data2)).toMatchObject({ label: 'Data 2', spin: 'Spinning', canSpin: true });
    expect(poolWords(u.pools[0] as never)).toBe('btrfs raid10, encrypted · 4 disks');
  });

  it('say when parity can’t protect the array', () => {
    const { u } = real();
    expect(parityView(u.array, NOW)).toMatchObject({ title: 'Parity is disabled', tone: 'bad' });
    expect(unraidAbilities(u)).toMatchObject({
      start: false,
      stop: true,
      checkParity: false,
      checkReason: 'Parity is disabled, so there’s nothing to check.',
      moverReason: 'No share moves files between a pool and the array.',
    });
    const running = world('parity-running').detail().unraid;
    expect(running && parityView(running.array, NOW)).toMatchObject({
      title: 'Parity check · 42\u00a0%',
      running: true,
    });
    expect(
      parityRunWords({
        at: '',
        durationS: 1,
        speedMbs: null,
        errors: 0,
        result: 'ok',
        action: 'recon D1 D2',
      }),
    ).toMatchObject({ action: 'Rebuild', result: 'No errors' });
  });

  it('say what stopping the array stops', () => {
    const { d, u } = real();
    const guests = [...(d.workloads?.docker?.guests ?? []), ...(d.workloads?.libvirt?.guests ?? [])];
    expect(arrayStopWords(u, guests, 'blackbox')).toBe(
      '12 running containers, 1 running VM and the shares stop too until the array is started again on blackbox.',
    );
  });

  it('read shares, plugins and the version line', () => {
    const { d, u } = real();
    expect(shareWhere({ primary: 'cache', secondary: 'array', moverAction: 'to_array' })).toBe(
      'cache → Array',
    );
    expect(shareWhere({ primary: 'cache', secondary: 'array', moverAction: 'to_pool' })).toBe(
      'Array → cache',
    );
    const rows = pluginRows(u);
    expect(rows.slice(0, 2).map((p) => p.name)).toEqual(['community.applications', 'fix.common.problems']);
    expect(rows.some((p) => p.file === 'unRAIDServer.plg')).toBe(false);
    expect(unraidVersionView(u)).toEqual({
      text: 'Unraid 7.3.1 · Pro',
      update: 'Unraid 7.3.2 is available — update it in Unraid.',
    });
    expect(unraidPageUrl(d, 'Tools/Update')).toBe('http://10.100.1.30/Tools/Update');
    expect(unraidPageUrl({ server: { ...d.server, address: null } }, 'Main')).toBeNull();
  });

  it('give Docker on Unraid its update, autostart and web page', () => {
    const { d } = real();
    const docker = d.workloads?.docker?.guests ?? [];
    const plex = docker.find((g) => g.name === 'plex') as HostGuest;
    const ml = docker.find((g) => g.name === 'immich_machine_learning') as HostGuest;
    expect(canUpdateContainer(plex, true)).toBe(true);
    expect(canUpdateContainer(ml, true)).toBe(false);
    expect(canUpdateContainer(plex, false)).toBe(false);
    expect(hasAutostart(plex, true)).toBe(true);
    expect(guestWebUi(plex)).toBe('http://10.100.1.30:32400/web');
    expect(guestWebUi({ ...plex, webUi: 'javascript:alert(1)' })).toBeNull();
  });

  it('give every hint its way out', () => {
    const { d } = real();
    const guests = d.workloads?.docker?.guests ?? [];
    const ctx = { guests, updateUrl: 'http://10.100.1.30/Tools/Update', canManage: true };
    const fixes = (kind: string) => {
      const h = d.hints.find((x) => x.kind === kind);
      if (!h) throw new Error(`no ${kind}`);
      return unraidHintFixes(h, ctx);
    };
    expect(fixes('unraid.plugin_updates').map((f) => f.label)).toEqual(['Update all', 'Open Plugins']);
    expect(fixes('unraid.os_update')).toEqual([
      { kind: 'link', href: 'http://10.100.1.30/Tools/Update', label: 'Update in Unraid' },
    ]);
    expect(fixes('docker.update_available')).toEqual([
      { kind: 'update_container', guestId: 'docker:plex', label: 'Update plex' },
      { kind: 'guest', guestId: 'docker:immich_machine_learning', label: 'Open immich_machine_learning' },
    ]);
    expect(fixes('unraid.notification')[0]).toMatchObject({ kind: 'archive', label: 'Archive' });
    const stopped = { kind: 'unraid.array_stopped', entity: 'array', detail: '', section: 'array' };
    expect(unraidHintFixes(stopped, ctx)).toEqual([{ kind: 'start_array', label: 'Start the array' }]);
    expect(unraidHintFixes(stopped, { ...ctx, canManage: false })).toEqual([
      { kind: 'tab', tab: 'array', label: 'Open Array' },
    ]);
    // An alert about the disks (section storage on other servers) opens Array.
    expect(
      unraidHintFixes({ kind: 'raid.degraded', entity: 'md1', detail: '', section: 'storage' }, ctx),
    ).toEqual([{ kind: 'tab', tab: 'array', label: 'Open Array' }]);
  });

  it('say what each change does in plain words', () => {
    expect(unraidChangeWords('array.start', 'blackbox')).toEqual({
      what: 'Starting the array on blackbox',
      started: 'Starting the array on blackbox.',
      finished: 'The array on blackbox is started.',
    });
    expect(unraidChangeWords('container.update', 'blackbox', { target: 'plex' }).finished).toBe(
      'plex on blackbox is up to date now.',
    );
    expect(unraidChangeWords('guest.autostart', 'blackbox', { target: 'pbs', on: false }).finished).toBe(
      'pbs no longer starts with blackbox.',
    );
    expect(unraidChangeWords('disk.spin_down', 'blackbox', { target: 'Data 3' }).finished).toBe(
      'Data 3 is spun down.',
    );
  });
});
