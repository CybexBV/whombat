import { describe, expect, it } from 'vitest';
import { serverMark } from '../hosts/model';
import { thingMark } from './things';

describe('thingMark (AP-2204)', () => {
  it('draws a server’s system and a connection’s maker', () => {
    expect(thingMark({ icon: 'debian' })).toBe('debian');
    expect(thingMark({ icon: 'proxmox' })).toBe('proxmox');
    expect(thingMark({ icon: 'homeassistant', catalogId: 'homeassistant' })).toBe('homeassistant');
    expect(thingMark({ icon: 'whatever', catalogId: 'mollie' })).toBe('mollie');
  });

  it('draws the connections of CM-01 by their catalog id (AP-2760)', () => {
    const ids = [
      'unifi_access',
      'sabnzbd',
      'nzbhydra',
      'plex',
      'overseerr',
      'adguard',
      'pihole',
      'nginx_proxy_manager',
      'truenas',
      'esphome',
      'pterodactyl',
      'airtable',
      'hubspot',
      'pipedrive',
      'plausible',
      'imap',
    ];
    expect(ids.filter((id) => thingMark({ icon: 'plug', catalogId: id }) !== id)).toEqual([]);
  });

  it('leaves a generic server and a device to their glyph', () => {
    expect(thingMark({ icon: 'server' })).toBeNull();
    expect(thingMark({ icon: 'thermometer', catalogId: 'device' })).toBeNull();
  });
});

describe('serverMark (AP-2204)', () => {
  it('is Proxmox for a Proxmox host and the distribution for another', () => {
    expect(serverMark({ platform: 'proxmox', os: 'Debian GNU/Linux 13 (trixie)' })).toBe('proxmox');
    expect(serverMark({ platform: 'standard', os: 'Debian GNU/Linux 13 (trixie)' })).toBe('debian');
    expect(serverMark({ platform: 'standard', os: null })).toBeNull();
  });
});
