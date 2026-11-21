import type { ConnectionDiscovery, DiscoveredService } from '@whombat/core/contracts';
import { catalogEntry } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { asServerNote, foundList, foundServerAddress, foundServerSearch } from './setup';

const service = (over: Partial<DiscoveredService>): DiscoveredService => ({
  catalogId: 'proxmox',
  url: 'https://192.168.1.10:8006',
  host: '192.168.1.10',
  version: null,
  certificate: null,
  connectionIds: [],
  hidden: false,
  ...over,
});
const scan = (found: DiscoveredService[]): Pick<ConnectionDiscovery, 'found'> => ({ found });

describe('servers in Found on your network (connect-in-chat.md)', () => {
  it('offers Add as a server for a computer and for Proxmox VE, Connect for the rest', () => {
    const list = foundList(
      scan([
        service({ version: '9.0.10' }),
        service({ catalogId: 'server', url: 'ssh://192.168.1.70', host: '192.168.1.70', version: 'Debian' }),
        service({ catalogId: 'grafana', url: 'http://192.168.1.40:3000', host: '192.168.1.40' }),
      ]),
    );
    expect(list.rows.map((r) => [r.name, r.action, r.serverAddress, r.where])).toEqual([
      ['Proxmox VE', 'server', '192.168.1.10', 'https://192.168.1.10:8006'],
      ['Debian server', 'server', '192.168.1.70', '192.168.1.70'],
      ['Grafana', 'connect', null, 'http://192.168.1.40:3000'],
    ]);
    expect(list.rows[1]?.version).toBeNull();
    expect(list.rows[1]?.tagline).toBe('A computer Whombat can look after');
  });

  it('leaves out a server added already, as a connected service', () => {
    const list = foundList(
      scan([
        service({ serverIds: ['pve-01'] }),
        service({ catalogId: 'server', url: 'ssh://10.0.0.9', host: '10.0.0.9' }),
      ]),
    );
    expect(list.rows.map((r) => r.catalogId)).toEqual(['server']);
    expect(list.connected).toBe(1);
  });

  it('keeps a port that isn’t 22', () => {
    expect(foundServerAddress({ host: '10.0.0.9', url: 'ssh://10.0.0.9:2222' })).toBe('10.0.0.9:2222');
    expect(foundServerAddress({ host: 'fd00::9', url: 'ssh://[fd00::9]' })).toBe('fd00::9');
    expect(foundServerSearch('10.0.0.9')).toEqual({ add: 1, address: '10.0.0.9' });
  });

  it('points the connect page of Proxmox VE to Add a server', () => {
    const proxmox = catalogEntry('proxmox');
    const ha = catalogEntry('homeassistant');
    if (!proxmox || !ha) throw new Error('catalog');
    expect(asServerNote(proxmox, 'https://192.168.1.10:8006')).toMatchObject({
      label: 'Add as a server',
      address: '192.168.1.10',
    });
    expect(asServerNote(proxmox, undefined)?.address).toBe('');
    expect(asServerNote(ha, 'http://192.168.1.20:8123')).toBeNull();
  });
});
