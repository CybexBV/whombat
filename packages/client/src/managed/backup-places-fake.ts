/**
 * Backup places on a fake box (`@whombat/client/backup-places/fake`; app backup-places.md AP-6716): the five ops of
 * `backup.places`…`backup.forgetPlace` over one in-memory list, for the web's fixture mode, its fake managed world, the
 * visual baselines and tests. The fixture world's places name the fixture servers: blackbox keeps the backups (Unraid,
 * cleared weekly) in its share whombat-backups, beside the shares Backups and appdata; the-falcon is ready; a Synology
 * DiskStation is ready with two shared folders; pve-01 is added with Look only; a Synology NAS the scan found isn't
 * connected and a QNAP whose Container Station Whombat can't use is set up by hand. Choosing another location on the
 * place in use moves the backups (`moveMs`).
 */
import { BACKUP_PLACE_KEEP_DAYS, BACKUP_PLACE_TEXT, BackupPlace } from '@whombat/core/domain';
import type { z } from 'zod';
import type { BackupPlacesList } from '../session/managed-ops';
import { BACKUP_PLACES_TEXT } from './backup-places';

const DAY = 86_400_000;
const TB = 1_000_000_000_000;
const SHARED = 'Shared on your network: anyone who can open it could delete the backups.';

/** The fixture world's places (`now` sets when blackbox was last cleared). */
export function backupPlacesFixture(now: number = Date.now()): BackupPlacesList {
  const given: z.input<typeof BackupPlace>[] = [
    {
      id: 'server:blackbox',
      kind: 'unraid',
      name: 'blackbox',
      address: '10.100.1.30',
      state: 'in_use',
      reason: null,
      byHand: false,
      kept: {
        usedBytes: 182_400_000_000,
        freeBytes: 14_600_000_000_000,
        cleanup: {
          on: true,
          keepDays: BACKUP_PLACE_KEEP_DAYS,
          lastAt: new Date(now - 3 * DAY).toISOString(),
          ok: true,
        },
        byHand: false,
      },
      locations: [
        {
          id: 'whombat-backups',
          name: 'whombat-backups',
          freeBytes: 14.6 * TB,
          isNew: false,
          recommended: true,
          note: 'Only Whombat uses it. It isn’t shared on your network.',
        },
        {
          id: 'Backups',
          name: 'Backups',
          freeBytes: 14.6 * TB,
          isNew: false,
          recommended: false,
          note: SHARED,
        },
        {
          id: 'appdata',
          name: 'appdata',
          freeBytes: 0.4 * TB,
          isNew: false,
          recommended: false,
          note: 'Unraid’s apps keep their settings here.',
        },
      ],
      location: 'whombat-backups',
    },
    {
      id: 'server:the-falcon',
      kind: 'linux',
      name: 'the-falcon',
      address: '10.100.1.40',
      state: 'ready',
      reason: null,
      byHand: false,
      kept: null,
    },
    {
      id: 'connection:con_diskstation',
      kind: 'synology',
      name: 'DiskStation',
      address: '10.100.1.50',
      state: 'ready',
      reason: null,
      byHand: false,
      kept: null,
      locations: [
        {
          id: 'Backups',
          name: 'Backups',
          freeBytes: 7.2 * TB,
          isNew: false,
          recommended: false,
          note: SHARED,
        },
        {
          id: 'whombat',
          name: 'whombat',
          freeBytes: 7.2 * TB,
          isNew: false,
          recommended: true,
          note: 'Only Whombat uses it.',
        },
      ],
    },
    {
      id: 'server:pve-01',
      kind: 'linux',
      name: 'pve-01',
      address: '10.100.1.21',
      state: 'manage_first',
      reason: BACKUP_PLACE_TEXT.reasons.manage,
      byHand: false,
      kept: null,
    },
    {
      id: 'found:192.168.1.50',
      kind: 'synology',
      name: 'Synology NAS',
      address: '192.168.1.50',
      state: 'connect_first',
      reason: BACKUP_PLACE_TEXT.reasons.connect('the Synology NAS'),
      byHand: false,
      kept: null,
    },
    {
      id: 'found:192.168.1.60',
      kind: 'qnap',
      name: 'QNAP NAS',
      address: '192.168.1.60',
      state: 'unsupported',
      reason: 'Its Container Station is too old for Whombat to set up. You can set it up by hand.',
      byHand: true,
      kept: null,
    },
  ];
  const places = given.map((p) => BackupPlace.parse(p));
  return { places, currentPlaceId: 'server:blackbox' };
}

const COMPOSE = (client: string) => `services:
  whombat-backup:
    image: restic/rest-server:0.14.0
    container_name: whombat-backup-${client}
    restart: unless-stopped
    command: ["--append-only", "--private-repos", "--htpasswd-file", "/data/.whombat/${client}.htpasswd"]
    ports:
      - "8747:8000"
    volumes:
      - ./whombat-backups:/data
    configs:
      - source: htpasswd
        target: /data/.whombat/${client}.htpasswd
configs:
  htpasswd:
    content: "${client}:$$2y$$10$$Fake.bcrypt.line.for.the.fixture.world.only.XXXXXXXXXX"
`;

export interface FakeBackupPlacesOptions {
  /** The list to start from (the fixture world's by default). */
  initial?: BackupPlacesList;
  now?: () => number;
  /** How long setting a place up takes, so its progress shows (0: at once). */
  setupMs?: number;
  /** How long moving the backups to another location on the place in use takes (`setupMs` by default). */
  moveMs?: number;
  /** A box without backup places: every op answers `unknown_op`. */
  available?: boolean;
  /** This Whombat's client name on the NAS. */
  client?: string;
}

