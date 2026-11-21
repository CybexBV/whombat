import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { controlSocketOf } from '@whombat/agent-net';
import { clearLentLogin, hermesBin } from '@whombat/agent-runtime';
import { privateDir, runnerTmpRoot, sdNotifier } from '@whombat/agent-runtime/host';
import { checkProviderDrift, clientCommandSync } from '@whombat/agent-runtime/providers';
import { createRunnerApi } from './api';
import { hasChromium } from './browser';
import { capacityAdmission, readCapacity } from './capacity';
import { clientResolverOptions, RunnerClients } from './clients';
import { commandGuard, createRunnerCommandsApi } from './commands/api';
import { AgentNet } from './commands/net';
import type { CommandsBox } from './commands/place';
import { loadDotEnv, loadRunnerConfig } from './config';
import { FILES_CACHE_DIR, FilesCache } from './files-cache';
import { HermesHomeService, HermesHomeWorker, syncSkills } from './hermes-home';
import { cachedDrift, type ManagedPolicy, managedUsageHost } from './managed';
import { startManaged } from './managed-setup';
import { moveToOnePerson } from './one-person-files';
import { PodManager } from './pods';
import { createRegistry } from './registry';
import { Runner } from './runner';
import { SignInWorker } from './signin';

loadDotEnv();
const config = loadRunnerConfig();
// The token lives in the API client from here on; nothing this process starts (git, provider CLIs) gets it.
delete process.env.RUNNER_TOKEN;
delete process.env.RUNNER_TOKEN_FILE;
const levels = ['error', 'warn', 'info', 'debug'] as const;
const log = (level: (typeof levels)[number], msg: string, extra?: Record<string, unknown>) => {
  if (levels.indexOf(level) > levels.indexOf(config.LOG_LEVEL)) return;
  const line = `[runner] ${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

/** Hermes's root (`WHOMBAT_HERMES_ROOT`, else `$WHOMBAT_HOME/hermes`). */
function hermesRootOf(): string {
  return process.env.WHOMBAT_HERMES_ROOT?.trim() || join(config.WHOMBAT_HOME, 'hermes');
}

// The installed AI client (SUB-09), Claude Code: the manager's bundle (`WHOMBAT_CLIENTS_FILE`); an operator's
// `WHOMBAT_CLAUDE_PATH` wins.
const clientOptions = clientResolverOptions(config, process.env);
const clients = new RunnerClients(clientOptions);
/** The execution policy once it's up (usage probes run in its sandbox, UI-R05); null before. */
let managedPolicy: ManagedPolicy | null = null;
/** The person's pod once it's up (a sign-in change lets their Hermes go once idle, HN-W11); null before. */
let podManager: PodManager | null = null;
// Hermes's root: the person's profile, where their ChatGPT login lives (hermes-native.md HN-03), and the outsiders'
// beside it (one-person.md OP-08, OP-17).
const hermesRootDir = hermesRootOf();
// A ChatGPT token the last runner lent to an outsiders' turn it didn't finish goes (one-person.md OP-S89).
await clearLentLogin(hermesRootDir).catch(() => {});
// Provider sign-ins run here, as this runner's user (managed-providers.md PV-12).
const signIns = new SignInWorker({
  serverUrl: config.WHOMBAT_SERVER_URL,
  token: config.RUNNER_TOKEN,
  ...(config.WHOMBAT_SIGNIN_SOCKET ? { socketPath: config.WHOMBAT_SIGNIN_SOCKET } : {}),
  root: config.WHOMBAT_CREDENTIALS_ROOT,
  hermes: { root: hermesRootDir, bin: hermesBin(process.env) },
  resolveClient: (provider) => clientCommandSync(provider, clientOptions),
  usageHost: managedUsageHost(() => managedPolicy),
  // A sign-in changed: the pod lets its Hermes go once idle (hermes-native.md HN-W11).
  onLoginChange: () => podManager?.retire(),
  log: (level, msg) => log(level, msg),
});

// Turns' temporary space must be this user's alone (BP-C38); say so at start rather than at the first turn. The model
// lists are read in throwaway homes there too (model-effort.md ME-04), when it is.
const privateTmp = new Set<string>();
for (const dir of [runnerTmpRoot()])
  await privateDir(dir)
    .then(() => privateTmp.add(dir))
    .catch((err: unknown) =>
      log(
        'warn',
        `scratch · ${err instanceof Error ? err.message : String(err)} — turns that need a scratch directory are refused until it is removed (or the runner gets another TMPDIR)`,
      ),
    );

// The generation, the task sandbox and the orphan sweep, before any claim (docs/decisions/managed-sandbox.md). A host
// that can't build the sandbox still starts, says so, and refuses every live turn (one mode, hermes-engine.md HE-48).
const managed = await startManaged({ ...config, RUNNER_ID: config.RUNNER_ID });
managedPolicy = managed.policy;
log('info', `sandbox · generation ${managed.generation.generation} (${managed.generation.runnerId})`);
if (managed.probe.ok) log('info', `sandbox · ${managed.probe.detail}`);
else
  log(
    'error',
    `sandbox · unavailable: ${managed.probe.detail} — every live turn is refused until it is fixed`,
  );
if (managed.orphans.length)
  log('warn', `sandbox · killed what earlier generations left: ${managed.orphans.join(', ')}`);
// The files kept per account before one person (one-person.md OP-S131…OP-S134): moved once, as the only runner (the
// generation's lock) with nothing of an earlier one left, before the sign-ins, the skills, the Hermes homes and the pod.
const runnerApi = createRunnerApi(config.WHOMBAT_SERVER_URL, config.RUNNER_TOKEN);
await moveToOnePerson({
  hermesRoot: hermesRootDir,
  credentialsRoot: config.WHOMBAT_CREDENTIALS_ROOT,
  workspaces: config.WHOMBAT_WORKSPACES,
  agentHome: config.WHOMBAT_AGENT_HOME,
  person: () => runnerApi.person(),
  log,
});
signIns.start();
// The agent's commands (one-person.md OP-07): Hermes runs them in its sandbox, each in a wrapper of its own, the
// network through the commands-network daemon's proxy (`whombat-agent-net`), so only with a working sandbox. The guard
// is the contracts' classifyCommand.
const agentNet = new AgentNet({ control: controlSocketOf(config.WHOMBAT_AGENT_NET_SOCKET), log });
const containers =
  config.WHOMBAT_CONTAINERS_SOCKET && existsSync(config.WHOMBAT_CONTAINERS_SOCKET)
    ? config.WHOMBAT_CONTAINERS_SOCKET
    : null;
const toolsBin = config.WHOMBAT_AGENT_TOOLS
  ? [join(config.WHOMBAT_AGENT_TOOLS, 'bin')]
  : (process.env.PATH ?? '').split(':');
const commandsApi = createRunnerCommandsApi(config.WHOMBAT_SERVER_URL, config.RUNNER_TOKEN);
const commandsBox: CommandsBox = {
  guard: commandGuard,
  notify: (body) => commandsApi.notify(body),
  net: agentNet,
  proxySocket: config.WHOMBAT_AGENT_NET_SOCKET,
  log,
  agentHome: config.WHOMBAT_AGENT_HOME,
  tools: config.WHOMBAT_AGENT_TOOLS ?? null,
  nixLd: {
    ld: config.WHOMBAT_AGENT_NIX_LD ?? null,
    libraryPath: config.WHOMBAT_AGENT_NIX_LD_LIBRARY_PATH ?? null,
  },
  hostPath: process.env.PATH ?? '/usr/bin:/bin',
  containers,
};
const commands = managed.probe.ok
  ? {
      box: commandsBox,
      api: commandsApi,
      approvalWaitMs: config.WHOMBAT_COMMANDS_APPROVAL_WAIT_MINUTES * 60_000,
      // The agent's browser (OP-S113): a Chromium of the image's tools, or the host's own.
      chromium: hasChromium([...toolsBin, '/usr/bin', '/bin', '/run/current-system/sw/bin']),
    }
  : null;
if (commands) agentNet.start();
log(
  commands ? 'info' : 'warn',
  commands
    ? `commands · home ${config.WHOMBAT_AGENT_HOME}, ${config.WHOMBAT_AGENT_TOOLS ? `tools ${config.WHOMBAT_AGENT_TOOLS}` : 'the host’s tools'}, ${containers ? `Docker at ${containers}` : 'no Docker'}, network through ${config.WHOMBAT_AGENT_NET_SOCKET}${commands.chromium ? '' : ', no Chromium'}`
    : 'commands · none: they need the task sandbox, which this host can’t build',
);

// Hermes, which runs every turn (hermes-engine.md HE-01): its profiles under WHOMBAT_HERMES_ROOT, checked with Claude Code
// (installed, its models: ME-04; ready when its installed client is, SUB-49) and ChatGPT's models from Hermes itself
// (HN-04); the MCP bridge runs on the sandbox's Node.
const registry = await createRegistry({
  hermes: {
    root: hermesRootDir,
    ...(managed.policy.sandbox ? { node: managed.policy.sandbox.node } : {}),
    log: (m) => log('info', m),
  },
  log: (m) => log('info', `provider ${m}`),
  // The models each CLI offers (ME-04), listed with the executable a turn would run: the installed client.
  modelsExecutable: (kind) => clientCommandSync(kind, clientOptions),
  ...(privateTmp.has(runnerTmpRoot()) ? { modelsTmpRoot: runnerTmpRoot() } : {}),
  ...clients.registryOptions(),
});
log('info', `hermes · ${hermesBin(process.env)} · profiles in ${hermesRootDir}`);
// One Hermes per person (hermes-native.md HN-09, HN-W01…HN-W16): a pod per Hermes profile, started by the person's
// first turn, with the task sandbox's walls. Turns of a provider that has pods run there.
const pods = managed.policy.sandbox
  ? new PodManager({
      sandboxes: managed.policy.sandbox,
      // The scripted Hermes (HE-46) has no gateway: its viewer is all there is.
      hermes: () => ({
        gateway: registry.hermesScripted?.() ? null : ['gateway', 'run', '--quiet'],
        acp: ['acp'],
      }),
      stateDir: join(runnerTmpRoot(), 'pods'),
      hermesRoot: hermesRootDir,
      // Where turn folders live: at their own paths in the pod and the commands' holder (OP-07).
      roots: () => [config.WHOMBAT_WORKSPACES],
      ...(commands ? { commands: commandsBox, chromium: commands.chromium } : {}),
      // The websites the agent keeps signed in between pods (kept-sites.md): restored into each fresh browser.
      keptSites: runnerApi,
      serverUrl: config.WHOMBAT_SERVER_URL,
      log,
      cap: config.WHOMBAT_POD_TURNS,
      idleMs: config.WHOMBAT_POD_IDLE_MINUTES * 60_000,
      maxAgeMs: config.WHOMBAT_POD_MAX_HOURS * 3_600_000,
      limits: { memoryBytes: config.WHOMBAT_POD_MEMORY_MB * 1024 * 1024 },
    })
  : null;
podManager = pods;
// The Hermes homes are the runner's (HE-38): the server reads and changes memory, sessions and skills, and backs a home
// up, only through this service, over the sign-in socket when there is one (MR-34).
const hermesHomeService = new HermesHomeService({
  root: hermesRootDir,
  // A step quiesces the person's pod first (HN-W11).
  ...(pods ? { pods } : {}),
  bin: hermesBin(process.env),
  // Hermes's skills steps run in the runner's own state, outside the Hermes root (hermes-skills.md HSK-S03).
  skillsState: join(config.WHOMBAT_RUNNER_STATE ?? join(config.WHOMBAT_HOME, 'runner'), 'hermes-skills'),
  log: (level, msg) => log(level, msg),
});
// The skills every profile reads (HSK-02): Hermes's built-ins synced into the shared directory before any turn.
await syncSkills(hermesHomeService.ctx)
  .then((r) =>
    log(
      'info',
      `skills · Hermes's built-ins: ${r.added.length} added, ${r.updated.length} updated, ${r.kept.length} kept as changed, ${r.removed.length} gone from Hermes`,
    ),
  )
  .catch((err: unknown) => log('warn', `skills · Hermes's skills couldn’t be synced: ${String(err)}`));
