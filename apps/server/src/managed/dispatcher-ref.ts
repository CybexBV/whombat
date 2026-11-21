/**
 * The session dispatcher a managed runtime runs, for the assistant's settings tools (docs/decisions/assistant-settings.md).
 * A module of its own so the tools reach it without importing the dispatcher, which imports every route.
 */
import type { SessionDispatcher } from './dispatcher';

const dispatchers = new WeakMap<object, SessionDispatcher>();

/** The session dispatcher the assistant's settings tools run ops through; null where no managed runtime runs. */
export function sessionDispatcherOf(owner: object): SessionDispatcher | null {
  return dispatchers.get(owner) ?? null;
}

export function setSessionDispatcherFor(owner: object, dispatcher: SessionDispatcher): void {
  dispatchers.set(owner, dispatcher);
}
