/**
 * The models a tool offers, as the tool lists them itself (Whombat model-effort.md ME-04): without a sign-in, a network
 * call or a model call, in a throwaway home of its own, so what the list says is what this version of the tool knows.
 *
 * - Claude Code: `-p` in stream-JSON mode with an empty `CLAUDE_CONFIG_DIR`, no settings files and non-essential traffic
 *   off; one `initialize` control request, whose response lists `models` (`value`, `resolvedModel`, `displayName`,
 *   `description`, `supportsEffort`, `supportedEffortLevels`, `supportsFastMode`). `default` is left out; the entry it
 *   resolves to is the default. Descriptions lose their price segments (“· $4/$20 per Mtok”). Fast replies (chat-runtime.md
 *   CR-06): `supportsFastMode` → `off` (Claude Code's fast mode is off unless asked). A model Anthropic released after
 *   the pinned version takes the place of the one it follows.
 * - ChatGPT: Hermes's own catalog, through the plugin's `models` step (`chatgptModels`, hermes-native.md HN-04).
 *
 * Efforts are kept to `AGENT_EFFORTS`, least first. A list is checked against `ProviderModels` (at most
 * `PROVIDER_MODELS_MAX`); an empty one, a failure or no answer within 20 s is no list (null). Never throws.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_EFFORTS,
  type AgentEffort,
  MODEL_ID_MAX,
  PROVIDER_MODELS_MAX,
  type ProviderModel,
  ProviderModels,
} from '@whombat/core';
import { ClaudeCliProcess, launchCommand } from '../claude/cli';
import type { ProcessSpawner } from '../contract';

/** How long listing a tool's models may take, start to finish. */
export const MODEL_LIST_TIMEOUT_MS = 20_000;

const LABEL_MAX = 60;
const DESCRIPTION_MAX = 200;

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Obj) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The efforts of `levels` that Whombat knows, least first. */
function effortsOf(levels: readonly unknown[]): AgentEffort[] {
  return AGENT_EFFORTS.filter((e) => levels.includes(e));
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Claude Code's description without its price segments: “Opus 5.5 · Best for everyday, complex tasks”. */
export function claudeModelDescription(description: string | null): string | null {
  if (!description) return null;
  const kept = description
    .split(' · ')
    .map((s) => s.trim())
    .filter((s) => s && !s.includes('$'))
    .join(' · ');
  return kept ? cut(kept, DESCRIPTION_MAX) : null;
}

/** A list as the contract takes it: valid ids, labels within bounds, at most `PROVIDER_MODELS_MAX`; null when empty. */
function checked(models: ProviderModel[]): ProviderModel[] | null {
  const kept = models.filter((m) => m.id.length <= MODEL_ID_MAX).slice(0, PROVIDER_MODELS_MAX);
  if (kept.length === 0) return null;
  const parsed = ProviderModels.safeParse(kept);
  return parsed.success ? parsed.data : null;
}

/**
 * The API model id behind each of Claude Code's names (`sonnet` → `claude-sonnet-5-5`), as its last listing said: a
 * turn on Hermes's own loop (an organisation key, the AI gateway) names the API's id, never the CLI's alias (HE-S48).
 */
const claudeResolved = new Map<string, string>();

/** The API id of a Claude Code model name (`claudeResolved`), else the name itself (already an API id, or unknown). */
export function claudeApiModel(model: string): string {
  return claudeResolved.get(model) ?? model;
}

/**
 * Claude models Anthropic released after the pinned Claude Code (docs/decisions/model-effort.md). The pinned version runs them
 * when they are named by id but doesn't list them yet, so each one takes the place of the model it follows in the
 * tool's own list, with that entry's name and efforts. An alias (`fable`) then means the newer model, as Hermes's
 * catalog says too (whombat_hermes/directsdk.py). A full id (`claude-fable-5-1[1m]`) becomes the newer one's. Nothing
 * changes once the tool lists the newer model itself.
 */
const CLAUDE_NEWER_MODELS: readonly { follows: string; model: string; was: string; now: string }[] = [
  { follows: 'claude-fable-5-1', model: 'claude-fable-5-2', was: 'Fable 5.1', now: 'Fable 5.2' },
];

function withNewerModels(entries: Obj[]): Obj[] {
  return entries.map((e) => {
    const newer = CLAUDE_NEWER_MODELS.find(
      (n) => str(e.resolvedModel) === n.follows && !entries.some((o) => str(o.resolvedModel) === n.model),
    );
    if (!newer) return e;
    const value = str(e.value);
    const description = str(e.description);
    return {
      ...e,
      ...(value?.startsWith(newer.follows) ? { value: newer.model + value.slice(newer.follows.length) } : {}),
      resolvedModel: newer.model,
      ...(description ? { description: description.replace(newer.was, newer.now) } : {}),
    };
  });
}

/** Claude Code's `initialize` `models` as a model list (ME-04). Null: none Whombat can use. */
export function claudeModelsFrom(raw: unknown): ProviderModel[] | null {
  const entries = withNewerModels(
    (Array.isArray(raw) ? raw : []).map(obj).filter((e): e is Obj => e !== null),
  );
  const defaultModel = str(entries.find((e) => e.value === 'default')?.resolvedModel);
  for (const e of entries) {
    const id = str(e.value);
    const resolved = str(e.resolvedModel);
    if (id && resolved) claudeResolved.set(id, resolved);
  }
  const out: ProviderModel[] = [];
  for (const e of entries) {
    const id = str(e.value);
    if (!id || id === 'default' || out.some((m) => m.id === id)) continue;
    const isDefault =
      defaultModel !== null && str(e.resolvedModel) === defaultModel && !out.some((m) => m.isDefault);
    const levels = Array.isArray(e.supportedEffortLevels) ? e.supportedEffortLevels : [];
    out.push({
      id,
      label: cut(str(e.displayName) ?? id, LABEL_MAX),
      description: claudeModelDescription(str(e.description)),
      efforts: e.supportsEffort === false ? [] : effortsOf(levels),
      isDefault,
      // Claude Code's fast mode is off unless a turn asks for it (`fastMode` in its flag settings).
      ...(e.supportsFastMode === true ? { fast: 'off' as const } : {}),
    });
  }
  return checked(out);
}

export interface ModelListOptions {
  /** The runner's environment: only `PATH` and the locale are taken from it. */
  env?: NodeJS.ProcessEnv;
  /** Where the throwaway home is made (default the system's temporary directory). */
  tmpRoot?: string;
  /** Start to finish (default `MODEL_LIST_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** How the process starts (default a process group on the host). */
  spawn?: ProcessSpawner;
}

/** Nothing of the runner's environment but `PATH` and the locale: no login, no key, no proxy. */
function listingEnv(base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: base.PATH || '/usr/bin:/bin',
    HOME: home,
    TMPDIR: join(home, 'tmp'),
  };
  for (const [key, value] of Object.entries(base))
    if (value !== undefined && /^(LANG|LANGUAGE|LC_[A-Z]+)$/.test(key)) env[key] = value;
  return env;
}

