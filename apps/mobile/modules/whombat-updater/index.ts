/**
 * `whombat-updater` — the Android app updates itself (android-self-update.md AP-813), as Morphe Manager does: the APK
 * control hands out is downloaded into the app's cache with progress, checked (size, SHA-256, then this package, the
 * announced version and this app's signer) and handed to Android's installer (`android/`, Kotlin). Without the native
 * module (tests, the iPhone, a build from before 0.44) `supported()` is false and “Update” opens the Mobile app page.
 */
import { requireOptionalNativeModule } from 'expo';

export interface UpdaterProgress {
  received: number;
  total: number;
}

interface NativeWhombatUpdater {
  isSupported(): boolean;
  canInstall(): boolean;
  openInstallSettings(): boolean;
  openAppDetails?(): boolean;
  download(url: string, sha256: string, size: number, versionCode: number): Promise<string>;
  install(path: string): Promise<void>;
  addListener(event: 'onProgress', listener: (event: UpdaterProgress) => void): { remove(): void };
}

const native = requireOptionalNativeModule<NativeWhombatUpdater>('WhombatUpdater');

/** Why a native call failed: `busy`, `network`, `verify`, `signature`, `failed`. */
export function updaterFailureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'failed';
}

function missing(): Error {
  return Object.assign(new Error('No updater here.'), { code: 'failed' });
}

export const WhombatUpdater = {
  supported: (): boolean => {
    try {
      return native?.isSupported() ?? false;
    } catch {
      return false;
    }
  },
  /** Whether Android lets this app install apps (“Install unknown apps”, Android 8+). */
  canInstall: (): boolean => native?.canInstall() ?? false,
  /** Opens that setting for this app; false when it couldn't. */
  openInstallSettings: (): boolean => native?.openInstallSettings() ?? false,
  /** Opens this app's page in Android's settings; false when it couldn't (or the build has no such call). */
  openAppDetails: (): boolean => {
    try {
      return native?.openAppDetails?.() ?? false;
    } catch {
      return false;
    }
  },
  /** Downloads and checks the APK; resolves with its path in the app's cache. */
  async download(
    apk: { url: string; sha256: string; size: number; versionCode: number },
    onProgress: (p: UpdaterProgress) => void,
  ): Promise<string> {
    if (!native) throw missing();
    const sub = native.addListener('onProgress', onProgress);
    try {
      return await native.download(apk.url, apk.sha256, apk.size, apk.versionCode);
    } finally {
      sub.remove();
    }
  },
  /** Opens Android's installer on a downloaded APK. */
  async install(path: string): Promise<void> {
    if (!native) throw missing();
    await native.install(path);
  },
};
