/**
 * The app's one in-app update (AP-813): `createAppInstaller` over the native `whombat-updater` and React Native's
 * AppState, made when first needed. `canSelfUpdate()` is false on the iPhone and in a build without the module; there
 * “Update” keeps opening the Mobile app page.
 */
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { updaterFailureCode, WhombatUpdater } from '../../modules/whombat-updater';
import { type AppInstaller, createAppInstaller, type InstallState } from './appInstall';

let installer: AppInstaller | null = null;

function appInstaller(): AppInstaller {
  installer ??= createAppInstaller(
    {
      download: (apk, onProgress) => WhombatUpdater.download(apk, onProgress),
      canInstall: () => WhombatUpdater.canInstall(),
      openInstallSettings: () => WhombatUpdater.openInstallSettings(),
      openAppDetails: () => WhombatUpdater.openAppDetails(),
      install: (path) => WhombatUpdater.install(path),
      failureCode: updaterFailureCode,
    },
    {
      active: () => AppState.currentState === 'active',
      onActive(listener) {
        const sub = AppState.addEventListener('change', (next) => next === 'active' && listener());
        return () => sub.remove();
      },
    },
  );
  return installer;
}

export function canSelfUpdate(): boolean {
  return WhombatUpdater.supported();
}

const IDLE: InstallState = { step: 'idle' };
const subscribe = (listener: () => void) => appInstaller().subscribe(listener);
const snapshot = () => appInstaller().get();
const noSubscription = () => () => {};
const idle = () => IDLE;
const start: AppInstaller['start'] = (apk) => appInstaller().start(apk);

/** The update's step, and `start` for the buttons (null where the app can't update itself). */
export function useAppInstall(): { state: InstallState; start: AppInstaller['start'] } | null {
  const able = canSelfUpdate();
  const state = useSyncExternalStore(able ? subscribe : noSubscription, able ? snapshot : idle);
  return able ? { state, start } : null;
}
