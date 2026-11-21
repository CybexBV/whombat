import type { AndroidDownload } from '@whombat/client/managed';
import { describe, expect, it, vi } from 'vitest';
import {
  createAppInstaller,
  downloadPercent,
  type Foreground,
  type InstallState,
  installView,
  type Updater,
} from './appInstall';

const apk = (versionCode = 44_000): AndroidDownload => ({
  version: `0.${Math.floor(versionCode / 1000)}.${versionCode % 1000}`,
  versionCode,
  size: 96_000_000,
  sha256: 'ab'.repeat(32),
  publishedAt: '2026-10-06T10:00:00Z',
  url: `https://api.whombat.com/v1/downloads/android/whombat-${versionCode}.apk`,
});

const fail = (code: string) => Object.assign(new Error(code), { code });

function world({ allowed = true, active = true } = {}) {
  let returnToApp: () => void = () => {};
  const phone = { allowed, active };
  const foreground: Foreground = {
    active: () => phone.active,
    onActive(listener) {
      returnToApp = listener;
      return () => {};
    },
  };
  const updater = {
    download: vi.fn<Updater['download']>(async (a, onProgress) => {
      onProgress({ received: a.size / 2, total: a.size });
      return `/cache/updates/whombat-${a.versionCode}.apk`;
    }),
    canInstall: vi.fn(() => phone.allowed),
    openInstallSettings: vi.fn(() => true),
    install: vi.fn(async (_path: string) => {}),
    failureCode: (e: unknown) => (e as { code: string }).code,
  } satisfies Updater;
  const installer = createAppInstaller(updater, foreground);
  const steps: InstallState['step'][] = [];
  installer.subscribe(() => {
    const step = installer.get().step;
    if (steps.at(-1) !== step) steps.push(step);
  });
  /** The person leaves the app and comes back (Android's settings or installer in between). */
  const back = () => {
    phone.active = true;
    returnToApp();
  };
  return { installer, updater, phone, steps, back };
}

describe('the app updates itself (AP-813)', () => {
  it('downloads the APK with progress and opens Android’s installer on it', async () => {
    const { installer, updater, steps } = world();
    await installer.start(apk());
    expect(steps).toEqual(['downloading', 'installing']);
    expect(updater.install).toHaveBeenCalledWith('/cache/updates/whombat-44000.apk');
    expect(updater.openInstallSettings).not.toHaveBeenCalled();
  });

  it('asks to allow installs the first time, then installs when the person comes back allowed', async () => {
    const { installer, updater, phone, back } = world({ allowed: false });
    await installer.start(apk());
    expect(installer.get().step).toBe('allow');
    expect(updater.openInstallSettings).toHaveBeenCalledTimes(1);
    expect(updater.install).not.toHaveBeenCalled();
    // Came back without allowing: still waiting, the button asks again.
    back();
    expect(installer.get().step).toBe('allow');
    phone.allowed = true;
    back();
    await vi.waitFor(() => expect(updater.install).toHaveBeenCalledTimes(1));
    expect(updater.download).toHaveBeenCalledTimes(1);
  });

  it('offers “Install” again after the installer was cancelled, without downloading again', async () => {
    const { installer, updater, back } = world();
    await installer.start(apk());
    back();
    expect(installer.get()).toMatchObject({ step: 'ready', versionCode: 44_000 });
    await installer.start(apk());
    expect(updater.download).toHaveBeenCalledTimes(1);
    expect(updater.install).toHaveBeenCalledTimes(2);
  });

  it('waits for the app to be in front when the download finished in the background', async () => {
    const { installer, updater, phone, back } = world();
    phone.active = false;
    await installer.start(apk());
    expect(installer.get().step).toBe('ready');
    expect(updater.install).not.toHaveBeenCalled();
    back();
    await vi.waitFor(() => expect(updater.install).toHaveBeenCalledTimes(1));
  });

  it('says why a download failed', async () => {
    for (const [code, reason] of [
      ['network', 'network'],
      ['verify', 'verify'],
      ['signature', 'signature'],
      ['busy', 'failed'],
    ] as const) {
      const { installer, updater } = world();
      updater.download.mockRejectedValueOnce(fail(code));
      await installer.start(apk());
      expect(installer.get()).toEqual({ step: 'failed', versionCode: 44_000, reason });
      // “Try again” downloads again.
      await installer.start(apk());
      expect(installer.get().step).toBe('installing');
    }
  });

  it('ignores taps while it downloads or the installer is open', async () => {
    const { installer, updater } = world();
    let finish: (path: string) => void = () => {};
    updater.download.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    const first = installer.start(apk());
    await installer.start(apk());
    expect(updater.download).toHaveBeenCalledTimes(1);
    finish('/cache/updates/whombat-44000.apk');
    await first;
    await installer.start(apk());
    expect(updater.install).toHaveBeenCalledTimes(1);
  });

  it('downloads a newer published APK instead of installing the one staged before', async () => {
    const { installer, updater, back } = world();
    await installer.start(apk(44_000));
    back();
    await installer.start(apk(44_001));
    expect(updater.download).toHaveBeenCalledTimes(2);
    expect(updater.install).toHaveBeenLastCalledWith('/cache/updates/whombat-44001.apk');
  });
});

describe('what the update buttons say', () => {
  const a = apk();
  it('follows the steps', () => {
    expect(installView({ step: 'idle' }, a, 'Update')).toEqual({
      label: 'Update',
      busy: false,
      meta: '0.44.0 · 96 MB · Download and install it over this app.',
      note: null,
    });
    expect(
      installView(
        { step: 'downloading', versionCode: 44_000, received: 33_600_000, total: 96_000_000 },
        a,
        'Update',
      ),
    ).toMatchObject({ label: 'Downloading 35%', meta: '0.44.0 · 34 of 96 MB' });
    expect(installView({ step: 'allow', versionCode: 44_000, path: 'p' }, a, 'Update')).toMatchObject({
      label: 'Allow installs',
      note: 'Allow Whombat to install apps in Android’s settings, then come back here.',
    });
    expect(installView({ step: 'installing', versionCode: 44_000, path: 'p' }, a, 'Update')).toMatchObject({
      label: 'Install',
      busy: true,
      meta: '0.44.0 · Downloaded. Android asks before it installs.',
    });
    expect(
      installView({ step: 'failed', versionCode: 44_000, reason: 'network' }, a, 'Update'),
    ).toMatchObject({
      label: 'Try again',
      note: 'The download didn’t finish. Check the connection and try again.',
    });
  });

  it('shows an older version’s step as nothing started', () => {
    expect(
      installView({ step: 'failed', versionCode: 43_001, reason: 'network' }, a, 'Update the app').label,
    ).toBe('Update the app');
  });

  it('never says 100% before the download is done', () => {
    expect(downloadPercent(999, 1000)).toBe(99);
    expect(downloadPercent(1000, 1000)).toBe(100);
    expect(downloadPercent(0, 0)).toBe(0);
  });
});
