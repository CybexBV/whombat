/**
 * A listener that throws stops nothing else: the listeners after it still hear, and the connection it was called from
 * stays. Called unguarded, one throwing listener ended the app when it ran from a timer (a heartbeat, a reconnect),
 * and from the read loop it was taken for a lost connection, which hid the error behind a reconnect.
 */

/** Told what a listener threw and which kind of listener it was (`state`, `event`, …). */
export type ListenerErrorHook = (error: unknown, where: string) => void;

/** `call(where, listener, ...args)`: true when the listener ran through. */
export function guardListeners(hook: ListenerErrorHook | undefined) {
  return function call<A extends unknown[]>(
    where: string,
    listener: ((...args: A) => void) | undefined,
    ...args: A
  ): boolean {
    try {
      listener?.(...args);
      return true;
    } catch (error) {
      try {
        if (hook) hook(error, where);
        else console.error(`A session ${where} listener failed`, error);
      } catch {
        // The hook's own error has nowhere left to go.
      }
      return false;
    }
  };
}
