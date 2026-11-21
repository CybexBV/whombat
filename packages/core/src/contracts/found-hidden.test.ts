import { describe, expect, it } from 'vitest';
import { ConnectionDiscovery, DiscoveredService, HideFoundServiceBody } from './connections.js';
import { api } from './index.js';

const found = {
  catalogId: 'proxmox',
  url: 'https://10.100.0.240:8006',
  host: '10.100.0.240',
  version: '9.2.11',
  certificate: null,
  connectionIds: [],
};

describe('hiding a found service (CT-316)', () => {
  it('reads an older runtime’s found service as not hidden', () => {
    expect(DiscoveredService.parse(found).hidden).toBe(false);
    expect(DiscoveredService.parse({ ...found, hidden: true }).hidden).toBe(true);
  });

  it('hides by default and shows again with hidden: false', () => {
    expect(HideFoundServiceBody.parse({ catalogId: 'proxmox', url: found.url })).toEqual({
      catalogId: 'proxmox',
      url: found.url,
      hidden: true,
    });
    expect(HideFoundServiceBody.parse({ catalogId: 'proxmox', url: found.url, hidden: false }).hidden).toBe(
      false,
    );
  });

  it('answers the discovery', () => {
    const op = api.connections.hideFound;
    expect(op.id).toBe('connections.hideFound');
    expect(op.method).toBe('POST');
    expect(op.path).toBe('/burrows/:burrow/connections/discover/hidden');
    const answer = {
      state: 'done',
      progress: null,
      startedAt: null,
      finishedAt: null,
      networks: [],
      found: [{ ...found, hidden: true }],
    };
    expect(op.response).toBe(ConnectionDiscovery);
    expect(ConnectionDiscovery.parse(answer).found[0]?.hidden).toBe(true);
  });
});
