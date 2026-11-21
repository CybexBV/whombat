import { PS5_OFFICIAL_REPOSITORY, PS5_WEBKIT_INSTALLER } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { ConnectionRequest } from '../http';
import { ps5CoverPath, ps5PictureUrl, ps5ServiceUrl, readPs5Console, readPs5Snapshot } from '../ps5-api';
import { callWordsFor } from './index';
import { PS5_ADAPTER } from './ps5';
import type { AdapterContext } from './types';

const checksum = 'a'.repeat(64);
const chosen = { id: PS5_WEBKIT_INSTALLER, version: 'v0.7.1', checksum };
const payload = {
  ...chosen,
  name: 'WebKit Autoloader installer',
  filename: 'WebKit-Autoloader-Installer_v0.7.1.elf',
  slot: 'repo/webkit-autoloader-installer@1234',
  source_url: PS5_OFFICIAL_REPOSITORY,
};
const inventory = { self: { running_version: '0.6.3', pending_version: '' }, items: [payload] };
const emptyInventory = { ...inventory, items: [] };
const config = {
  AUTOLOAD_ENABLED: true,
  AUTOLOAD_LIST: 'local/kstuff',
  AUTOLOAD_DELAY: 5,
  FAVORITES: 'keep-me',
};
const startup = {
  enabled: true,
  expectedConfig: config,
  delaySeconds: 5,
  entries: [{ slot: 'local/kstuff' }, { delayMs: 3000 }],
};

function stub(replies: Record<string, unknown> | unknown[]) {
  const requests: ConnectionRequest[] = [];
  const ctx: AdapterContext = {
    baseUrl: 'http://192.168.1.20:8084',
    fields: {},
    bases: {},
    send: async (req) => {
      requests.push(req);
      const body = Array.isArray(replies) ? replies.shift() : replies[new URL(req.url).pathname];
      if (body instanceof Error) throw body;
      return {
        status: body === undefined ? 404 : 200,
        headers: {},
        body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body ?? {})),
      };
    },
  };
  return { ctx, requests };
}
const repo = (p: unknown = chosen) => ({
  sources: [
    {
      url: PS5_OFFICIAL_REPOSITORY,
      name: 'Official Repository',
      payloads: [{ ...payload, description: 'FW 7.00–13.60', ...(p as object) }],
    },
  ],
});
const run = (name: string, ctx: AdapterContext, input: Record<string, unknown> = {}) => {
  const tool = PS5_ADAPTER[name];
  if (!tool) throw new Error(name);
  return tool(ctx, input);
};

describe('PS5 reads', () => {
  it('keeps both services on the console and validates the secondary port', () => {
    expect(ps5ServiceUrl('http://192.168.1.20:8084/path', {}, 'shadowmount', '/api/v1/games')).toBe(
      'http://192.168.1.20:10101/api/v1/games',
    );
    expect(
      ps5ServiceUrl('http://[fd00::20]:8084', { shadowmountPort: '12345' }, 'shadowmount', '/api/v1/version'),
    ).toBe('http://[fd00::20]:12345/api/v1/version');
    for (const port of ['0', '65536', '80/other', 'evil.example', '-1'])
      expect(() =>
        ps5ServiceUrl('http://192.168.1.20:8084', { shadowmountPort: port }, 'shadowmount', '/api/v1/games'),
      ).toThrow();
  });

  it('uses only fixed read routes, including ShadowMountPlus’s POST reads', async () => {
    const { ctx, requests } = stub({
      '/list_payloads': inventory,
      '/get_config': config,
      '/processes_list': { processes: [] },
      '/api/v1/version': { status: 0, api_version: 1, shadowmount_version: '1.7beta11', capabilities: [] },
      '/api/v1/games': { status: 0, count: 0, games: [] },
      '/api/v1/storage': { status: 0, mounts: [] },
      '/history_list': { history: [] },
      '/log': { logs: [] },
    });
    const s = await readPs5Snapshot(ctx);
    expect(s.unavailable).toEqual(['Homebrew releases']);
    expect(requests).toHaveLength(9);
    expect(requests.every((r) => !r.headers?.['X-PLDMGR-Request'])).toBe(true);
    expect(
      requests
        .filter((r) => r.method === 'POST')
        .map((r) => [new URL(r.url).port, new URL(r.url).pathname, JSON.parse(String(r.body))]),
    ).toEqual([
      ['10101', '/api/v1/version', {}],
      ['10101', '/api/v1/games', { include_size: false }],
      ['10101', '/api/v1/storage', {}],
    ]);
  });

  it('keeps Payload Manager details when optional services are missing', async () => {
    const { ctx } = stub({ '/list_payloads': inventory });
    const s = await readPs5Snapshot(ctx);
    expect(s.payloads.self.running_version).toBe('0.6.3');
    expect(s.games).toBeNull();
    expect(s.unavailable).toContain('ShadowMountPlus');
    await expect(readPs5Snapshot(stub({}).ctx)).rejects.toThrow('Payload Manager');
  });
});

