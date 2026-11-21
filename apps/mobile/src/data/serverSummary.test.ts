/** A server's Summary on the phone (dashboards-mobile.md AP-2127…): its tabs for links, and links into itself. */
import { describe, expect, it } from 'vitest';
import { serverLinkTarget, serverPhoneTabs, serverTabFor } from './serverSummary';
import { linkRun } from './thingPage';

describe('a server’s tabs', () => {
  it('stand for the web’s: Docker, VMs and Instances open Guests, notifications Array', () => {
    const unraid = ['summary', 'array', 'guests', 'plugins'] as const;
    expect(serverTabFor('docker', unraid)).toBe('guests');
    expect(serverTabFor('vms', unraid)).toBe('guests');
    expect(serverTabFor('notifications', unraid)).toBe('array');
    expect(serverTabFor('plugins', unraid)).toBe('plugins');
    expect(serverTabFor('storage', unraid)).toBeNull();
    expect(serverTabFor('array', ['summary', 'guests', 'backups'])).toBeNull();
  });

  it('let a Summary’s link name a web tab the phone shows under another name', () => {
    const tabs = serverPhoneTabs(['summary', 'guests', 'backups']);
    expect(tabs.map((t) => [t.key, t.label])).toEqual([
      ['summary', 'Summary'],
      ['guests', 'Guests'],
      ['backups', 'Backups'],
    ]);
    expect(linkRun({ kind: 'tab', label: 'Containers', tab: 'containers' }, tabs)).toEqual({
      label: 'Containers',
      run: { kind: 'tab', tab: 'guests' },
    });
    expect(linkRun({ kind: 'tab', label: 'Sensors', tab: 'sensors' }, tabs)).toBeNull();
    // A button names where it goes on the phone: Unraid's System is its Array here.
    const unraid = serverPhoneTabs(['summary', 'array', 'guests', 'plugins']);
    expect(linkRun({ kind: 'tab', label: 'Open System', tab: 'system' }, unraid)).toEqual({
      label: 'Open Array',
      run: { kind: 'tab', tab: 'array' },
    });
  });
});

describe('links into the server’s own page', () => {
  it('open a tab, a guest (on its tab), or nothing for a console', () => {
    expect(serverLinkTarget('/things/server%3Apve-02?tab=storage', 'pve-02')).toEqual({
      tab: 'storage',
      guest: null,
      guestTab: null,
      console: false,
    });
    expect(
      serverLinkTarget('/burrow-hq/things/server:pve-02?guest=pve%3A131&gtab=backups', 'pve-02'),
    ).toEqual({
      tab: null,
      guest: 'pve:131',
      guestTab: 'backups',
      console: false,
    });
    expect(serverLinkTarget('/things/server%3Apve-02?console=pve%3A131', 'pve-02')?.console).toBe(true);
  });

  it('leave other pages to open as any link', () => {
    expect(serverLinkTarget('/things/server%3Apve-01?tab=storage', 'pve-02')).toBeNull();
    expect(serverLinkTarget('/things/connection%3Acon_ha', 'pve-02')).toBeNull();
    expect(serverLinkTarget('/chats/cnv_1', 'pve-02')).toBeNull();
    expect(serverLinkTarget('/things/servers?add=1', 'pve-02')).toBeNull();
  });
});
