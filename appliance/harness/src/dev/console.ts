/**
 * `dev/console` — the dev appliance's console (CC-11, IN-33): what tty1 shows on a real appliance, drawn by the same
 * `whombat-console` from the console state file the dev runtime writes (`WHOMBAT_CONSOLE_FILE` =
 * `env/run/console.json`). The binary is built from this checkout into `<WB_MGD_HOME>/bin/whombat-console`.
 *
 *   dev/console            one frame (whombat-console --once)
 *   dev/console --watch    redraw on every change, like tty1 (Ctrl-C stops)
 *   dev/console --json     the state file as it is
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, REPO_DIR } from '../lib/paths.ts';
import { run } from '../lib/proc.ts';

/** The console state file (contracts 0.7.0 `ConsoleState`, CC-08); read leniently, the console validates strictly. */
export interface ConsoleState {
  v: 1;
  state: 'starting' | 'waiting' | 'claimable' | 'backoff' | 'claimed';
  code?: string;
  url: string;
  retryAt?: string | number;
  /** How the box is reached (contracts 4.4 `ConsoleReach`): Whombat Link's state and, while it starts, its code. */
  reach?: {
    link?: { state: string; code?: string; url?: string; expiresAt?: string; waitingForAddress?: boolean };
    tailscale?: { loginUrl?: string; needsHttps?: boolean; name?: string };
  };
}

const STATES = new Set(['starting', 'waiting', 'claimable', 'backoff', 'claimed']);

export function readConsoleState(file: string = paths.console): ConsoleState | null {
  if (!existsSync(file)) return null;
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as Partial<ConsoleState>;
    return s && s.v === 1 && typeof s.state === 'string' && STATES.has(s.state) ? (s as ConsoleState) : null;
  } catch {
    return null;
  }
}

/** One line for `dev/up` and `dev/status`. */
export function consoleSummary(s: ConsoleState | null): string {
  if (!s) return 'no state yet (the runtime writes it once it runs; dev/console --watch)';
  const link = s.reach?.link;
  // Whombat Link's code comes first: the box's own page is of use only once its Link is on.
  if (s.state !== 'claimed' && link?.state === 'starting' && link.code)
    return `Whombat Link code ${link.code} — open ${(link.url ?? '').replace(/^https?:\/\//, '')} and enter it (dev/console)`;
  switch (s.state) {
    case 'claimable':
      return `${s.code ?? '?'} — open ${s.url.replace(/^https?:\/\//, '')} and enter it (dev/console)`;
    case 'waiting':
      return 'waiting for control (no lookup number yet)';
    case 'backoff':
      return `too many wrong codes, again at ${typeof s.retryAt === 'number' ? new Date(s.retryAt * (s.retryAt > 1e11 ? 1 : 1000)).toISOString() : s.retryAt}`;
    default:
      return s.state;
  }
}

/** Builds whombat-console from this checkout (Go's build cache makes a rebuild instant); null without Go. */
export async function buildConsole(): Promise<string | null> {
  const out = join(paths.bin, 'whombat-console');
  mkdirSync(paths.bin, { recursive: true });
  const r = await run('go', ['build', '-trimpath', '-o', out, './console/cmd/whombat-console'], {
    cwd: REPO_DIR,
    env: { CGO_ENABLED: '0' },
    timeoutMs: 300_000,
  }).catch(() => null);
  if (r?.code === 0) return out;
  if (r) process.stderr.write(`dev/console: building whombat-console failed:\n${r.stderr}`);
  return existsSync(out) ? out : null;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes('--json')) {
    console.log(existsSync(paths.console) ? readFileSync(paths.console, 'utf8').trim() : 'null');
    process.exit(0);
  }
  const bin = await buildConsole();
  if (!bin) {
    // No Go toolchain: the summary instead of the drawn screen.
    console.log(`console: ${consoleSummary(readConsoleState())}`);
    process.exit(0);
  }
  const watch = args.includes('--watch');
  const child = spawn(bin, [...(watch ? [] : ['--once']), '--file', paths.console], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
  process.on('SIGINT', () => child.kill('SIGTERM'));
}
