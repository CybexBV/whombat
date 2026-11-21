/**
 * The signed-in person's own account: who they are, their burrows and preferences, their name, title and photo. A
 * person is signed in by their device's enrolled key (the session's endpoint, `@whombat/protocol/session`); there are
 * no cookies, sign-in links or tokens.
 */
import { z } from 'zod';
import { Account, Membership, Preferences } from '../domain/account.js';
import { Person, PersonName, PersonTitle } from '../domain/principal.js';
import { endpoint } from './endpoint.js';

export const MeResponse = z.object({
  account: Account,
  memberships: z.array(Membership),
  preferences: Preferences,
});
export type MeResponse = z.infer<typeof MeResponse>;

/** The sign-up name step and the Profile section of settings. At least one field. */
export const UpdateProfileBody = z
  .object({ name: PersonName.optional(), title: PersonTitle.optional() })
  .refine((b) => b.name !== undefined || b.title !== undefined, 'Change the name or the title.');
export type UpdateProfileBody = z.infer<typeof UpdateProfileBody>;

/** Largest photo `me.setAvatar` takes, decoded bytes: one session request (64 KiB) carries it as base64 (CT-265). */
export const AVATAR_MAX_BYTES = 32 * 1024;
/** The square, in pixels, clients crop and scale a photo to before `me.setAvatar` (two device pixels at 128). */
export const AVATAR_PIXELS = 256;
/** Smallest and largest side the runtime keeps. */
export const AVATAR_MIN_PIXELS = 32;
export const AVATAR_MAX_PIXELS = 1024;
/** The image types a photo may have (sniffed from the bytes; SVG never: it can carry script). */
export const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/**
 * `me.setAvatar`: the photo as base64 (`image/jpeg`, `image/png` or `image/webp`, at most `AVATAR_MAX_BYTES` decoded and
 * `AVATAR_MAX_PIXELS` a side; clients send an `AVATAR_PIXELS` square), or null to go back to the initials.
 */
export const SetAvatarBody = z.object({
  image: z
    .string()
    .max(Math.ceil(AVATAR_MAX_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'The photo must be base64.')
    .nullable(),
});
export type SetAvatarBody = z.infer<typeof SetAvatarBody>;

export const ProfileResponse = z.object({
  account: Account,
  /** The account's person in each of its burrows, after the change (each change is a signed event there). */
  people: z.array(Person),
});
export type ProfileResponse = z.infer<typeof ProfileResponse>;

export const meEndpoints = {
  get: endpoint({
    id: 'me.get',
    method: 'GET',
    path: '/me',
    summary: 'Signed-in account, burrows and preferences.',
    response: MeResponse,
  }),
  getPreferences: endpoint({
    id: 'me.getPreferences',
    method: 'GET',
    path: '/me/preferences',
    summary: 'Theme, time zone and avatar motion preferences.',
    response: Preferences,
  }),
  updatePreferences: endpoint({
    id: 'me.updatePreferences',
    method: 'PATCH',
    path: '/me/preferences',
    summary: 'Change theme (light / dark / system) or time zone. Persisted per user.',
    body: Preferences.partial(),
    response: Preferences,
  }),
  updateProfile: endpoint({
    id: 'me.updateProfile',
    method: 'PATCH',
    path: '/me/profile',
    summary: 'Change your name and title: the account and your person (a signed “person.updated” event).',
    body: UpdateProfileBody,
    response: ProfileResponse,
  }),
  setAvatar: endpoint({
    id: 'me.setAvatar',
    method: 'PUT',
    path: '/me/avatar',
    summary: 'Set or remove your photo: the account and your person (a signed “person.updated” event).',
    body: SetAvatarBody,
    response: ProfileResponse,
  }),
};
