/** The caller's own account (`me.*`): who they are, their burrows, preferences, name, title and photo. */
import { api, DEFAULT_PREFERENCES } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { memberships, toAccount } from '../auth/service';
import { updatePreferences } from '../commands/account';
import { setAvatar, updateProfile } from '../commands/profile';
import { accounts } from '../db/schema/index';
import { unauthorized } from '../lib/errors';
import { route } from './define';

export const meRoutes = [
  route(api.me.get, async ({ auth, services }) => {
    if (!auth.account) throw unauthorized();
    return {
      account: toAccount(auth.account),
      memberships: await memberships(services, auth.account.id),
      preferences: { ...DEFAULT_PREFERENCES, ...auth.account.preferences },
    };
  }),

  route(api.me.getPreferences, async ({ auth, services }) => {
    if (!auth.account) throw unauthorized();
    const [row] = await services.db.select().from(accounts).where(eq(accounts.id, auth.account.id));
    return { ...DEFAULT_PREFERENCES, ...(row?.preferences ?? {}) };
  }),

  route(api.me.updatePreferences, async ({ auth, body, services }) => {
    if (!auth.account) throw unauthorized();
    return updatePreferences(services, auth.account.id, body);
  }),

  route(api.me.updateProfile, async ({ auth, body, services }) => {
    if (!auth.account) throw unauthorized();
    return updateProfile(services, auth.account.id, body);
  }),

  // A person's photo, account-wide like the profile (contracts CT-265, person-avatars.md PVA-01).
  route(api.me.setAvatar, async ({ auth, body, services }) => {
    if (!auth.account) throw unauthorized();
    return setAvatar(services, auth.account.id, body);
  }),
];
