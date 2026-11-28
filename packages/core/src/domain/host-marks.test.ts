import { describe, expect, it } from 'vitest';
import { HOST_OS_MARKS, hostOsMark, osMark } from './host-marks.js';

describe('osMark', () => {
  it.each([
    ['Debian GNU/Linux 13 (trixie)', 'debian'],
    ['Ubuntu 24.04.1 LTS', 'ubuntu'],
    ['Kubuntu 24.04 LTS', 'kubuntu'],
    ['Raspbian GNU/Linux 12 (bookworm)', 'raspberrypi'],
    ['Fedora Linux 41 (Server Edition)', 'fedora'],
    ['Fedora Linux Asahi Remix 40', 'asahilinux'],
    ['Rocky Linux 9.4 (Blue Onyx)', 'rockylinux'],
    ['AlmaLinux 9.4 (Seafoam Ocelot)', 'almalinux'],
    ['CentOS Stream 9', 'centos'],
    ['Red Hat Enterprise Linux 9.4 (Plow)', 'redhat'],
    ['openSUSE Tumbleweed', 'opensuse'],
    ['SUSE Linux Enterprise Server 15 SP5', 'suse'],
    ['Arch Linux', 'archlinux'],
    ['Alpine Linux v3.20', 'alpinelinux'],
    ['NixOS 24.05 (Uakari)', 'nixos'],
    ['Linux Mint 22', 'linuxmint'],
    ['Pop!_OS 22.04 LTS', 'popos'],
    ['Kali GNU/Linux Rolling', 'kalilinux'],
    ['Amazon Linux 2023', 'linux'],
    ['macOS 27.2.1', 'mac'],
    ['Mac OS X 10.15', 'mac'],
    ['Windows 11 Pro', 'pc'],
    ['Windows Server 2022', 'pc'],
    [null, null],
  ])('%s → %s', (os, mark) => {
    expect(osMark(os)).toBe(mark);
  });
});

describe('hostOsMark', () => {
  it('knows Proxmox and Unraid by their platform, not their os-release', () => {
    expect(hostOsMark({ platform: 'proxmox', os: 'Debian GNU/Linux 12 (bookworm)' })).toBe('proxmox');
    expect(hostOsMark({ platform: 'unraid', os: 'Slackware 15.0' })).toBe('unraid');
    expect(hostOsMark({ platform: 'macos', os: null })).toBe('mac');
    expect(hostOsMark({ platform: 'windows', os: null })).toBe('pc');
  });

  it('shows any other server’s operating system', () => {
    expect(hostOsMark({ platform: 'standard', os: 'Debian GNU/Linux 13 (trixie)' })).toBe('debian');
    expect(hostOsMark({ platform: 'incus', os: 'Ubuntu 24.04.1 LTS' })).toBe('ubuntu');
  });

  it('falls back to the platform’s mark, then to none', () => {
    expect(hostOsMark({ platform: 'incus', os: null })).toBe('linuxcontainers');
    expect(hostOsMark({ platform: 'libvirt', os: null })).toBe('qemu');
    expect(hostOsMark({ platform: 'standard', os: null })).toBeNull();
  });

  it('lists every mark it can answer', () => {
    expect(HOST_OS_MARKS).toEqual(
      expect.arrayContaining(['proxmox', 'unraid', 'debian', 'linux', 'qemu', 'mac', 'pc']),
    );
    expect(new Set(HOST_OS_MARKS).size).toBe(HOST_OS_MARKS.length);
  });
});