const hermesHome = new HermesHomeWorker(hermesHomeService, {
  serverUrl: config.WHOMBAT_SERVER_URL,
  token: config.RUNNER_TOKEN,
  ...(config.WHOMBAT_SIGNIN_SOCKET ? { socketPath: config.WHOMBAT_SIGNIN_SOCKET } : {}),
  log: (level, msg) => log(level, msg),
});
hermesHome.start();

const runner = new Runner({
  api: runnerApi,
  registry,
  serverUrl: config.WHOMBAT_SERVER_URL,
  workspacesRoot: config.WHOMBAT_WORKSPACES,
  host: {
    home: homedir(),
    whombatHome: config.WHOMBAT_HOME,
    env: process.env,
    // Denied to every turn, wherever it points (CON-3).
    credentialsRoot: config.WHOMBAT_CREDENTIALS_ROOT,
    agentHome: config.WHOMBAT_AGENT_HOME,
  },
  cleanup: { olderThanMs: config.WHOMBAT_WORKSPACE_IDLE_DAYS * 86_400_000 },
  managed: {
    ...managed.policy,
    // A turn runs only on the pinned provider runtime (managed-providers.md PV-01): the installed bundle's digest
    // (SUB-09, CT-73), else the image's pins.
    drift: clients.drift(cachedDrift((provider) => checkProviderDrift(provider, process.env))),
  },
  clients,
  ...(commands ? { commands } : {}),
  ...(pods ? { pods } : {}),
  // The conversations' Files of a person's turns (files-space.md FS-09), at `~/files` of their commands.
  filesCache: new FilesCache({
    root: join(config.WHOMBAT_WORKSPACES, FILES_CACHE_DIR),
    maxBytes: config.WHOMBAT_FILES_CACHE_BYTES,
  }),
  concurrency: config.RUNNER_CONCURRENCY,
  admit: async (active) => capacityAdmission(await readCapacity(), active),
  // The generation is part of the runner id, so the lease is a fencing token (MSB-10).
  runnerId: managed.generation.runnerId,
  ...(config.RUNNER_NAME ? { name: config.RUNNER_NAME } : {}),
  log,
});

