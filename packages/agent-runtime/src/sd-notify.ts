/**
 * systemd readiness and watchdog for the managed units (appliance NX-20: `Type=notify`, `WatchdogSec=`;
 * docs/decisions/managed-runtime.md MR-37). Node can't send the unix datagram `sd_notify` needs, so each
 * notification runs systemd's own `systemd-notify` (`WHOMBAT_SYSTEMD_NOTIFY`, default on PATH). A child process
 * sends from its own PID: the units need `NotifyAccess=all`. Nothing happens outside systemd (`NOTIFY_SOCKET` unset).
 *
 * - `ready()` once the process serves (`READY=1`);
 * - the watchdog pings (`WATCHDOG=1`) every half of `WATCHDOG_USEC`, only while this process's event loop turns and
 *   its optional `alive()` check holds, and only when `WATCHDOG_PID` (if set) is this process;
 * - `stopping()` at shutdown (`STOPPING=1`).
 */
import { execFile } from 'node:child_process';

export interface SdNotifier {
  ready(status?: string): Promise<void>;
  stopping(): Promise<void>;
  /** Starts the watchdog pings (no-op without `WATCHDOG_USEC`); returns a stop function. */
  watchdog(alive?: () => boolean | Promise<boolean>): () => void;
  /** Milliseconds between pings, or null when systemd set no watchdog for this process. */
  readonly intervalMs: number | null;
}

export type NotifySend = (vars: string[]) => Promise<void>;

/** The notifier for this process, or null outside systemd. `send` is replaceable for tests. */
export function sdNotifier(
  env: NodeJS.ProcessEnv = process.env,
  options: { send?: NotifySend; pid?: number; log?: (msg: string) => void } = {},
): SdNotifier | null {
  if (!env.NOTIFY_SOCKET) return null;
  const exe = env.WHOMBAT_SYSTEMD_NOTIFY || 'systemd-notify';
  let warned = false;
  const send: NotifySend =
    options.send ??
    ((vars) =>
      new Promise<void>((resolve) => {
        execFile(
          exe,
          vars,
          { env: { NOTIFY_SOCKET: env.NOTIFY_SOCKET, PATH: env.PATH ?? '' }, timeout: 5_000 },
          (err) => {
            if (err && !warned) {
              warned = true;
              options.log?.(`systemd notification failed (${exe}): ${err.message}`);
            }
            resolve();
          },
        );
      }));
  const pid = options.pid ?? process.pid;
  const usec = Number(env.WATCHDOG_USEC);
  const forUs = !env.WATCHDOG_PID || Number(env.WATCHDOG_PID) === pid;
  const intervalMs =
    Number.isFinite(usec) && usec > 0 && forUs ? Math.max(1, Math.floor(usec / 2_000)) : null;
  return {
    intervalMs,
    ready: (status) => send(['READY=1', ...(status ? [`STATUS=${status.slice(0, 200)}`] : [])]),
    stopping: () => send(['STOPPING=1']),
    watchdog(alive) {
      if (intervalMs === null) return () => {};
      let busy = false;
      const timer = setInterval(() => {
        if (busy) return;
        busy = true;
        void (async () => {
          try {
            if (!alive || (await alive())) await send(['WATCHDOG=1']);
          } catch {
            // an unhealthy process simply misses its ping
          } finally {
            busy = false;
          }
        })();
      }, intervalMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}
