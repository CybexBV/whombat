/**
 * Reaching a NAS as its connection (backup-places.md BPL-03): only a connection with Manage may change it, and the
 * repository needs the NAS's numeric home-network address.
 */
import { BACKUP_PLACE_TEXT } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { CatalogConnectionRow } from '../../connections/types';
import type { Services } from '../../services';
import { QnapPlaceDriver } from './qnap';
import { SynologyPlaceDriver } from './synology';
import { nasAddress, nasPlaceDriver, privateIpv4 } from './transport';
import { TrueNasPlaceDriver } from './truenas';

const row = (over: Partial<CatalogConnectionRow>) =>
  ({
    id: 'c1',
    catalogId: 'truenas',
    label: 'Vault',
    baseUrl: 'https://192.168.1.30',
    access: 'manage',
    status: 'active',
    fields: {},
    ...over,
  }) as CatalogConnectionRow;
const services = {} as Services;

describe('nasPlaceDriver', () => {
  it('gives the driver of each NAS kind', () => {
    expect(nasPlaceDriver(services, row({}))).toBeInstanceOf(TrueNasPlaceDriver);
    expect(nasPlaceDriver(services, row({ catalogId: 'synology' }))).toBeInstanceOf(SynologyPlaceDriver);
    expect(nasPlaceDriver(services, row({ catalogId: 'qnap' }))).toBeInstanceOf(QnapPlaceDriver);
    expect(() => nasPlaceDriver(services, row({ catalogId: 'plex' }))).toThrow();
  });

  it('refuses a connection that only looks, or needs a new password', () => {
    expect(() => nasPlaceDriver(services, row({ access: 'read' }))).toThrow(BACKUP_PLACE_TEXT.reasons.manage);
    expect(() => nasPlaceDriver(services, row({ status: 'needs_reauth' }))).toThrow(/Settings → Connections/);
  });
});

describe('the NAS’s address', () => {
  it('takes a private IPv4 address only', () => {
    for (const a of ['10.0.0.5', '172.16.3.4', '172.31.255.1', '192.168.1.30'])
      expect(privateIpv4(a)).toBe(true);
    for (const a of ['8.8.8.8', '172.32.0.1', '127.0.0.1', 'fd00::1', 'nas.local'])
      expect(privateIpv4(a)).toBe(false);
  });

  it('is the connection’s address when it is one', async () => {
    expect(await nasAddress(services, row({}))).toBe('192.168.1.30');
  });
});
