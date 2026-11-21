/**
 * Device-code sign-ins driven through the provider's own CLI (PV-03): the CLI asks its provider for a code, prints
 * the verification address and the one-time code (parsed here and relayed to the person's browser, on any computer),
 * then polls until the person approves, the code expires or they cancel. The appliance never opens a localhost
 * callback and never sees the person's password or the tokens the CLI receives (they go straight into the
 * credential home).
 *
 * Output formats (verified against the pinned CLIs' sources and binaries, PV-05; ChatGPT's sign-in is Hermes's own,
 * `login/chatgpt.ts`):
 * - gh 2.101.0 `auth login --web` without a terminal: “! First copy your one-time code: XXXX-XXXX” and
 *   “Open this URL to continue in your web browser: https://github.com/login/device”; GitHub's code expires after
 *   15 minutes.
 */
import { type CliResult, runCli } from './cli';

export interface DeviceCode {
  verificationUri: string;
  userCode: string;
  expiresAt: string;
}

export type LoginFailure = 'expired' | 'denied' | 'disabled' | 'network' | 'cancelled' | 'missing' | 'failed';

export type LoginOutcome = { ok: true } | { ok: false; reason: LoginFailure; message: string };

export interface DeviceLogin {
  /** Resolves once the CLI printed the code (rejects if it ended before that). */
  code: Promise<DeviceCode>;
  /** Resolves when the CLI finished: signed in, or why not. */
  done: Promise<LoginOutcome>;
  cancel(): void;
}

/** A parser fed one output line at a time; returns the code once both halves were seen. */
export type DeviceParser = (line: string) => {
  verificationUri?: string;
  userCode?: string;
  minutes?: number;
};

const URL_RE = /(https:\/\/[^\s)]+)/;

export function githubDeviceParser(): DeviceParser {
  return (line) => {
    const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(line);
    if (code) return { userCode: (code[1] as string).toUpperCase() };
    if (/Open this URL/i.test(line) && URL_RE.test(line))
      return { verificationUri: URL_RE.exec(line)?.[1] as string };
    return {};
  };
}

/** Why a device sign-in ended without signing in, from the CLI's last lines. */
export function deviceFailure(result: CliResult): { reason: LoginFailure; message: string } {
  const text = result.lines.join('\n');
  if (result.spawnError)
    return { reason: 'missing', message: 'The provider’s command isn’t installed on the appliance.' };
  if (result.aborted) return { reason: 'cancelled', message: 'Sign-in cancelled.' };
  if (result.timedOut || /timed out|expired|expired_token|token_expired/i.test(text))
    return {
      reason: 'expired',
      message: 'The code expired before it was entered. Start again for a new code.',
    };
  if (/not enabled|device_flow_disabled/i.test(text))
    return {
      reason: 'disabled',
      message:
        'Device code sign-in isn’t enabled for this account. Turn it on in the provider’s security settings (or ask the workspace admin), then start again.',
    };
  if (/access_denied|denied|declined/i.test(text))
    return { reason: 'denied', message: 'The sign-in was declined in the browser.' };
  if (/error sending request|could not resolve|connection|network|dns/i.test(text))
    return {
      reason: 'network',
      message: 'The appliance couldn’t reach the provider to sign in. Try again later.',
    };
  return { reason: 'failed', message: 'The sign-in didn’t complete. Start again.' };
}

export interface DeviceLoginOptions {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  parser: DeviceParser;
  /** How long the code lives when the CLI doesn't say (minutes, default 15). */
  defaultMinutes?: number;
  /** Upper bound for the whole sign-in (default 16 minutes). */
  timeoutMs?: number;
  now?: () => Date;
}

/** Starts a device sign-in through a CLI. The result's `code` and `done` settle independently. */
export function startDeviceLogin(options: DeviceLoginOptions): DeviceLogin {
  const controller = new AbortController();
  const now = options.now ?? (() => new Date());
  const seen: { verificationUri?: string; userCode?: string; minutes?: number } = {};
  let resolveCode!: (c: DeviceCode) => void;
  let rejectCode!: (e: Error) => void;
  let codeSettled = false;
  const code = new Promise<DeviceCode>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  code.catch(() => {});
  const done = runCli({
    command: options.command,
    args: options.args,
    env: options.env,
    signal: controller.signal,
    timeoutMs: options.timeoutMs ?? 16 * 60_000,
    onLine: (line) => {
      if (codeSettled) return;
      Object.assign(
        seen,
        Object.fromEntries(Object.entries(options.parser(line)).filter(([, v]) => v !== undefined)),
      );
      if (seen.verificationUri && seen.userCode) {
        codeSettled = true;
        const minutes = seen.minutes ?? options.defaultMinutes ?? 15;
        resolveCode({
          verificationUri: seen.verificationUri,
          userCode: seen.userCode,
          expiresAt: new Date(now().getTime() + minutes * 60_000).toISOString(),
        });
      }
    },
  }).then((result): LoginOutcome => {
    const outcome: LoginOutcome =
      result.code === 0 && !result.aborted ? { ok: true } : { ok: false, ...deviceFailure(result) };
    if (!codeSettled) {
      codeSettled = true;
      rejectCode(new Error(outcome.ok ? 'The CLI signed in without showing a code.' : outcome.message));
    }
    return outcome;
  });
  return { code, done, cancel: () => controller.abort() };
}