export interface FakeBackupPlaces {
  /** Answers one of the backup places' ops; null for any other op. */
  call(op: string, input: unknown): Promise<{ status: number; body: unknown }> | null;
  snapshot(): BackupPlacesList;
}

const err = (status: number, code: string, message: string, details?: unknown) => ({
  status,
  body: { error: { code, message, ...(details === undefined ? {} : { details }) } },
});

export function createFakeBackupPlaces(options: FakeBackupPlacesOptions = {}): FakeBackupPlaces {
  const now = options.now ?? Date.now;
  const client = options.client ?? 'whombat-home-3fkq';
  let list: BackupPlacesList = structuredClone(options.initial ?? backupPlacesFixture(now()));
  const byHandAsked = new Set<string>();
  const wait = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

  const set = (placeId: string, byHand: boolean, location?: string) => {
    const place = list.places.find((p) => p.id === placeId);
    if (!place) return null;
    const at =
      place.locations.length > 1
        ? (location ?? place.locations.find((l) => l.recommended)?.id ?? place.locations[0]?.id ?? null)
        : null;
    const where = at ? place.locations.find((l) => l.id === at) : null;
    list = {
      currentPlaceId: placeId,
      places: list.places.map((p) =>
        p.id === placeId
          ? {
              ...p,
              state: 'in_use',
              reason: null,
              location: at,
              // Moved within the place in use: what it keeps comes along.
              kept: (p.state === 'in_use' && p.kept) || {
                usedBytes: 0,
                freeBytes: p.kept?.freeBytes ?? 2_900_000_000_000,
                cleanup: { on: !byHand, keepDays: BACKUP_PLACE_KEEP_DAYS, lastAt: null, ok: null },
                byHand,
              },
            }
          : p.state === 'in_use'
            ? { ...p, state: 'ready' }
            : p,
      ),
    };
    return {
      placeId,
      destination: place.name,
      locationName: where ? BACKUP_PLACES_TEXT.where(place.kind, where.name) : null,
      appendOnly: 'verified',
      firstBackup: true,
    };
  };

  const refuseMove = (placeId: string, move: unknown) => {
    if (move === true || !list.currentPlaceId || list.currentPlaceId === placeId) return null;
    const from = list.places.find((p) => p.id === list.currentPlaceId)?.name;
    return err(409, 'conflict', 'Backups go somewhere else already.', { code: 'move_needed', from });
  };

  return {
    snapshot: () => structuredClone(list),
    call(op, raw) {
      if (!op.startsWith('backup.') || !OPS.has(op)) return null;
      if (options.available === false) return Promise.resolve(err(404, 'unknown_op', `No operation ${op}`));
      const input = (raw ?? {}) as { placeId?: string; move?: boolean; location?: string };
      const place = input.placeId ? list.places.find((p) => p.id === input.placeId) : undefined;
      if (op === 'backup.places') return Promise.resolve({ status: 200, body: structuredClone(list) });
      if (!place) return Promise.resolve(err(404, 'not_found', 'There is no such place.'));
      switch (op) {
        case 'backup.usePlace': {
          if (input.location && !place.locations.some((l) => l.id === input.location))
            return Promise.resolve(err(400, 'bad_request', `${place.name} has no such place for backups.`));
          // Where on the place in use, chosen again: the backups move there (BPL-14).
          if (place.state === 'in_use' && input.location && input.location !== place.location) {
            // A NAS starts new backups there and keeps the old ones: only with the person's word.
            const nas = place.kind !== 'unraid' && place.kind !== 'linux';
            if (nas && input.move !== true) {
              const from = place.locations.find((l) => l.id === place.location)?.name;
              return Promise.resolve(
                err(409, 'conflict', 'New backups would start there.', { code: 'move_needed', from }),
              );
            }
            return wait(options.moveMs ?? options.setupMs ?? 0).then(() => ({
              status: 200,
              body: { ...set(place.id, place.kept?.byHand ?? false, input.location), firstBackup: nas },
            }));
          }
          if (place.state !== 'ready')
            return Promise.resolve(err(409, 'conflict', `${place.name} can’t keep backups yet.`));
          const refused = refuseMove(place.id, input.move);
          if (refused) return Promise.resolve(refused);
          return wait(options.setupMs ?? 0).then(() => ({
            status: 200,
            body: set(place.id, false, input.location),
          }));
        }
        case 'backup.placeByHand':
          if (!place.byHand) return Promise.resolve(err(409, 'conflict', 'Whombat sets this one up itself.'));
          byHandAsked.add(place.id);
          return Promise.resolve({
            status: 200,
            body: {
              compose: COMPOSE(client),
              steps: [
                `Open Container Station on ${place.name} and choose Create.`,
                'Paste the app below and start it.',
                'Come back here and choose Check it.',
              ],
              expiresAt: new Date(now() + DAY).toISOString(),
            },
          });
        case 'backup.placeCheck': {
          if (!byHandAsked.has(place.id))
            return Promise.resolve(err(409, 'conflict', 'Get the app to paste first.'));
          const refused = refuseMove(place.id, input.move);
          if (refused) return Promise.resolve(refused);
          return wait(options.setupMs ?? 0).then(() => ({ status: 200, body: set(place.id, true) }));
        }
        case 'backup.forgetPlace':
          if (place.state === 'in_use')
            return Promise.resolve(err(409, 'conflict', 'Backups go there now. Choose another place first.'));
          list = { ...list, places: list.places.filter((p) => p.id !== place.id) };
          return Promise.resolve({ status: 200, body: { ok: true } });
        default:
          return null;
      }
    },
  };
}

const OPS = new Set([
  'backup.places',
  'backup.usePlace',
  'backup.placeByHand',
  'backup.placeCheck',
  'backup.forgetPlace',
]);
