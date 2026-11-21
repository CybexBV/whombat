/**
 * Small persisted key-value settings. The bearer token lives in the platform keystore
 * (`expo-secure-store`); the other values are tiny, so they share it rather than adding a second store.
 */
import * as SecureStore from 'expo-secure-store';
import type { KeyValueStore } from './kv';

export const secureStore: KeyValueStore = {
  get: (key) => SecureStore.getItemAsync(key),
  set: (key, value) => SecureStore.setItemAsync(key, value),
  remove: (key) => SecureStore.deleteItemAsync(key),
};
