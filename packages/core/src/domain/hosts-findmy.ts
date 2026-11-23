/**
 * Find My through a Mac (docs/implementation/macos/findmy.md): Whombat reads the Find My app on a Mac through Whombat
 * Helper, as a person reads it, finds each person's place with the Mac's own geocoder and draws the map on the Mac.
 * Find My gives no coordinates, so a person's spot on the map is their address's (about 100 m); “Show exactly” takes
 * Find My's own map of that person from the Mac's screen. What was read lives in the box's memory only. The Find My
 * connection (docs/implementation/macos/findmy-connection.md) reads it for its page, the assistant and automations.
 */
import { z } from 'zod';
import { ConnectionId } from '../ids.js';
import { Timestamp } from './common.js';
import { HOST_SCREEN_IMAGE_MAX, HOST_SCREEN_LIMITS, HostScreenCode, hostScreenProblemText } from './hosts.js';

const Id = z.string().min(1).max(200);

/** Find My's people a read keeps at most. */
export const HOST_FIND_MY_PEOPLE_MAX = 50;

/** A read newer than this answers a refresh by itself (ms): the tab opening twice reads once. */
export const HOST_FIND_MY_FRESH_MS = 2 * 60_000;

/** The apps read again this often while the tab stays open (ms). */
export const HOST_FIND_MY_REFRESH_MS = 15 * 60_000;

/** The apps ask for the state this often while a read or a picture is under way (ms). */
export const HOST_FIND_MY_POLL_MS = 2000;

/**
 * The Find My connection's Read in the background choices (its `background` field), Off first and the default: reading
 * takes the Mac's screen for a moment, so it happens without anyone looking only when the person chose how often.
 */
export const FIND_MY_BACKGROUND_CHOICES = [
  { value: 'off', label: 'Off' },
  { value: '5', label: 'Every 5 minutes' },
  { value: '15', label: 'Every 15 minutes' },
  { value: '30', label: 'Every 30 minutes' },
  { value: '60', label: 'Every hour' },
] as const;

export type FindMyBackground = (typeof FIND_MY_BACKGROUND_CHOICES)[number]['value'];

/** Minutes between background reads for a `background` value; null for Off or a value it doesn't know. */
export function findMyBackgroundMinutes(value: string | null | undefined): number | null {
  const choice = FIND_MY_BACKGROUND_CHOICES.find((c) => c.value === value);
  return choice && choice.value !== 'off' ? Number(choice.value) : null;
}

/**
 * How often a Find My connection reads at least while a live automation listens to it, even with Read in the
 * background Off (ms): an arrival is noticed within a quarter of an hour without taking the Mac's screen more often.
 */
export const FIND_MY_LISTENED_MS = 15 * 60_000;

/** The longest place words a Find My trigger or event carries (Find My's own words: “Home”, “Lelystad”). */
export const FIND_MY_PLACE_MAX = 200;

/** A person on Find My as Whombat names them everywhere: 12 hex characters of the SHA-256 of their name. */
export const FindMyPersonId = z.string().regex(/^[0-9a-f]{12}$/);

/** `findmy_people`'s input: everyone, or one person by name or first name. */
export const FindMyPeopleArgs = z.strictObject({
  person: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('A name or first name (Mara); leave out for everyone'),
});
export type FindMyPeopleArgs = z.infer<typeof FindMyPeopleArgs>;

/** The signed event a Find My connection an automation listens to records when a person's place changes. */
export const FIND_MY_PLACE_CHANGED = 'findmy.place_changed';

/**
 * `findmy.place_changed`'s payload: whose place changed on which Find My connection, their name, and the place's words
 * before and now (null: Find My had no place for them, “No location found”). Never a street or coordinates.
 */
export const FindMyPlaceChanged = z.strictObject({
  connectionId: ConnectionId,
  person: FindMyPersonId,
  name: z.string().min(1).max(200),
  from: z.string().min(1).max(FIND_MY_PLACE_MAX).nullable(),
  to: z.string().min(1).max(FIND_MY_PLACE_MAX).nullable(),
});
export type FindMyPlaceChanged = z.infer<typeof FindMyPlaceChanged>;

/** Place words as automations compare them: case and spaces don't count (“home ” is “Home”). */
export function findMyPlaceKey(place: string): string {
  return place.normalize('NFC').toLowerCase().replace(/\s+/g, '');
}

/**
 * Why a read or a picture didn't work: the Mac's screen codes, and `in_use` (someone used the Mac's keyboard or mouse
 * in the last minute: Whombat doesn't take the screen from them), `no_find_my` (Find My didn't open or shows no People
 * tab) and `helper_old` (Whombat Helper older than 1.1.0; it updates itself).
 */
export const HOST_FIND_MY_CODES = ['in_use', 'no_find_my', 'helper_old'] as const;
export const HostFindMyCode = z.union([HostScreenCode, z.enum(HOST_FIND_MY_CODES)]);
export type HostFindMyCode = z.infer<typeof HostFindMyCode>;

export const HostFindMyProblem = z.object({ code: HostFindMyCode, message: z.string().max(2000).optional() });
export type HostFindMyProblem = z.infer<typeof HostFindMyProblem>;

/**
 * One person on Find My's People tab. `id` is stable for the name (12 hex characters of its SHA-256), `place` and `when`
 * are Find My's own words in the Mac's language (“Home”, “Now”), `address` the street when Find My gave one, and
 * `location` where the Mac's geocoder put the address (else the place): about `accuracyM` metres, not Find My's dot.
 */
