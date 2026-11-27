/**
 * Messages written while the phone is offline (AP-717): kept in order — on the device, sealed in the `SecureBox` like the
 * cached burrow — shown under the conversation as “Waiting to send”, and sent one after another once the connection is
 * back. Each keeps the client id it was written with, so a send that may already have arrived is the same request again
 * (the server's idempotency), never a second copy. One the server refuses stays as “Not sent” with Retry and Delete;
 * the messages after it in the same conversation wait behind it, so a conversation never reads out of order.
 *
 * Pure apart from the injected `send` and box (`OutboxProvider` wires the client and the phone's box).
 */
import { newClientId } from '@whombat/client/query';
import type { ChatRuntime } from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';
import type { SecureBox } from './secureBox';

export interface OutboxMessage {
  /** The message's client id: its idempotency key on every attempt. */
  id: string;
  burrow: string;
  conversationId: string;
  threadRootId: string | null;
  text: string;
  /** Files already uploaded when it was written. */
  attachmentIds?: string[];
  /**
   * What answers a new thread of the Chat, chosen in the box (`SendMessageBody.runtime`, chat-runtime-android.md
   * AP-2719); absent: the agent's own.
   */
  runtime?: ChatRuntime;
  createdAt: number;
  state: 'waiting' | 'sending' | 'failed';
  /** Why it wasn't sent (`failed`). */
  error?: string;
  /** Sends that ended without an answer (the connection went again). */
  attempts: number;
}

export type SendOutcome =
  | { kind: 'sent' }
  /** Not now: offline, the session went, no answer. It is tried again on the next connection. */
  | { kind: 'later' }
  | { kind: 'failed'; error: string };

/** After this many sends without an answer while online, it shows as not sent rather than trying for ever. */
export const MAX_ATTEMPTS = 5;

/** Errors that say nothing was refused: the message is tried again when the connection is back. */
const TRANSIENT = new Set([
  'NetworkError',
  'NotDeliveredError',
  'DeadlineExceededError',
  'SessionClosedError',
  'OutcomeUnknownError',
]);

/**
 * What a send's answer means for the outbox: the server took it (stored, or held for a person's approval — either way
 * it is no longer this phone's to send), it couldn't be reached, or it refused (the reason shown under the message).
 */
export function sendOutcome(
  answer: { result: { status: string; message?: string } } | { error: unknown },
  locale?: string,
): SendOutcome {
  const { t } = mobileTranslator(locale);
  if ('result' in answer) {
    const { result } = answer;
    if (result.status === 'ok' || result.status === 'pending_approval') return { kind: 'sent' };
    return { kind: 'failed', error: result.message?.trim() || t('data.outbox.refused') };
  }
  const error = answer.error as {
    name?: unknown;
    state?: unknown;
    status?: unknown;
    message?: unknown;
  } | null;
  const name = typeof error?.name === 'string' ? error.name : '';
  // It went through, but its answer isn't kept (CT-195).
  if (name === 'OutcomeRedactedError' && error?.state === 'completed') return { kind: 'sent' };
  if (TRANSIENT.has(name)) return { kind: 'later' };
  if (name === 'ApiError') {
    const status = typeof error?.status === 'number' ? error.status : 0;
    if (status >= 500 || status === 408 || status === 429) return { kind: 'later' };
    const message = typeof error?.message === 'string' ? error.message.trim() : '';
    return { kind: 'failed', error: message || t('data.outbox.refused') };
  }
  return { kind: 'failed', error: t('data.outbox.wentWrong') };
}

/** The next message to send: the oldest waiting one whose conversation has nothing failed or sending before it. */
export function nextToSend(items: readonly OutboxMessage[]): OutboxMessage | null {
  const held = new Set<string>();
  for (const item of items) {
    const lane = `${item.conversationId}|${item.threadRootId ?? ''}`;
    if (held.has(lane)) continue;
    if (item.state === 'waiting') return item;
    held.add(lane);
  }
  return null;
}

/** The messages one conversation (or one thread) shows as waiting, oldest first. */
export function outboxFor(
  items: readonly OutboxMessage[],
  conversationId: string,
  threadRootId: string | null,
): OutboxMessage[] {
  return items.filter((i) => i.conversationId === conversationId && i.threadRootId === threadRootId);
}

