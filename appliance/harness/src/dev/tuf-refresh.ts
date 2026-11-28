/**
 * The dev TUF repository's timestamp, kept fresh (IN-224). Production re-signs its update repository every 6 hours
 * (`tufrepo refresh`, control's `whombat-tuf-timestamp.timer`; PI-11, HZ-16). Signed only when something is published
 * into it, the dev repository's timestamp would expire 24 hours after a publish and its box could verify no assignment
 * until the next one. `dev/up` runs this as the service `tuf-refresh` next to the
 * repository's server (`tuf`).
 *
 * It re-signs whenever the timestamp has 18 hours or less left (a 24-hour timestamp 6 hours old), has expired or can't
 * be read: at start, 6 hours after each refresh, and when the timestamp reaches 18 hours left (a publish in between
 * moves that). So the timestamp keeps at least 18 hours, as production's does and control's `tuf_timestamp_stale`
 * (below 12 hours, UP-G2) expects. Re-signing is `tufrepo refresh --dir <repository>` with the repository's own
 * development keys and this checkout's tufrepo (`tufrepo.ts`): snapshot and timestamp always,
 * the clients role within 7 days of its expiry and targets within 14. One line per refresh on
 * stdout (`logs/tuf-refresh.log`, `dev/logs tuf-refresh`); a failure is a warning line and another try after 15
 * minutes, and the stack keeps running.
 *
 *   node tuf-refresh.ts [<repository>]          the service (default: the environment's env/manager/tuf)
 *   node tuf-refresh.ts [<repository>] --once   re-sign now and print the line; exit 1 when it failed
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, sleep } from '../lib/proc.ts';
import { envPath } from './env.ts';
import { tufrepoBin } from './tufrepo.ts';

const HOUR = 3_600_000;
/** Production's timer interval (PI-11): the most a timestamp gets old here. */
export const PERIOD_MS = 6 * HOUR;
/** Re-sign at 18 hours left: a 24-hour timestamp (devtuf's, PI-11) one period old. */
export const WINDOW_MS = 18 * HOUR;
/** The next try after a failure. */
export const RETRY_MS = 15 * 60_000;

export interface Timestamp {
  version: number;
  /** Epoch milliseconds. */
  expires: number;
}

/** The timestamp the repository serves (`metadata/timestamp.json`); null when it is missing or unreadable. */
export function readTimestamp(repo: string): Timestamp | null {
  try {
    const { signed } = JSON.parse(readFileSync(join(repo, 'metadata', 'timestamp.json'), 'utf8')) as {
      signed?: { version?: unknown; expires?: unknown };
    };
    const expires = typeof signed?.expires === 'string' ? Date.parse(signed.expires) : Number.NaN;
    return typeof signed?.version === 'number' && Number.isFinite(expires)
      ? { version: signed.version, expires }
      : null;
  } catch {
    return null;
  }
}

export const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** `17.9 h left`, `expired at …` or `unreadable`. */
export function timeLeft(ts: Timestamp | null, now: number): string {
  if (!ts) return 'unreadable';
  const left = ts.expires - now;
  return left > 0 ? `${(left / HOUR).toFixed(1)} h left` : `expired at ${iso(ts.expires)}`;
}

/** `v85 expires … (17.9 h left)`, `v85 expired at …` or that there is none: for the log and `dev/status`. */
export function timestampState(ts: Timestamp | null, now: number): string {
  if (!ts) return 'no readable timestamp.json';
  return ts.expires > now
    ? `v${ts.version} expires ${iso(ts.expires)} (${timeLeft(ts, now)})`
    : `v${ts.version} ${timeLeft(ts, now)}`;
}

export interface Plan {
  /** Re-sign now. */
  due: boolean;
  why: 'unreadable' | 'expired' | 'window' | 'fresh';
  /** When it isn't due: how long until it reaches the window (a second past it), at most a period. */
  waitMs: number;
}

/** The scheduling decision: due when the timestamp is unreadable, expired or within WINDOW_MS of its expiry. */
export function plan(ts: Timestamp | null, now: number): Plan {
  if (!ts) return { due: true, why: 'unreadable', waitMs: 0 };
  const left = ts.expires - now;
  if (left <= 0) return { due: true, why: 'expired', waitMs: 0 };
  if (left <= WINDOW_MS) return { due: true, why: 'window', waitMs: 0 };
  return { due: false, why: 'fresh', waitMs: Math.min(PERIOD_MS, left - WINDOW_MS + 1000) };
}