export const HostFindMyPerson = z.object({
  id: z.string().regex(/^[0-9a-f]{12}$/),
  name: z.string().min(1).max(200),
  place: z.string().max(300).nullable(),
  address: z.string().max(300).nullable(),
  when: z.string().max(100).nullable(),
  nearby: z.boolean(),
  location: z
    .object({
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
      accuracyM: z.number().nonnegative(),
    })
    .nullable(),
});
export type HostFindMyPerson = z.infer<typeof HostFindMyPerson>;

/** The exact picture of one person: being taken, ready to fetch (`hosts.findMyPicture`) or failed. */
export const HostFindMyExact = z.object({
  person: z.string().regex(/^[0-9a-f]{12}$/),
  state: z.enum(['taking', 'ready', 'failed']),
  takenAt: Timestamp.nullable(),
  problem: HostFindMyProblem.nullable(),
});
export type HostFindMyExact = z.infer<typeof HostFindMyExact>;

/**
 * `hosts.findMy`: what Whombat read from a Mac's Find My last (`readAt`, null: never since the box started or an hour
 * went by without a look), whether a read is under way, why the last one didn't work, and the exact picture asked last.
 */
export const HostFindMy = z.object({
  server: Id,
  reading: z.boolean(),
  readAt: Timestamp.nullable(),
  problem: HostFindMyProblem.nullable(),
  people: z.array(HostFindMyPerson).max(HOST_FIND_MY_PEOPLE_MAX),
  exact: HostFindMyExact.nullable(),
  /**
   * How a Find My connection reads this Mac without anyone looking: every `everyMinutes`, and the name of the
   * automation that needs it when that is the reason. Null or absent: only while someone looks (and an older box).
   */
  background: z
    .object({ everyMinutes: z.number().int().positive(), automation: z.string().max(200).nullable() })
    .nullable()
    .optional(),
});
export type HostFindMy = z.infer<typeof HostFindMy>;

/** `hosts.findMyRefresh`'s body: nothing to say (a read starts unless one runs or the last is fresh). */
export const HostFindMyRefreshBody = z.strictObject({});
export type HostFindMyRefreshBody = z.infer<typeof HostFindMyRefreshBody>;

/** `hosts.findMyExact`'s body: whose exact picture to take. */
export const HostFindMyExactBody = z.strictObject({ person: z.string().regex(/^[0-9a-f]{12}$/) });
export type HostFindMyExactBody = z.infer<typeof HostFindMyExactBody>;

const Side = z.coerce.number().int().min(64).max(HOST_SCREEN_LIMITS.mapSide);

/**
 * `hosts.findMyMap`'s query: the picture's size in points (drawn at two pixels a point), the app's theme, and the
 * centre and span to show; without them the map fits everyone who has a place.
 */
export const HostFindMyMapQuery = z.object({
  w: Side,
  h: Side,
  /** `?dark=true` (as `QueryBool`), or the boolean the apps send over the session once they parsed the query. */
  dark: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')])
    .optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  spanM: z.coerce.number().min(50).max(20_000_000).optional(),
});
export type HostFindMyMapQuery = z.infer<typeof HostFindMyMapQuery>;

/**
 * `hosts.findMyMap`: the Mac's map picture (`w` × `h` pixels), each located person's spot on it in the asked points
 * (people outside the picture are left out), and the region drawn (centre, shorter side in metres) to zoom from.
 */
export const HostFindMyMap = z.object({
  server: Id,
  imageB64: z.string().max(HOST_SCREEN_IMAGE_MAX),
  format: z.enum(['png', 'jpeg']),
  w: z.number().int().nonnegative(),
  h: z.number().int().nonnegative(),
  points: z
    .array(z.object({ person: z.string().regex(/^[0-9a-f]{12}$/), x: z.number(), y: z.number() }))
    .max(HOST_FIND_MY_PEOPLE_MAX),
  lat: z.number(),
  lon: z.number(),
  spanM: z.number(),
});
export type HostFindMyMap = z.infer<typeof HostFindMyMap>;

/** `hosts.findMyPicture`'s query: whose exact picture. */
export const HostFindMyPictureQuery = z.object({ person: z.string().regex(/^[0-9a-f]{12}$/) });
export type HostFindMyPictureQuery = z.infer<typeof HostFindMyPictureQuery>;

/** `hosts.findMyPicture`: Find My's own map of one person, cut from the Mac's screen, and when it was taken. */
export const HostFindMyPicture = z.object({
  server: Id,
  person: z.string().regex(/^[0-9a-f]{12}$/),
  imageB64: z.string().max(HOST_SCREEN_IMAGE_MAX),
  format: z.enum(['png', 'jpeg']),
  w: z.number().int().nonnegative(),
  h: z.number().int().nonnegative(),
  takenAt: Timestamp,
});
export type HostFindMyPicture = z.infer<typeof HostFindMyPicture>;

/** Why Find My couldn't be read on `server`, in a sentence a person reads (the screen's codes as a screen step's). */
export function findMyProblemText(code: HostFindMyCode, server: string, message?: string | null): string {
  switch (code) {
    case 'in_use':
      return `Someone is using ${server} right now, so Whombat leaves its screen alone. Try again when it’s been left for a minute.`;
    case 'no_find_my':
      return `Find My didn’t open on ${server}. Check that the Mac is signed in to iCloud with Find My on.`;
    case 'helper_old':
      return `Whombat Helper on ${server} is updating to a version that reads Find My. Try again in a few minutes.`;
    default:
      return hostScreenProblemText(code, server, message);
  }
}
