import { BACKUP_PLACE_TEXT, type BackupPlace } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { OperationError } from '../session/managed-ops';
import { OutcomeUnknownError } from '../session/types';
import {
  BACKUP_PLACES_TEXT,
  backupPlaceRows,
  currentPlaceLine,
  keptHere,
  moveFromPlace,
  moveNeeded,
  placeAgo,
  placeErrorText,
  placeLocationChange,
  placeLocations,
  placeMoveMayRun,
  placeSetNotes,
  placeWhere,
  waitForPlaceLocation,
} from './backup-places';
import { backupPlacesFixture, createFakeBackupPlaces } from './backup-places-fake';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const DAY = 86_400_000;

const place = (over: Partial<BackupPlace>): BackupPlace => ({
  id: 'server:x',
  kind: 'linux',
  name: 'x',
  address: null,
  state: 'ready',
  reason: null,
  byHand: false,
  kept: null,
  locations: [],
  location: null,
  ...over,
});

describe('backupPlaceRows', () => {
  it('lists the place in use first, then by what can be done, each with its one action', () => {
    const rows = backupPlaceRows(backupPlacesFixture(NOW));
    expect(rows.map((r) => [r.name, r.action?.kind ?? null])).toEqual([
      ['blackbox', 'change'],
      ['the-falcon', 'use'],
      ['DiskStation', 'use'],
      ['pve-01', 'manage'],
      ['Synology NAS', 'connect'],
      ['QNAP NAS', 'byHand'],
    ]);
    expect(rows[0]).toMatchObject({ current: true, mark: 'unraid' });
    expect(rows[0]?.line).toContain(BACKUP_PLACE_TEXT.state.in_use);
    expect(rows[0]?.line).toContain('whombat-backups');
    expect(rows[1]).toMatchObject({ mark: 'server', line: BACKUP_PLACE_TEXT.state.ready });
  });

  it('says the free space of a ready place when the box knows it', () => {
    const kept = {
      usedBytes: 0,
      freeBytes: 3_100_000_000_000,
      cleanup: { on: false, keepDays: 90, lastAt: null, ok: null },
      byHand: false,
    };
    const [row] = backupPlaceRows({ places: [place({ kept })], currentPlaceId: null });
    expect(row?.line).toContain('Ready');
    expect(row?.line).toContain('3.1');
  });

  it('links a found NAS to its connect page and a found Unraid to Add a server', () => {
    const rows = backupPlaceRows({
      currentPlaceId: null,
      places: [
        place({ id: 'found:192.168.1.50', kind: 'synology', state: 'connect_first' }),
        place({ id: 'found:10.0.0.9', kind: 'unraid', state: 'connect_first' }),
      ],
    });
    expect(rows[0]?.action).toMatchObject({
      kind: 'connect',
      catalogId: 'synology',
      address: '192.168.1.50',
      asServer: false,
    });
    expect(rows[1]?.action).toMatchObject({ kind: 'connect', address: '10.0.0.9', asServer: true });
  });

  it('sends Look only to the server’s System tab and a connection’s Settings', () => {
    const rows = backupPlaceRows({
      currentPlaceId: null,
      places: [
        place({ id: 'server:pve-01', state: 'manage_first' }),
        place({ id: 'connection:con_1', kind: 'truenas', state: 'manage_first' }),
      ],
    });
    expect(rows[0]?.action).toMatchObject({ kind: 'manage', thing: 'server:pve-01', tab: 'system' });
    expect(rows[1]?.action).toMatchObject({ kind: 'manage', thing: 'connection:con_1', tab: 'settings' });
  });

  it('offers nothing for a place that can’t keep backups, and its reason as the line', () => {
    const [row] = backupPlaceRows({
      currentPlaceId: null,
      places: [place({ state: 'unsupported', reason: BACKUP_PLACE_TEXT.reasons.noDocker })],
    });
    expect(row).toMatchObject({ action: null, line: BACKUP_PLACE_TEXT.reasons.noDocker });
  });

  it('is empty without an answer', () => {
    expect(backupPlaceRows(null)).toEqual([]);
  });
});

describe('currentPlaceLine', () => {
  it('names the place and its kind, that deleting is blocked and the cleanup', () => {
    const line = currentPlaceLine(backupPlacesFixture(NOW));
    expect(line?.title).toBe('blackbox · Unraid · the share whombat-backups');
    expect(line?.meta).toContain(BACKUP_PLACE_TEXT.appendOnly);
    expect(line?.meta).toContain('90');
  });

  it('says when old backups aren’t cleared there', () => {
    const list = backupPlacesFixture(NOW);
    const kept = list.places[0]?.kept;
    if (kept) kept.cleanup.on = false;
    expect(currentPlaceLine(list)?.meta).toContain(BACKUP_PLACE_TEXT.noCleanup);
  });

  it('is null while no place keeps the backups', () => {
    expect(currentPlaceLine({ ...backupPlacesFixture(NOW), currentPlaceId: null })).toBeNull();
  });
});

