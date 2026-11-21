/**
 * Found on your network's reach and words (docs/decisions/desk-found.md DF-03, DF-05, DF-13; DF-S03…DF-S06): the
 * networks of this machine's interfaces up to a /22, the order things found are listed in, their names, short lines
 * and addresses, and the assistant's one message.
 */
import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { interfaceNetworks } from './discover';
import {
  DEVICE_NAME,
  FALLBACK_TAGLINE,
  foundAddress,
  foundName,
  foundTagline,
  orderFound,
} from './found-view';

const iface = (cidr: string, internal = false): NetworkInterfaceInfo => ({
  address: cidr.split('/')[0] ?? '',
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: '00:16:3e:00:00:01',
  internal,
  cidr,
});

describe('the box’s own networks (DF-13)', () => {
  it('takes each network as it is up to a /22, else the /22 around the address', () => {
    expect(
      interfaceNetworks({
        // A /23 reaches 10.100.0.x too, where the Home Assistant and Proxmox hosts are.
        eth0: [iface('10.100.1.160/23')],
        eth1: [iface('192.168.8.20/24')],
        wlan0: [iface('172.16.5.9/16')],
        eth2: [iface('10.20.0.130/25')],
        usb0: [iface('10.30.0.6/22')],
      }),
    ).toEqual(['10.100.0.0/23', '192.168.8.0/24', '172.16.4.0/22', '10.20.0.128/25', '10.30.0.0/22']);
  });

  it('leaves out loopback, bridges, public and repeated networks', () => {
    expect(
      interfaceNetworks({
        lo: [iface('127.0.0.1/8', true)],
        docker0: [iface('172.17.0.1/16')],
        podman3: [iface('10.200.0.1/24')],
        eth0: [iface('192.168.1.10/24'), iface('192.168.1.11/24'), iface('203.0.113.5/24')],
      }),
    ).toEqual(['192.168.1.0/24']);
  });
});

const at = (catalogId: string, host: string, port: number, version: string | null = null) => ({
  catalogId,
  host,
  port,
  version,
});

describe('what was found, in order and named (DF-03, DF-08)', () => {
  it('lists Home Assistant and the hypervisors first, then the catalog’s order, a device last, then by address', () => {
    const ordered = orderFound([
      at('device', '10.100.0.42', 502),
      at('plex', '10.100.0.20', 32400),
      at('proxmox', '10.100.0.241', 8006),
      at('pihole', '10.100.0.3', 80),
      at('proxmox', '10.100.0.240', 8006),
      at('unraid', '10.100.0.20', 443),
      at('homeassistant', '10.100.0.5', 8123),
    ]);
    expect(ordered.map((f) => `${f.catalogId} ${f.host}`)).toEqual([
      'homeassistant 10.100.0.5',
      'proxmox 10.100.0.240',
      'proxmox 10.100.0.241',
      'unraid 10.100.0.20',
      'plex 10.100.0.20',
      'pihole 10.100.0.3',
      'device 10.100.0.42',
    ]);
  });

  it('names an entry by the catalog and a device by the model it reported', () => {
    expect(foundName(at('proxmox', '10.100.0.240', 8006, '9.0.10'))).toBe('Proxmox VE');
    expect(foundName(at('device', '10.100.0.42', 502, 'Daikin EKRHH'))).toBe('Daikin EKRHH');
    expect(foundName(at('device', '10.100.0.43', 502))).toBe(DEVICE_NAME);
    // Every findable entry and a device have their own short line (DF-08).
    for (const id of ['homeassistant', 'proxmox', 'device'])
      expect(foundTagline(at(id, '10.100.0.5', 80))).not.toBe(FALLBACK_TAGLINE);
    expect(foundTagline(at('homeassistant', '10.100.0.5', 8123))).toMatch(/^[^.]{1,40}$/);
  });

  it('shows the address without the entry’s own port, unless the same entry is there twice', () => {
    const plex = at('plex', '10.100.0.20', 32400);
    const nextcloud = at('nextcloud', '10.100.0.30', 443);
    const nextcloudAgain = at('nextcloud', '10.100.0.30', 11000);
    expect(foundAddress(plex, [plex])).toBe('10.100.0.20');
    expect(foundAddress(at('device', '10.100.0.42', 502), [])).toBe('10.100.0.42');
    expect(foundAddress(nextcloud, [nextcloud, nextcloudAgain])).toBe('10.100.0.30:443');
    expect(foundAddress(nextcloudAgain, [nextcloud, nextcloudAgain])).toBe('10.100.0.30:11000');
    expect(foundAddress(at('plex', '10.100.0.21', 8080), [])).toBe('10.100.0.21:8080');
  });
});
