/**
 * “What’s new” on the phone: the web app's page of what changed in Whombat lately (public on the hosted app, so the
 * phone opens it in the browser), its row in About, and the one-time “Whombat updated” notice after an update. What
 * this phone saw last is kept per Whombat in the secure store; a store that can't be read shows nothing.
 */
import { WHATS_NEW_PATH, WHATS_NEW_TEXT, whatsNewNotice, whatsNewSeenKey } from '@whombat/client/managed';
import type { ApplianceStatus } from '@whombat/client/session';
import type { KeyValueStore } from '../lib/kv';
import { UI_ORIGINS } from './config';

export const WHATS_NEW_URL = `${UI_ORIGINS[0] ?? 'https://app.whombat.com'}${WHATS_NEW_PATH}`;

/** About's row under the updates. */
export const WHATS_NEW_ROW = {
  title: WHATS_NEW_TEXT.link,
  body: WHATS_NEW_TEXT.linkMeta,
  label: `${WHATS_NEW_TEXT.link}. ${WHATS_NEW_TEXT.linkMeta}`,
} as const;

/**
 * The release the notice tells about, or null for none. It is kept as seen at once, so the notice shows once even when
 * nobody taps it; the first look only remembers the release (there is nothing to compare it with), quietly.
 */
export async function whatsNewToShow(
  store: KeyValueStore,
  whombat: string,
  status: Pick<ApplianceStatus, 'update'> | null | undefined,
): Promise<string | null> {
  const key = whatsNewSeenKey(whombat);
  let seen: string | null;
  try {
    seen = await store.get(key);
  } catch {
    return null;
  }
  const { action, release } = whatsNewNotice(status, seen);
  if (action === 'none') return null;
  await store.set(key, release).catch(() => {});
  return action === 'show' ? release : null;
}
