/**
 * This phone's passkeys and the nudge's memory (passkeys.md AP-798, AP-800): Credential Manager through
 * `whombat-passkeys`, and “Open faster next time” remembered in the registry's file next to the Whombats.
 */
import { createPasskeyNudge } from '@whombat/client/managed';
import { documentTextFile } from './expoStores';
import { preloadedStorage } from './stores';

export { PASSKEYS } from './passkeys';

let nudgeStorage: ReturnType<typeof preloadedStorage> | null = null;

export const PASSKEY_NUDGE = createPasskeyNudge(() => {
  nudgeStorage ??= preloadedStorage(documentTextFile('whombat-passkeys.json'));
  return nudgeStorage;
});