/** A throwaway directory with `home/` and `home/tmp/`, removed by the returned function. */
async function throwaway(root: string | undefined, prefix: string) {
  const dir = await mkdtemp(join(root ?? tmpdir(), prefix));
  const home = join(dir, 'home');
  await mkdir(join(home, 'tmp'), { recursive: true, mode: 0o700 });
  return { dir, home, remove: () => rm(dir, { recursive: true, force: true }).catch(() => {}) };
}

/**
 * Runs `body` for at most `ms`; a timeout or a failure is null. `cleanup` runs either way; `body` asks `over()` before it
 * starts a process, so nothing starts after it.
 */
async function bounded<T>(
  ms: number,
  body: (over: () => boolean) => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  let ended = false;
  try {
    return await Promise.race([
      body(() => ended),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
        timer.unref?.();
      }),
    ]);
  } catch {
    return null;
  } finally {
    ended = true;
    if (timer) clearTimeout(timer);
    await cleanup();
  }
}

/** Claude Code's models (ME-04): one `initialize` with an empty config dir, then the process is ended. */
export async function listClaudeModels(
  executable: string,
  options: ModelListOptions = {},
): Promise<ProviderModel[] | null> {
  const ms = options.timeoutMs ?? MODEL_LIST_TIMEOUT_MS;
  let cli: ClaudeCliProcess | null = null;
  let remove: () => Promise<void> = async () => {};
  return bounded(
    ms,
    async (over) => {
      const scratch = await throwaway(options.tmpRoot, 'whombat-claude-models-');
      remove = scratch.remove;
      if (over()) {
        await scratch.remove();
        return null;
      }
      const launch = launchCommand(executable, [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--setting-sources=',
      ]);
      cli = new ClaudeCliProcess({
        command: launch.command,
        args: launch.args,
        cwd: scratch.dir,
        env: {
          ...listingEnv(options.env ?? process.env, scratch.home),
          CLAUDE_CONFIG_DIR: scratch.home,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
        },
        killGraceMs: 500,
        ...(options.spawn ? { spawn: options.spawn } : {}),
      });
      const response = await cli.request({ subtype: 'initialize' }, ms);
      return claudeModelsFrom(response.models);
    },
    async () => {
      await (cli as ClaudeCliProcess | null)?.close();
      await remove();
    },
  );
}
