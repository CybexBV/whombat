/**
 * ChatGPT sign-ins through Hermes (docs/decisions/hermes-native.md HN-03, HN-C04…HN-C08): the person sees what they saw
 * with the Codex CLI — OpenAI's own page and a one-time code — but the login is Hermes's own, in their Hermes profile,
 * which only Hermes reads, writes and refreshes. The runner runs the plugin's steps (`whombat_hermes.codex_auth`, with the
 * Python beside `hermes`), one per process:
 *
 * - `login` in a private staging Hermes home: Hermes's device-code login. The link and code come back as JSON; Hermes
 *   writes the login into the staging home's `auth.json` and checks it with its read-only resolution.
 * - `token`: a Codex access token (stdin) as Hermes's own credential, into a staging home.
 * - `install` with the person's profile as `HERMES_HOME`: the staged `auth.json` replaces the profile's, under Hermes's
 *   own auth-store lock (a Hermes running there never writes an older login over it).
 * - `remove`: the profile's goes (sign-out), under the same lock.
 * - `usage`, `models`: the plan's windows; Hermes's ChatGPT models.
 *
 * Whombat never opens `auth.json` and never sees a token: no step prints one. Every step runs with nothing of the
 * appliance's environment but PATH, locale, CA bundle and proxies (`loginEnv`), its `HERMES_HOME` and an empty `HOME` —
 * never `OPENAI_API_KEY`, `CODEX_HOME` or the operator's homes.
 *
 * An OpenAI API key needs none of this: it is a 0600 `api-key` file in the person's credential home, which Hermes's
 * loop reads per request (`key_cmd`, HE-S49).
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AGENT_EFFORTS,
  type AgentEffort,
  MODEL_ID_MAX,
  PROVIDER_MODELS_MAX,
  type ProviderModel,
  ProviderModels,
  usageWindowKindForMinutes,
} from '@whombat/core';
import type { ProcessSpawner } from '../../contract';
import { killProcessTree } from '../../support/process-group';
import {
  isoOf,
  minutesLabel,
  namedWindow,
  statusOf,
  type UsageObservation,
  type UsageWindow,
} from '../../usage/types';
import { CLAUDE_KEY_FILE, writePrivateFile } from '../credential-home';
import { loginEnv } from './cli';
import type { DeviceCode, DeviceLogin, LoginFailure, LoginOutcome } from './device';

/** The plugin's module of ChatGPT steps. */
export const CHATGPT_STEPS_MODULE = 'whombat_hermes.codex_auth';

export interface ChatgptSteps {
  /** What runs a step: `[python, '-m', CHATGPT_STEPS_MODULE]` (a stand-in's command in tests). */
  command: readonly string[];
  /** PATH, locale, CA bundle and proxies come from here (default `process.env`). */
  hostEnv?: NodeJS.ProcessEnv;
}

/** The plugin's steps with the Python beside `hermes` (`hermesPythonBeside`); null without a real Hermes. */
export function chatgptSteps(python: string | null, hostEnv?: NodeJS.ProcessEnv): ChatgptSteps | null {
  return python ? { command: [python, '-m', CHATGPT_STEPS_MODULE], ...(hostEnv ? { hostEnv } : {}) } : null;
}

const ANSWER_MAX = 1024 * 1024;
/** CA bundle variables Python reads on top of `loginEnv`'s `SSL_CERT_FILE` / `SSL_CERT_DIR`. */
const PYTHON_CA_ENV = ['NIX_SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE'] as const;

interface StepRun {
  /** `HERMES_HOME` of the step. */
  home: string;
  /** An empty private directory: the step's working directory and `HOME` (`-m` puts it first on Python's path). */
  scratch: string;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  spawn?: ProcessSpawner;
  /** Each line of stdout as it comes (the login's code arrives before the step ends). */
  onAnswer?: (answer: Record<string, unknown>) => void;
}

