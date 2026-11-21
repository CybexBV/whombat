/**
 * The Claude subscription sign-in console (SUB-02, SUB-03; contracts CT-71): the unmodified CLI's own
 * `claude auth login --claudeai`, and nothing else, in a pseudo-terminal whose output the person's browser shows and
 * whose keyboard the browser drives. The person signs in on claude.ai and types the code Anthropic shows them back
 * into the CLI; the CLI writes its credential into the private staging home. Whombat never reads that credential:
 * whether the sign-in happened comes from `claude auth status` alone.
 *
 * - Fixed program and arguments (`PROVIDER_CONSOLE_COMMANDS['claude:subscription_cli']`), no shell.
 * - An environment built from nothing but PATH, the locale, the CA bundle and proxies (as every sign-in, PV-03),
 *   HOME = the staging home, TERM and CLAUDE_CONFIG_DIR = `<staging>/config`. No `ANTHROPIC_*`, no
 *   `CLAUDE_CODE_OAUTH_TOKEN`, no operator HOME can reach it.
 * - Output is reported as raw PTY bytes with byte offsets from 0, in pieces of at most
 *   `PROVIDER_CONSOLE_READ_MAX_BYTES`. Neither output nor input is ever logged: the output may echo the code.
 * - It stops itself at `expiresAt`.
 */

import type { ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PROVIDER_CONSOLE_COMMANDS,
  PROVIDER_CONSOLE_MAX_OFFSET,
  PROVIDER_CONSOLE_READ_MAX_BYTES,
} from '@whombat/core/domain';
import type { IPty } from 'node-pty';
import { killProcessTree } from '../../support/process-group';
import { CLAUDE_CONFIG_SUBDIR, homeLinkProblem } from '../credential-home';
import { runCli } from './cli';

/** The CLI's arguments (the program is the resolved `claude` binary). */
export const CLAUDE_CONSOLE_ARGS: readonly string[] =
  PROVIDER_CONSOLE_COMMANDS['claude:subscription_cli'].slice(1);

export const CONSOLE_TERM = 'xterm-256color';

/** What a console's CLI gets from the host environment. */
const CONSOLE_PASS_THROUGH =
  /^(PATH|LANG|LC_ALL|LC_CTYPE|TZ|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|(HTTPS?|NO)_PROXY|(https?|no)_proxy)$/;

/**
 * The console's environment (and that of `claude auth status` for the same home): PATH, locale, CA bundle and
 * proxies from the host, HOME = the home, TERM, CLAUDE_CONFIG_DIR = `<home>/config`. Nothing else.
 */
export function claudeConsoleEnv(
  home: string,
  host: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = { PATH: host.PATH || '/usr/bin:/bin' };
  for (const [k, v] of Object.entries(host)) if (v !== undefined && CONSOLE_PASS_THROUGH.test(k)) out[k] = v;
  return { ...out, HOME: home, TERM: CONSOLE_TERM, CLAUDE_CONFIG_DIR: join(home, CLAUDE_CONFIG_SUBDIR) };
}

export type ConsoleStopReason = 'cancelled' | 'expired';

export type ConsoleOutcome =
  | { state: 'completed'; exitCode: number; error: null }
  | {
      state: 'failed' | 'cancelled' | 'expired';
      exitCode: number | null;
      error: { code: string; message: string };
    };

export interface ClaudeConsoleOptions {
  /** The resolved `claude` executable. */
  command: string;
  /** The private staging home (exists, 0700): cwd, HOME and the parent of CLAUDE_CONFIG_DIR. */
  home: string;
  cols: number;
  rows: number;
  /** It stops itself then (`expired`). */
  expiresAt: Date;
  /** Output bytes in order; `offset` counts from 0. At most `PROVIDER_CONSOLE_READ_MAX_BYTES` per call. */
  onOutput: (offset: number, data: Buffer) => void;
  hostEnv?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** `claude auth status` (default 30 s). */
  statusTimeoutMs?: number;
}

