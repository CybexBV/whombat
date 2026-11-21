import type { AndroidDownload, ControlApi } from '@whombat/client/managed';
import { type ApplianceSession, sessionOps } from '@whombat/client/session';
import { AndroidDownload as AndroidDownloadSchema, downloadsApi } from '@whombat/control-contracts';
import type { PhoneSignInDeps } from './usePhoneSignIn';

/** The phone sign-in over control and, with a Whombat open, its pairing calls. */
export function phoneSignInDeps(
  control: ControlApi,
  session: ApplianceSession | null,
  appliance: { device: string; peerId: string } | null,
): PhoneSignInDeps {
  return {
    control,
    origin: window.location.origin,
    appliance:
      appliance && session
        ? {
            ...appliance,
            lookup: async (code) => {
              const found = await sessionOps.pairLookup(session, code);
              return { label: found.label, platform: found.platform, fingerprint: found.fingerprint };
            },
            approve: async (input) => {
              await sessionOps.pairApprove(session, input);
            },
          }
        : null,
  };
}

/** Fixture mode (Storybook, tests, the visual suite): a published APK, no network. */
export const FIXTURE_DOWNLOAD: AndroidDownload = {
  version: '0.16.0',
  versionCode: 16000,
  size: 41_234_567,
  sha256: '0'.repeat(64),
  publishedAt: '2026-09-30T12:00:00.000Z',
  url: 'https://api.whombat.com/v1/downloads/android/whombat-0.16.0.apk',
};

/**
 * The self-hosted build has no control session; the APK is public (CT-191), so it asks Whombat's control directly,
 * and only when this page is opened (AP-525).
 */
export async function publicAndroidDownload(): Promise<AndroidDownload | null> {
  const base = (import.meta.env.VITE_WHOMBAT_CONTROL_URL ?? 'https://api.whombat.com').replace(/\/+$/, '');
  const res = await fetch(`${base}/v1${downloadsApi.android.path}`, { credentials: 'omit' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`downloads.android ${res.status}`);
  const body = (await res.json()) as { android?: unknown };
  const parsed = AndroidDownloadSchema.safeParse(body.android);
  return parsed.success ? parsed.data : null;
}