describe('where on a place (BPL-13, BPL-14)', () => {
  const blackbox = () => backupPlacesFixture(NOW).places.find((p) => p.id === 'server:blackbox');
  const station = () => backupPlacesFixture(NOW).places.find((p) => p.id === 'connection:con_diskstation');

  it('asks only with more than one location, the recommended one first and preselected', () => {
    const asked = placeLocations(station());
    expect(asked?.rows.map((r) => [r.id, r.recommended])).toEqual([
      ['whombat', true],
      ['Backups', false],
    ]);
    expect(asked?.selected).toBe('whombat');
    expect(asked?.rows[1]?.line).toContain('anyone who can open it');
    expect(placeLocations(place({}))).toBeNull();
    expect(placeLocations(place({ locations: station()?.locations.slice(0, 1) ?? [] }))).toBeNull();
  });

  it('marks and preselects the location in use', () => {
    const asked = placeLocations(blackbox());
    expect(asked?.selected).toBe('whombat-backups');
    expect(asked?.rows.filter((r) => r.current).map((r) => r.id)).toEqual(['whombat-backups']);
    expect(placeWhere(blackbox() ?? place({}))).toBe('the share whombat-backups');
  });

  it('moves the backups on Unraid and starts afresh on a NAS, as its confirm says', () => {
    const unraid = placeLocationChange(blackbox() ?? place({}), 'Backups');
    expect(unraid).toMatchObject({ move: false, name: 'Backups' });
    expect(unraid?.body).toContain('keep their history');
    const nas = placeLocationChange({ ...(station() ?? place({})), location: 'whombat' }, 'Backups');
    expect(nas).toMatchObject({ move: true });
    expect(nas?.body).toContain('stay in whombat');
    expect(placeLocationChange(blackbox() ?? place({}), 'whombat-backups')).toBeNull();
    expect(placeLocationChange(blackbox() ?? place({}), 'nowhere')).toBeNull();
  });
});

describe('a move that outlasts its call (BPL-S20)', () => {
  it('reads the places again after an unknown outcome, not after a refusal', () => {
    expect(placeMoveMayRun(new OutcomeUnknownError('backup.usePlace', 'r1', { acknowledged: true }))).toBe(
      true,
    );
    expect(placeMoveMayRun(new OperationError('backup.usePlace', 504, 'deadline_exceeded', 'late'))).toBe(
      true,
    );
    expect(placeMoveMayRun(new OperationError('backup.usePlace', 409, 'conflict', 'no'))).toBe(false);
  });

  it('waits until the place keeps them in the new location, or gives up', async () => {
    const at = (location: string) => {
      const list = backupPlacesFixture(NOW);
      return {
        ...list,
        places: list.places.map((p) => (p.id === 'server:blackbox' ? { ...p, location } : p)),
      };
    };
    const answers = [at('whombat-backups'), at('whombat-backups'), at('Backups')];
    let reads = 0;
    const read = async () => answers[Math.min(reads++, answers.length - 1)] ?? at('x');
    expect(await waitForPlaceLocation(read, 'server:blackbox', 'Backups', { everyMs: 1 })).toBe(true);
    expect(reads).toBe(3);
    let t = 0;
    const never = waitForPlaceLocation(async () => at('whombat-backups'), 'server:blackbox', 'Backups', {
      everyMs: 1,
      forMs: 3,
      now: () => t++,
    });
    expect(await never).toBe(false);
  });
});

describe('keptHere', () => {
  it('says which Whombat, the space, and when old backups were last cleared', () => {
    const rows = keptHere(backupPlacesFixture(NOW), 'server:blackbox', { whombat: 'Home', now: NOW });
    expect(rows?.[0]?.title).toBe('Home');
    expect(rows?.[0]?.meta).toContain('182');
    expect(rows?.[0]?.meta).toContain('14.6');
    expect(rows?.[1]).toMatchObject({ dot: 'ok' });
    expect(rows?.[1]?.meta).toContain('3 days ago');
  });

  it('warns when the last cleanup failed and is quiet without one', () => {
    const list = backupPlacesFixture(NOW);
    const kept = list.places[0]?.kept;
    if (!kept) throw new Error('fixture');
    kept.cleanup.ok = false;
    expect(keptHere(list, 'server:blackbox', { now: NOW })?.[1]?.dot).toBe('warn');
    expect(keptHere(list, 'server:blackbox', { now: NOW })?.[0]?.title).toBe(BACKUP_PLACES_TEXT.thisWhombat);
    kept.cleanup.on = false;
    expect(keptHere(list, 'server:blackbox', { now: NOW })?.[1]).toMatchObject({
      title: BACKUP_PLACE_TEXT.noCleanup,
      dot: 'mut',
    });
  });

  it('is null for a place that keeps nothing for this Whombat', () => {
    expect(keptHere(backupPlacesFixture(NOW), 'server:the-falcon', { now: NOW })).toBeNull();
    expect(keptHere(null, 'server:blackbox', { now: NOW })).toBeNull();
  });
});

