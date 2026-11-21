/**
 * What a turn waits for on a card (docs/decisions/vault-simplify.md VLT-44, VLT-45): the runner's long polls
 * (`runner.loginAskWait`) wait on a card's message here and are woken when the card is answered, and a one-time code the
 * person typed is held here — in this process's memory only, for the turn that asked — until that turn's Hermes takes it
 * or the turn ends. A code is never stored, logged, signed or put in a message. One server process (BP-10): the maps
 * live with the services.
 */
import type { Services } from '../services';

interface HeldCode {
  dispatchId: string;
  /** The site the card named (github.com), as Hermes's code prompt names it. */
  site: string;
  code: string;
}

interface State {
  waiters: Map<string, Set<() => void>>;
  /** By the card's message. */
  codes: Map<string, HeldCode>;
}

const states = new WeakMap<Services, State>();

function stateOf(services: Services): State {
  let s = states.get(services);
  if (!s) {
    s = { waiters: new Map(), codes: new Map() };
    states.set(services, s);
  }
  return s;
}

/** Resolves when the card is answered, after `ms`, or when `signal` aborts, whichever comes first. */
export function cardAnswerOrTimeout(
  services: Services,
  messageId: string,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    const { waiters } = stateOf(services);
    let set = waiters.get(messageId);
    if (!set) {
      set = new Set();
      waiters.set(messageId, set);
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      const current = waiters.get(messageId);
      current?.delete(done);
      if (current && current.size === 0) waiters.delete(messageId);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    set.add(done);
    if (signal?.aborted) done();
    else signal?.addEventListener('abort', done, { once: true });
  });
}

/** Wakes every poll waiting on the card (it was answered). */
export function cardAnswered(services: Services, messageId: string): void {
  const set = stateOf(services).waiters.get(messageId);
  if (!set) return;
  for (const done of [...set]) done();
}

/** Holds a code the person typed for the turn that asked (until it takes it or ends). */
export function holdCode(services: Services, messageId: string, held: HeldCode): void {
  stateOf(services).codes.set(messageId, held);
}

/** The code held for a card, taken: a code goes to one sign-in only. */
export function takeCode(services: Services, messageId: string, dispatchId: string): string | null {
  const { codes } = stateOf(services);
  const held = codes.get(messageId);
  if (!held || held.dispatchId !== dispatchId) return null;
  codes.delete(messageId);
  return held.code;
}

/** The turns holding a code (the orphan sweep asks which still run). */
export function codeDispatches(services: Services): string[] {
  return [...new Set([...stateOf(services).codes.values()].map((h) => h.dispatchId))];
}

/** The turns that ended drop the codes they held. */
export function forgetTurnCodes(services: Services, dispatchIds: readonly string[]): void {
  const ended = new Set(dispatchIds);
  const { codes } = stateOf(services);
  for (const [messageId, held] of codes) if (ended.has(held.dispatchId)) codes.delete(messageId);
}
