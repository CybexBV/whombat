/**
 * Windows PCs as servers (Whombat windows-servers.md): the platform and OS family, a PC's own facts on its page, the
 * Windows line of an enrollment, the two checks and the PC's mark.
 */
import { describe, expect, it } from 'vitest';
import { hostOsMark } from './host-marks.js';
import { HOST_WATCH_CHECKS, hostHintCheck } from './host-watch.js';
import {
  HOST_WINDOWS_UNINSTALL_COMMAND,
  HostEnrollment,
  HostOsFamily,
  HostServerDetail,
  HostServerPlatform,
  HostWindowsDetail,
} from './hosts.js';

const windowsPc = (over: Record<string, unknown> = {}) => ({
  product: 'Windows 11 Pro',
  displayVersion: '24H2',
  build: '26100.2605',
  edition: 'Professional',
  server: false,
  manufacturer: 'Example Computers',
  model: 'Desk 5',
  updatesCheckedAt: '2026-11-28T04:00:00Z',
  updatesInstalledAt: '2026-11-20T03:10:00Z',
  protection: {
    state: 'on',
    product: 'Microsoft Defender Antivirus',
    defender: {
      running: true,
      mode: 'normal',
      realTime: true,
      tamper: true,
      signaturesAt: '2026-11-27T06:12:40Z',
      quickScanAt: null,
    },
    antivirus: [{ name: 'Microsoft Defender Antivirus', on: true, upToDate: true }],
  },
  bitlocker: [{ drive: 'C:', protection: 'on', system: true }],
  ...over,
});

describe('a Windows PC', () => {
  it('is a server kind and an OS family of its own', () => {
    expect(HostServerPlatform.options).toContain('windows');
    expect(HostOsFamily.options).toContain('windows');
  });

  it('parses its facts, its protection and BitLocker', () => {
    const d = HostWindowsDetail.parse(windowsPc());
    expect(d.protection.state).toBe('on');
    expect(d.bitlocker?.[0]?.system).toBe(true);
    expect(HostWindowsDetail.parse(windowsPc({ bitlocker: null })).bitlocker).toBeNull();
    expect(HostWindowsDetail.safeParse(windowsPc({ protection: { state: 'maybe' } })).success).toBe(false);
    expect(HostServerDetail.shape.windows.safeParse(undefined).success).toBe(true);
  });

  it('gets a Windows line with its enrollment, while the box has a Windows agent', () => {
    const base = { id: 'en_1', expiresAt: '2026-11-28T12:00:00Z', installCommand: ' curl … | sudo sh' };
    expect(HostEnrollment.parse(base).installCommandWindows).toBeUndefined();
    expect(
      HostEnrollment.parse({ ...base, installCommandWindows: "$u='https://203.0.113.5:8443'" }),
    ).toMatchObject({
      installCommandWindows: expect.stringContaining('203.0.113.5'),
    });
    expect(HOST_WINDOWS_UNINSTALL_COMMAND).toContain('whombat-agent.exe');
    expect(HOST_WINDOWS_UNINSTALL_COMMAND).toContain('uninstall');
  });

  it('watches protection off from the start, old virus definitions only when asked', () => {
    expect(hostHintCheck('windows.protection_off').startsOn).toBe(true);
    expect(hostHintCheck('windows.signatures_old').startsOn).toBe(false);
    // Fewer than half of all checks start on (watch-defaults.md).
    expect(HOST_WATCH_CHECKS.filter((c) => c.startsOn).length * 2).toBeLessThan(HOST_WATCH_CHECKS.length);
  });

  it('shows Whombat’s own computer glyph, not a maker’s logo', () => {
    expect(hostOsMark({ platform: 'windows', os: 'Windows 11 Pro' })).toBe('pc');
    expect(hostOsMark({ platform: 'standard', os: 'Windows Server 2025 Standard' })).toBe('pc');
  });
});
