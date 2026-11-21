import { describe, expect, it } from 'vitest';
import { catalogEntry, toolAlwaysAsks } from './connections-catalog.js';
import {
  PS5_OFFICIAL_REPOSITORY,
  PS5_POWER_HELPER,
  Ps5AutoloadArgs,
  Ps5RebootArgs,
  Ps5Repository,
  Ps5Slot,
  parsePs5Discovery,
  parsePs5PowerStatus,
  ps5AllUpdates,
  ps5AutoloadList,
  ps5FileVersion,
  ps5Firmware,
  ps5FirmwareFits,
  ps5FirmwareRange,
  ps5StartupRun,
  ps5Updates,
  ps5VersionOrder,
} from './ps5.js';

describe('PS5 boundaries', () => {
  it('identifies the reviewed power helper and requires a current pid for reboot', () => {
    expect(parsePs5PowerStatus(`OK pid=101 build=${PS5_POWER_HELPER.build}\n`)).toMatchObject({
      ready: true,
      pid: 101,
    });
    for (const reply of [
      'OK rebooting\n',
      `OK pid=101 build=unknown\n`,
      `OK pid=0 build=${PS5_POWER_HELPER.build}\n`,
      `OK pid=101 build=${PS5_POWER_HELPER.build}`,
    ])
      expect(parsePs5PowerStatus(reply)).toBeNull();
    expect(Ps5RebootArgs.safeParse({}).success).toBe(false);
    expect(Ps5RebootArgs.safeParse({ expectedPid: 101, command: 'SHUTDOWN' }).success).toBe(false);
  });
  it('accepts installed slot names and refuses paths or startup syntax inside a slot', () => {
    expect(Ps5Slot.parse('repo/webkit-autoloader-installer@e8cce5d1')).toContain('@e8cce5d1');
    for (const slot of [
      'local/..',
      'local/.',
      'local/a..b',
      '/data/a.elf',
      'local/a,b',
      'local/a/evil',
      'local/a?x=y',
      'local/a%2fb',
      'local/a\\b',
      'http://evil/a',
    ])
      expect(Ps5Slot.safeParse(slot).success, slot).toBe(false);
    expect(
      ps5AutoloadList(
        Ps5AutoloadArgs.parse({
          enabled: true,
          delaySeconds: 5,
          expectedConfig: { AUTOLOAD_ENABLED: false, AUTOLOAD_LIST: '', AUTOLOAD_DELAY: 5 },
          entries: [{ slot: 'local/kstuff-lite' }, { delayMs: 3000 }, { slot: 'local/shadowmountplus' }],
        }),
      ),
    ).toBe('local/kstuff-lite,!3000,local/shadowmountplus');
  });

  it('makes every write ask first and offers no unrestricted request', () => {
    const entry = catalogEntry('ps5');
    expect(entry).not.toBeNull();
    if (!entry) throw new Error('Missing PS5');
    expect(entry.request).toBeNull();
    for (const tool of entry.tools)
      expect(toolAlwaysAsks(entry, tool.name), tool.name).toBe(tool.access === 'write');
  });
});

describe('PS5 versions and firmware', () => {
  it('reads a version from a payload’s file name', () => {
    expect(ps5FileVersion('kstuff-lite_v1.10.elf')).toEqual({ name: 'kstuff-lite', version: 'v1.10' });
    expect(ps5FileVersion('ShadowMountPlus_1.7beta11.elf')).toEqual({
      name: 'ShadowMountPlus',
      version: '1.7beta11',
    });
    expect(ps5FileVersion('ps5-web-file-manager_v1.13-rc2.elf')?.name).toBe('ps5-web-file-manager');
    expect(ps5FileVersion('etaHEN_2.5B.bin')?.version).toBe('2.5B');
    expect(ps5FileVersion('kstuff.elf')).toBeNull();
  });

  it('orders versions, with a pre-release before its release', () => {
    expect(ps5VersionOrder('v1.11', 'v1.10')).toBeGreaterThan(0);
    expect(ps5VersionOrder('v1.10', '1.10')).toBe(0);
    expect(ps5VersionOrder('1.7', '1.7beta11')).toBeGreaterThan(0);
    expect(ps5VersionOrder('1.7beta12', '1.7beta11')).toBeGreaterThan(0);
    expect(ps5VersionOrder('v1.13-rc2', 'v1.13-beta9')).toBeGreaterThan(0);
    expect(ps5VersionOrder('v0.7.1', 'v0.7')).toBeGreaterThan(0);
    expect(ps5VersionOrder('v2', 'v10')).toBeLessThan(0);
    expect(ps5VersionOrder('latest', 'v1')).toBeNull();
  });

  it('reads the console’s discovery answer, awake or resting', () => {
    const awake = [
      'HTTP/1.1 200 Ok',
      'host-id:5C9666898D19',
      'host-type:PS5',
      'host-name:PS5-103',
      'host-request-port:997',
      'system-version:10010000',
    ].join('\n');
    expect(parsePs5Discovery(awake)).toEqual({ state: 'awake', name: 'PS5-103', firmware: '10.01' });
    expect(parsePs5Discovery(awake.replace('200 Ok', '620 Server Standby'))?.state).toBe('resting');
    expect(parsePs5Discovery(awake.replace('PS5', 'PS4'))).toBeNull();
    expect(parsePs5Discovery('garbage')).toBeNull();
    expect(ps5Firmware('07000000')).toBe('7.00');
    expect(ps5Firmware('1001')).toBeNull();
  });

  it('checks firmware against a release’s range', () => {
    const range = ps5FirmwareRange('Installs WebKit Autoloader on homescreen (FW 7.00-13.60)');
    expect(range).toEqual({ from: '7.00', to: '13.60' });
    expect(ps5FirmwareFits('10.01', range)).toBe(true);
    expect(ps5FirmwareFits('13.70', range)).toBe(false);
    expect(ps5FirmwareFits(null, range)).toBeNull();
    expect(ps5FirmwareRange('Lite version of kstuff')).toBeNull();
  });
});

