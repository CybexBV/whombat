import {
  PS5_MANAGER_ID,
  PS5_OFFICIAL_REPOSITORY,
  PS5_WEBKIT_INSTALLER,
  type Ps5UpdateLine,
} from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { ConnectionRequest } from '../../connections/http';
import type { Ps5Context, Ps5Snapshot } from '../../connections/ps5-api';
import { ConnectionArgumentError } from '../../connections/request';
import type { CatalogConnectionRow } from '../../connections/types';
import type { Services } from '../../services';
import { ps5Notices, ps5View } from './ps5';
import { plain, ps5UpdateActions, updatesKey } from './ps5-update';
import type { KindActionCtx } from './registry';
import { slotProblems } from './slots';

const row = {
  id: 'con_ps5',
  access: 'manage',
  label: 'PS5',
  catalogId: 'ps5',
  fields: {},
} as unknown as CatalogConnectionRow;
const lookOnly = { ...row, access: 'read' } as CatalogConnectionRow;
const discovery = Buffer.from('HTTP/1.1 200 Ok\nhost-type:PS5\nhost-name:PS5-103\nsystem-version:10010000\n');

const kstuff = {
  id: 'kstuff-lite',
  name: 'kstuff-lite',
  filename: 'kstuff-lite_v1.11.elf',
  version: 'v1.11',
  checksum: 'd'.repeat(64),
  description: 'Lite version of kstuff',
};
const manager = {
  id: PS5_MANAGER_ID,
  name: 'Payload Manager',
  filename: 'pldmgr.elf',
  version: 'v0.7.0',
  checksum: 'e'.repeat(64),
  description: '',
};
const webkit = {
  id: PS5_WEBKIT_INSTALLER,
  name: 'WebKit Autoloader installer',
  filename: 'WebKit-Autoloader-Installer_v0.7.2.elf',
  version: 'v0.7.2',
  checksum: 'f'.repeat(64),
  description: 'FW 7.00-13.60',
};
const local = { slot: 'local/kstuff-lite', filename: 'kstuff-lite_v1.10.elf' };
const installer = {
  slot: 'repo/webkit-autoloader-installer@1234',
  filename: 'WebKit-Autoloader-Installer_v0.7.1.elf',
  id: PS5_WEBKIT_INSTALLER,
  version: 'v0.7.1',
  checksum: 'c'.repeat(64),
  source_url: PS5_OFFICIAL_REPOSITORY,
};