/** The line under a waiting message. */
export function outboxLabel(item: Pick<OutboxMessage, 'state' | 'error'>, locale?: string): string {
  const { t } = mobileTranslator(locale);
  switch (item.state) {
    case 'waiting':
      return t('data.outbox.waiting');
    case 'sending':
      return t('data.outbox.sending');
    case 'failed':
      return item.error ? t('data.outbox.notSentWhy', { error: item.error }) : t('data.outbox.notSent');
  }
}

export interface Outbox {
  items(): readonly OutboxMessage[];
  subscribe(listener: () => void): () => void;
  /** Reads what was kept on the device (once, at start). */
  load(): Promise<void>;
  add(input: Omit<OutboxMessage, 'id' | 'createdAt' | 'state' | 'attempts'> & { id?: string }): OutboxMessage;
  retry(id: string): void;
  remove(id: string): void;
  /** Sends what is waiting, in order, while `canSend()` holds; stops at the first one that has to wait. */
  flush(): Promise<void>;
}

export function createOutbox(input: {
  box: SecureBox;
  /** The storage scope (`managed:<org>/<Whombat>`). */
  scope: string;
  send(item: OutboxMessage): Promise<SendOutcome>;
  canSend(): boolean;
  /** A message went out (refresh its conversation). */
  onSent?(item: OutboxMessage): void;
  now?: () => number;
  /** The app's language now, for the reason kept under a message that wasn't sent. */
  locale?: () => string | undefined;
}): Outbox {
  const { box, scope } = input;
  const now = input.now ?? Date.now;
  let items: OutboxMessage[] = [];
  let flushing: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  const set = (next: OutboxMessage[]) => {
    items = next;
    for (const l of [...listeners]) l();
    // What is on the device follows every change; an empty outbox leaves no file.
    const kept = next.map((i) => (i.state === 'sending' ? { ...i, state: 'waiting' as const } : i));
    void (kept.length ? box.save(scope, 'outbox', kept) : box.remove(scope, 'outbox')).catch(() => {});
  };
  const update = (id: string, patch: Partial<OutboxMessage>) =>
    set(items.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  const run = async () => {
    for (;;) {
      if (!input.canSend()) return;
      const next = nextToSend(items);
      if (!next) return;
      update(next.id, { state: 'sending' });
      let outcome: SendOutcome;
      try {
        outcome = await input.send(next);
      } catch (error) {
        outcome = sendOutcome({ error }, input.locale?.());
      }
      if (!items.some((i) => i.id === next.id)) continue; // deleted while it was on its way
      if (outcome.kind === 'sent') {
        set(items.filter((i) => i.id !== next.id));
        input.onSent?.(next);
      } else if (outcome.kind === 'failed') {
        update(next.id, { state: 'failed', error: outcome.error });
      } else {
        const attempts = next.attempts + 1;
        // Online, and still no answer after several tries: say so instead of waiting for ever.
        if (attempts >= MAX_ATTEMPTS && input.canSend())
          update(next.id, {
            state: 'failed',
            attempts,
            error: mobileTranslator(input.locale?.()).t('data.outbox.unreachable'),
          });
        else update(next.id, { state: 'waiting', attempts });
        return;
      }
    }
  };

  return {
    items: () => items,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async load() {
      const kept = await box.load<OutboxMessage[]>(scope, 'outbox').catch(() => null);
      if (!Array.isArray(kept) || kept.length === 0) return;
      // Ones written since (before the file was read) come after the kept ones.
      const known = new Set(kept.map((i) => i.id));
      set([
        ...kept.map((i) => (i.state === 'sending' ? { ...i, state: 'waiting' as const } : i)),
        ...items.filter((i) => !known.has(i.id)),
      ]);
    },
    add(message) {
      const item: OutboxMessage = {
        ...message,
        id: message.id ?? newClientId(now),
        createdAt: now(),
        state: 'waiting',
        attempts: 0,
      };
      set([...items, item]);
      return item;
    },
    retry(id) {
      const item = items.find((i) => i.id === id);
      if (item?.state !== 'failed') return;
      const { error: _error, ...rest } = item;
      set(items.map((i) => (i.id === id ? { ...rest, state: 'waiting', attempts: 0 } : i)));
    },
    remove(id) {
      set(items.filter((i) => i.id !== id));
    },
    flush() {
      flushing ??= run().finally(() => {
        flushing = null;
      });
      return flushing;
    },
  };
}