interface StepResult {
  code: number | null;
  /** The step's JSON lines, in order. */
  answers: Record<string, unknown>[];
  /** Why it never ran (not installed) or was stopped. */
  failure: 'missing' | 'timeout' | 'cancelled' | null;
  /** The last of what Hermes wrote on stderr, for the log (never shown to people, never a token). */
  stderr: string;
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Runs one step: JSON lines on stdout, nothing of the host's logins in its environment. Never throws. */
function runStep(steps: ChatgptSteps, op: string, run: StepRun): Promise<StepResult> {
  const [command, ...prefix] = steps.command;
  const host = steps.hostEnv ?? process.env;
  // Python's own names for the CA bundle (the appliance's Nix Python reads them), besides `loginEnv`'s.
  const certificates = Object.fromEntries(
    PYTHON_CA_ENV.flatMap((name) => (host[name] ? [[name, host[name] as string]] : [])),
  );
  const env = loginEnv(
    {
      ...certificates,
      HERMES_HOME: run.home,
      HOME: run.scratch,
      PYTHONDONTWRITEBYTECODE: '1',
      HERMES_QUIET: '1',
    },
    host,
  );
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = run.spawn
        ? run.spawn(command as string, [...prefix, op], { cwd: run.scratch, env })
        : spawn(command as string, [...prefix, op], {
            cwd: run.scratch,
            env,
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
    } catch {
      resolve({ code: null, answers: [], failure: 'missing', stderr: '' });
      return;
    }
    const answers: Record<string, unknown>[] = [];
    let buffer = '';
    let bytes = 0;
    let stderr = '';
    let failure: StepResult['failure'] = null;
    let settled = false;
    const stop = (why: 'timeout' | 'cancelled') => {
      failure ??= why;
      void killProcessTree(child, { graceMs: 500 });
    };
    const timer = setTimeout(() => stop('timeout'), run.timeoutMs);
    timer.unref?.();
    const onAbort = () => stop('cancelled');
    run.signal?.addEventListener('abort', onAbort, { once: true });
    if (run.signal?.aborted) onAbort();
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.signal?.removeEventListener('abort', onAbort);
      const last = parseLine(buffer.trim());
      if (last) {
        answers.push(last);
        run.onAnswer?.(last);
      }
      resolve({ code, answers, failure, stderr: stderr.slice(-2000) });
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > ANSWER_MAX) {
        stop('timeout');
        return;
      }
      buffer += chunk.toString('utf8');
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const answer = parseLine(buffer.slice(0, at).trim());
        buffer = buffer.slice(at + 1);
        if (!answer) continue;
        answers.push(answer);
        run.onAnswer?.(answer);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000);
    });
    child.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'EACCES') failure ??= 'missing';
      finish(null);
    });
    child.once('close', (code) => finish(code));
    child.stdin?.on('error', () => {});
    child.stdin?.end(run.stdin ?? '');
  });
}

