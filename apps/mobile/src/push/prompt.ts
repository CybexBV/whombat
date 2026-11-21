/**
 * Asking for notifications with a reason first (MN-05). The app doesn't ask cold: while Android hasn't asked yet, a push
 * bridge (`PushBridge` self-hosted, `useManagedPush` managed) offers a card in the inbox — what notifications are for,
 * “Turn on” (then Android's question) and “Not now”. “Not now” is kept on this phone: the card doesn't come back, and
 * Settings → Notifications keeps “Turn on”. Once notifications are allowed or refused the card goes. Pure: the store is
 * injected (`promptStore.ts` has the app's).
 */
import { type KeyValueStore, STORAGE_KEYS } from '../lib/kv';

/** The card's words, in the app's voice. */
export const PUSH_PROMPT_COPY = {
  title: 'Know when something needs you',
  text: 'Turn on notifications for approvals to give, mentions and your agent’s answers. Your phone asks you next.',
  turnOn: 'Turn on',
  notNow: 'Not now',
} as const;

export interface PushPromptState {
  /** The card shows: Android hasn't asked yet and the person hasn't said “Not now”. */
  shown: boolean;
  /** “Turn on” is waiting for Android's answer. */
  busy: boolean;
}

export interface PushPrompt {
  state(): PushPromptState;
  subscribe(listener: () => void): () => void;
  /** Android hasn't asked yet; `turnOn` asks (and registers). */
  offer(turnOn: () => Promise<unknown>): void;
  /** Allowed, refused or not available: no card. */
  withdraw(): void;
  /** “Turn on”: Android asks now. */
  turnOn(): Promise<void>;
  /** “Not now”: no card on this phone again (Settings keeps “Turn on”). */
  notNow(): Promise<void>;
}

/** Where “Not now” is kept. */
export const PUSH_PROMPT_KEY = STORAGE_KEYS.pushPrompt;

export function createPushPrompt(store: KeyValueStore): PushPrompt {
  let offered: (() => Promise<unknown>) | null = null;
  /** Null until read from the store. */
  let dismissed: boolean | null = null;
  let reading: Promise<void> | null = null;
  let busy = false;
  let current: PushPromptState = { shown: false, busy: false };
  const listeners = new Set<() => void>();
  const emit = () => {
    const next = { shown: !!offered && dismissed === false, busy };
    if (next.shown === current.shown && next.busy === current.busy) return;
    current = next;
    for (const listener of [...listeners]) listener();
  };
  const read = () => {
    reading ??= store.get(PUSH_PROMPT_KEY).then(
      (value) => {
        dismissed = dismissed ?? !!value;
        emit();
      },
      () => {
        dismissed = dismissed ?? false;
        emit();
      },
    );
    return reading;
  };
  return {
    state: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    offer(turnOn) {
      offered = turnOn;
      if (dismissed === null) void read();
      emit();
    },
    withdraw() {
      offered = null;
      emit();
    },
    async turnOn() {
      const ask = offered;
      if (!ask || busy) return;
      busy = true;
      emit();
      try {
        await ask();
      } catch {
        // The bridge says what came of it (offers again while Android still hasn't asked).
      } finally {
        busy = false;
        if (offered === ask) offered = null;
        emit();
      }
    },
    async notNow() {
      dismissed = true;
      emit();
      await store.set(PUSH_PROMPT_KEY, new Date().toISOString()).catch(() => {});
    },
  };
}
