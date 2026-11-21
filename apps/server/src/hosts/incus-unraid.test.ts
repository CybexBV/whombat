/**
 * Incus and Unraid on Whombat's side, the pure parts (incus-unraid.md IU-02…IU-08; incus-unraid-server.md): the
 * server's kind and its own things mapped to the contract, the manage requests the new ops become, what the guest
 * this Whombat runs in refuses, the new calls in words, task outcomes with what the report adds, hints' ways out.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HostServerDetail, HostTask } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { TaskFollow } from './follow';
import { serverPlatform, toHostGuest, toHostIncusProfile, toHostServerDetail, toHostTask } from './map';
import { manageCall, manageText } from './routes';
import { noteSelfServers, runsThisWhombat, selfActionRefused, selfOpRefused } from './self';
import { hintLink } from './sources';
import { memoryTaskStore } from './testing/task-store';
import {
  backupNoun,
  serversAskWords,
  serversDoneWords,
  serversNoteWords,
  serversTaskWords,
  taskAfterText,
  taskOutcomeText,
} from './words';

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'testing/fixtures', name), 'utf8')) as Record<
    string,
    unknown
  >;
const NOW = new Date('2026-10-17T10:00:00Z');

describe('Incus and Unraid servers mapped', () => {
  it('reads the server’s kind; an unknown one is a standard page', () => {
    expect(serverPlatform('incus')).toBe('incus');
    expect(serverPlatform('unraid')).toBe('unraid');
    expect(serverPlatform('proxmox')).toBe('proxmox');
    expect(serverPlatform('truenas')).toBe('standard');
    expect(serverPlatform(undefined)).toBe('standard');
  });

  it('maps an Unraid server’s detail to the contract', () => {
    const raw = fixture('server-blackbox-unraid.json');
    (raw.server as Record<string, unknown>).detail_view = 'unraid';
    const d = toHostServerDetail(raw, [], null, NOW);
    expect(HostServerDetail.safeParse(d).error).toBeUndefined();
    expect(d.server.platform).toBe('unraid');
    expect(d.unraid?.array.state).toBe('started');
    expect(d.unraid?.array.disks.map((x) => x.slot)).toContain('parity');
    expect(d.unraid?.pools.length).toBe(3);
    expect(d.unraid?.osUpdate?.version).toBe('7.3.2');
    const plex = d.workloads?.docker?.guests.find((g) => g.id === 'docker:plex');
    expect(plex).toMatchObject({ updateAvailable: true, template: true });
    expect(typeof plex?.autostart).toBe('boolean');
  });

  it('is lenient with an odd Unraid or Incus part', () => {
    const d = toHostServerDetail(
      {
        server: { id: 'x', detail_view: 'unraid', hosts_this_whombat: true },
        unraid: {
          array: { state: 'weird', disks: [{ name: 'disk1', status: 'DISK_?' }] },
          notifications: null,
        },
        incus: {
          pools: [{ name: 'default', used_bytes: 'a lot' }],
          images: [{ type: 'virtual-machine', fingerprint: 'ab12' }, { type: 'container' }],
        },
      },
      [],
      null,
      NOW,
    );
    expect(HostServerDetail.safeParse(d).error).toBeUndefined();
    expect(d.server.hostsThisWhombat).toBe(true);
    expect(d.unraid?.array.state).toBe('invalid');
    expect(d.unraid?.array.disks[0]?.status).toBe('invalid');
    expect(d.unraid?.notifications).toEqual([]);
    expect(d.incus?.pools[0]?.usedBytes).toBeNull();
    expect(d.incus?.images[0]?.type).toBe('virtual-machine');
  });

  it('maps the self guest, autostart, a container’s page and template, and a task that can be stopped', () => {
    const g = toHostGuest(
      { id: 'incus:whombat-dev-box', platform: 'incus', self: true, autostart: true, template: true },
      'the-titan',
    );
    expect(g).toMatchObject({ self: true, autostart: true });
    // Proxmox's `template` means a template guest: only a Docker guest's is a dockerMan template.
    expect(g.template).toBeUndefined();
    expect(
      toHostGuest(
        { id: 'docker:plex', platform: 'docker', template: true, web_ui: 'http://x:32400/web' },
        'bb',
      ),
    ).toMatchObject({ template: true, webUi: 'http://x:32400/web' });
    expect(toHostGuest({ id: 'docker:a', platform: 'docker', self: false }, 'bb').self).toBeUndefined();
    // Whombat's own containers keep their label, so the apps can leave them out; other labels don't come through.
    expect(
      toHostGuest({ id: 'docker:wb', platform: 'docker', labels: { 'whombat.service': '1', x: 'y' } }, 'bb')
        .labels,
    ).toEqual({ 'whombat.service': '1' });
    expect(
      toHostGuest({ id: 'docker:a', platform: 'docker', labels: { x: 'y' } }, 'bb').labels,
    ).toBeUndefined();
    const t = toHostTask({
      id: 'incus:1b2c',
      type: 'backup',
      status: 'running',
      started: '2026-10-17T09:00:00Z',
      cancellable: true,
    });
    expect(HostTask.safeParse(t).error).toBeUndefined();
    expect(t.cancellable).toBe(true);
    expect(
      toHostIncusProfile({
        profile: { name: 'web', config: { 'limits.cpu': 2 }, devices: { eth0: { type: 'nic' } } },
      }),
    ).toMatchObject({
      name: 'web',
      project: 'default',
      config: { 'limits.cpu': '2' },
      devices: { eth0: { type: 'nic' } },
    });
  });
});

describe('the new ops as the service’s routes', () => {
  it('Incus: rename, move, publish, images, profiles, volumes', () => {
    expect(
      manageCall('the-titan', { op: 'guest.rename', guestId: 'incus:web', params: { name: 'web2' } }),
    ).toEqual({
      method: 'POST',
      path: '/api/v1/servers/the-titan/guests/incus:web/rename',
      body: { name: 'web2' },
    });
    expect(
      manageCall('the-titan', {
        op: 'guest.move',
        guestId: 'incus:web',
        params: { pool: 'fast' },
        confirm: true,
      }),
    ).toMatchObject({ body: { pool: 'fast', confirm: true } });
    expect(
      manageCall('the-titan', { op: 'image.delete', params: { fingerprint: 'abc123', project: 'ci' } }),
    ).toEqual({
      method: 'DELETE',
      path: '/api/v1/servers/the-titan/incus/images/abc123',
      query: { project: 'ci' },
    });
    expect(
      manageCall('the-titan', {
        op: 'profile.update',
        params: { profile: 'web', set: { 'limits.cpu': '2' }, devices: { eth0: null } },
        digest: 'd1',
      }),
    ).toEqual({
      method: 'PUT',
      path: '/api/v1/servers/the-titan/incus/profiles/web',
      body: { set: { 'limits.cpu': '2' }, devices: { eth0: null }, digest: 'd1' },
    });
    expect(
      manageCall('the-titan', { op: 'profile.delete', params: { profile: 'old' }, confirm: true }),
    ).toMatchObject({ query: { confirm: '1' } });
    expect(
      manageCall('the-titan', {
        op: 'volume.create',
        params: { pool: 'default', name: 'data', size: '10GiB', contentType: 'block' },
      }),
    ).toEqual({
      method: 'POST',
      path: '/api/v1/servers/the-titan/incus/pools/default/volumes',
      body: { name: 'data', size: '10GiB', content_type: 'block' },
    });
    expect(
      manageCall('the-titan', {
        op: 'volume.resize',
        params: { pool: 'default', volume: 'data', size: '20GiB' },
      }).path,
    ).toBe('/api/v1/servers/the-titan/incus/pools/default/volumes/data/resize');
  });

  it('Incus: create from an image (template is the image), backups with names and expiry, restore as new', () => {
    expect(
      manageCall('the-titan', {
        op: 'guest.create',
        platform: 'incus',
        params: {
          kind: 'container',
          name: 'dns',
          template: 'images:debian/13',
          project: 'lab',
          cloudInit: '#cloud-config',
        },
      }).body,
    ).toEqual({
      platform: 'incus',
      kind: 'container',
      name: 'dns',
      image: 'images:debian/13',
      project: 'lab',
      cloud_init: '#cloud-config',
    });
    expect(
      manageCall('the-titan', {
        op: 'backup.create',
        guestId: 'incus:web',
        params: { name: 'before-upgrade', expiresAt: '2026-10-24T00:00:00Z', instanceOnly: true },
      }).body,
    ).toEqual({ name: 'before-upgrade', expires_at: '2026-10-24T00:00:00Z', instance_only: true });
    expect(
      manageCall('the-titan', {
        op: 'backup.restore',
        guestId: 'incus:web',
        params: { platform: 'incus', volume: 'before-upgrade', name: 'web-restored' },
      }).body,
    ).toEqual({ platform: 'incus', volume: 'before-upgrade', guest: 'incus:web', name: 'web-restored' });
    expect(
      manageCall('the-titan', {
        op: 'backup.delete',
        guestId: 'incus:web',
        params: { platform: 'incus', volume: 'before-upgrade' },
      }).query,
    ).toEqual({ platform: 'incus', guest: 'incus:web', volume: 'before-upgrade' });
  });

  it('Unraid: the array, parity, disks, plugins, notifications, containers, autostart', () => {
    expect(manageCall('blackbox', { op: 'array.start', params: {} })).toEqual({
      method: 'POST',
      path: '/api/v1/servers/blackbox/unraid/array/start',
    });
    expect(manageCall('blackbox', { op: 'array.stop', params: {}, confirm: true }).body).toEqual({
      confirm: true,
    });
    expect(manageCall('blackbox', { op: 'parity.start', params: { correct: true } }).body).toEqual({
      correct: true,
    });
    expect(manageCall('blackbox', { op: 'disk.spin_down', params: { disk: 'all' } }).path).toBe(
      '/api/v1/servers/blackbox/unraid/disks/all/spin-down',
    );
    expect(
      manageCall('blackbox', {
        op: 'plugin.update',
        params: { plugin: 'unassigned.devices.plg' },
        confirm: true,
      }),
    ).toEqual({
      method: 'POST',
      path: '/api/v1/servers/blackbox/unraid/plugins/unassigned.devices.plg/update',
      body: { confirm: true },
    });
    expect(manageCall('blackbox', { op: 'notification.archive', params: {} }).body).toEqual({});
    expect(
      manageCall('blackbox', { op: 'container.update', guestId: 'docker:plex', params: {}, confirm: true })
        .path,
    ).toBe('/api/v1/servers/blackbox/guests/docker:plex/update');
    expect(
      manageCall('blackbox', { op: 'guest.autostart', guestId: 'libvirt:pbs', params: { on: false } }),
    ).toEqual({
      method: 'PUT',
      path: '/api/v1/servers/blackbox/guests/libvirt:pbs/autostart',
      body: { on: false },
    });
    // A param the route doesn't pass is refused (PX-S01), here too.
    expect(() => manageCall('blackbox', { op: 'mover.start', params: { now: true } })).toThrow('“now”');
    expect(() => manageCall('blackbox', { op: 'disk.spin_up', params: {} })).toThrow('disk');
  });

  it('titles each change for Done recently', () => {
    expect(manageText('guest.rename', 'the-titan', 'web', { name: 'web2' })).toBe(
      'Renamed web on the-titan to web2',
    );
    expect(manageText('guest.move', 'the-titan', 'web', { project: 'ci' })).toBe(
      'Moved web on the-titan to the project ci',
    );
    expect(manageText('parity.start', 'blackbox', null, { correct: true })).toBe(
      'Started a parity check with corrections on blackbox',
    );
    expect(manageText('plugin.update', 'blackbox', null, { plugin: 'all' })).toBe(
      'Updated the plugins on blackbox',
    );
    expect(manageText('disk.spin_up', 'blackbox', null, { disk: 'disk1' })).toBe('Spun up disk1 on blackbox');
    expect(manageText('guest.autostart', 'blackbox', 'plex', { on: false })).toBe(
      'plex on blackbox no longer starts by itself',
    );
    expect(manageText('container.update', 'blackbox', 'plex')).toBe('Updated plex on blackbox');
    expect(manageText('backup.restore', 'the-titan', 'web', { platform: 'incus', name: 'web-2' })).toBe(
      'Restored a copy of web on the-titan as web-2',
    );
  });
});

describe('the guest this Whombat runs in (IU-02)', () => {
  it('keeps snapshots, backups, copies and a restore as new; refuses the rest', () => {
    for (const action of ['stop', 'shutdown', 'force_stop', 'restart', 'reboot', 'pause', 'snapshot_restore'])
      expect(selfActionRefused(action), action).toBe(true);
    for (const action of ['start', 'resume', 'snapshot_create', 'snapshot_delete'])
      expect(selfActionRefused(action), action).toBe(false);
    for (const op of [
      'config.set',
      'disk.resize',
      'guest.delete',
      'guest.rename',
      'guest.move',
      'guest.publish',
    ])
      expect(selfOpRefused(op), op).toBe(true);
    expect(selfOpRefused('guest.autostart')).toBe(true);
    expect(selfOpRefused('backup.create')).toBe(false);
    expect(selfOpRefused('guest.clone')).toBe(false);
    expect(selfOpRefused('backup.restore')).toBe(true);
    expect(selfOpRefused('backup.restore', true)).toBe(false);
  });

  it('knows from the fleet which servers run this Whombat, and the question says it goes down too', () => {
    noteSelfServers({
      servers: [{ id: 'the-titan', hostname: 'thetitan', hosts_this_whombat: true }, { id: 'pve-02' }],
    });
    expect(runsThisWhombat('the-titan')).toBe(true);
    expect(runsThisWhombat('TheTitan')).toBe(true);
    expect(runsThisWhombat('pve-02')).toBe(false);
    expect(serversAskWords('server_power', { server: 'the-titan', action: 'reboot' })).toBe(
      'reboot the-titan, the server this Whombat runs on',
    );
    expect(serversNoteWords('server_power', { server: 'the-titan', action: 'reboot' })).toBe(
      'This Whombat goes down too.',
    );
    expect(serversNoteWords('server_power', { server: 'pve-02', action: 'reboot' })).toBeNull();
    expect(serversAskWords('server_power', { server: 'pve-02', action: 'reboot' })).toBe('reboot pve-02');
    expect(
      serversDoneWords(
        'server_power',
        { server: 'the-titan', action: 'reboot' },
        { ok: true, isError: false, content: '{}' },
      ),
    ).toBe('Rebooting the-titan now. This Whombat goes down too and comes back with it.');
    noteSelfServers({ servers: [] });
    expect(runsThisWhombat('the-titan')).toBe(false);
  });
});

describe('the new calls in words', () => {
  const ask = (tool: string, args: Record<string, unknown>) => serversAskWords(tool, args, NOW);
  const done = (tool: string, args: Record<string, unknown>) =>
    serversDoneWords(tool, args, { ok: true, isError: false, content: '{}' }, NOW);

  it('asks plainly', () => {
    expect(ask('guest_rename', { server: 'the-titan', guest: 'web', name: 'web2' })).toBe(
      'rename web on the-titan to web2',
    );
    expect(ask('guest_move', { server: 'the-titan', guest: 'web', pool: 'fast', project: 'ci' })).toBe(
      'move web on the-titan to the pool fast in the project ci',
    );
    expect(ask('incus_image', { server: 'the-titan', action: 'download', alias: 'debian/13' })).toBe(
      'download the image debian/13 to the-titan',
    );
    expect(ask('incus_profile_set', { server: 'the-titan', action: 'delete', profile: 'old' })).toBe(
      'delete the profile old on the-titan',
    );
    expect(
      ask('storage_volume', { server: 'the-titan', action: 'delete', pool: 'default', volume: 'data' }),
    ).toBe('delete the volume data on the-titan');
    expect(ask('unraid_array', { server: 'blackbox', action: 'stop' })).toBe('stop the array of blackbox');
    expect(ask('unraid_array', { server: 'blackbox', action: 'parity_check', correct: true })).toBe(
      'check parity on blackbox and write corrections',
    );
    expect(ask('unraid_array', { server: 'blackbox', action: 'spin_down' })).toBe(
      'spin down every disk of blackbox',
    );
    expect(
      ask('unraid_plugins', { server: 'blackbox', action: 'update', plugin: 'unassigned.devices.plg' }),
    ).toBe('update the plugin unassigned.devices on blackbox');
    expect(ask('container_update', { server: 'blackbox', action: 'update', guest: 'plex' })).toBe(
      'update plex on blackbox',
    );
    expect(ask('guest_autostart', { server: 'blackbox', guest: 'pbs', on: true })).toBe(
      'have pbs on blackbox start with its server',
    );
  });

  it('says what it did or is doing', () => {
    expect(done('unraid_array', { server: 'blackbox', action: 'parity_check' })).toBe(
      'Checking parity on blackbox now.',
    );
    expect(done('unraid_array', { server: 'blackbox', action: 'archive_notifications' })).toBe(
      'Archived the notifications on blackbox.',
    );
    expect(done('guest_autostart', { server: 'blackbox', guest: 'plex', on: false })).toBe(
      'plex on blackbox no longer starts with its server.',
    );
  });

  it('tells how the long ones ended (IU-07)', () => {
    const w = (tool: string, args: Record<string, unknown>, names: Record<string, unknown> = {}) =>
      serversTaskWords(tool, args, { server: 'blackbox', ...names });
    const parity = w('unraid_array', { action: 'parity_check' }, { label: 'BlackBox' });
    expect(parity?.after).toBe('parity');
    expect(taskOutcomeText(parity as NonNullable<typeof parity>, 'ok', null)).toBe(
      'The parity check on BlackBox is done.',
    );
    const plex = w('container_update', { action: 'update' }, { guest: 'plex' });
    expect(taskOutcomeText(plex as NonNullable<typeof plex>, 'ok', null)).toBe(
      'plex on blackbox is up to date now.',
    );
    const backup = serversTaskWords(
      'guest_backup',
      { action: 'create' },
      { server: 'the-titan', guest: 'web', platform: 'incus' },
    );
    expect(taskOutcomeText(backup as NonNullable<typeof backup>, 'ok', null)).toBe(
      'web on the-titan is backed up.',
    );
    const rename = serversTaskWords('guest_rename', { name: 'web2' }, { server: 'the-titan', guest: 'web' });
    expect(taskOutcomeText(rename as NonNullable<typeof rename>, 'error', 'Instance is running')).toBe(
      'Renaming web on the-titan to web2 didn’t work: it has to be stopped first.',
    );
    // Short ones aren't followed.
    expect(w('unraid_array', { action: 'spin_up' })).toBeNull();
    expect(backupNoun('whombat-20261016-0200', NOW)).toBe('yesterday’s backup');
  });

  it('adds what the report says after a clean end', () => {
    const since = Date.parse('2026-10-17T09:00:00Z');
    const detail = (errors: number, at = '2026-10-17T09:30:00Z') =>
      ({
        unraid: {
          array: { parity: { last: { at, errors } } },
          plugins: [
            { name: 'a', update: '2' },
            { name: 'b', update: null },
          ],
        },
        workloads: { docker: { guests: [{ name: 'plex', updateAvailable: true }, { name: 'sonarr' }] } },
      }) as unknown as Parameters<typeof taskAfterText>[1];
    expect(taskAfterText('parity', detail(0), since)).toBe('No errors.');
    expect(taskAfterText('parity', detail(3), since)).toBe('It found 3 errors.');
    expect(taskAfterText('parity', detail(1), since)).toBe('It found 1 error.');
    // A report older than the check doesn't tell; the task's own message may.
    expect(taskAfterText('parity', detail(0, '2026-09-01T00:00:00Z'), since)).toBeNull();
    expect(
      taskAfterText('parity', detail(0, '2026-09-01T00:00:00Z'), since, 'Parity check finished (2 errors)'),
    ).toBe('It found 2 errors.');
    expect(taskAfterText('plugins', detail(0), since)).toBe('a has an update.');
    expect(taskAfterText('containers', detail(0), since)).toBe('plex has an update.');
  });

  it('tells the outcome with what the report adds', async () => {
    const store = memoryTaskStore();
    const follow = new TaskFollow({ store, enrich: async () => ({ text: 'No errors.' }) });
    const words = serversTaskWords('unraid_array', { action: 'parity_check' }, { server: 'blackbox' });
    await follow.remember({
      taskId: 'unraid:1',
      serverId: 'blackbox',
      serverName: 'blackbox',
      burrowId: 'b',
      conversationId: 'c',
      threadRootId: null,
      agentId: 'a',
      personId: null,
      words: words as NonNullable<typeof words>,
    });
    await follow.finished('blackbox', 'unraid:1', 'ok', null);
    expect(store.told.map((t) => t.end.words)).toEqual(['The parity check on blackbox is done. No errors.']);
  });
});

describe('hints with a way out (IU-08)', () => {
  const hint = (kind: string, detail = '', section = '') => ({ serverId: 'blackbox', kind, detail, section });
  it('Unraid and Incus hints open the tab that fixes them', () => {
    expect(hintLink(hint('unraid.array_stopped'), [], 'unraid')).toEqual({
      href: '/things/server%3Ablackbox?tab=array',
      wayOut: 'Start the array.',
    });
    expect(hintLink(hint('unraid.plugin_updates'), [], 'unraid').href).toBe(
      '/things/server%3Ablackbox?tab=plugins',
    );
    expect(hintLink(hint('unraid.os_update'), [], 'unraid').wayOut).toBe('Update it in Unraid.');
    expect(hintLink(hint('incus.pool_full'), [], 'incus').href).toBe('/things/server%3Ablackbox?tab=storage');
    expect(
      hintLink(
        hint('incus.no_snapshots', 'mqtt-bridge'),
        [{ id: 'incus:mqtt-bridge', name: 'mqtt-bridge' }],
        'incus',
      ),
    ).toEqual({
      href: '/things/server%3Ablackbox?guest=incus%3Amqtt-bridge&gtab=snapshots',
      wayOut: 'Set up automatic restore points for it.',
    });
  });

  it('reads the guests an Incus hint names before what it says about them', () => {
    const guests = [
      { id: 'incus:web', name: 'web' },
      { id: 'incus:db', name: 'db' },
    ];
    expect(
      hintLink(hint('incus.no_snapshots', 'web · no backup in 30 days either'), guests, 'incus').href,
    ).toBe('/things/server%3Ablackbox?guest=incus%3Aweb&gtab=snapshots');
    expect(
      hintLink(hint('incus.no_snapshots', 'web, db · no backup in 30 days either'), guests, 'incus'),
    ).toEqual({
      href: '/things/server%3Ablackbox?tab=guests',
      wayOut: 'Set up automatic restore points for them.',
    });
  });

  it('a container update on Unraid links to the container; elsewhere to its tab', () => {
    const guests = [{ id: 'docker:plex', name: 'plex' }];
    expect(hintLink(hint('docker.update_available', 'plex', 'guests'), guests, 'unraid')).toEqual({
      href: '/things/server%3Ablackbox?guest=docker%3Aplex',
      wayOut: 'Update it.',
    });
    expect(hintLink(hint('docker.update_available', 'plex', 'guests'), guests, 'standard')).toEqual({
      href: '/things/server%3Ablackbox?tab=guests',
      wayOut: null,
    });
  });
});

describe('QEMU/KVM through libvirt (IU-13)', () => {
  it('maps the kind and the libvirt part of a detail', () => {
    expect(serverPlatform('libvirt')).toBe('libvirt');
    const d = toHostServerDetail(
      {
        server: { id: 'kvm-lab', detail_view: 'libvirt' },
        libvirt: {
          version: '12.2.0',
          qemu: '10.1.0',
          pools: [
            {
              name: 'default',
              type: 'dir',
              active: true,
              used_bytes: 6e10,
              total_bytes: 1e11,
              avail_bytes: 4e10,
            },
          ],
          networks: [
            { name: 'default', active: true, forward: 'nat', bridge: 'virbr0', dhcp: true, used_by: 2 },
          ],
          folders: null,
          firmware: { uefi: true, secure_boot: true, tpm: false },
          backups_dir: '/var/lib/libvirt/images/.whombat-backups',
        },
      },
      [],
      null,
      NOW,
    );
    expect(HostServerDetail.safeParse(d).error).toBeUndefined();
    expect(d.server.platform).toBe('libvirt');
    expect(d.libvirt?.pools[0]).toMatchObject({ name: 'default', usedBytes: 6e10, volumes: 0 });
    expect(d.libvirt?.firmware).toEqual({ uefi: true, secureBoot: true, tpm: false });
  });

  it('sends a libvirt pool’s volumes under /libvirt and a create with its OS type', () => {
    expect(
      manageCall('kvm-lab', {
        op: 'volume.create',
        platform: 'libvirt',
        params: { pool: 'default', name: 'data.qcow2', size: '20GiB', format: 'qcow2' },
      }),
    ).toEqual({
      method: 'POST',
      path: '/api/v1/servers/kvm-lab/libvirt/pools/default/volumes',
      body: { name: 'data.qcow2', size: '20GiB', format: 'qcow2' },
    });
    expect(
      manageCall('kvm-lab', { op: 'volume.delete', params: { pool: 'default', volume: 'x' }, confirm: true })
        .path,
    ).toBe('/api/v1/servers/kvm-lab/incus/pools/default/volumes/x');
    expect(
      manageCall('kvm-lab', {
        op: 'guest.create',
        platform: 'libvirt',
        params: {
          kind: 'vm',
          name: 'win11',
          osVariant: 'win11',
          iso: 'isos/win11.iso',
          diskGb: 64,
          bridge: 'br0',
        },
      }).body,
    ).toEqual({
      platform: 'libvirt',
      kind: 'vm',
      name: 'win11',
      os_variant: 'win11',
      iso: 'isos/win11.iso',
      disk_gb: 64,
      bridge: 'br0',
    });
  });

  it('says a QEMU/KVM backup in words and its ways out', () => {
    expect(backupNoun('20261016-020000', NOW)).toBe('yesterday’s backup');
    const w = serversTaskWords(
      'guest_backup',
      { action: 'create' },
      { server: 'kvm-lab', guest: 'win11', platform: 'libvirt' },
    );
    expect(taskOutcomeText(w as NonNullable<typeof w>, 'ok', null)).toBe('win11 on kvm-lab is backed up.');
    const dl = serversTaskWords(
      'storage_content',
      { action: 'download', storage: 'folder:isos', filename: 'debian-13.iso' },
      { server: 'blackbox' },
    );
    expect(taskOutcomeText(dl as NonNullable<typeof dl>, 'ok', null)).toBe(
      'debian-13.iso is on the ISO folder on blackbox now.',
    );
    const h = (kind: string, detail = '') => ({ serverId: 'kvm-lab', kind, detail, section: '' });
    expect(hintLink(h('libvirt.pool_full'), [], 'libvirt')).toEqual({
      href: '/things/server%3Akvm-lab?tab=storage',
      wayOut: 'Free up space or add more.',
    });
    expect(
      hintLink(h('libvirt.no_backup', 'pfsense'), [{ id: 'libvirt:pfsense', name: 'pfsense' }], 'libvirt'),
    ).toEqual({
      href: '/things/server%3Akvm-lab?guest=libvirt%3Apfsense&gtab=backups',
      wayOut: 'Back it up now.',
    });
  });
});