/** A private scratch directory for one step (its `HOME` and working directory), removed after it. */
async function withScratch<T>(parent: string, body: (scratch: string) => Promise<T>): Promise<T> {
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(join(parent, '.step-'));
  try {
    return await body(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** What people read when a ChatGPT sign-in ends without a login (the plugin's `reason`). */
export function chatgptLoginFailure(reason: unknown): { reason: LoginFailure; message: string } {
  switch (reason) {
    case 'expired':
      return {
        reason: 'expired',
        message: 'The code expired before it was entered. Start again for a new code.',
      };
    case 'disabled':
      return {
        reason: 'disabled',
        message:
          'Signing in with a code isn’t turned on for this ChatGPT account. Turn it on in ChatGPT’s security settings (or ask your workspace admin), then start again.',
      };
    case 'network':
      return {
        reason: 'network',
        message: 'This Whombat couldn’t reach OpenAI to sign in. Try again later.',
      };
    case 'busy':
      return { reason: 'failed', message: 'OpenAI is busy with sign-ins right now. Try again in a minute.' };
    case 'cancelled':
      return { reason: 'cancelled', message: 'Sign-in cancelled.' };
    case 'missing':
      return { reason: 'missing', message: 'ChatGPT sign-in needs Hermes, which isn’t on this Whombat.' };
    default:
      return { reason: 'failed', message: 'The sign-in didn’t complete. Start again.' };
  }
}

const failed = (r: StepResult): LoginOutcome => {
  if (r.failure === 'missing') return { ok: false, ...chatgptLoginFailure('missing') };
  if (r.failure === 'cancelled') return { ok: false, ...chatgptLoginFailure('cancelled') };
  if (r.failure === 'timeout') return { ok: false, ...chatgptLoginFailure('expired') };
  const done = r.answers.findLast((a) => a.event === 'done');
  return { ok: false, ...chatgptLoginFailure(done?.reason) };
};

export interface ChatgptDeviceLoginOptions {
  steps: ChatgptSteps;
  /** The private staging Hermes home the login is written into. */
  home: string;
  now?: () => Date;
  /** Upper bound for the whole sign-in (default 16 minutes: Hermes waits 15 for the code). */
  timeoutMs?: number;
}

/** Hermes's device-code login in `home` (`login`): the code as soon as Hermes has it, then how it ended. */
export function chatgptDeviceLogin(o: ChatgptDeviceLoginOptions): DeviceLogin {
  const controller = new AbortController();
  const now = o.now ?? (() => new Date());
  let resolveCode!: (c: DeviceCode) => void;
  let rejectCode!: (e: Error) => void;
  let codeSettled = false;
  const code = new Promise<DeviceCode>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  code.catch(() => {});
  const done = withScratch(o.home, (scratch) =>
    runStep(o.steps, 'login', {
      home: o.home,
      scratch,
      timeoutMs: o.timeoutMs ?? 16 * 60_000,
      signal: controller.signal,
      onAnswer: (a) => {
        if (codeSettled || a.event !== 'code') return;
        if (typeof a.verificationUri !== 'string' || typeof a.userCode !== 'string') return;
        codeSettled = true;
        const minutes = typeof a.expiresInMinutes === 'number' ? a.expiresInMinutes : 15;
        resolveCode({
          verificationUri: a.verificationUri,
          userCode: a.userCode,
          expiresAt: new Date(now().getTime() + minutes * 60_000).toISOString(),
        });
      },
    }),
  ).then((r): LoginOutcome => {
    const ok = r.code === 0 && !r.failure && r.answers.some((a) => a.event === 'done' && a.ok === true);
    const outcome: LoginOutcome = ok ? { ok: true } : failed(r);
    if (!codeSettled) {
      codeSettled = true;
      rejectCode(new Error(outcome.ok ? 'Hermes signed in without showing a code.' : outcome.message));
    }
    return outcome;
  });
  return { code, done, cancel: () => controller.abort() };
}

/** A Codex access token as Hermes's own credential in the staging `home` (`token`; the token only on stdin). */
export async function chatgptAccessTokenLogin(
  steps: ChatgptSteps,
  home: string,
  token: string,
): Promise<LoginOutcome> {
  const r = await withScratch(home, (scratch) =>
    runStep(steps, 'token', { home, scratch, stdin: `${token.trim()}\n`, timeoutMs: 60_000 }),
  );
  if (r.code === 0 && r.answers.at(-1)?.ok === true) return { ok: true };
  if (r.failure) return failed(r);
  return r.answers.at(-1)?.code === 'invalid'
    ? { ok: false, reason: 'failed', message: 'That doesn’t look like a Codex access token.' }
    : {
        ok: false,
        reason: 'failed',
        message: 'Hermes didn’t keep the access token. Check it and paste it again.',
      };
}

/** Thrown when a step that keeps or removes a login didn't. */
export class ChatgptStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatgptStepError';
  }
}

const stepError = (op: string, r: StepResult) =>
  new ChatgptStepError(
    r.failure === 'missing'
      ? 'Hermes isn’t on this Whombat'
      : `Hermes's ${op} step failed${r.failure ? ` (${r.failure})` : ''}: ${String(r.answers.at(-1)?.message ?? r.stderr.trim().split('\n').at(-1) ?? '').slice(0, 300)}`,
  );

/**
 * The login staged in `staging` replaces the one in `profile` (`install`), under Hermes's own auth-store lock. The
 * staged file is moved, not copied: `staging` must be on the profile's filesystem (under the Hermes root).
 */
export async function chatgptInstall(steps: ChatgptSteps, staging: string, profile: string): Promise<void> {
  const r = await withScratch(staging, (scratch) =>
    runStep(steps, 'install', {
      home: profile,
      scratch,
      stdin: JSON.stringify({ from: staging }),
      timeoutMs: 60_000,
    }),
  );
  if (r.code !== 0 || r.answers.at(-1)?.ok !== true) throw stepError('install', r);
}

/** The ChatGPT login in `profile` goes (`remove`); `scratchParent` holds the step's scratch directory. */
export async function chatgptRemove(
  steps: ChatgptSteps,
  profile: string,
  scratchParent: string,
): Promise<{ removed: boolean }> {
  const r = await withScratch(scratchParent, (scratch) =>
    runStep(steps, 'remove', { home: profile, scratch, timeoutMs: 60_000 }),
  );
  const last = r.answers.at(-1);
  if (r.code !== 0 || last?.ok !== true) throw stepError('remove', r);
  return { removed: last.removed === true };
}

/** Why `chatgptLend` lent nothing: the person must sign in again, Hermes isn't here, or try again (busy, failed). */
export type ChatgptLendRefusal = 'sign_in' | 'unavailable' | 'retry';

/**
 * The person's ChatGPT access token alone into the outsiders' profile `to` for one turn (`lend`; one-person.md
 * OP-S89): refreshed first, the Hermes way in the person's own `profile`, when it has less than `minSeconds` left.
 * `to` gets no refresh token. `scratchParent` holds the step's scratch directory. Never throws.
 */
export async function chatgptLend(
  steps: ChatgptSteps,
  o: { profile: string; to: string; minSeconds: number; scratchParent: string; signal?: AbortSignal },
): Promise<
  { ok: true; expiresAt: string | null } | { ok: false; refusal: ChatgptLendRefusal; detail: string }
> {
  const r = await withScratch(o.scratchParent, (scratch) =>
    runStep(steps, 'lend', {
      home: o.profile,
      scratch,
      stdin: JSON.stringify({ to: o.to, minSeconds: Math.round(o.minSeconds) }),
      // A refresh is one request to OpenAI (Hermes waits up to 20 s), the auth-store lock up to its own timeout.
      timeoutMs: 90_000,
      ...(o.signal ? { signal: o.signal } : {}),
    }),
  ).catch((err: unknown) => ({ code: null, answers: [], failure: null, stderr: String(err) }) as StepResult);
  const last = r.answers.at(-1);
  if (r.code === 0 && last?.ok === true)
    return { ok: true, expiresAt: typeof last.expiresAt === 'string' ? last.expiresAt : null };
  const code = typeof last?.code === 'string' ? last.code : '';
  const detail = stepError('lend', r).message;
  if (code === 'not_signed_in' || code === 'expired') return { ok: false, refusal: 'sign_in', detail };
  if (r.failure === 'missing' || /No module named/.test(r.stderr))
    return { ok: false, refusal: 'unavailable', detail };
  return { ok: false, refusal: 'retry', detail };
}

/** Writes an OpenAI API key into a Codex credential home (0600 `api-key`): no Hermes step, no CLI. */
export async function openaiApiKeyLogin(home: string, key: string): Promise<LoginOutcome> {
  const trimmed = key.trim();
  if (!trimmed || trimmed.length > 4096 || /\s/.test(trimmed))
    return { ok: false, reason: 'failed', message: 'That doesn’t look like an OpenAI API key.' };
  await writePrivateFile(join(home, CLAUDE_KEY_FILE), `${trimmed}\n`);
  return { ok: true };
}

/**
 * Best-effort `exp` of an access token (a JWT): the earlier of this and the date the person entered wins. The
 * signature isn't checked (OpenAI does that); only a readable, numeric `exp` counts.
 */
export function jwtExpiry(token: string): Date | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof claims.exp === 'number' && Number.isFinite(claims.exp) ? new Date(claims.exp * 1000) : null;
  } catch {
    return null;
  }
}

