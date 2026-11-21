/**
 * Running a provider's own CLI for a sign-in (PV-03): its own process group, an environment built from nothing
 * but what the command needs (never the appliance's environment: no `OPENAI_API_KEY`, `ANTHROPIC_*`, `GH_TOKEN`
 * or the operator's homes can leak into, or be picked up by, someone's sign-in), a secret only ever on stdin, and
 * output that is bounded and has the secret cut out before anyone sees it.
 */
import { killProcessTree, spawnGroup } from '../../support/process-group';

export interface CliRun {
  command: string;
  args: readonly string[];
  /** The complete environment (callers build it with `loginEnv`). */
  env: Record<string, string>;
  /** Written to stdin, then stdin is closed. Never on the command line or in the environment. */
  stdin?: string;
  /** Kills the process group. */
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Each output line (stdout and stderr, ANSI stripped, secret redacted) as it arrives. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
}

export interface CliResult {
  code: number | null;
  /** Last lines of output (bounded, redacted). */
  lines: string[];
  timedOut: boolean;
  aborted: boolean;
  /** The CLI couldn't be started (not installed). */
  spawnError: string | null;
}

/** What every sign-in command gets from the host environment: a PATH, the locale, a CA bundle, proxies. */
const PASS_THROUGH =
  /^(LANG|LC_ALL|TZ|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|(HTTPS?|NO)_PROXY|(https?|no)_proxy)$/;

/** The environment of a sign-in command: PATH and locale from the host, the rest from the caller only. */
export function loginEnv(
  extra: Record<string, string>,
  host: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = { PATH: host.PATH || '/usr/bin:/bin', NO_COLOR: '1' };
  for (const [k, v] of Object.entries(host)) if (v !== undefined && PASS_THROUGH.test(k)) out[k] = v;
  return { ...out, ...extra };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI escape codes from CLI output
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

export function redact(line: string, secret: string | undefined): string {
  let out = line.replace(ANSI, '');
  if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]');
  return out;
}

const MAX_LINES = 40;
const MAX_LINE = 500;

export function runCli(run: CliRun): Promise<CliResult> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let child: ReturnType<typeof spawnGroup>;
    try {
      child = spawnGroup(run.command, run.args, { env: run.env });
    } catch (err) {
      resolve({ code: null, lines: [], timedOut: false, aborted: false, spawnError: String(err) });
      return;
    }
    const finish = (result: CliResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const push = (stream: 'stdout' | 'stderr') => {
      let buffer = '';
      return (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        for (;;) {
          const at = buffer.search(/\r?\n/);
          if (at < 0) break;
          const raw = buffer.slice(0, at);
          buffer = buffer.slice(at + (buffer[at] === '\r' ? 2 : 1));
          const line = redact(raw, run.stdin).slice(0, MAX_LINE);
          lines.push(line);
          if (lines.length > MAX_LINES) lines.shift();
          run.onLine?.(line, stream);
        }
        if (buffer.length > 64 * 1024) buffer = buffer.slice(-MAX_LINE);
      };
    };
    child.stdout.on('data', push('stdout'));
    child.stderr.on('data', push('stderr'));
    const onAbort = () => {
      aborted = true;
      void killProcessTree(child, { graceMs: 500 });
    };
    run.signal?.addEventListener('abort', onAbort, { once: true });
    if (run.signal?.aborted) onAbort();
    const timer = setTimeout(() => {
      timedOut = true;
      void killProcessTree(child, { graceMs: 500 });
    }, run.timeoutMs ?? 60_000);
    child.once('error', (err) =>
      finish({ code: null, lines, timedOut, aborted, spawnError: (err as Error).message }),
    );
    child.once('close', (code) => finish({ code, lines, timedOut, aborted, spawnError: null }));
    child.stdin.on('error', () => {});
    if (run.stdin !== undefined) child.stdin.end(run.stdin);
    else child.stdin.end();
  });
}
