/**
 * App downloads served by control (CT-191): until the phone app is in the stores, the Android app is a signed APK that
 * the hosted UI's “Mobile app” page links to. Public: the file is the same for everyone.
 */
import { z } from 'zod';
import { controlEndpoint } from './endpoint.js';

export const AndroidDownload = z.object({
  /** The app's version (`0.16.0`) and Android `versionCode`. */
  version: z.string().min(1).max(40),
  versionCode: z.number().int().positive(),
  /** Bytes. */
  size: z.number().int().positive(),
  /** Hex SHA-256 of the APK. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  publishedAt: z.iso.datetime({ offset: true }),
  /** Absolute URL of the APK on control (`https://api.whombat.com/v1/downloads/android/whombat-0.16.0.apk`). */
  url: z.url(),
});
export type AndroidDownload = z.infer<typeof AndroidDownload>;

export const downloadsApi = {
  android: controlEndpoint({
    id: 'downloads.android',
    method: 'GET',
    path: '/downloads/android',
    auth: 'none',
    summary:
      'The Android app this control hands out (null when none is published). The APK itself is `GET /v1/downloads/android/<file>` (`application/vnd.android.package-archive`, an attachment).',
    response: z.object({ android: AndroidDownload.nullable() }),
  }),
};
