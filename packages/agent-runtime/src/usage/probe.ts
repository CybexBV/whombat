/**
 * The usage probe of one person's Claude subscription (docs/decisions/ui-improvements.md UI-R02, UI-R05, UI-R06): the
 * unmodified Claude Code with exactly that person's credential home — the same home and variables a turn on their
 * sign-in gets (`credentialEnv`: `CLAUDE_CONFIG_DIR = <home>/config`) and nothing of the host's logins (`loginEnv`:
 * PATH, locale, CA bundle, proxies). Whombat never opens the CLI's own files (SUB-03); what it reads is the CLI's answer
 * on stdout. ChatGPT's usage is Hermes's own read (`chatgptUsageProbe`, hermes-native.md HN-03).
 *
 * An API-key sign-in has no windows and is never probed (pay as you go). Where the process runs is the caller's: a
 * managed runner starts it in a task sandbox like a turn (`spawn`); a self-hosted server runs it on the host after
 * `homeLinkProblem` (SUB-41), as it runs `claude auth status`.
 */
import type { ProcessSpawner } from '../contract';
import { CLAUDE_BUNDLE } from '../providers/bundles';
import { credentialEnv } from '../providers/credential-home';
import { loginEnv } from '../providers/login/cli';
import { claudeUsageProbe } from './claude';
import type { UsageObservation, UsageProvider } from './types';

/** Auth modes that are pay-as-you-go keys: no plan, no windows (UI-R06). */
export const API_KEY_MODES: Record<UsageProvider, readonly string[]> = {
  claude: ['api_key'],
  codex: ['api_key'],
};

export function isApiKeyMode(provider: UsageProvider, authMode: string): boolean {
  return API_KEY_MODES[provider].includes(authMode);
}

/** The reading of an API-key sign-in: no windows, nothing run. */
export function apiKeyObservation(provider: UsageProvider, observedAt: string): UsageObservation {
  return { provider, kind: 'api_key', plan: null, windows: [], observedAt, error: null };
}

export interface UsageProbeJob {
  provider: 'claude';
  /** The person's credential home for this provider (`credentialHomePath`). */
  home: string;
  authMode: string;
  /** The installed client's executable. */
  command: string;
  /** Where the process runs (a private, empty directory). */
  cwd: string;
  /** PATH, locale, CA bundle and proxies come from here (default `process.env`). */
  hostEnv?: NodeJS.ProcessEnv;
  /** Managed: start it inside the task sandbox. */
  spawn?: ProcessSpawner;
  timeoutMs?: number;
  now?: () => Date;
}

/** Runs the probe; a failure is a reading with `error`, never a throw (except for a home without a sign-in). */
export async function runUsageProbe(job: UsageProbeJob): Promise<UsageObservation> {
  const now = job.now ?? (() => new Date());
  if (isApiKeyMode(job.provider, job.authMode)) return apiKeyObservation(job.provider, now().toISOString());
  const own = await credentialEnv(job.home, job.provider, job.authMode);
  // HOME is the probe's own empty directory: the CLI's state lives in the credential home's variables alone.
  const env = loginEnv({ HOME: job.cwd, ...own }, job.hostEnv);
  const common = {
    command: job.command,
    env,
    cwd: job.cwd,
    ...(job.spawn ? { spawn: job.spawn } : {}),
    ...(job.timeoutMs ? { timeoutMs: job.timeoutMs } : {}),
    now,
  };
  return claudeUsageProbe({
    ...common,
    settings: {
      disableAllHooks: true,
      env: { ...(CLAUDE_BUNDLE.selfUpdate.config.env as Record<string, string>) },
    },
  });
}