log('info', `${runner.runnerId} → ${config.WHOMBAT_SERVER_URL} · up to ${config.RUNNER_CONCURRENCY} turns`);
runner.start();
// systemd (NX-20, MR-37): READY once claiming, watchdog pings while the event loop turns, STOPPING at shutdown.
const notify = sdNotifier(process.env, { log: (msg) => log('warn', msg) });
await notify?.ready('claiming');
const stopWatchdog = notify?.watchdog() ?? (() => {});

// Each stop step runs even when an earlier one fails: one rejection must not leave the pods' gateways or the
// generation's cgroups behind.
const stopStep = async (name: string, step: () => unknown): Promise<void> => {
  try {
    await step();
  } catch (err) {
    log('error', `stopping ${name} failed`, { error: err instanceof Error ? err.message : String(err) });
  }
};

// A second signal while stopping (SIGTERM, then Ctrl-C) is ignored: the first stop runs once, to its end.
let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  stopWatchdog();
  await stopStep('the systemd notifier', () => notify?.stopping());
  log('info', `${signal}: stopping ${runner.inFlight.length} turn(s)`);
  await stopStep('the runner', () => runner.stop());
  await stopStep('sign-ins', () => signIns.stop());
  await stopStep('the Hermes home', () => hermesHome.stop());
  // The pods' gateways end gracefully before the generation's cgroups go.
  await stopStep('the pods', () => pods?.close());
  await stopStep('the commands network', () => agentNet.close());
  await stopStep('the managed generation', () => managed.shutdown());
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
