/**
 * “Moving faces”, this phone's switch for the live faces: on unless turned off, kept in the keystore like the app's
 * other settings on this phone. Every face and the switch in Settings read the same value.
 */
import { useSyncExternalStore } from 'react';
import { STORAGE_KEYS } from '../lib/kv';
import { secureStore } from '../lib/storage';

let on = true;
/** `unread` until a face or the switch first asks; `known` once read, or once the person chose. */
let read: 'unread' | 'reading' | 'known' = 'unread';
const listeners = new Set<() => void>();

function change(next: boolean): void {
  if (on === next) return;
  on = next;
  for (const listener of listeners) listener();
}

function load(): void {
  if (read !== 'unread') return;
  read = 'reading';
  secureStore.get(STORAGE_KEYS.faceMotion).then(
    (value) => {
      // A choice made while it was being read wins.
      if (read !== 'reading') return;
      read = 'known';
      change(value !== 'off');
    },
    () => {
      if (read === 'reading') read = 'known';
    },
  );
}

function subscribe(listener: () => void): () => void {
  load();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const current = () => on;

/** Turns it on or off on this phone; a keystore that refuses still holds the choice until the app closes. */
export function setFaceMotion(next: boolean): void {
  read = 'known';
  change(next);
  const saved = next
    ? secureStore.remove(STORAGE_KEYS.faceMotion)
    : secureStore.set(STORAGE_KEYS.faceMotion, 'off');
  saved.catch(() => {});
}

/** The switch: whether faces move on this phone, and the way to change it. */
export function useFaceMotionSetting(): [boolean, (on: boolean) => void] {
  return [useSyncExternalStore(subscribe, current, current), setFaceMotion];
}
