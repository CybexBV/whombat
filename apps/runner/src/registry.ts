/**
 * Provider registry (hermes-engine.md HE-01, HE-32; hermes-native.md HN-02, HN-04): every turn runs on Hermes Agent's own
 * loop (`HermesProvider`), one per thing an agent can be on — Claude (DirectSDK, Claude Code its model client), ChatGPT
 * (Hermes's own `openai-codex`), a model on the person's network (`local`).
 *
 * What the registry checks, again and again (`recheck`) and reports with every heartbeat (`RunnerStatus`):
 *
 * - Hermes (`checkHermes`: the pinned version answers, its profile root can be written) → `RunnerStatus.hermes`. Without
 *   it nothing is claimed: the server answers the agent's turns with the quiet reply that says so.
 * - Claude Code (`cliAvailability`): installed → `RunnerStatus.providers`, what Settings → AI shows; the readiness is the
 *   installed client's (`availability`, SUB-49): the person's sign-in is checked per turn. ChatGPT is ready with Hermes:
 *   it runs no client of its own.
 * - The models each offers (Whombat model-effort.md ME-04): Claude Code's from the CLI itself once per version — its own
 *   list, without a sign-in, in a throwaway home — ChatGPT's from Hermes's catalog once per Hermes version (the plugin's
 *   `models` step); in the background, after a failure again at most every `modelsRetryMs`. Reported with each check
 *   (`ProviderCheck.models`) and kept for the turns.
 *
 * What it claims for: `claude` while Claude Code is installed here and `codex` while Hermes is (signed in or not: a turn
 * runs on its person's sign-in, the burrow's AI gateway or an organisation key), `local` always — each only while Hermes
 * is ready. The scripted Hermes (its version ends in `(scripted)`, HE-46) runs no CLI: with it every provider is
 * claimed, and the server decides whether such a turn may run without a sign-in (`WHOMBAT_ALLOW_SCRIPTED`).
 */
import { tmpdir } from 'node:os';
import {
  type AgentProvider,
  type Availability,
  type CliKind,
  checkHermes,
  cliAvailability,
  HermesProvider,
  type HermesProviderOptions,
  hermesBin,
  hermesPythonBeside,
  hermesRoot,
  isScriptedHermes,
  listCliModels,
  unavailableKind,
} from '@whombat/agent-runtime';
import { chatgptModels, chatgptSteps } from '@whombat/agent-runtime/providers';
import {
  type AgentProvider as AgentProviderKind,
  AiGatewaySwitches,
  type HermesCheck,
  type ProviderCheck,
  type ProviderModel,
  type RunnerStatus,
} from '@whombat/core';

/** The subscription providers: Claude and ChatGPT (`codex`). */
export const LIVE_PROVIDERS = ['claude', 'codex'] as const;
type LiveProvider = (typeof LIVE_PROVIDERS)[number];
/** The CLIs checked one each: Claude Code alone (ChatGPT runs no client of its own, HN-04). */
const CLIS: readonly CliKind[] = ['claude'];

export interface ProviderRegistry {
  /** Providers this runner claims dispatches for (the claim body's `providers`); empty while Hermes isn't ready. */
  claims(): AgentProviderKind[];
  /**
   * The provider that runs an agent configured for `configured`, or null when this runner can't run it now. A turn
   * through the AI gateway (`gateway`) keeps its route even when the switch went off since its claim (AIG-07).
   */
  for(configured: AgentProviderKind, options?: { gateway?: boolean }): AgentProvider | null;
  /**
   * The burrow's AI gateway switches from the latest heartbeat (AIG-16; null: none, or a server without them). Returns
   * whether what this runner claims for changed, so a waiting claim can end (SUB-53).
   */
  setGateway?(switches: GatewaySwitches | null): boolean;
  /** What was found at startup, for the log. */
  report(): string[];
  /**
   * Hermes here is the scripted stand-in (HE-46): it runs no CLI, so a turn needs no installed client and, when the
   * server sends none, no sign-in.
   */
  hermesScripted?(): boolean;
  /** What the host has, for the heartbeat (docs/decisions/agent-setup.md). */
  status?(): RunnerStatus;
  /**
   * Checks Hermes and the CLIs again: all of them with `force`, else those due — one that isn't ready
   * every `retryMs`, a ready one every `refreshMs`. Returns the lines that changed.
   */
  recheck?(options?: { force?: boolean }): Promise<string[]>;
  /** The models a CLI offers, as it listed them itself (ME-04); null while not known. */
  models?(kind: AgentProviderKind): ProviderModel[] | null;
  /** Resolves once no model list is being read (tests, the startup log). */
  modelsSettled?(): Promise<void>;
}