/** Whether the CLI's own status says signed in (`claude auth status`, JSON; SUB-03: never the credential file). */
export async function claudeAuthStatus(
  command: string,
  home: string,
  options: { hostEnv?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ loggedIn: boolean; ran: boolean }> {
  // Never outside a sandbox on a home with a link in it (SUB-41).
  if (await homeLinkProblem(home)) return { loggedIn: false, ran: true };
  let loggedIn: boolean | null = null;
  const result = await runCli({
    command,
    args: ['auth', 'status'],
    env: claudeConsoleEnv(home, options.hostEnv),
    timeoutMs: options.timeoutMs ?? 30_000,
    onLine: (line, stream) => {
      if (stream !== 'stdout' || loggedIn !== null) return;
      const said = /"loggedIn"\s*:\s*(true|false)/.exec(line);
      if (said) loggedIn = said[1] === 'true';
    },
  });
  if (result.spawnError || result.timedOut) return { loggedIn: false, ran: false };
  return { loggedIn: loggedIn === true, ran: true };
}

/** One running `claude auth login --claudeai` in a PTY. */
export class ClaudeConsoleLogin {
  /** Settles once the CLI exited and, after exit 0, its status was asked. Never rejects. */
  readonly done: Promise<ConsoleOutcome>;
  private readonly term: IPty;
  private offset = 0;
  private exited = false;
  private stopReason: ConsoleStopReason | null = null;
  private readonly timer: ReturnType<typeof setTimeout>;

  /** Throws when the PTY can't be started. The staging home's `config` directory is created first. */
  static async start(options: ClaudeConsoleOptions): Promise<ClaudeConsoleLogin> {
    await mkdir(join(options.home, CLAUDE_CONFIG_SUBDIR), { recursive: true, mode: 0o700 });
    // Loaded here, not at import: its native addon (MR-72) is needed by a sign-in console only, so the server, the
    // runner and `whombat migrate` start without loading it.
    const { spawn } = await import('node-pty');
    return new ClaudeConsoleLogin(options, spawn);
  }

  private constructor(
    private readonly options: ClaudeConsoleOptions,
    spawn: typeof import('node-pty').spawn,
  ) {
    this.term = spawn(options.command, [...CLAUDE_CONSOLE_ARGS], {
      name: CONSOLE_TERM,
      cols: options.cols,
      rows: options.rows,
      cwd: options.home,
      env: claudeConsoleEnv(options.home, options.hostEnv),
      // Raw bytes: a multi-byte character may split across reads, and the offsets count bytes.
      encoding: null,
    });
    this.term.onData((chunk: string | Buffer) => this.output(chunk));
    const exit = new Promise<{ exitCode: number; signal: number | undefined }>((resolve) =>
      this.term.onExit((e) => {
        this.exited = true;
        resolve({ exitCode: e.exitCode, signal: e.signal || undefined });
      }),
    );
    this.done = exit.then((e) => this.settle(e));
    const now = options.now?.() ?? new Date();
    this.timer = setTimeout(
      () => this.stop('expired'),
      Math.max(0, options.expiresAt.getTime() - now.getTime()),
    );
    this.timer.unref?.();
  }

  get pid(): number {
    return this.term.pid;
  }

  get running(): boolean {
    return !this.exited;
  }

  private output(chunk: string | Buffer): void {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    for (let at = 0; at < bytes.length; at += PROVIDER_CONSOLE_READ_MAX_BYTES) {
      const piece = bytes.subarray(at, at + PROVIDER_CONSOLE_READ_MAX_BYTES);
      // Far above what a 10-minute login writes; past it the output is dropped rather than numbered wrongly.
      if (this.offset + piece.length > PROVIDER_CONSOLE_MAX_OFFSET) return;
      const offset = this.offset;
      this.offset += piece.length;
      this.options.onOutput(offset, piece);
    }
  }

  private async settle(e: { exitCode: number; signal: number | undefined }): Promise<ConsoleOutcome> {
    clearTimeout(this.timer);
    const exitCode = e.signal ? null : e.exitCode;
    if (this.stopReason === 'expired')
      return {
        state: 'expired',
        exitCode,
        error: {
          code: 'provider.login_expired',
          message: 'The sign-in took too long and was stopped. Start again.',
        },
      };
    if (this.stopReason === 'cancelled')
      return {
        state: 'cancelled',
        exitCode,
        error: { code: 'provider.login_cancelled', message: 'Sign-in cancelled.' },
      };
    if (exitCode !== 0)
      return {
        state: 'failed',
        exitCode,
        error: {
          code: 'provider.login_failed',
          message: 'Claude Code’s sign-in didn’t complete. Start again.',
        },
      };
    const status = await claudeAuthStatus(this.options.command, this.options.home, {
      ...(this.options.hostEnv ? { hostEnv: this.options.hostEnv } : {}),
      ...(this.options.statusTimeoutMs ? { timeoutMs: this.options.statusTimeoutMs } : {}),
    }).catch(() => ({ loggedIn: false, ran: false }));
    if (status.loggedIn) return { state: 'completed', exitCode, error: null };
    return {
      state: 'failed',
      exitCode,
      error: status.ran
        ? {
            code: 'provider.login_missing',
            message:
              'Claude Code finished without signing in. Start again and finish the sign-in on claude.ai.',
          }
        : {
            code: 'provider.login_failed',
            message: 'Claude Code’s sign-in status couldn’t be checked. Start again.',
          },
    };
  }

  /** Keystrokes as the terminal emulator produced them. Ignored once the CLI exited. */
  write(data: string): void {
    if (this.exited || this.stopReason) return;
    this.term.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    try {
      this.term.resize(cols, rows);
    } catch {
      // The PTY closed between the check and the call.
    }
  }

  /** Stops the CLI and everything it started (its session's process group). The first reason wins. */
  stop(reason: ConsoleStopReason): void {
    if (this.exited || this.stopReason) return;
    this.stopReason = reason;
    clearTimeout(this.timer);
    void killProcessTree({ pid: this.term.pid } as ChildProcess, { graceMs: 500 }).catch(() => {});
  }
}
