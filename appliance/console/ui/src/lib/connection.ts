/**
 * The page polls every second and tolerates the server being away for a moment (a restart of the console
 * server, a busy installer): for less than `QUIET_MS` nothing changes on screen, then a quiet hint appears.
 */
export const POLL_MS = 1000;
export const QUIET_MS = 10_000;

export type Connection = 'ok' | 'hiccup' | 'lost';

/** `failingSince`: when the first failed poll after the last good one happened (null while polls succeed). */
export function connectionStatus(failingSince: number | null, now: number): Connection {
  if (failingSince === null) return 'ok';
  return now - failingSince >= QUIET_MS ? 'lost' : 'hiccup';
}
