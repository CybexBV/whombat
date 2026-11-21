/**
 * The CLI Hermes runs a subscription turn with — Claude Code, DirectSDK's model client (CDS-01) — as the runner checks it
 * beside Hermes: installed and signed in, and the models it offers (model-effort.md ME-04). ChatGPT runs no CLI: Hermes
 * is its client (hermes-native.md HN-04). Every turn runs on Hermes (`HermesProvider`); these checks are what Settings →
 * AI shows and what the runner claims for.
 *
 * - The runner (every box, `managed`): the pinned binary is installed (`managedAvailability`); the person's sign-in is
 *   checked per turn.
 * - Without `managed` (tests, `pnpm hermes:e2e`): the CLI's own answer about its own login (`claude auth status`), with
 *   the host user's environment.
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import type { ProviderModel } from '@whombat/core';
import { parseClaudeAuthStatus } from '../claude/auth-status';
import { launchCommand } from '../claude/cli';
import type { Availability, ModelListRequest } from '../contract';
import { listClaudeModels } from '../models/list';
import { errorMessage, trimMessage } from '../support/errors';
import { managedAvailability, providerExecutable } from './drift';

export type CliKind = 'claude';

export interface CliCheckOptions {
  /** The runner's environment (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** A managed runner: the pinned binary, never the host user's login (PV-04). */
  managed?: boolean;
  /** The CLI to check (default `providerExecutable`: `WHOMBAT_*_PATH`, the pinned bundle, else on `PATH`). */
  executable?: string;
  timeoutMs?: number;
}

/** Runs `command args` and returns its stdout even when it exits non-zero (`claude auth status` exits 1 logged out). */
function run(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number },
): Promise<{ stdout: string; code: number | null }> {
  const launch = launchCommand(command, args);
  return new Promise((resolve, reject) => {
    execFile(
      launch.command,
      launch.args,
      { env: options.env, cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        const code = (error as (Error & { code?: unknown }) | null)?.code;
        if (error && typeof code !== 'number') reject(error);
        else resolve({ stdout: String(stdout), code: typeof code === 'number' ? code : 0 });
      },
    );
  });
}

async function claudeAvailability(
  executable: string,
  env: NodeJS.ProcessEnv,
  ms: number,
): Promise<Availability> {
  const turnEnv = { ...env, DISABLE_AUTOUPDATER: '1' };
  const status = await run(executable, ['auth', 'status', '--json'], {
    env: turnEnv,
    cwd: homedir(),
    timeoutMs: ms,
  });
  const auth = parseClaudeAuthStatus(status.stdout);
  if (!auth) return { ok: false, reason: 'Claude Code didn’t say whether it is signed in.', kind: 'error' };
  if (!auth.loggedIn)
    return { ok: false, reason: 'Claude is installed but not logged in.', kind: 'logged_out' };
  const version = await run(executable, ['--version'], { env: turnEnv, timeoutMs: 10_000 })
    .then((r) => r.stdout.trim())
    .catch(() => '');
  return { ok: true, version: version || 'Claude Code (version unknown)' };
}

/** Whether `kind`'s CLI is ready here: installed (managed), or installed and signed in (without it). Never throws. */
export async function cliAvailability(kind: CliKind, options: CliCheckOptions = {}): Promise<Availability> {
  const env = options.env ?? process.env;
  if (options.managed) return managedAvailability(kind, env);
  const executable = options.executable ?? providerExecutable(kind, env);
  const ms = options.timeoutMs ?? 20_000;
  try {
    return await claudeAvailability(executable, env, ms);
  } catch (error) {
    return { ok: false, reason: trimMessage(errorMessage(error), 300) };
  }
}

/**
 * The models `kind`'s CLI offers, as it lists them itself without a sign-in (ME-04): Claude Code's `initialize`, in a
 * throwaway home. Null when it didn't list them; never throws.
 */
export async function listCliModels(
  kind: CliKind,
  request: ModelListRequest & { env?: NodeJS.ProcessEnv } = {},
): Promise<ProviderModel[] | null> {
  const { executable, env = process.env, ...rest } = request;
  return listClaudeModels(executable ?? providerExecutable(kind, env), { env, ...rest });
}
