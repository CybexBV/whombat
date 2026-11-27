/**
 * The app updates itself (android-self-update.md AP-813), as Morphe Manager does: “Update” downloads the published
 * APK into the app (progress on the button), Android is asked to allow installs from Whombat the first time, then
 * Android's installer opens on the file. Before, “Update” opened the APK's URL in the browser, which downloaded it to
 * Downloads and left the rest to the person.
 *
 * One update at a time for the whole app (the settings card, the banner and the gate screens show the same one).
 * Coming back to the app moves it on: from Android's “Install unknown apps” page to the installer once allowed, from a
 * download that finished in the background to the installer, from the installer (cancelled, or still asking) to
 * “Install”. A successful update replaces this process, so nothing here sees it. Pure: the native updater and the
 * foreground are injected, so the steps are unit-tested.
 */
import type { AndroidDownload } from '@whombat/client/managed';
import { managedCopy } from './copy';

export type InstallFailure = 'network' | 'verify' | 'signature' | 'failed';

export type AllowPage = 'setting' | 'details' | 'none';

export type InstallState =
  | { step: 'idle' }
  | { step: 'downloading'; versionCode: number; received: number; total: number }
  /**
   * Downloaded; waiting for the person to allow installs from Whombat in Android's settings. `opened` is the page that
   * opened: the setting itself, the app's details page when Android couldn't open the setting, or none.
   */
  | { step: 'allow'; versionCode: number; path: string; opened: AllowPage }
  /** Downloaded; “Install” opens Android's installer. */
  | { step: 'ready'; versionCode: number; path: string }
  /** Android's installer is open. */
  | { step: 'installing'; versionCode: number; path: string }
  | { step: 'failed'; versionCode: number; reason: InstallFailure };

export interface Updater {
  download(
    apk: AndroidDownload,
    onProgress: (p: { received: number; total: number }) => void,
  ): Promise<string>;
  canInstall(): boolean;
  openInstallSettings(): boolean;
  /** This app's page in Android's settings, where the setting above wouldn't open. */
  openAppDetails(): boolean;
  install(path: string): Promise<void>;
  /** The rejection's code (`network`, `verify`, `signature`, …). */
  failureCode(error: unknown): string;
}

export interface Foreground {
  active(): boolean;
  onActive(listener: () => void): () => void;
}

export interface AppInstaller {
  get(): InstallState;
  subscribe(listener: () => void): () => void;
  /** “Update” (and “Install”, “Allow installs”, “Try again”): downloads when needed, then on to the installer. */
  start(apk: AndroidDownload): Promise<void>;
}

const IDLE: InstallState = { step: 'idle' };

export function createAppInstaller(updater: Updater, foreground: Foreground): AppInstaller {
  let state: InstallState = IDLE;
  /** The download finished while the app was in the background: Android won't show the installer from there. */
  let afterForeground = false;
  const listeners = new Set<() => void>();
  const set = (next: InstallState) => {
    state = next;
    for (const l of listeners) l();
  };

  const install = async (versionCode: number, path: string): Promise<void> => {
    if (!foreground.active()) {
      afterForeground = true;
      set({ step: 'ready', versionCode, path });
      return;
    }
    afterForeground = false;
    if (!updater.canInstall()) {
      // Some phones can't open the per-app setting: their app page has it too, and the words say where to look.
      const opened: AllowPage = updater.openInstallSettings()
        ? 'setting'
        : updater.openAppDetails()
          ? 'details'
          : 'none';
      set({ step: 'allow', versionCode, path, opened });
      return;
    }
    set({ step: 'installing', versionCode, path });
    try {
      await updater.install(path);
    } catch (e) {
      const code = updater.failureCode(e);
      set({ step: 'failed', versionCode, reason: code === 'verify' ? 'verify' : 'failed' });
    }
  };

  foreground.onActive(() => {
    const s = state;
    if (s.step === 'installing') set({ step: 'ready', versionCode: s.versionCode, path: s.path });
    else if (s.step === 'allow' && updater.canInstall()) void install(s.versionCode, s.path);
    else if (s.step === 'ready' && afterForeground) void install(s.versionCode, s.path);
  });

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start(apk) {
      const s = state;
      if (s.step === 'downloading' || s.step === 'installing') return;
      if ((s.step === 'ready' || s.step === 'allow') && s.versionCode === apk.versionCode)
        return install(s.versionCode, s.path);
      set({ step: 'downloading', versionCode: apk.versionCode, received: 0, total: apk.size });
      let path: string;
      try {
        path = await updater.download(apk, ({ received, total }) => {
          if (state.step === 'downloading') set({ ...state, received, total });
        });
      } catch (e) {
        const code = updater.failureCode(e);
        set({
          step: 'failed',
          versionCode: apk.versionCode,
          reason: code === 'network' || code === 'verify' || code === 'signature' ? code : 'failed',
        });
        return;
      }
      await install(apk.versionCode, path);
    },
  };
}

/** The state as it concerns this APK: what belonged to another version (an older one, since replaced) is idle. */
export function installStateFor(state: InstallState, apk: AndroidDownload): InstallState {
  return state.step === 'idle' || state.versionCode === apk.versionCode ? state : IDLE;
}

/** Whole percent of a download, never 100 before it is done. */
export function downloadPercent(received: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(received >= total ? 100 : 99, Math.floor((received / total) * 100));
}

export interface InstallView {
  label: string;
  /** Android's installer is open: a spinner on the button. */
  busy: boolean;
  /** The line under “Update available”: the version and size, the progress, or what to do next. */
  meta: string;
  /** Allow installs or try again: buttons without a card say why under them. */
  note: string | null;
}

/** What the update buttons show for this step; `idleLabel` is “Update” on the card, “Update the app” elsewhere. */
export function installView(
  state: InstallState,
  apk: AndroidDownload,
  idleLabel: string,
  locale?: string,
): InstallView {
  const COPY = managedCopy(locale);
  const s = installStateFor(state, apk);
  switch (s.step) {
    case 'idle':
      return {
        label: idleLabel,
        busy: false,
        meta: COPY.update.availableMeta(apk.version, apk.size),
        note: null,
      };
    case 'downloading':
      return {
        label: COPY.update.downloading(downloadPercent(s.received, s.total)),
        busy: false,
        meta: COPY.update.downloadingMeta(apk.version, s.received, s.total),
        note: null,
      };
    case 'allow': {
      const words = COPY.update.allowWhere[s.opened];
      return { label: COPY.update.allow, busy: false, meta: words, note: words };
    }
    case 'ready':
    case 'installing':
      return {
        label: COPY.update.ready,
        busy: s.step === 'installing',
        meta: COPY.update.readyMeta(apk.version),
        note: null,
      };
    case 'failed':
      return {
        label: COPY.update.retry,
        busy: false,
        meta: COPY.update.failed[s.reason],
        note: COPY.update.failed[s.reason],
      };
  }
}