describe('PS5 updates and startup', () => {
  const releases =
    Ps5Repository.parse({
      sources: [
        {
          url: PS5_OFFICIAL_REPOSITORY,
          name: 'Official Repository',
          payloads: [
            {
              id: 'kstuff-lite',
              name: 'kstuff-lite',
              filename: 'kstuff-lite_v1.11.elf',
              version: 'v1.11',
              checksum: 'a'.repeat(64),
              description: 'Lite version of kstuff',
              release_notes: 'Adds 10.01 offsets.',
            },
            {
              id: 'shadowmountplus',
              name: 'ShadowMountPlus',
              filename: 'ShadowMountPlus_1.7beta11.elf',
              version: '1.7beta11',
              checksum: 'b'.repeat(64),
            },
            {
              id: 'webkit-autoloader-installer',
              name: 'WebKit-Autoloader-Installer',
              filename: 'x.elf',
              version: 'v0.7.1',
              checksum: 'c'.repeat(64),
              description: 'Installs WebKit Autoloader on homescreen (FW 7.00-13.60)',
            },
          ],
        },
      ],
    }).sources[0]?.payloads ?? [];

  it('matches payloads uploaded by hand to their release by name', () => {
    const lines = ps5Updates(
      {
        self: { running_version: '0.6.3', pending_version: '' },
        items: [
          { slot: 'local/kstuff-lite', filename: 'kstuff-lite_v1.10.elf' },
          { slot: 'local/shadowmountplus', filename: 'ShadowMountPlus_1.7beta11.elf' },
          { slot: 'local/ftpsrv', filename: 'ftpsrv_v0.21.1.elf' },
          {
            slot: 'repo/webkit-autoloader-installer@e8cce5d1',
            filename: 'x.elf',
            id: 'webkit-autoloader-installer',
            version: 'v0.7.1',
            source_url: PS5_OFFICIAL_REPOSITORY,
          },
        ],
      },
      releases,
      'local/kstuff-lite,!3000,local/shadowmountplus',
      '10.01',
    );
    expect(
      lines.map((l) => [l.slot, l.installed, l.available?.version ?? null, l.newer, l.startup, l.source]),
    ).toEqual([
      ['local/kstuff-lite', 'v1.10', 'v1.11', true, true, 'uploaded'],
      ['local/shadowmountplus', '1.7beta11', '1.7beta11', false, true, 'uploaded'],
      ['local/ftpsrv', 'v0.21.1', null, false, false, 'uploaded'],
      ['repo/webkit-autoloader-installer@e8cce5d1', 'v0.7.1', 'v0.7.1', false, false, 'repository'],
    ]);
    expect(lines[0]?.notes).toContain('10.01');
    expect(lines[1]?.notes).toBeUndefined();
    expect(lines[3]?.fits).toBe(true);
  });

  it('adds Payload Manager’s own update unless it already waits to restart into it', () => {
    const withManager = [
      ...releases,
      {
        id: 'pldmgr',
        name: 'Payload Manager',
        filename: 'pldmgr.elf',
        version: 'v0.7.0',
        checksum: 'd'.repeat(64),
        description: '',
      },
    ];
    const lines = ps5AllUpdates(
      { self: { running_version: 'v0.6.3', pending_version: '' }, items: [] },
      withManager,
      '',
      '10.01',
    );
    expect(lines.map((l) => [l.slot, l.name, l.installed, l.available?.version, l.newer])).toEqual([
      ['pldmgr', 'Payload Manager', 'v0.6.3', 'v0.7.0', true],
    ]);
    const waiting = ps5AllUpdates(
      { self: { running_version: 'v0.6.3', pending_version: 'v0.7.0' }, items: [] },
      withManager,
      '',
      '10.01',
    );
    expect(waiting[0]?.newer).toBe(false);
    expect(
      ps5AllUpdates(
        { self: { running_version: 'v0.6.3', pending_version: '' }, items: [] },
        releases,
        '',
        null,
      ),
    ).toEqual([]);
  });

  it('reads how the last startup went from the log', () => {
    const log = [
      '[PLDMGR] Starting Payload Manager v0.6.3 on port 8084...',
      '[Autoload] Starting sequence...',
      '[Autoload] Launching: /data/pldmgr/payloads/local/kstuff-lite/kstuff-lite_v1.10.elf',
      '[PLDMGR] Loader transfer complete (1572832 bytes sent).',
      '[Autoload] Launching: /data/pldmgr/payloads/local/shadowmountplus/ShadowMountPlus_1.7beta11.elf',
      '[PLDMGR] Loader transfer failed or cancelled (12 bytes sent).',
      '[Autoload] Missing, failed or cancelled payload: local/gone',
      '[Autoload] Sequence complete.',
    ];
    expect(ps5StartupRun(log)).toEqual({
      state: 'done',
      entries: [
        { slot: 'local/kstuff-lite', outcome: 'started' },
        { slot: 'local/shadowmountplus', outcome: 'failed' },
        { slot: 'local/gone', outcome: 'failed' },
      ],
    });
    expect(ps5StartupRun(log.slice(0, 4))?.state).toBe('running');
    expect(ps5StartupRun(['[Autoload] ABORTED via PS Button.'])?.state).toBe('stopped');
    expect(ps5StartupRun(['[PLDMGR] Server is running.'])).toBeNull();
  });
});