/** A console that keeps what it is told: downloads become slots, startup changes stick. */
function fakePs5(releases: object[] = [kstuff, manager, webkit]) {
  const state = {
    self: { running_version: 'v0.6.3', pending_version: '' },
    items: [local, installer] as object[],
    config: { AUTOLOAD_ENABLED: true, AUTOLOAD_LIST: 'local/kstuff-lite,!3000', AUTOLOAD_DELAY: 5 },
  };
  const requests: ConnectionRequest[] = [];
  const reply = (body: unknown, status = 200) => ({
    status,
    headers: {},
    body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const ctx: Ps5Context = {
    baseUrl: 'http://192.168.1.20:8084',
    fields: {},
    datagram: async () => discovery,
    send: async (req) => {
      requests.push(req);
      const url = new URL(req.url);
      switch (url.pathname) {
        case '/list_payloads':
          return reply({ self: state.self, items: state.items });
        case '/get_config':
          return reply(state.config);
        case '/repository_payloads':
          return reply({
            sources: [{ url: PS5_OFFICIAL_REPOSITORY, name: 'Official Repository', payloads: releases }],
          });
        case '/repository_install': {
          const r = releases.find(
            (x) => (x as { id: string }).id === url.searchParams.get('id'),
          ) as typeof kstuff;
          if (r.id === PS5_MANAGER_ID) state.self = { ...state.self, pending_version: r.version };
          else state.items.push({ ...r, slot: `repo/${r.id}@e8cce5d1`, source_url: PS5_OFFICIAL_REPOSITORY });
          return reply({ ok: true });
        }
        case '/set_config':
          state.config = JSON.parse(String(req.body));
          return reply({ ok: true });
        case '/history_list':
          return reply({ history: [] });
        default:
          if (url.pathname.startsWith('/loadpayload')) return reply('OK');
          return reply({}, 404);
      }
    },
  };
  return {
    ctx,
    state,
    requests,
    writes: () => requests.filter((r) => r.method === 'POST').map((r) => new URL(r.url).pathname),
  };
}

const actx = {
  services: {} as Services,
  row,
  now: new Date('2026-11-08T12:00:00Z'),
  timeZone: 'UTC',
} as KindActionCtx;

const line = (over: Partial<Ps5UpdateLine>): Ps5UpdateLine => ({
  slot: 'local/kstuff-lite',
  name: 'kstuff-lite',
  installed: 'v1.10',
  source: 'uploaded',
  available: { id: 'kstuff-lite', version: 'v1.11', checksum: 'd'.repeat(64) },
  newer: true,
  startup: true,
  firmware: null,
  fits: null,
  ...over,
});
const managerLine = line({
  slot: PS5_MANAGER_ID,
  name: 'Payload Manager',
  installed: 'v0.6.3',
  source: 'repository',
  startup: false,
  available: { id: PS5_MANAGER_ID, version: 'v0.7.0', checksum: 'e'.repeat(64) },
});
const webkitLine = line({
  slot: installer.slot,
  name: 'WebKit Autoloader installer',
  installed: 'v0.7.1',
  source: 'repository',
  startup: false,
  available: { id: PS5_WEBKIT_INSTALLER, version: 'v0.7.2', checksum: 'f'.repeat(64) },
});

const snapshot = (updates: Ps5UpdateLine[]): Ps5Snapshot => ({
  payloads: { self: { running_version: 'v0.6.3', pending_version: '' }, items: [local] },
  history: null,
  startup: null,
  releases: null,
  updates,
  console: { state: 'awake', name: 'PS5-103', firmware: '10.01' },
  power: null,
  webkit: null,
  config: null,
  processes: { processes: [{ pid: 87, name: 'shadowmountplus.elf', memory: 24.9, is_daemon: true }] },
  shadow: null,
  games: null,
  storage: null,
  unavailable: [],
});
const at = { now: actx.now, timeZone: 'UTC', buttons: { row } };

describe('PS5 updates on the page', () => {
  it('puts updates in Live with an Update button each and Update all, and keeps running homebrew below', () => {
    const view = ps5View(snapshot([line({}), managerLine, webkitLine]), at);
    expect(slotProblems(view)).toEqual([]);
    const live = view.panels[0];
    expect(live?.kind === 'list' && live.id).toBe('updates');
    if (live?.kind !== 'list') throw new Error('no Live');
    expect(
      live.items.map((i) => i.actions?.[0] && [i.actions[0].action, i.actions[0].target, i.actions[0].value]),
    ).toEqual([
      ['update', 'local/kstuff-lite', 'v1.11'],
      ['update', PS5_MANAGER_ID, 'v0.7.0'],
      ['update', installer.slot, 'v0.7.2'],
    ]);
    expect(live.items.every((i) => i.actions?.[0]?.allowed && i.actions[0].confirm)).toBe(true);
    // WebKit Autoloader runs on the PS5 and needs a restart: it keeps its own button.
    expect(live.buttons?.[0]).toMatchObject({
      action: 'update-all',
      value: updatesKey([line({}), managerLine]),
    });
    expect(live.buttons?.[0]?.confirm?.body).toContain('WebKit Autoloader');
    expect(view.panels.some((p) => p.id === 'running' && p.place === 'main')).toBe(true);
  });

  it('keeps Running homebrew in Live while nothing waits', () => {
    const view = ps5View(snapshot([line({ newer: false })]), at);
    expect(view.panels[0]?.id).toBe('running');
    expect(view.panels.some((p) => p.id === 'updates')).toBe(false);
    expect(slotProblems(view)).toEqual([]);
  });

  it('draws a button disabled with the reason: another firmware, no checksum, Look only', () => {
    const items = (s: Ps5Snapshot, buttons = { row }) => {
      const live = ps5View(s, { ...at, buttons }).panels[0];
      return live?.kind === 'list' ? live.items.map((i) => i.actions?.[0]) : [];
    };
    const [misfit, unchecked] = items(
      snapshot([
        line({ fits: false, firmware: { from: '7.00', to: '9.60' } }),
        line({
          slot: 'local/ftpsrv',
          name: 'ftpsrv',
          available: { id: 'ftpsrv', version: 'v0.22', checksum: '' },
        }),
      ]),
    );
    expect(misfit).toMatchObject({ allowed: false, reason: expect.stringContaining('9.60') });
    expect(unchecked).toMatchObject({ allowed: false, reason: expect.stringContaining('checksum') });
    expect(items(snapshot([line({})]), { row: lookOnly })[0]).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('Look only'),
    });
  });

  it('gives Worth a look the same button, or Update all for several', () => {
    expect(ps5Notices(snapshot([line({})]), { row })[0]?.action).toMatchObject({ action: 'update' });
    expect(ps5Notices(snapshot([line({}), managerLine]), { row })[0]?.action).toMatchObject({
      action: 'update-all',
    });
    expect(ps5Notices(snapshot([line({})]))[0]?.action).toBeUndefined();
  });
});

