/**
 * Windows PCs as servers without Postgres (docs/decisions/windows-servers.md): the hub's Windows shapes mapped to the
 * contract, the protection hints in Dutch, the desk's words for a PC, and the assistant leaving a PC's updates to the
 * person.
 */
import { HostFleet, HostServerDetail } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { serverLine } from '../desk/options';
import { hubWords } from './localize';
import { osFamily, serverPlatform, toHostEnrollment, toHostFleet, toHostServerDetail } from './map';
import { WINDOWS_UPDATES_NOTE } from './tools-updates';

const NOW = new Date('2026-11-28T10:00:00Z');

const windowsBlock = {
  product: 'Windows 11 Pro',
  display_version: '24H2',
  build: '26100.2605',
  edition: 'Professional',
  server: false,
  manufacturer: 'Example Computers',
  model: 'Tower 5',
  updates_checked_at: '2026-11-28T06:00:00Z',
  updates_installed_at: null,
  protection: {
    state: 'on',
    product: 'Microsoft Defender Antivirus',
    defender: {
      running: true,
      mode: 'normal',
      real_time: true,
      tamper: null,
      signatures_at: '2026-11-27T22:00:00Z',
      quick_scan_at: '0001-01-01T00:00:00Z',
    },
    antivirus: [{ name: 'Microsoft Defender Antivirus', on: true, up_to_date: true }],
  },
  bitlocker: [
    { drive: 'C:', protection: 'on', system: true },
    { drive: 'D:', protection: 'maybe', system: false },
  ],
};

describe('a Windows PC from the hosts service', () => {
  it('is its own kind of page and OS family', () => {
    expect(serverPlatform('windows')).toBe('windows');
    expect(osFamily('windows')).toBe('windows');
    expect(osFamily(undefined, 'windows')).toBe('windows');
  });

  it('maps a PC’s card and its detail, unknowns as null', () => {
    const fleet = toHostFleet(
      {
        fleet: {
          as_of: NOW.toISOString(),
          servers: [
            {
              id: 'pc-01',
              status: 'online',
              os: 'Windows 11 Pro',
              os_family: 'windows',
              detail_view: 'windows',
            },
          ],
          alerts: [],
          kpis: {},
        },
      },
      NOW,
    );
    expect(HostFleet.parse(fleet).servers[0]).toMatchObject({ platform: 'windows', osFamily: 'windows' });
    const d = toHostServerDetail(
      {
        as_of: NOW.toISOString(),
        server: { id: 'pc-01', detail_view: 'windows', os_family: 'windows', agent: {} },
        sensors: [],
        disks: [],
        hints: [],
        windows: windowsBlock,
      },
      [],
      null,
      NOW,
    );
    const parsed = HostServerDetail.parse(d);
    expect(parsed.server).toMatchObject({ platform: 'windows', osFamily: 'windows' });
    expect(parsed.windows).toMatchObject({
      product: 'Windows 11 Pro',
      displayVersion: '24H2',
      updatesInstalledAt: null,
      protection: {
        state: 'on',
        defender: { realTime: true, tamper: null, quickScanAt: null },
        antivirus: [{ on: true, upToDate: true }],
      },
      bitlocker: [
        { drive: 'C:', protection: 'on', system: true },
        { drive: 'D:', protection: 'unknown', system: false },
      ],
    });
    expect(parsed.windows?.protection.defender?.signaturesAt).toBe('2026-11-27T22:00:00Z');
  });

  it('takes the PowerShell line when the hub gives one, and does without', () => {
    const base = { code: 'ABCD-1234', expires_at: NOW.toISOString(), install_command: 'curl … | sh' };
    expect(toHostEnrollment({ ...base, install_command_windows: 'iex …' }).installCommandWindows).toBe(
      'iex …',
    );
    expect(toHostEnrollment(base).installCommandWindows).toBeUndefined();
  });

  it('says the protection hints in Dutch, the real-time variant with its own advice', () => {
    const off = hubWords({ code: 'windows.protection_off' }, 'nl');
    const realtime = hubWords({ code: 'windows.protection_off.realtime' }, 'nl');
    expect(off?.title).toContain('Virusbescherming');
    expect(off?.detail).toContain('Defender');
    expect(realtime?.detail).toContain('realtime');
    expect(hubWords({ code: 'windows.signatures_old', params: { days: 9 } }, 'nl')?.title).toContain('9');
    expect(hubWords({ code: 'windows.protection_off' }, 'en')).toBeNull();
  });

  it('calls it Windows on the desk, and Whombat leaves its updates to the person', () => {
    expect(serverLine({ platform: 'windows', os: 'Windows 11 Pro', cpu: { cores: 8 } } as never)).toContain(
      'Windows',
    );
    expect(WINDOWS_UPDATES_NOTE).toContain('Windows Update');
  });
});
