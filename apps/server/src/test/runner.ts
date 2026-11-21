/**
 * Test helper: the real runner (`@whombat/runner`) in-process against a test server, every turn on Hermes as live turns
 * are — with the scripted Hermes as its binary (hermes-engine.md HE-33, HE-S106): the profile the runner writes, ACP,
 * Whombat's MCP through the stdio bridge, Hermes sessions. Plus `waitFor` for asserting on what the agent does
 * asynchronously.
 */
import { mkdtempSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptedHermesLauncher } from '@whombat/agent-runtime/testing/hermes';
import {
  createRegistry,
  createRunnerApi,
  HermesHomeService,
  HermesHomeWorker,
  PodManager,
  Runner,
  type TurnOutcome,
  testPolicy,
} from '@whombat/runner';

export interface TestRunner {
  runner: Runner;
  outcomes: { dispatchId: string; outcome: TurnOutcome }[];
  /** The runner's Hermes-home service (HE-38) on the same profile root, answering the server's steps. */
  hermesHome: HermesHomeService;
  /** The profile root (`WHOMBAT_HERMES_ROOT`). */
  hermesRoot: string;
  /** The Hermes pods (one-person.md OP-03), null when the runner was started without them. */
  pods: PodManager | null;
  stop(): Promise<void>;
}

/**
 * The server's environment for tests with run turns: FakeGitHub's repos as bare git repositories on disk, which the
 * runner checks a run's branch out of (`WHOMBAT_FAKE_GITHUB_GIT_ROOT`).
 */
export function checkoutEnv(): Record<string, string> {
  return { WHOMBAT_FAKE_GITHUB_GIT_ROOT: mkdtempSync(join(tmpdir(), 'whombat-fake-github-')) };
}

export async function startTestRunner(
  baseUrl: string,
  options: {
    thinkMs?: number;
    tickMs?: number;
    progressMs?: number;
    /** A person's turns at once in their pod (hermes-native.md HN-W10; default the runner's, 4); 0: no pods. */
    podTurns?: number;
  } = {},
): Promise<TestRunner> {
  const dir = await mkdtemp(join(tmpdir(), 'whombat-test-runner-'));
  const hermes = {
    // A throwaway WHOMBAT_HOME.
    env: { ...process.env, WHOMBAT_HOME: join(dir, 'whombat-home') },
    bin: await scriptedHermesLauncher(dir, { thinkMs: options.thinkMs ?? 30, tickMs: options.tickMs ?? 20 }),
    root: join(dir, 'hermes-root'),
    // Nothing runs after the scripted Hermes's answer: no review to wait for.
    settleMs: 0,
  };
  // Hermes is checked for real (the scripted one answers `--version` as the pin); the CLIs it would start are taken as
  // installed, and list no models: a turn without a model runs on the CLI's own default.
  const registry = await createRegistry({
    hermes,
    cliCheck: async () => ({ ok: true, version: 'test' }),
    listModels: async () => null,
  });
  const outcomes: TestRunner['outcomes'] = [];
  const managed = testPolicy();
  // Hermes's pods, as a runner runs them (one-person.md OP-03): in the stand-in sandbox, the scripted Hermes's
  // viewer in each (it has no gateway).
  const pods =
    options.podTurns === 0 || !managed.sandbox
      ? null
      : new PodManager({
          sandboxes: managed.sandbox,
          hermes: () => ({ gateway: null, acp: ['acp'] }),
          stateDir: join(dir, 'pods'),
          hermesRoot: hermes.root,
          roots: () => [join(dir, 'workspaces')],
          serverUrl: baseUrl,
          log: () => {},
          cap: options.podTurns ?? 4,
          lingerMs: 0,
          reviewWaitMs: 0,
        });
  const runner = new Runner({
    api: createRunnerApi(baseUrl, 'dev-runner-token'),
    registry,
    serverUrl: baseUrl,
    workspacesRoot: join(dir, 'workspaces'),
    host: { home: tmpdir(), whombatHome: join(dir, 'whombat-home') },
    // Every turn runs in a task sandbox (one mode, HE-48): here the runner's stand-in, which walls nothing and needs
    // no bubblewrap or cgroups; the scripted Hermes runs in it as on the host.
    managed,
    ...(pods ? { pods } : {}),
    concurrency: 4,
    waitMs: 300,
    heartbeatMs: 200,
    progressMs: options.progressMs ?? 40,
    onTurn: (dispatchId, outcome) => outcomes.push({ dispatchId, outcome }),
  });
  runner.start();
  const hermesHome = new HermesHomeService({
    root: hermes.root,
    bin: hermes.bin,
    env: hermes.env,
    ...(pods ? { pods } : {}),
  });
  const homeWorker = new HermesHomeWorker(hermesHome, { serverUrl: baseUrl, token: 'dev-runner-token' });
  homeWorker.start();
  return {
    runner,
    outcomes,
    hermesHome,
    hermesRoot: hermes.root,
    pods,
    stop: async () => {
      await runner.stop(2000);
      await homeWorker.stop();
      await pods?.close();
    },
  };
}

/** Polls until `check` returns a truthy value (or throws the last error after `timeoutMs`). */
export async function waitFor<T>(
  check: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  timeoutMs = 10_000,
  what = 'condition',
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
