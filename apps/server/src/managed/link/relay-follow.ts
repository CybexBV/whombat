/**
 * The relay carries the box's sessions and its own address's door while Whombat Link runs, and only then
 * (docs/decisions/whombat-link.md). When Link stops, the relay closes a moment later rather than at once: the owner
 * who turned Link off from a device that came in through the relay gets the answer before that route goes.
 */

/** Long enough for the answer to an owner's own change to go out; short enough that off is off. */
export const RELAY_CLOSE_DELAY_MS = 3_000;

export interface RelayFollower {
  /** Opens the relay while Link runs, closes it a moment after Link stopped. */
  follow(): void;
  /** Stops waiting to close (the box stops). */
  stop(): void;
}

export function followLinkWithRelay(options: {
  active: () => boolean;
  start: () => void;
  close: () => void;
  delayMs?: number;
}): RelayFollower {
  const delayMs = options.delayMs ?? RELAY_CLOSE_DELAY_MS;
  let closing: ReturnType<typeof setTimeout> | null = null;
  let opened = false;
  const cancel = () => {
    if (closing) clearTimeout(closing);
    closing = null;
  };
  return {
    follow() {
      if (options.active()) {
        cancel();
        opened = true;
        options.start();
        return;
      }
      // Never opened (a box starting without Link): nothing to wait for.
      if (!opened) {
        options.close();
        return;
      }
      if (closing) return;
      closing = setTimeout(() => {
        closing = null;
        if (options.active()) return;
        opened = false;
        options.close();
      }, delayMs);
      closing.unref?.();
    },
    stop: cancel,
  };
}
