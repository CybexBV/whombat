import { describe, expect, it } from 'vitest';
import { memoryStore, STORAGE_KEYS } from '../lib/kv';
import { loadThemePreference, saveThemePreference } from './preference';

const refusing = {
  ...memoryStore(),
  get: () => Promise.reject(new Error('keystore unavailable')),
  set: () => Promise.reject(new Error('keystore unavailable')),
};

describe('the theme choice when the keystore refuses (AP-594)', () => {
  it('reads the stored choice, and System when there is none or it can’t be read', async () => {
    expect(await loadThemePreference(memoryStore({ [STORAGE_KEYS.theme]: 'dark' }))).toBe('dark');
    expect(await loadThemePreference(memoryStore())).toBe('system');
    await expect(loadThemePreference(refusing)).resolves.toBe('system');
  });

  it('saving never rejects: the choice holds for this run', async () => {
    const store = memoryStore();
    await saveThemePreference(store, 'light');
    expect(store.data.get(STORAGE_KEYS.theme)).toBe('light');
    await expect(saveThemePreference(refusing, 'dark')).resolves.toBeUndefined();
  });
});