describe('PS5 homebrew changes', () => {
  it('names the approved release and the manual reboot in the approval', () => {
    const words = callWordsFor('ps5');
    expect(words?.ask('ps5_update_webkit', chosen)).toContain(chosen.version);
    expect(words?.note?.('ps5_update_webkit', chosen)).toContain('reboot');
    expect(words?.ask('ps5_set_autoload', startup)).toContain('startup');
  });

  it.each([{ version: 'v0.7.2' }, { checksum: 'b'.repeat(64) }])(
    'refuses a changed release before writing: %j',
    async (change) => {
      const { ctx, requests } = stub([repo(change)]);
      await expect(run('ps5_update_webkit', ctx, { version: chosen.version, checksum })).rejects.toThrow(
        'release changed',
      );
      expect(requests.every((r) => r.method === 'GET')).toBe(true);
    },
  );

  it('rejects a matching release from another source', async () => {
    const repository = repo();
    repository.sources = repository.sources.map((source) => ({
      ...source,
      url: 'https://example.net/repo.json',
    }));
    const { ctx, requests } = stub([repository]);
    await expect(run('ps5_install_payload', ctx, chosen)).rejects.toThrow('Official Repository');
    expect(requests).toHaveLength(1);
  });

  it('downloads without running, and uses the action marker', async () => {
    const { ctx, requests } = stub([repo(), emptyInventory, { ok: true }, inventory]);
    const out = await run('ps5_install_payload', ctx, chosen);
    expect(JSON.parse(out.content).slot).toBe(payload.slot);
    const write = requests.find((r) => r.method === 'POST');
    expect(write?.headers?.['X-PLDMGR-Request']).toBe('1');
    expect(new URL(write?.url ?? '').searchParams.get('source_url')).toBe(PS5_OFFICIAL_REPOSITORY);
    expect(requests.some((r) => r.url.includes('loadpayload'))).toBe(false);
  });

  it.each([{ ok: false }, { ok: true }])(
    'doesn’t launch an unconfirmed or mismatched download: %j',
    async (answer) => {
      const { ctx, requests } = stub([
        repo(),
        emptyInventory,
        answer,
        { ...inventory, items: [{ ...payload, checksum: 'b'.repeat(64) }] },
      ]);
      await expect(run('ps5_update_webkit', ctx, { version: chosen.version, checksum })).rejects.toThrow();
      expect(requests.some((r) => r.url.includes('loadpayload'))).toBe(false);
    },
  );

  it('checks the stored installer again before launch and reports acceptance only', async () => {
    const { ctx, requests } = stub([repo(), emptyInventory, { ok: true }, inventory, inventory, 'OK']);
    const out = await run('ps5_update_webkit', ctx, { version: chosen.version, checksum });
    expect(requests.filter((r) => r.method === 'POST').map((r) => new URL(r.url).pathname)).toEqual([
      '/repository_install',
      `/loadpayload:${encodeURIComponent(payload.slot)}`,
    ]);
    expect(out.content).toContain('reboot');
    expect(out.content).toContain('hasn’t verified');
    const replaced = stub([
      repo(),
      emptyInventory,
      { ok: true },
      inventory,
      { ...inventory, items: [{ ...payload, checksum: 'b'.repeat(64) }] },
    ]);
    await expect(
      run('ps5_update_webkit', replaced.ctx, { version: chosen.version, checksum }),
    ).rejects.toThrow('changed');
    expect(replaced.requests).toHaveLength(5);
  });

  it('reuses an exact stored installer and checks it again before launch', async () => {
    const { ctx, requests } = stub([repo(), inventory, inventory, 'OK', { history: [] }]);
    const out = JSON.parse(
      (await run('ps5_update_webkit', ctx, { version: chosen.version, checksum })).content,
    );
    expect(out.reused).toBe(true);
    expect(requests.filter((r) => r.method === 'POST').map((r) => new URL(r.url).pathname)).toEqual([
      `/loadpayload:${encodeURIComponent(payload.slot)}`,
    ]);
    const changed = stub([
      repo(),
      inventory,
      { ...inventory, items: [{ ...payload, checksum: 'b'.repeat(64) }] },
    ]);
    await expect(
      run('ps5_update_webkit', changed.ctx, { version: chosen.version, checksum }),
    ).rejects.toThrow('changed');
    expect(changed.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('reuses an exact installed download without running it', async () => {
    const { ctx, requests } = stub([repo(), inventory]);
    expect(JSON.parse((await run('ps5_install_payload', ctx, chosen)).content).reused).toBe(true);
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('refuses stale startup, missing payloads and installers before writing', async () => {
    for (const [settings, items, input] of [
      [{ ...config, AUTOLOAD_LIST: '' }, [], startup],
      [config, [], startup],
      [config, [payload], { ...startup, entries: [{ slot: payload.slot }] }],
    ] as const) {
      const { ctx, requests } = stub([settings, { ...inventory, items }]);
      await expect(run('ps5_set_autoload', ctx, input)).rejects.toThrow();
      expect(requests.every((r) => r.method === 'GET')).toBe(true);
    }
  });

  it('patches only startup fields and verifies the saved result', async () => {
    const saved = { ...config, AUTOLOAD_LIST: 'local/kstuff,!3000' };
    const replies = [
      config,
      { ...inventory, items: [{ slot: 'local/kstuff', filename: 'kstuff.elf' }] },
      'OK',
      saved,
    ];
    const { ctx, requests } = stub([...replies]);
    await run('ps5_set_autoload', ctx, startup);
    expect(JSON.parse(String(requests[2]?.body))).toEqual({
      AUTOLOAD_ENABLED: true,
      AUTOLOAD_LIST: 'local/kstuff,!3000',
      AUTOLOAD_DELAY: 5,
    });
    expect(requests.at(-1)?.method).toBe('GET');
    await expect(
      run('ps5_set_autoload', stub([...replies.slice(0, 3), config]).ctx, startup),
    ).rejects.toThrow('didn’t confirm');
  });
});

/** Every string inside a value (a drizzle `sql` fragment is circular). */
function strings(v: unknown, seen = new WeakSet<object>()): string[] {
  if (typeof v === 'string') return [v];
  if (!v || typeof v !== 'object' || seen.has(v)) return [];
  seen.add(v);
  return Object.values(v).flatMap((x) => strings(x, seen));
}

const discovery = Buffer.from('HTTP/1.1 200 Ok\nhost-type:PS5\nhost-name:PS5-103\nsystem-version:10010000\n');
const local = {
  slot: 'local/kstuff-lite',
  filename: 'kstuff-lite_v1.10.elf',
  path: '/data/pldmgr/payloads/local/kstuff-lite/kstuff-lite_v1.10.elf',
};
const kstuff = { id: 'kstuff-lite', version: 'v1.11', checksum: 'd'.repeat(64) };
const kstuffRepo = (release: object = kstuff) => ({
  sources: [
    {
      url: PS5_OFFICIAL_REPOSITORY,
      name: 'Official Repository',
      payloads: [
        {
          name: 'kstuff-lite',
          filename: 'kstuff-lite_v1.11.elf',
          description: 'Lite version of kstuff',
          ...release,
        },
      ],
    },
  ],
});
const stored = {
  ...kstuff,
  slot: 'repo/kstuff-lite@e8cce5d1',
  filename: 'kstuff-lite_v1.11.elf',
  source_url: PS5_OFFICIAL_REPOSITORY,
};
const startupConfig = {
  AUTOLOAD_ENABLED: true,
  AUTOLOAD_LIST: 'local/kstuff-lite,!3000,local/shadowmountplus',
  AUTOLOAD_DELAY: 5,
};

describe('PS5 updates for payloads uploaded by hand', () => {
  it('compares them with the Official Repository and the console’s firmware', async () => {
    const { ctx } = stub({
      '/repository_payloads': kstuffRepo(),
      '/list_payloads': { ...inventory, items: [local] },
      '/get_config': startupConfig,
    });
    ctx.datagram = async (port) => (port === 9302 ? discovery : null);
    const out = JSON.parse((await run('ps5_payload_updates', ctx)).content);
    expect(out.firmware).toBe('10.01');
    expect(out.updates).toMatchObject([
      {
        slot: 'local/kstuff-lite',
        installed: 'v1.10',
        available: { version: 'v1.11' },
        newer: true,
        startup: true,
      },
    ]);
  });

  it('downloads the approved release, moves startup to it and keeps the old copy', async () => {
    const { ctx, requests } = stub([
      kstuffRepo(),
      { ...inventory, items: [local] },
      startupConfig,
      { ok: true },
      { ...inventory, items: [local, stored] },
      startupConfig,
      'OK',
      { ...startupConfig, AUTOLOAD_LIST: 'repo/kstuff-lite@e8cce5d1,!3000,local/shadowmountplus' },
    ]);
    const out = JSON.parse((await run('ps5_update_payload', ctx, { ...kstuff, slot: local.slot })).content);
    expect(out).toMatchObject({ slot: stored.slot, previous: local.slot, startup: 'switched' });
    const writes = requests.filter((r) => r.method === 'POST');
    expect(writes.map((r) => new URL(r.url).pathname)).toEqual(['/repository_install', '/set_config']);
    expect(new URL(writes[0]?.url ?? '').searchParams.get('id')).toBe('kstuff-lite');
    expect(JSON.parse(String(writes[1]?.body))).toEqual({
      AUTOLOAD_ENABLED: true,
      AUTOLOAD_LIST: 'repo/kstuff-lite@e8cce5d1,!3000,local/shadowmountplus',
      AUTOLOAD_DELAY: 5,
    });
    expect(requests.some((r) => /delete|loadpayload/.test(r.url))).toBe(false);
  });

  it('leaves startup alone when it changed during the download', async () => {
    const { ctx, requests } = stub([
      kstuffRepo(),
      { ...inventory, items: [local] },
      startupConfig,
      { ok: true },
      { ...inventory, items: [local, stored] },
      { ...startupConfig, AUTOLOAD_DELAY: 9 },
    ]);
    const out = JSON.parse((await run('ps5_update_payload', ctx, { ...kstuff, slot: local.slot })).content);
    expect(out.startup).toBe('not_switched');
    expect(requests.some((r) => r.url.includes('set_config'))).toBe(false);
  });

  it('refuses another payload’s slot, an older version and a changed release before writing', async () => {
    for (const [replies, input] of [
      [
        [
          kstuffRepo(),
          { ...inventory, items: [{ ...local, slot: 'local/ftpsrv', filename: 'ftpsrv_v0.21.1.elf' }] },
          startupConfig,
        ],
        { ...kstuff, slot: 'local/ftpsrv' },
      ],
      [
        [
          kstuffRepo(),
          { ...inventory, items: [{ ...local, filename: 'kstuff-lite_v1.12.elf' }] },
          startupConfig,
        ],
        { ...kstuff, slot: local.slot },
      ],
      [[kstuffRepo({ ...kstuff, version: 'v1.12' })], { ...kstuff, slot: local.slot }],
      [[], { ...chosen, slot: payload.slot }],
    ] as const) {
      const { ctx, requests } = stub([...replies]);
      await expect(run('ps5_update_payload', ctx, input)).rejects.toThrow();
      expect(requests.every((r) => r.method === 'GET')).toBe(true);
    }
  });
});

describe('PS5 runs, WebKit Autoloader and the console', () => {
  it('confirms a run from the launch history', async () => {
    const { ctx } = stub([{ ...inventory, items: [local] }, 'OK', { history: [local.path] }]);
    expect(JSON.parse((await run('ps5_run_payload', ctx, { slot: local.slot })).content).started).toBe(true);
  });

  it('refuses a WebKit release whose firmware range leaves the console out', async () => {
    const { ctx, requests } = stub([repo({ ...chosen, description: 'FW 7.00-9.60' })]);
    ctx.datagram = async () => discovery;
    await expect(run('ps5_update_webkit', ctx, { version: chosen.version, checksum })).rejects.toThrow(
      '10.01',
    );
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('remembers the WebKit installer it ran on the connection', async () => {
    const { ctx } = stub([repo(), emptyInventory, { ok: true }, inventory, inventory, 'OK', { history: [] }]);
    const sets: unknown[] = [];
    const chain = {
      set: (v: unknown) => {
        sets.push(v);
        return chain;
      },
      where: () => Promise.resolve([]),
    };
    ctx.call = {
      services: {
        pipeline: { transactAccount: (fn: (tx: unknown) => Promise<unknown>) => fn({ update: () => chain }) },
        clock: () => new Date('2026-11-08T10:00:00Z'),
        log: { warn: () => undefined },
      },
      connectionId: 'con_ps5',
    } as unknown as AdapterContext['call'];
    await run('ps5_update_webkit', ctx, { version: chosen.version, checksum });
    expect(sets).toHaveLength(1);
    const words = strings(sets[0]).join(' ');
    expect(words).toContain('v0.7.1');
    expect(words).toContain('2026-11-08T10:00:00.000Z');
  });

  it('stops only a homebrew payload whose pid and name still match', async () => {
    const processes = {
      processes: [
        { pid: 86, name: 'kstuff.elf', memory: 6.8, is_daemon: true },
        { pid: 91, name: 'ftpsrv.elf', memory: 3, is_daemon: true },
      ],
    };
    for (const input of [
      { pid: 86, name: 'kstuff.elf' },
      { pid: 91, name: 'other.elf' },
    ]) {
      const { ctx, requests } = stub([processes]);
      await expect(run('ps5_stop_payload', ctx, input)).rejects.toThrow();
      expect(requests.every((r) => r.method === 'GET')).toBe(true);
    }
    const { ctx, requests } = stub([
      processes,
      { ok: true, message: 'Killed' },
      { processes: processes.processes.slice(0, 1) },
    ]);
    expect(
      JSON.parse((await run('ps5_stop_payload', ctx, { pid: 91, name: 'ftpsrv.elf' })).content).stopped,
    ).toBe(true);
    const kill = requests.find((r) => r.method === 'POST');
    expect(new URL(kill?.url ?? '').searchParams.get('pid')).toBe('91');
    expect(kill?.headers?.['X-PLDMGR-Request']).toBe('1');
  });

  it('ejects a USB drive by its current source and mount id', async () => {
    const storage = {
      status: 0,
      mounts: [
        {
          mount_point: '/user',
          source: 'ssd0.user',
          total_bytes: 1,
          available_bytes: 1,
          used_bytes: 0,
          read_only: false,
          ejectable: false,
        },
        {
          mount_point: '/mnt/usb0',
          source: '/dev/da1p1',
          mount_id: '0000002c00000128',
          total_bytes: 1,
          available_bytes: 1,
          used_bytes: 0,
          read_only: false,
          ejectable: true,
        },
      ],
    };
    const { ctx, requests } = stub([storage, { status: 0, job_id: 4, operation: 'eject' }]);
    expect(JSON.parse((await run('ps5_eject_usb', ctx, { mountPoint: '/mnt/usb0' })).content).jobId).toBe(4);
    expect(JSON.parse(String(requests[1]?.body))).toEqual({
      path: '/mnt/usb0',
      source: '/dev/da1p1',
      mount_id: '0000002c00000128',
    });
    expect(new URL(requests[1]?.url ?? '').port).toBe('10101');
    await expect(run('ps5_eject_usb', stub([]).ctx, { mountPoint: '/user' })).rejects.toThrow();
  });

  it('reads one game, ShadowMountPlus’s log and a rescan through their fixed routes', async () => {
    const { ctx, requests } = stub([
      {
        status: 0,
        title_id: 'PPSA08560',
        title_name: 'Split Fiction',
        version: '01.500.000',
        size_bytes: 161025431838,
      },
      { status: 0, content: '[DB] loaded', truncated: true },
      { status: 0, scan_queued: true, scan_deferred: false },
    ]);
    expect(JSON.parse((await run('ps5_game_info', ctx, { titleId: 'PPSA08560' })).content).size_bytes).toBe(
      161025431838,
    );
    expect(
      JSON.parse((await run('ps5_shadowmount_logs', ctx, { log: 'kernel', kilobytes: 8 })).content).log,
    ).toBe('kernel');
    expect(JSON.parse((await run('ps5_rescan_games', ctx)).content).queued).toBe(true);
    expect(requests.map((r) => [new URL(r.url).pathname, JSON.parse(String(r.body))])).toEqual([
      ['/api/v1/games/info', { title_id: 'PPSA08560' }],
      ['/api/v1/kernel-log', { max_bytes: 8192 }],
      ['/api/v1/scan', { reset_attempts: false }],
    ]);
    await expect(run('ps5_game_info', ctx, { titleId: '../x' })).rejects.toThrow();
  });

  it('asks the console once more after an unreadable answer, and calls no answer silent', async () => {
    const answers = [Buffer.from([0x00, 0xe3, 0x81]), discovery];
    const { ctx } = stub({});
    ctx.datagram = async () => answers.shift() ?? null;
    expect(await readPs5Console(ctx)).toEqual({ state: 'awake', name: 'PS5-103', firmware: '10.01' });
    ctx.datagram = async () => null;
    expect(await readPs5Console(ctx)).toBe('silent');
    ctx.datagram = async () => {
      throw new Error('not allowed');
    };
    expect(await readPs5Console(ctx)).toBeNull();
  });

  it('names the console’s cover route and nothing else', () => {
    expect(
      ps5PictureUrl('http://192.168.1.20:8084', {}, '/api/v1/games/icon?title_id=PPSA08560&v=3-f75e'),
    ).toBe('http://192.168.1.20:10101/api/v1/games/icon?title_id=PPSA08560&v=3-f75e&size=thumb');
    for (const path of [
      '/list_payloads',
      '/api/v1/games/icon?title_id=PPSA08560&size=cover',
      '/api/v1/games/icon?title_id=../x',
    ])
      expect(ps5PictureUrl('http://192.168.1.20:8084', {}, path)).toBeNull();
    expect(ps5CoverPath('PPSA08560', '/api/v1/games/icon?title_id=PPSA08560&v=3-f75e')).toBe(
      '/api/v1/games/icon?title_id=PPSA08560&v=3-f75e',
    );
  });
});
