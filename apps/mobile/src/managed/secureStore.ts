/**
 * `SecretStore` over expo-secure-store (Keystore/Keychain, this device only). A call the Keychain refuses while the app
 * is away (the phone is locked) is made again back in the foreground (`foregroundStore`).
 */
import * as SecureStore from 'expo-secure-store';
import { AppState } from 'react-native';
import type { SecretStore } from './keys';
import { type Foreground, foregroundStore } from './stores';

const OPTIONS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

const appForeground: Foreground = {
  active: () => AppState.currentState === 'active',
  next: () =>
    new Promise((resolve) => {
      const sub = AppState.addEventListener('change', (state) => {
        if (state !== 'active') return;
        sub.remove();
        resolve();
      });
      // It came back between the refusal and here.
      if (AppState.currentState === 'active') {
        sub.remove();
        resolve();
      }
    }),
};

export const secureStore: SecretStore = foregroundStore(
  {
    get: (key) => SecureStore.getItemAsync(key, OPTIONS),
    set: (key, value) => SecureStore.setItemAsync(key, value, OPTIONS),
    remove: (key) => SecureStore.deleteItemAsync(key, OPTIONS),
  },
  appForeground,
);
