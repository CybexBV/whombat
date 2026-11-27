/**
 * The one time the app asks for notifications, with a reason (docs/app/decisions/mobile-reach.md). Where the phone
 * must ask first (Android 13 and later, never asked: `pushStart` says `sheet`), the push bridge (`useManagedPush`)
 * offers a sheet at the first open after sign-in: “Get a ping when {Agent} needs you?”, Turn on (then Android's
 * question) and Not now. Not now is kept on this phone: the sheet doesn't come back, and Settings → Notifications keeps
 * Turn on. Once notifications are allowed or refused the sheet goes. Pure: the store is injected (`promptStore.ts` has
 * the app's).
 */
import { agentWords } from '@whombat/client';
import { mobileTranslator } from '../i18n/translate';
import { type KeyValueStore, STORAGE_KEYS } from '../lib/kv';

/** The sheet's words, the web's own; `{Agent}` is the assistant's name. */
export function pushPromptCopy(agent: string | null | undefined, locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    title: t('data.pushPrompt.title', { name: agentWords(agent, locale).name }),
    text: t('data.pushPrompt.text'),
    turnOn: t('data.pushPrompt.turnOn'),
    notNow: t('data.pushPrompt.notNow'),
  } as const;
}

export interface PushPromptState {
  /** The sheet shows: the phone must ask, and the person hasn't said “Not now”. */
  shown: boolean;
  /** Turn on is waiting for the system's answer. */
  busy: boolean;
}

export interface PushPrompt {
  state(): PushPromptState;
  subscribe(listener: () => void): () => void;
  /** Whether “Not now” was said on this phone (also before this run). */
  notNowKept(): Promise<boolean>;
  /** The phone must ask first; `turnOn` asks (and registers). */
  offer(turnOn: () => Promise<unknown>): void;
  /** Allowed, refused or not available: no sheet. */
  withdraw(): void;
  /** Turn on: the system asks now. */
  turnOn(): Promise<void>;
  /** Not now, or the sheet closed: not asked again on this phone (Settings keeps Turn on). */
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
    async notNowKept() {
      await read();
      return dismissed === true;
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
        // The bridge says what came of it in Settings → Notifications.
      } finally {
        busy = false;
        if (offered === ask) offered = null;
        emit();
      }
    },
    async notNow() {
      if (busy) return;
      dismissed = true;
      emit();
      await store.set(PUSH_PROMPT_KEY, new Date().toISOString()).catch(() => {});
    },
  };
}
