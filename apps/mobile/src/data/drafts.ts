/**
 * What was typed and not sent, per conversation and per thread (MX-02): kept while the person goes elsewhere, and on the
 * device between launches — sealed in the `SecureBox` with the outbox (AP-717), so a wipe (sign-out, another Whombat,
 * revocation) takes it too. Sending clears it. Saves wait until the typing rests (`DRAFT_SAVE_MS`) and are written all
 * at once; at most `DRAFTS_MAX` conversations keep one, the newest, and one older than `DRAFT_TTL_MS` is dropped.
 *
 * Pure apart from the injected box and timers (`OutboxProvider` wires the phone's box).
 */
import type { SecureBox } from './secureBox';

export const DRAFT_SAVE_MS = 800;
export const DRAFTS_MAX = 50;
/** 30 days. */
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** The box entry. */
export const DRAFTS_NAME = 'drafts';

/** A conversation's own draft, or one thread's in it. */
export function draftKey(conversationId: string, threadRootId: string | null): string {
  return threadRootId ? `${conversationId}/${threadRootId}` : conversationId;
}

interface Draft {
  text: string;
  /** When it was last typed in (ms). */
  at: number;
}

export interface DraftStore {
  /** The draft, '' without one. */
  get(key: string): string;
  /** Keeps what is typed now ('' or only spaces forgets it); saved once the typing rests. */
  set(key: string, text: string): void;
  /** Reads what was kept on the device (once, at start). Drafts typed meanwhile win. */
  load(): Promise<void>;
  /** Writes a waiting save now (leaving a conversation, the app going to the background). */
  flush(): Promise<void>;
  /** Stops: a waiting save is dropped (the box may have been wiped). */
  dispose(): void;
  /** Whether what the device kept has been read. */
  loaded(): boolean;
  /** Called once what the device kept has been read (not on every keystroke). */
  onLoad(listener: () => void): () => void;
}

/** What is kept: no empty drafts, none too old, the newest `DRAFTS_MAX`. */
export function keptDrafts(drafts: Readonly<Record<string, Draft>>, now: number): Record<string, Draft> {
  const entries = Object.entries(drafts)
    .filter(
      ([, d]) =>
        typeof d?.text === 'string' &&
        d.text.trim() !== '' &&
        typeof d.at === 'number' &&
        now - d.at < DRAFT_TTL_MS,
    )
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, DRAFTS_MAX);
  return Object.fromEntries(entries);
}

export function createDraftStore(input: {
  box: SecureBox;
  /** The storage scope (`managed:<org>/<Whombat>`, `server:<url>`). */
  scope: string;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}): DraftStore {
  const { box, scope } = input;
  const now = input.now ?? Date.now;
  const setTimer = input.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = input.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let drafts: Record<string, Draft> = {};
  let timer: unknown = null;
  let disposed = false;
  let isLoaded = false;
  const listeners = new Set<() => void>();

  const write = async () => {
    timer = null;
    if (disposed) return;
    const kept = keptDrafts(drafts, now());
    await (Object.keys(kept).length
      ? box.save(scope, DRAFTS_NAME, kept)
      : box.remove(scope, DRAFTS_NAME)
    ).catch(() => {});
  };
  const schedule = () => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => void write(), DRAFT_SAVE_MS);
  };

  return {
    get: (key) => drafts[key]?.text ?? '',
    set(key, text) {
      const had = drafts[key]?.text ?? '';
      if (had === text || (!had && !text.trim())) return;
      if (text.trim()) drafts = { ...drafts, [key]: { text, at: now() } };
      else {
        const { [key]: _gone, ...rest } = drafts;
        drafts = rest;
      }
      schedule();
    },
    async load() {
      const kept = await box.load<Record<string, Draft>>(scope, DRAFTS_NAME).catch(() => null);
      if (disposed) return;
      if (kept && typeof kept === 'object') drafts = { ...keptDrafts(kept, now()), ...drafts };
      isLoaded = true;
      for (const l of [...listeners]) l();
      listeners.clear();
    },
    async flush() {
      if (timer === null) return;
      clearTimer(timer);
      await write();
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      listeners.clear();
    },
    loaded: () => isLoaded,
    onLoad(listener) {
      if (isLoaded) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
