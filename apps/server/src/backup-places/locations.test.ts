/**
 * Where on a place the backups go (backup-places.md BPL-13, BPL-14, BPL-16): the hosts service's Unraid shares read into
 * locations, their order and notes, the location in use on the list, the move rule on a NAS and the sentence the
 * assistant passes on.
 */
import { BACKUP_PLACE_TEXT, type BackupPlace } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { hubBackupPlace, toLocation } from './hub';
import { type LocationFacts, locationNote, locationSaid, placeLocations } from './locations';
import { placesList } from './places';
import type { BackupPlaceRow } from './store';
import { chosenLocation, newBackupsNeeded } from './use';

const L = BACKUP_PLACE_TEXT.location;

const share = (over: Record<string, unknown>) => ({
  id: 'media',
  name: over.id ?? 'media',
  free_bytes: 1000,
  is_new: false,
  smb: '',
  nfs: '',
  primary: 'array',
  path: '/mnt/user/media',
  ...over,
});

const facts = (over: Partial<LocationFacts>): LocationFacts => ({
  id: 'x',
  name: over.id ?? 'x',
  freeBytes: null,
  isNew: false,
  recommended: false,
  shared: false,
  pool: null,
  holdsOther: false,
  ...over,
});

describe('Unraid’s shares as locations (BPL-13)', () => {
  it('reads the hub’s shares: new, exported, on a pool, Unraid’s own', () => {
    expect(toLocation(share({ id: 'whombat-backups', is_new: true, free_bytes: 5000 }))).toEqual({
      id: 'whombat-backups',
      name: 'whombat-backups',
      freeBytes: 5000,
      isNew: true,
      recommended: true,
      shared: false,
      pool: null,
      holdsOther: false,
    });
    expect(toLocation(share({ smb: 'private' }))?.shared).toBe(true);
    expect(toLocation(share({ nfs: 'public' }))?.shared).toBe(true);
    expect(toLocation(share({ nfs: true }))?.shared).toBe(true);
    expect(toLocation(share({ smb: 'no', nfs: '' }))?.shared).toBe(false);
    expect(toLocation(share({ primary: 'cache' }))?.pool).toBe('cache');
    expect(toLocation(share({ primary: 'user' }))?.pool).toBeNull();
    expect(toLocation(share({ id: 'appdata' }))?.holdsOther).toBe(true);
    expect(toLocation({ name: 'no id' })).toBeNull();
    const place = hubBackupPlace({
      backup_place: {
        supported: true,
        platform: 'unraid',
        locations: [share({}), { bad: true }],
        clients: [{ client: 'whombat-home-3fkq', location: 'media', cleanup: {} }],
      },
    });
    expect(place?.locations.map((l) => l.id)).toEqual(['media']);
    expect(place?.clients[0]?.location).toBe('media');
  });

  it('the dedicated share first, by room after, Unraid’s own last; one plain note each', () => {
    const list = placeLocations([
      facts({ id: 'appdata', freeBytes: 9000, holdsOther: true, pool: 'cache' }),
      facts({ id: 'media', freeBytes: 100, shared: true }),
      facts({ id: 'backups', freeBytes: 800, pool: 'cache' }),
      facts({ id: 'whombat-backups', freeBytes: 50, isNew: true, recommended: true }),
      facts({ id: 'media', freeBytes: 1 }),
    ]);
    expect(list.map((l) => [l.id, l.recommended, l.note])).toEqual([
      ['whombat-backups', true, null],
      ['backups', false, L.onPool('cache')],
      ['media', false, L.shared],
      ['appdata', false, L.holdsOther],
    ]);
    expect(list[0]?.isNew).toBe(true);
    // Shared on the network outweighs the rest.
    expect(locationNote(facts({ shared: true, holdsOther: true, pool: 'cache' }))).toBe(L.shared);
  });

  it('one location or none is no choice: the person isn’t asked', () => {
    expect(placeLocations([])).toEqual([]);
    expect(placeLocations([facts({ id: 'whombat-backups', recommended: true })])).toEqual([]);
  });

  it('a location in a sentence, per kind; none without a choice', () => {
    const two = placeLocations([facts({ id: 'tank' }), facts({ id: 'big' })]);
    expect(locationSaid('truenas', two, 'tank')).toBe('the pool tank');
    expect(locationSaid('synology', two, 'tank')).toBe('the shared folder tank');
    expect(locationSaid('unraid', two, 'big')).toBe('the share big');
    expect(locationSaid('linux', [], 'srv')).toBeNull();
    expect(locationSaid('unraid', two, null)).toBeNull();
  });
});

const place = (over: Partial<BackupPlace>): BackupPlace => ({
  id: 'connection:con_1',
  kind: 'truenas',
  name: 'Vault',
  address: '192.168.1.20',
  state: 'in_use',
  reason: null,
  byHand: false,
  kept: null,
  locations: placeLocations([facts({ id: 'tank' }), facts({ id: 'big', recommended: true })]),
  location: 'tank',
  ...over,
});

describe('choosing a location (BPL-14)', () => {
  it('only one the place lists', () => {
    expect(chosenLocation(place({}), undefined)).toBeUndefined();
    expect(chosenLocation(place({}), 'big')).toBe('big');
    expect(() => chosenLocation(place({}), 'gone')).toThrow(L.gone);
  });

  it('a NAS in use, another location: new backups, so the person confirms; the agent moves them itself', () => {
    expect(newBackupsNeeded(place({}), 'big', false)).toEqual({ from: 'tank' });
    expect(newBackupsNeeded(place({}), 'big', true)).toBeNull();
    expect(newBackupsNeeded(place({}), 'tank', false)).toBeNull();
    expect(newBackupsNeeded(place({}), undefined, false)).toBeNull();
    expect(newBackupsNeeded(place({ state: 'ready', location: null }), 'big', false)).toBeNull();
    expect(newBackupsNeeded(place({ kind: 'unraid', id: 'server:blackbox' }), 'big', false)).toBeNull();
  });
});

describe('the location in use on the list', () => {
  const row = (over: Partial<BackupPlaceRow>): BackupPlaceRow => ({
    id: 'server:blackbox',
    kind: 'unraid',
    name: 'BlackBox',
    client: 'whombat-home-3fkq',
    address: '10.100.0.40',
    port: 8747,
    byHand: false,
    repositoryId: 'repo-1',
    cleanupAt: null,
    cleanupKeep: null,
    pendingPasswordEnc: null,
    pendingUntil: null,
    location: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  });
  const listed = (over: Partial<BackupPlace>) => place({ state: 'ready', ...over });

  it('a server’s as its agent reports it, a NAS’s from its record, else where the NAS put them before', () => {
    const server = listed({ id: 'server:blackbox', kind: 'unraid', location: 'whombat-backups' });
    const nas = listed({ location: 'tank' });
    const list = (rows: BackupPlaceRow[], repositoryId: string) =>
      placesList({ servers: [server], connections: [nas], found: [], rows, repositoryId }).places;
    expect(list([row({ location: 'media' })], 'repo-1').map((p) => [p.id, p.state, p.location])).toEqual([
      ['server:blackbox', 'in_use', 'whombat-backups'],
      ['connection:con_1', 'ready', null],
    ]);
    const nasRow = row({ id: 'connection:con_1', kind: 'truenas', repositoryId: 'repo-2' });
    expect(list([{ ...nasRow, location: 'big' }], 'repo-2')[1]?.location).toBe('big');
    expect(list([nasRow], 'repo-2')[1]?.location).toBe('tank');
  });
});
