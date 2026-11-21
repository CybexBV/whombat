/**
 * What a turn runs with (`TurnDeps`): the runner's API and providers, the host, the task sandbox and its policy; and the
 * defaults for callers that pass none (tests, embedded runners).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpTarget, WhombatMcp } from '@whombat/agent-runtime';
import { defaultWhombatHome } from '@whombat/agent-runtime/host';
import type { RunnerApi } from '../api';
import type { RunnerClients } from '../clients';
import type { RunnerCommandsApi } from '../commands/api';
import type { CommandsBox } from '../commands/place';
import { FILES_CACHE_DIR, FilesCache } from '../files-cache';
import type { ManagedPolicy } from '../managed';
import type { PodManager } from '../pods';
import type { ProviderRegistry } from '../registry';
import type { RunnerHost } from '../workspace';

export interface TurnDeps {
  api: RunnerApi;
  registry: ProviderRegistry;
  serverUrl: string;
  workspacesRoot: string;
  /** The host (default: `~` and `WHOMBAT_HOME` from the environment). */
  host?: RunnerHost;
  log: (level: 'info' | 'warn' | 'error' | 'debug', msg: string, extra?: Record<string, unknown>) => void;
  /** Progress heartbeat interval. */
  progressMs?: number;
  /** One long poll on a card Hermes asked the person with (`runner.loginAskWait`, 25 s; tests shorten it). */
  loginAskPollMs?: number;
  /** Time allowed to recover a missing answer on its existing session (default 45 seconds). */
  replyRecoveryMs?: number;
  connectMcp?: (target: McpTarget) => Promise<WhombatMcp>;
  /**
   * The execution policy (MA-10, `managed.ts`): every live turn runs in its task sandbox, on its credential owner's
   * sign-in. Without a sandbox in it no turn runs.
   */
  managed: ManagedPolicy;
  /** The installed AI clients (SUB-09, `clients.ts`): which executable a Claude or Codex turn runs. */
  clients?: RunnerClients;
  /**
   * The people's pods (hermes-native.md HN-09, HN-W01): a turn whose provider has pods (`AgentProvider.podNeeds`) runs in
   * its person's pod instead of a task sandbox of its own. Absent: every turn has its own.
   */
  pods?: PodManager;
  /**
   * The real gh and its time limit for turns whose gh goes through Whombat (default from the environment), and the git
   * that fetches for git's GitHub transport (resourceful-agents.md RA-DS72; tests: where it may fetch from).
   */
  gh?: { ghBin?: string; timeoutMs?: number; gitBin?: string; gitRemoteBase?: string };
  /**
   * The runner's cache of the conversations' Files (files-space.md FS-09; default `<workspaces>/.files-cache` with the
   * default bound, one per workspaces root).
   */
  filesCache?: FilesCache;
  /**
   * The agent's commands (one-person.md OP-07): Hermes runs them in its sandbox, each in a wrapper of its own — a
   * person's in their pod, an outsiders' turn's in its task sandbox. Absent: Hermes's terminal is off.
   */
  commands?: {
    box: CommandsBox;
    api: RunnerCommandsApi;
    /** How long a command waits for a person's yes (`WHOMBAT_COMMANDS_APPROVAL_WAIT_MINUTES`). */
    approvalWaitMs?: number;
    resolve4?: (host: string) => Promise<string[]>;
    /** Whether a Chromium is where the commands run (the image's tools, or the host's): the turn's browser. */
    chromium: boolean;
  };
}

/** One Files cache per workspaces root, for callers that pass none (tests, embedded runners). */
const defaultCaches = new Map<string, FilesCache>();
export function filesCacheOf(deps: Pick<TurnDeps, 'filesCache' | 'workspacesRoot'>): FilesCache {
  if (deps.filesCache) return deps.filesCache;
  let cache = defaultCaches.get(deps.workspacesRoot);
  if (!cache) {
    cache = new FilesCache({ root: join(deps.workspacesRoot, FILES_CACHE_DIR) });
    defaultCaches.set(deps.workspacesRoot, cache);
  }
  return cache;
}

/** The host from the environment, for callers that do not pass one (tests, embedded runners). */
export function hostFromEnv(env: NodeJS.ProcessEnv = process.env): RunnerHost {
  return { home: homedir(), whombatHome: defaultWhombatHome(env), env };
}