/** Which providers' turns go through the burrow's AI gateway (the heartbeat response's `gateway`, AIG-16). */
export type GatewaySwitches = AiGatewaySwitches;

/**
 * The heartbeat response's `gateway` (contracts 0.76.0, CT-332), or null when it has none (an older server) or none that
 * reads as one: both off then.
 */
export function gatewaySwitchesOf(
  response: { gateway?: unknown } | null | undefined,
): GatewaySwitches | null {
  const parsed = AiGatewaySwitches.safeParse(response?.gateway);
  return parsed.success ? parsed.data : null;
}

/**
 * How a CLI's readiness is checked instead of `cliAvailability` (passed as `fallback`): a managed runner's installed
 * clients (`RunnerClients.availability`, SUB-49).
 */
export type AvailabilityCheck = (
  kind: CliKind,
  fallback: () => Promise<Availability>,
) => Promise<Availability>;

interface CliEntry {
  check: ProviderCheck;
  checkedAt: number;
}

/** One CLI check (or `availability`'s) as a `ProviderCheck`. */
async function checkCli(
  kind: CliKind,
  check: () => Promise<Availability>,
  availability?: AvailabilityCheck,
): Promise<ProviderCheck> {
  try {
    const r = availability ? await availability(kind, check) : await check();
    if (r.ok) return { provider: kind, state: 'ready', version: r.version.slice(0, 120), detail: null };
    return { provider: kind, state: unavailableKind(r), version: null, detail: r.reason.slice(0, 500) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { provider: kind, state: 'error', version: null, detail: detail.slice(0, 500) };
  }
}

function describe(check: ProviderCheck): string {
  if (check.state === 'ready') return `${check.provider}: ${check.version}`;
  return `${check.provider}: unavailable (${check.detail ?? check.state})`;
}

function describeHermes(check: HermesCheck): string {
  if (check.ready) return `hermes: ${check.version}`;
  return `hermes: not ready (${check.problem}: ${check.detail ?? ''})`;
}

export interface RegistryOptions {
  log?: (msg: string) => void;
  /**
   * Hermes's options (`HermesProviderOptions` but the provider kind): its executable (`bin`, default
   * `WHOMBAT_HERMES_BIN`), the profiles' root (`root`, default `WHOMBAT_HERMES_ROOT`), how long its upkeep may run after
   * an answer (`settleMs`), the environment its turns are built from (`env`).
   */
  hermes?: Partial<Omit<HermesProviderOptions, 'kind'>>;
  /** How Hermes is checked instead of `checkHermes` (unit tests). */
  hermesCheck?: () => Promise<HermesCheck>;
  /** How a CLI is checked instead of `cliAvailability` (unit tests). */
  cliCheck?: (kind: CliKind) => Promise<Availability>;
  /**
   * Readiness of the CLIs from somewhere else than `cliAvailability`: the installed clients of `WHOMBAT_CLIENTS_FILE`,
   * the image's pins only without one (SUB-49).
   */
  availability?: AvailabilityCheck;
  /**
   * What the CLIs' readiness depends on besides themselves (the clients file's identity): when it differs from the last
   * check's, every CLI is checked again at the next `recheck` (SUB-49).
   */
  watch?: () => string | null;
  /**
   * The executable a turn of `kind` would run, for listing its models (ME-04): the installed client
   * (`clientCommandSync`). Null: none to list with; absent: `providerExecutable`.
   */
  modelsExecutable?: (kind: CliKind) => string | null | undefined;
  /**
   * How a provider's models are listed instead of `listCliModels` and Hermes's `models` step (unit tests; ChatGPT's is
   * asked with no executable).
   */
  listModels?: (kind: LiveProvider, executable: string | undefined) => Promise<ProviderModel[] | null>;
  /** Read a model list that failed again after this long (default 10 min). */
  modelsRetryMs?: number;
  /** Where the throwaway homes of model listing are made (default the system's temporary directory). */
  modelsTmpRoot?: string;
  /** Re-check what isn't ready after this long (default 30 s). */
  retryMs?: number;
  /** Re-check what is ready after this long, to notice a logout (default 10 min). */
  refreshMs?: number;
  now?: () => number;
}

export async function createRegistry(options: RegistryOptions = {}): Promise<ProviderRegistry> {
  const now = options.now ?? Date.now;
  const retryMs = options.retryMs ?? 30_000;
  const refreshMs = options.refreshMs ?? 600_000;
  const env = options.hermes?.env ?? process.env;
  const bin = options.hermes?.bin ?? hermesBin(env);
  const notes: string[] = [];
  const providers = new Map<AgentProviderKind, HermesProvider>(
    (['claude', 'codex', 'local'] as const).map((kind) => [
      kind,
      new HermesProvider({
        ...options.hermes,
        kind,
        // A ChatGPT turn naming no model tells Hermes the default of Hermes's own list (HE-67); the scripted Hermes
        // (HE-46) takes any name.
        defaultModel: () =>
          kind !== 'codex'
            ? null
            : (modelLists.get('codex')?.models?.find((m) => m.isDefault)?.id ??
              (scripted() ? 'codex' : null)),
      }),
    ]),
  );
  const clis = new Map<CliKind, CliEntry>();
  let hermes: HermesCheck = { ready: false, version: null, problem: 'broken', detail: 'Not checked yet.' };
  let hermesAt = 0;
  let checkedAt = new Date(now()).toISOString();
  let watched = options.watch?.() ?? null;

  /** Each provider's model list (ME-04): for which version, when it was read, and a read in progress. */
  const modelLists = new Map<
    LiveProvider,
    { key: string; models: ProviderModel[] | null; at: number; reading: Promise<void> | null }
  >();
  const modelsRetryMs = options.modelsRetryMs ?? 600_000;

  /** Lists a provider's models: Claude Code's from the CLI, ChatGPT's from Hermes's catalog (the plugin's step). */
  function listModels(kind: LiveProvider, executable: string | undefined): Promise<ProviderModel[] | null> {
    if (options.listModels) return options.listModels(kind, executable);
    if (kind === 'codex') {
      const steps = chatgptSteps(hermesPythonBeside(bin, env), env);
      return steps ? chatgptModels(steps, options.modelsTmpRoot ?? tmpdir()) : Promise.resolve(null);
    }
    return listCliModels(kind, {
      env,
      ...(executable ? { executable } : {}),
      ...(options.modelsTmpRoot ? { tmpRoot: options.modelsTmpRoot } : {}),
    });
  }

  /**
   * Reads a provider's models in the background when what lists them is ready and its list for this version isn't known
   * yet (or failed `modelsRetryMs` ago). One that isn't ready keeps its last list.
   */
  function refreshModels(kind: LiveProvider, check: ProviderCheck): void {
    if (check.state !== 'ready' && check.state !== 'logged_out') return;
    const key = check.version ?? 'installed';
    const current = modelLists.get(kind);
    if (current?.reading) return;
    if (current && current.key === key && (current.models || now() - current.at < modelsRetryMs)) return;
    const executable = kind === 'claude' ? options.modelsExecutable?.(kind) : undefined;
    if (executable === null) return;
    const next = {
      key,
      // Another version's list isn't this one's.
      models: current?.key === key ? current.models : null,
      at: now(),
      reading: null as Promise<void> | null,
    };
    modelLists.set(kind, next);
    next.reading = (async () => {
      const models = await listModels(kind, executable).catch(() => null);
      next.at = now();
      if (models) next.models = models;
      options.log?.(
        models
          ? `${kind}: ${models.length} models (default ${models.find((m) => m.isDefault)?.label ?? 'not said'})`
          : `${kind}: couldn’t list its models; trying again in ${Math.round(modelsRetryMs / 60_000)} min`,
      );
    })().finally(() => {
      next.reading = null;
    });
  }

  async function check(kind: CliKind, entry: CliEntry): Promise<string | null> {
    const own = () =>
      options.cliCheck ? options.cliCheck(kind) : cliAvailability(kind, { env, managed: true });
    const next = await checkCli(kind, own, options.availability);
    const before = entry.check;
    entry.check = next;
    entry.checkedAt = now();
    refreshModels(kind, next);
    const changed = before.state !== next.state || before.version !== next.version;
    return changed ? describe(next) : null;
  }

  /** ChatGPT's readiness (HN-04): Hermes's own, since Hermes is what runs it. */
  const chatgptCheck = (): ProviderCheck =>
    hermes.ready
      ? { provider: 'codex', state: 'ready', version: `Hermes ${hermes.version}`, detail: null }
      : {
          provider: 'codex',
          state: 'missing',
          version: null,
          detail: 'ChatGPT runs on Hermes, which isn’t ready on this Whombat.',
        };

  async function checkEngine(): Promise<string | null> {
    const next = await (
      options.hermesCheck ??
      (() =>
        checkHermes({
          bin,
          root: options.hermes?.root ?? hermesRoot(env),
          env,
        }))
    )().catch(
      (err: unknown): HermesCheck => ({
        ready: false,
        version: null,
        problem: 'broken',
        detail: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      }),
    );
    const before = hermes;
    hermes = next;
    hermesAt = now();
    refreshModels('codex', chatgptCheck());
    const changed = before.ready !== next.ready || before.version !== next.version;
    return changed ? describeHermes(next) : null;
  }

  await checkEngine();
  notes.push(describeHermes(hermes));
  for (const kind of CLIS) {
    const entry: CliEntry = {
      check: { provider: kind, state: 'error', version: null, detail: null },
      checkedAt: 0,
    };
    clis.set(kind, entry);
    await check(kind, entry);
    notes.push(describe(entry.check));
  }
  notes.push(describe(chatgptCheck()));
  for (const n of notes) options.log?.(n);

  /** Ready to run here, signed in or not (a turn signs in with the person's sign-in, or goes another way). */
  const installed = (kind: LiveProvider) => {
    if (kind === 'codex') return hermes.ready;
    const state = clis.get(kind)?.check.state;
    return state === 'ready' || state === 'logged_out';
  };
  /** The AI gateway's switches (AIG-16), from the heartbeats. */
  let gateway: GatewaySwitches = { claude: false, codex: false };
  const scripted = () => isScriptedHermes(hermes.version);
  const claims = (): AgentProviderKind[] => {
    if (!hermes.ready) return [];
    if (scripted()) return [...LIVE_PROVIDERS, 'local'];
    return [...LIVE_PROVIDERS.filter((k) => installed(k) || gateway[k]), 'local'];
  };
  return {
    claims,
    for(configured, route) {
      if (!hermes.ready) return null;
      const provider = providers.get(configured) ?? null;
      if (configured === 'local') return provider;
      // A turn through the AI gateway runs on Hermes's own loop and needs no CLI here (HE-S50); the scripted Hermes
      // runs none (HE-46).
      return installed(configured) || route?.gateway || scripted() ? provider : null;
    },
    setGateway(switches) {
      const before = claims().join(',');
      gateway = { claude: switches?.claude === true, codex: switches?.codex === true };
      return claims().join(',') !== before;
    },
    report: () => [...notes],
    hermesScripted: () => hermes.ready && scripted(),
    status() {
      const withModels = (kind: LiveProvider, c: ProviderCheck): ProviderCheck => {
        const models = modelLists.get(kind)?.models;
        return { ...c, ...(models ? { models } : {}) };
      };
      return {
        hermes,
        // With the models each lists (ME-04).
        providers: [
          ...[...clis.entries()].map(([kind, e]) => withModels(kind, e.check)),
          withModels('codex', chatgptCheck()),
        ],
        checkedAt,
      };
    },
    models(kind) {
      if (kind !== 'claude' && kind !== 'codex') return null;
      return modelLists.get(kind)?.models ?? null;
    },
    async modelsSettled() {
      await Promise.all([...modelLists.values()].map((m) => m.reading));
    },
    async recheck({ force = false } = {}) {
      const isDue = (ready: boolean, at: number) => force || now() - at >= (ready ? refreshMs : retryMs);
      // The clients file changed (an install, an update, a removal): every CLI now (SUB-49).
      const stamp = options.watch?.() ?? null;
      const changedInputs = stamp !== watched;
      watched = stamp;
      const due = [...clis.entries()].filter(
        ([, e]) => changedInputs || isDue(e.check.state === 'ready', e.checkedAt),
      );
      const engineDue = isDue(hermes.ready, hermesAt);
      if (due.length === 0 && !engineDue) return [];
      const changed = [
        ...(engineDue ? [await checkEngine()] : []),
        ...(await Promise.all(due.map(([kind, e]) => check(kind, e)))),
      ];
      checkedAt = new Date(now()).toISOString();
      const lines = changed.filter((l): l is string => l !== null);
      for (const l of lines) options.log?.(l);
      return lines;
    },
  };
}