describe('PS5 update actions', () => {
  it('updates one payload to the version shown and moves startup to it', async () => {
    const ps5 = fakePs5();
    const done = await ps5UpdateActions(() => ps5.ctx).update?.(actx, { target: local.slot, value: 'v1.11' });
    expect(done?.title).toContain('kstuff-lite');
    expect(done?.title).toContain('v1.11');
    expect(ps5.writes()).toEqual(['/repository_install', '/set_config']);
    expect(ps5.state.config.AUTOLOAD_LIST).toBe('repo/kstuff-lite@e8cce5d1,!3000');
  });

  it('refuses before writing when a newer version came out, it is up to date, or it isn’t there', async () => {
    for (const input of [
      { target: local.slot, value: 'v1.10.9' },
      { target: 'local/missing', value: 'v1.11' },
    ]) {
      const ps5 = fakePs5();
      await expect(ps5UpdateActions(() => ps5.ctx).update?.(actx, input)).rejects.toMatchObject({
        code: 'conflict',
      });
      expect(ps5.writes()).toEqual([]);
    }
    const current = fakePs5([{ ...kstuff, version: 'v1.10' }]);
    await expect(ps5UpdateActions(() => current.ctx).update?.(actx, { target: local.slot })).rejects.toThrow(
      'up to date',
    );
    expect(current.writes()).toEqual([]);
  });

  it('downloads Payload Manager’s update without running anything', async () => {
    const ps5 = fakePs5();
    const done = await ps5UpdateActions(() => ps5.ctx).update?.(actx, {
      target: PS5_MANAGER_ID,
      value: 'v0.7.0',
    });
    expect(done?.message).toContain('Payload Manager');
    expect(ps5.writes()).toEqual(['/repository_install']);
    expect(ps5.state.self.pending_version).toBe('v0.7.0');
  });

  it('updates all but WebKit Autoloader, only as the page showed them', async () => {
    const shown = updatesKey([line({}), managerLine]);
    const stale = fakePs5();
    await expect(
      ps5UpdateActions(() => stale.ctx)['update-all']?.(actx, { value: 'something-else' }),
    ).rejects.toThrow('changed');
    expect(stale.writes()).toEqual([]);
    const ps5 = fakePs5();
    const done = await ps5UpdateActions(() => ps5.ctx)['update-all']?.(actx, { value: shown });
    expect(ps5.writes()).toEqual(['/repository_install', '/set_config', '/repository_install']);
    expect(ps5.requests.some((r) => r.url.includes('loadpayload'))).toBe(false);
    expect(done?.message).toContain('kstuff-lite v1.11');
    expect(done?.message).toContain('Payload Manager v0.7.0');
  });

  it('keeps tool hints out of a person’s words', () => {
    const hinted = plain(
      new ConnectionArgumentError('That slot holds another payload. Read ps5_payload_updates again.'),
    );
    expect(hinted.code).toBe('conflict');
    expect(hinted.message).not.toMatch(/ps5_/);
    expect(plain(new ConnectionArgumentError('That payload already has this version.')).message).toContain(
      'already',
    );
    expect(plain(new Error('socket hang up')).code).toBe('unavailable');
  });
});