/* Usage --------------------------------------------------------------------------------------------------------- */

/** The `usage` step's answer as a reading (`ProbeUsage`): Hermes's windows by their length, the plan, a reached limit. */
export function chatgptUsageFrom(answer: Record<string, unknown>, observedAt: string): UsageObservation {
  const limited = answer.limited === true;
  const windows: UsageWindow[] = [];
  for (const raw of Array.isArray(answer.windows) ? answer.windows : []) {
    const w = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const usedPct =
      typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent)
        ? Math.max(0, Math.min(100, w.usedPercent))
        : null;
    const minutes = typeof w.windowMinutes === 'number' && w.windowMinutes > 0 ? w.windowMinutes : null;
    const resetsAt = isoOf(w.resetsAt);
    const said = limited && usedPct !== null && usedPct >= 100 ? 'limited' : null;
    const kind = usageWindowKindForMinutes(minutes);
    windows.push(
      kind === 'five_hour' || kind === 'seven_day'
        ? namedWindow(kind, usedPct, resetsAt, said)
        : {
            kind: 'other',
            label: minutes ? minutesLabel(minutes) : 'Usage',
            usedPct,
            resetsAt,
            status: statusOf(usedPct, said),
            windowMinutes: minutes,
          },
    );
  }
  const plan = typeof answer.plan === 'string' && answer.plan ? answer.plan : null;
  return {
    provider: 'codex',
    kind: 'subscription',
    plan,
    windows,
    observedAt,
    error: windows.length || plan ? null : 'ChatGPT didn’t report any usage limits.',
  };
}

