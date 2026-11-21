/**
 * Stopping a child the server started in its own process group (`detached: true`): the whole group gets SIGTERM, and
 * SIGKILL a moment later for whatever is left, so nothing it started outlives it (the browser host, BT-D02). Its home
 * since pack tool servers went (docs/decisions/archive/skill-store.md SST-R07).
 */

/** SIGTERM to the whole group, SIGKILL after `graceMs`. A child without a pid (never started) is left alone. */
export function killGroup(
  child: { pid?: number | undefined; exitCode: number | null },
  graceMs = 1500,
  kill: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) => process.kill(pid, signal),
): void {
  const pid = child.pid;
  if (!pid) return;
  const signal = (sig: NodeJS.Signals) => {
    try {
      kill(-pid, sig);
    } catch {
      // Already gone.
    }
  };
  signal('SIGTERM');
  const timer = setTimeout(() => signal('SIGKILL'), graceMs);
  timer.unref?.();
}