/**
 * Control's update repository checks (UP-G2, control CL-88) read `TUF_PUBLIC_URL`: `tuf_timestamp_stale` below 12 hours
 * left, `tuf_expiring` for root and targets, `client_channel_expiring` (`/clients/channel.json` on the same origin). In
 * the dev stack that is this repository's server, once the repository exists (a new environment makes it after control
 * has started; control reads it from its next start).
 */
export function controlTufUrl(repo: string, port: number): string | undefined {
  return existsSync(join(repo, 'metadata', 'root.json')) ? `http://127.0.0.1:${port}/metadata/` : undefined;
}

export interface Outcome {
  ok: boolean;
  /** tufrepo's line (`re-signed snapshot, timestamp; timestamp v86 expires …`), or why it failed. */
  line: string;
  /** tufrepo's warnings (`root expires at …`). */
  warnings: string[];
}

const lastLine = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1) ?? '';

/**
 * One `tufrepo refresh` of the repository. It takes the repository's lock, so it waits for a publish or a client
 * channel to finish (up to 2 minutes, then it fails and is tried again).
 */
export async function refresh(repo: string): Promise<Outcome> {
  let bin: string;
  try {
    bin = await tufrepoBin(undefined, 30 * 60_000);
  } catch (err) {
    return { ok: false, line: `no tufrepo: ${lastLine(String(err))}`, warnings: [] };
  }
  const r = await run(bin, ['refresh', '--dir', repo], { cwd: repo, timeoutMs: 10 * 60_000 });
  const warnings = r.stderr
    .split('\n')
    .map((l) => /^tufrepo: warning: (.+)$/.exec(l.trim())?.[1])
    .filter((w): w is string => !!w);
  if (r.code === 0) return { ok: true, line: lastLine(r.stdout), warnings };
  const why = (lastLine(r.stderr) || lastLine(r.stdout) || 'no output').replace(/^tufrepo: /, '');
  return {
    ok: false,
    line: `tufrepo refresh failed (${r.timedOut ? 'timed out' : `exit ${r.code ?? r.signal}`}): ${why}`,
    warnings,
  };
}

/** The service (see the module comment); never returns. */
async function serve(repo: string): Promise<never> {
  let first = true;
  const say = (s: string) => {
    process.stdout.write(
      `${iso(Date.now())} ${first ? `started (pid ${process.pid}, ${repo}): ` : ''}${s}\n`,
    );
    first = false;
  };
  for (;;) {
    const ts = readTimestamp(repo);
    const p = plan(ts, Date.now());
    if (!p.due) {
      say(`timestamp ${timestampState(ts, Date.now())}; next check ${iso(Date.now() + p.waitMs)}`);
      await sleep(p.waitMs);
      continue;
    }
    const before = timeLeft(ts, Date.now());
    const o = await refresh(repo);
    if (o.ok) say(`${o.line} (before: ${before}); next refresh ${iso(Date.now() + PERIOD_MS)}`);
    else
      say(
        `warning: ${o.line}; timestamp ${timestampState(readTimestamp(repo), Date.now())}; trying again ${iso(Date.now() + RETRY_MS)}, the stack keeps running`,
      );
    for (const w of o.warnings) say(`warning: ${w}`);
    await sleep(o.ok ? PERIOD_MS : RETRY_MS);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const repo = args.find((a) => !a.startsWith('-')) ?? envPath('manager', 'tuf');
  if (
    args.some((a) => a.startsWith('-') && a !== '--once') ||
    args.filter((a) => !a.startsWith('-')).length > 1
  ) {
    process.stderr.write('usage: tuf-refresh.ts [<repository>] [--once]\n');
    process.exit(2);
  }
  if (!existsSync(join(repo, 'metadata', 'root.json'))) {
    process.stderr.write(`tuf-refresh: ${repo} is not a TUF repository\n`);
    process.exit(2);
  }
  if (args.includes('--once')) {
    const before = timeLeft(readTimestamp(repo), Date.now());
    const o = await refresh(repo);
    process.stdout.write(`${o.ok ? o.line : `warning: ${o.line}`} (before: ${before})\n`);
    for (const w of o.warnings) process.stdout.write(`warning: ${w}\n`);
    process.exit(o.ok ? 0 : 1);
  }
  await serve(repo);
}