export interface ChatgptUsageOptions {
  steps: ChatgptSteps;
  /** The person's profile, with Hermes's login in it. */
  profile: string;
  /** A private, empty working directory (the probe host's). */
  cwd: string;
  /** Managed: inside the task sandbox. */
  spawn?: ProcessSpawner;
  timeoutMs?: number;
  now?: () => Date;
}

/** The person's ChatGPT plan and usage windows, read by Hermes on their own login (`usage`). Never throws. */
export async function chatgptUsageProbe(o: ChatgptUsageOptions): Promise<UsageObservation> {
  const now = o.now ?? (() => new Date());
  const r = await runStep(o.steps, 'usage', {
    home: o.profile,
    scratch: o.cwd,
    timeoutMs: o.timeoutMs ?? 30_000,
    ...(o.spawn ? { spawn: o.spawn } : {}),
  });
  const answer = r.answers.at(-1);
  if (r.code === 0 && answer) return chatgptUsageFrom(answer, now().toISOString());
  return {
    provider: 'codex',
    kind: 'subscription',
    plan: null,
    windows: [],
    observedAt: now().toISOString(),
    error:
      answer?.code === 'not_signed_in'
        ? 'There’s no ChatGPT sign-in to read usage from.'
        : 'ChatGPT’s usage couldn’t be read just now.',
  };
}

/* Models -------------------------------------------------------------------------------------------------------- */

const LABEL_MAX = 60;
const WORDS: Record<string, string> = { gpt: 'GPT', codex: 'Codex', mini: 'Mini', pro: 'Pro' };

/** A ChatGPT model's name from its id: `gpt-6-sol` → “GPT-6 Sol”, `gpt-5.3-codex-spark` → “GPT-5.3 Codex Spark”. */
export function chatgptModelLabel(id: string): string {
  const [first, version, ...rest] = id.split('-');
  const head =
    first === 'gpt' && version && /^\d/.test(version)
      ? `GPT-${version}`
      : [first, version].filter(Boolean).join('-');
  const words = rest.map((w) => WORDS[w] ?? `${w.charAt(0).toUpperCase()}${w.slice(1)}`);
  return [head, ...words].join(' ').slice(0, LABEL_MAX);
}

/** The `models` step's answer as a model list (ME-04); null when it holds none Whombat can use. */
export function chatgptModelsFrom(answer: Record<string, unknown>): ProviderModel[] | null {
  const out: ProviderModel[] = [];
  for (const raw of Array.isArray(answer.models) ? answer.models : []) {
    const m = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const id = typeof m.id === 'string' ? m.id.trim() : '';
    if (!id || id.length > MODEL_ID_MAX || out.some((x) => x.id === id)) continue;
    const levels = Array.isArray(m.efforts) ? m.efforts : [];
    out.push({
      id,
      label: chatgptModelLabel(id),
      description: null,
      efforts: AGENT_EFFORTS.filter((e: AgentEffort) => levels.includes(e)),
      isDefault: m.isDefault === true && !out.some((x) => x.isDefault),
      // Hermes's priority tier, off unless a turn asks (CR-06).
      ...(m.fast === true ? { fast: 'off' as const } : {}),
    });
  }
  const kept = out.slice(0, PROVIDER_MODELS_MAX);
  if (!kept.length) return null;
  const parsed = ProviderModels.safeParse(kept);
  return parsed.success ? parsed.data : null;
}

/** Hermes's ChatGPT models, without a sign-in, in a throwaway Hermes home under `tmpRoot` (`models`). Never throws. */
export async function chatgptModels(
  steps: ChatgptSteps,
  tmpRoot: string,
  timeoutMs = 30_000,
): Promise<ProviderModel[] | null> {
  try {
    return await withScratch(tmpRoot, async (scratch) => {
      const home = join(scratch, 'hermes');
      await mkdir(home, { mode: 0o700 });
      const r = await runStep(steps, 'models', { home, scratch, timeoutMs });
      const answer = r.answers.at(-1);
      return r.code === 0 && answer ? chatgptModelsFrom(answer) : null;
    });
  } catch {
    return null;
  }
}