describe('moving backups', () => {
  it('asks first when another place keeps them', () => {
    const list = backupPlacesFixture(NOW);
    expect(moveFromPlace(list, 'server:the-falcon')).toBe('blackbox');
    expect(moveFromPlace(list, 'server:blackbox')).toBeNull();
    expect(moveFromPlace({ ...list, currentPlaceId: null }, 'server:the-falcon')).toBeNull();
  });

  it('reads the box’s refusal to move without the person’s word', () => {
    const refusal = new OperationError('backup.usePlace', 409, 'conflict', 'No.', {
      code: 'move_needed',
      from: 'Backblaze',
    });
    expect(moveNeeded(refusal)).toEqual({ from: 'Backblaze' });
    expect(moveNeeded(new OperationError('x', 409, 'conflict', 'No.', { code: 'move_needed' }))).toEqual({
      from: BACKUP_PLACES_TEXT.fromUnknown,
    });
    expect(moveNeeded(new OperationError('x', 409, 'conflict', 'No.'))).toBeNull();
    expect(moveNeeded(new Error('x'))).toBeNull();
  });
});

describe('words', () => {
  it('says where backups go and that the first one started', () => {
    const text = placeSetNotes({ destination: 'blackbox', appendOnly: 'verified', firstBackup: true });
    expect(text).toContain('blackbox');
    expect(text).toContain(BACKUP_PLACES_TEXT.firstBackup);
    const where = placeSetNotes({
      destination: 'blackbox',
      locationName: 'the share whombat-backups',
      appendOnly: 'verified',
      firstBackup: false,
    });
    expect(where).toContain('the share whombat-backups');
    expect(where).not.toContain(BACKUP_PLACES_TEXT.firstBackup);
  });

  it('passes the box’s sentence about a failed step on, and says a slow one carries on', () => {
    expect(
      placeErrorText(new OperationError('x', 409, 'conflict', 'blackbox didn’t answer on port 8747.')),
    ).toBe('blackbox didn’t answer on port 8747.');
    expect(placeErrorText(new OperationError('x', 504, 'deadline_exceeded', 'late'))).toBe(
      BACKUP_PLACES_TEXT.slow,
    );
  });

  it('counts days, hours and minutes', () => {
    expect(placeAgo(new Date(NOW - 3 * DAY).toISOString(), NOW)).toBe('3 days ago');
    expect(placeAgo(new Date(NOW - DAY * 1.6).toISOString(), NOW)).toBe('2 days ago');
    expect(placeAgo(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe('3 hours ago');
    expect(placeAgo(new Date(NOW - 30_000).toISOString(), NOW)).toBe('just now');
  });
});

describe('the fake', () => {
  it('moves only with the person’s word, then keeps the backups at the new place', async () => {
    const fake = createFakeBackupPlaces({ now: () => NOW });
    const refused = await fake.call('backup.usePlace', { placeId: 'server:the-falcon' });
    expect(refused?.status).toBe(409);
    const done = await fake.call('backup.usePlace', { placeId: 'server:the-falcon', move: true });
    expect(done?.body).toMatchObject({ destination: 'the-falcon', firstBackup: true });
    expect(fake.snapshot().currentPlaceId).toBe('server:the-falcon');
    expect(fake.call('connections.list', {})).toBeNull();
  });

  it('keeps backups where the person chose, and moves them there on the place in use', async () => {
    const fake = createFakeBackupPlaces({ now: () => NOW });
    const set = await fake.call('backup.usePlace', {
      placeId: 'connection:con_diskstation',
      move: true,
      location: 'Backups',
    });
    expect(set?.body).toMatchObject({ locationName: 'the shared folder Backups' });
    expect(fake.snapshot().places.find((p) => p.id === 'connection:con_diskstation')?.location).toBe(
      'Backups',
    );
    const back = await fake.call('backup.usePlace', { placeId: 'server:blackbox', move: true });
    expect(back?.status).toBe(200);
    const moved = await fake.call('backup.usePlace', { placeId: 'server:blackbox', location: 'appdata' });
    expect(moved?.body).toMatchObject({ locationName: 'the share appdata', firstBackup: false });
    expect((await fake.call('backup.usePlace', { placeId: 'server:blackbox', location: 'x' }))?.status).toBe(
      400,
    );
    // A NAS starts afresh there, so only with the person's word.
    const nas = await fake.call('backup.usePlace', { placeId: 'connection:con_diskstation', move: true });
    expect(nas?.status).toBe(200);
    const fresh = await fake.call('backup.usePlace', {
      placeId: 'connection:con_diskstation',
      location: 'Backups',
    });
    expect(fresh?.body).toMatchObject({ error: { details: { code: 'move_needed', from: 'whombat' } } });
  });

  it('checks a place set up by hand only after handing out its app', async () => {
    const fake = createFakeBackupPlaces({ now: () => NOW });
    const id = 'found:192.168.1.60';
    expect((await fake.call('backup.placeCheck', { placeId: id, move: true }))?.status).toBe(409);
    const sheet = await fake.call('backup.placeByHand', { placeId: id });
    expect((sheet?.body as { compose: string } | undefined)?.compose).toContain('--append-only');
    expect((await fake.call('backup.placeCheck', { placeId: id, move: true }))?.status).toBe(200);
  });
});
