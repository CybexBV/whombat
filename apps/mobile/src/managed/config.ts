/**
 * The app's build-time configuration (AP-27): cloud sign-in against control, then end-to-end sessions with Whombats.
 */

export const CONTROL_URL = (process.env.EXPO_PUBLIC_WHOMBAT_CONTROL_URL || 'https://api.whombat.com').replace(
  /\/+$/,
  '',
);

/** Origins of the hosted UI whose `/auth/verify#token=…` links this app accepts. */
export const UI_ORIGINS: readonly string[] = (
  process.env.EXPO_PUBLIC_WHOMBAT_UI_URL || 'https://app.whombat.com'
)
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

/** Test builds without Firebase (see env.d.ts). */
export const PUSH_RELAY = process.env.EXPO_PUBLIC_WHOMBAT_PUSH_RELAY === '1';

/** The app build reported to appliances in `hello` (their compatibility checks). */
export const APP_BUILD = 'mobile-0.1.0';

/** The Play Store listing (AP-261), once there is one. Not linked while it doesn't exist (AP-537). */
export const STORE_URL = 'https://play.google.com/store/apps/details?id=com.whombat.mobile';

/**
 * Where a newer build of this app comes from, opened by the “Update the app” gates and the skew notice: the hosted UI's
 * Mobile app page with the Android download (CT-191), until the store listing exists (AP-537).
 */
export const UPDATE_URL = `${UI_ORIGINS[0] ?? 'https://app.whombat.com'}/mobile`;
