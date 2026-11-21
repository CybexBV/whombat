/**
 * A managed turn's task (managed-sandbox.md MSB-01): the sandbox the provider and every tool it starts run in, with what
 * the turn brings into it — the agent's commands (one-person.md OP-07: in the person's pod, or an outsiders' own
 * place, OP-17), its browser's CDP relay (hermes-engine.md HE-42), gh through Whombat (agent-gh.md AGH-02) and the AI
 * gateway's forwarder (AIG-08) — and the task's limits: its wall time, and a kill once it stops.
 */

import { join } from 'node:path';
import {
  type AgentProvider,
  type CredentialOwner,
  type EgressAllowance,
  type EgressPolicy,
  joinPolicies,
  type PodNeeds,
  SANDBOX_BROWSER_ORIGIN,
  type SandboxTask,
  SandboxUnavailable,
  type TurnGateway,
  type TurnInput,
} from '@whombat/agent-runtime';
import { runnerTmpRoot } from '@whombat/agent-runtime/host';
import { CLAUDE_KEY_FILE } from '@whombat/agent-runtime/providers';
import { COMMANDS_INIT_PATH } from '@whombat/commands';
import { Browser, turnBrowserPlan } from '../browser';
import { type CommandsContext, commandsContextOf, type TurnKeys } from '../commands/api';
import { turnBinds } from '../commands/binds';
import { browserHost } from '../commands/own';
import { CommandsPlace } from '../commands/place';
import { TurnCommands, type TurnCommandsTurn } from '../commands/turn';
import { GatewayForwarder, gatewayUnusableText } from '../gateway';
import { GhService, ghContextOf, ghSettingsFromEnv } from '../gh';
import { type TurnKeptSites, turnKeptSites } from '../kept-sites';
import { type LoginsRoute, loginAsker, TurnLogins } from '../logins';
import {
  GITHUB_ENDPOINTS,
  MANAGED_REFUSALS,
  type ManagedPolicy,
  SANDBOX_WALL_MINUTES,
  sandboxTask,
} from '../managed';
import type { PodCredential, PodShape } from '../pods';
import { toolAsker } from '../tool-asks';
import { type PreparedCwd, TurnRefusal } from '../workspace';
import type { FilesPlace } from './files';
import type { TurnScope } from './scope';
import type { TurnShape } from './shape';
import { stopManaged } from './stop';

/**
 * A turn runs at most `wallMs`; one whose runner can't renew its lease for a lease period stops (the server hands the
 * dispatch out again then — this runner must not keep writing; `TurnProgress`). On any stop, the provider gets a moment
 * to end its turn cleanly, then the whole task is killed (cgroup).
 */
export function guardTask(turn: Pick<TurnScope, 'deps' | 'stop' | 'verdict' | 'resources'>): {
  clear(): void;
} {
  const { deps, stop, verdict, resources } = turn;
  const wall = setTimeout(
    () => stopManaged(turn, 'wall_time'),
    deps.managed.wallMs ?? SANDBOX_WALL_MINUTES * 60_000,
  );
  wall.unref?.();
  stop.onStop(() => {
    const s = resources.sandbox;
    if (!s) return;
    setTimeout(() => void s.kill(), verdict.managedOutcome === 'lease_lost' ? 0 : 3_000).unref?.();
  });
  return { clear: () => clearTimeout(wall) };
}

export interface SandboxPlan {
  managed: ManagedPolicy;
  provider: AgentProvider;
  input: TurnInput;
  cwd: PreparedCwd;
  shape: TurnShape;
  /** Whose login the task mounts (`managedOwner`); null: none (a turn on `local` signs in to nothing). */
  owner: CredentialOwner | null;
  gateway: TurnGateway | null;
  /** A model on the person's network, and the Vault's MCP servers, the turn's egress opens to (HE-S52, HE-S154). */
  allowance?: EgressAllowance | null;
  /** The turn's keys, fetched already for its Vault MCP servers (HE-S154): its commands don't ask again. */
  keys?: TurnKeys | null;
  files: FilesPlace;
  step: (name: string) => void;
}

/**
 * The turn's part of its commands (OP-07): git's control files snapshotted, its production servers told to the wall,
 * what of the turn its commands see. A person's turn (`context`) gets its keys and the agent's home; an outsiders'
 * turn (OP-17) neither.
 */
async function turnCommands(
  turn: Pick<TurnScope, 'ctx' | 'deps' | 'id' | 'lease' | 'progress' | 'resources'>,
  plan: SandboxPlan,
  task: SandboxTask,
  context: CommandsContext | null,
  extra: Pick<TurnCommandsTurn, 'closed'> = {},
): Promise<TurnCommands> {
  const { ctx, deps, id, lease, progress, resources } = turn;
  const commands = deps.commands;
  if (!commands) throw new Error('no commands here');
  const person = context !== null;
  const home = commands.box.agentHome;
  return TurnCommands.open(
    {
      api: commands.api,
      guard: commands.box.guard,
      net: person ? commands.box.net : null,
      log: deps.log,
      ...(commands.approvalWaitMs !== undefined ? { approvalWaitMs: commands.approvalWaitMs } : {}),
      ...(commands.resolve4 ? { resolve4: commands.resolve4 } : {}),
      // A command not run because it kept failing the same way (health-command-loops.md HC-05): its row says so.
      onNotRun: () => progress.activity?.notRun(),
    },
    {
      dispatchId: id,
      lease: {
        runnerId: lease.runnerId ?? '',
        attempt: lease.attempt ?? Math.max(1, ctx.dispatch.attempts ?? 1),
      },
      context,
      binds: turnBinds({
        task,
        denied: [...(task.denied ?? []), ...(plan.managed.sandbox?.config.deniedPaths ?? [])],
        dispatchId: id,
        ...(plan.cwd.stepFolder ? { extra: [{ path: plan.cwd.stepFolder, readonly: false }] } : {}),
        // The conversation's Files, read-only at `~/files` (FS-09): a person's turns only.
        files:
          person && resources.conversationFiles && plan.files === 'home'
            ? { tree: resources.conversationFiles.dir, home }
            : null,
        covered: person ? [home] : [],
      }),
      cwd: plan.cwd.cwd,
      env: Object.fromEntries(
        Object.entries(plan.input.host?.env ?? {}).filter(
          (e): e is [string, string] => typeof e[1] === 'string',
        ),
      ),
      readOnlyInside: task.readOnlyInside ?? [],
      ...(plan.keys ? { keys: plan.keys } : {}),
      wantsKeys: person,
      ...extra,
    },
  );
}

/**
 * The enforced sandbox (MSB-01): the provider and every tool it starts. None configured, or the host can't build it:
 * refused, never run outside. What the task brings in is opened first, and kept by the turn as it opens.
 */
export async function openSandbox(
  turn: Pick<TurnScope, 'ctx' | 'deps' | 'id' | 'lease' | 'verdict' | 'progress' | 'resources' | 'stop'>,
  plan: SandboxPlan,
): Promise<void> {
  const { ctx, deps, id, lease, verdict, resources } = turn;
  const { managed, input, shape, step } = plan;
  const sandboxes = managed.sandbox;
  if (!sandboxes) {
    verdict.managedOutcome = 'sandbox_unavailable';
    throw new TurnRefusal(MANAGED_REFUSALS.sandbox, 'sandbox_unavailable');
  }
  const task = sandboxTask(id, plan.provider.kind, input, plan.owner, managed, plan.allowance ?? null);
  // A Hermes turn runs in its person's pod (hermes-native.md HN-W01): the provider says what the pod holds; the task
  // above is still what the turn's commands see and may reach.
  const pod = deps.pods && plan.provider.podNeeds ? await plan.provider.podNeeds(input) : null;
  const runnerLease = {
    runnerId: lease.runnerId ?? '',
    attempt: lease.attempt ?? Math.max(1, ctx.dispatch.attempts ?? 1),
  };
  // The agent's commands (OP-07): the person's in their pod; an outsiders' turn's in a place of its own (OP-17), never
  // in the person's pod.
  const context = shape.commandsTurn ? commandsContextOf(shape.ctx) : null;
  const outside = ctx.outside;
  if (deps.commands && (pod || outside)) {
    resources.commands = await turnCommands(turn, plan, task, outside ? null : context, {
      // Outsiders never run commands in the person's pod (OP-17): their own place only.
      ...(pod && (outside || !context)
        ? { closed: 'whombat: commands don’t run in this conversation, so this one didn’t run.' }
        : {}),
    });
    step('commands');
    // A key at Ask holds a Hermes tool back (HE-44, HE-S150): the turn's person is asked as a command asks.
    input.askPerson = toolAsker({
      api: deps.commands.api,
      dispatchId: id,
      lease: runnerLease,
      ...(deps.commands.approvalWaitMs !== undefined ? { approvalWaitMs: deps.commands.approvalWaitMs } : {}),
      log: deps.log,
    });
  }
  /** The pod's logins route for the turn (HN-W06), instead of a logins service of its own. */
  let podLogins: Pick<LoginsRoute, 'entries' | 'fetchSecret' | 'ask'> | null = null;
  /** The websites the agent may keep signed in (kept-sites.md): a person's own turn on their pod's browser only. */
  let podKept: TurnKeptSites | null = null;
  // The browser (HE-42, HE-S137…HE-S140): a Chromium where the commands run, through the CDP relay — the person's pod's
  // own, or an assessment's in its sandbox (its sites only). Without it the turn goes on without a browser.
  const browser = turnBrowserPlan(ctx, { chromium: Boolean(deps.commands?.chromium) });
  if (browser && browser !== 'unavailable') {
    input.browser = { cdpUrl: SANDBOX_BROWSER_ORIGIN, sites: browser.sites };
    // Never an outsiders' turn or an assessment: those have no pod browser, and keep nothing of anyone's.
    if (pod && !outside && browser.sites === null && ctx.dispatch.trigger !== 'feedback')
      podKept = turnKeptSites(deps.api, id, runnerLease);
    // The person's logins (HE-S141): Hermes's vault asks the turn's logins service for one at a fill. In a turn of the
    // person's the service is there without any login too: Hermes's save-login and code prompts ask the person through
    // it (vault-simplify.md VLT-45). An outsiders' turn gets neither.
    const logins = ctx.logins ?? [];
    const loginSecret = deps.api.loginSecret?.bind(deps.api);
    const { loginAsk, loginAskWait } = deps.api;
    const ask =
      !outside && loginAsk && loginAskWait
        ? loginAsker({
            api: { loginAsk: loginAsk.bind(deps.api), loginAskWait: loginAskWait.bind(deps.api) },
            dispatchId: id,
            lease: runnerLease,
            log: deps.log,
            ...(deps.loginAskPollMs !== undefined ? { pollMs: deps.loginAskPollMs } : {}),
          })
        : undefined;
    if ((logins.length || ask) && loginSecret) {
      const fetchSecret = (entryId: string) => loginSecret(id, entryId, runnerLease);
      try {
        if (pod) podLogins = { entries: new Set(logins.map((l) => l.entryId)), fetchSecret, ask };
        else {
          resources.logins = await TurnLogins.open(
            { tmpRoot: deps.host?.runnerTmp ?? runnerTmpRoot(), log: deps.log, fetchSecret, ask },
            id,
            logins.map((l) => l.entryId),
          );
          task.logins = { socket: resources.logins.socket };
        }
        input.browser.logins = logins;
      } catch (err) {
        deps.log('warn', `${ctx.agent.name} · no logins this turn: ${String(err)}`, { dispatchId: id });
      }
    }
  }
  // The AI gateway (AIG-08): the CLI reaches the server's relay through the turn's forwarder, bridged into the sandbox
  // at 127.0.0.1:47104; its provider's own endpoints aren't in the task's egress (`egressPolicy`).
  const { gateway } = plan;
  if (gateway && !pod) {
    try {
      resources.aiGateway = await GatewayForwarder.open(
        { serverUrl: deps.serverUrl, tmpRoot: deps.host?.runnerTmp ?? runnerTmpRoot(), log: deps.log },
        id,
      );
    } catch (err) {
      deps.log('error', `${ctx.agent.name} · no line to the AI gateway: ${String(err)}`, {
        dispatchId: id,
      });
      throw new TurnRefusal(gatewayUnusableText(gateway.name), 'gateway_unavailable');
    }
    task.gateway = { socket: resources.aiGateway.socket };
  }
  if (pod) {
    await admitToPod(turn, plan, task, pod, { logins: podLogins, keptSites: podKept });
    await podGh(turn, plan);
    return;
  }
  // What the provider itself brings (a person's Hermes profile, the CLI it starts; HE-S18).
  const needs = await plan.provider.sandboxNeeds?.(input);
  if (needs) {
    if (needs.stateDirs?.length) task.stateDirs = [...(task.stateDirs ?? []), ...needs.stateDirs];
    if (needs.installs?.length) task.installs = [...(task.installs ?? []), ...needs.installs];
    if (needs.readable?.length) task.readable = [...(task.readable ?? []), ...needs.readable];
    if (needs.env) task.env = { ...(task.env ?? {}), ...needs.env };
    if (needs.path?.length) task.path = [...(task.path ?? []), ...needs.path];
    if (needs.denied?.length) task.denied = [...(task.denied ?? []), ...needs.denied];
  }
  // An outsiders' turn's commands (OP-17): a place of its own, its checkout read-only, no home of the person's.
  const commands = resources.commands;
  if (commands && deps.commands) {
    const place = await CommandsPlace.open(deps.commands.box, {
      kind: 'outside',
      base: join(deps.host?.runnerTmp ?? runnerTmpRoot(), 'tasks', id.replace(/[^A-Za-z0-9_-]/g, '_')),
      node: sandboxes.node,
      skills: needs?.stateDirs?.[0] ? join(needs.stateDirs[0], 'skills') : null,
      roots: [],
      binds: commands.turn.binds,
    });
    resources.place = place;
    place.admit(commands);
    task.commands = place.sandbox;
    task.stateDirs = [...(task.stateDirs ?? []), ...place.stateDirs];
    task.readable = [...(task.readable ?? []), ...place.readable];
    task.env = { ...(task.env ?? {}), ...place.env };
    // An assessment's browser opens the reported website alone (FB-28): its wall is the task's egress, those sites added.
    if (input.browser?.sites)
      task.egress = joinPolicies([
        task.egress,
        { allow: input.browser.sites.flatMap((site) => [site, `*.${site}`]) },
      ]);
    if (input.browser && deps.commands.chromium) {
      resources.browser = await Browser.open(
        {
          host: browserHost(place, join(place.dir, 'own.sock')),
          socket: place.browserSocket,
          log: deps.log,
        },
        { name: id, sites: input.browser.sites },
      );
      task.browser = { socket: resources.browser.socket };
      step('browser');
    }
  }
  try {
    resources.sandbox = await sandboxes.open(task);
  } catch (err) {
    if (!(err instanceof SandboxUnavailable)) throw err;
    deps.log('error', `${ctx.agent.name} · ${err.message}`, { dispatchId: id });
    verdict.managedOutcome = 'sandbox_unavailable';
    throw new TurnRefusal(MANAGED_REFUSALS.sandbox, 'sandbox_unavailable');
  }
  step('sandbox');
  const session = resources.sandbox;
  const place = resources.place;
  if (place) {
    // Hermes starts under `commands-init`, which starts the turn's holder first (OP-17) and serves its own browser.
    const config = {
      ...place.hostConfig({
        bwrap: sandboxes.config.bwrap,
        nsenter: sandboxes.config.nsenter ?? 'nsenter',
        cgroup: session.commandsCgroup(),
      }),
      own: resources.browser ? join(place.dir, 'own.sock') : null,
    };
    input.host = {
      ...input.host,
      spawn: (c, a, o) =>
        session.spawn(sandboxes.node, [COMMANDS_INIT_PATH, JSON.stringify(config), c, ...a], o),
    };
  } else input.host = { ...input.host, spawn: (c, a, o) => session.spawn(c, a, o) };
  if (session.mcpUrl) input.mcp = { ...input.mcp, url: session.mcpUrl };
}

/**
 * gh through Whombat in a person's pod (AGH-02): the turn's service in its folder of the pod's commands, which every
 * command of the turn sees at `/run/whombat/gh.sock`; the same service fetches from GitHub for the agent's git
 * (resourceful-agents.md RA-DS72).
 */
async function podGh(
  turn: Pick<TurnScope, 'ctx' | 'deps' | 'id' | 'lease' | 'resources'>,
  plan: SandboxPlan,
): Promise<void> {
  const { ctx, deps, id, lease, resources } = turn;
  const place = resources.pod?.commands;
  const commands = resources.commands;
  if (!plan.shape.ghTurn || !deps.api.ghAuthorize || !place || !commands) return;
  const ghAuthorize = deps.api.ghAuthorize.bind(deps.api);
  const gitCredentials = deps.api.gitCredentials.bind(deps.api);
  try {
    const gh = await GhService.open(
      {
        api: { ghAuthorize, gitCredentials },
        log: deps.log,
        tmpRoot: deps.host?.runnerTmp ?? runnerTmpRoot(),
        ...ghSettingsFromEnv(deps.host?.env ?? process.env),
        ...deps.gh,
      },
      { dispatchId: id, lease, repos: ghContextOf(plan.shape.ctx)?.repos ?? [] },
      await place.turnDir(id),
    );
    resources.gh = gh;
    commands.useGh(gh.socket);
  } catch (err) {
    // The turn goes on without it: the stand-in then says gh can't reach Whombat (AGH-DR08).
    deps.log('warn', `${ctx.agent.name} · no gh this turn: ${String(err)}`, { dispatchId: id });
  }
  plan.step('gh');
}

/**
 * The sign-in a turn needs of its person's pod (HN-W03): an organisation key's file; Claude's config home and its
 * variables; none for ChatGPT (its login is in the profile) or the AI gateway (its token comes through the forwarder).
 */
export function podCredential(
  plan: Pick<SandboxPlan, 'owner' | 'gateway'>,
  task: Pick<SandboxTask, 'credentialHome'>,
  needs: Pick<PodNeeds, 'credentialEnv'>,
): PodCredential | null {
  if (plan.gateway) return null;
  if (plan.owner?.authMode === 'api_key')
    return { home: null, files: [join(plan.owner.home, CLAUDE_KEY_FILE)], env: {} };
  if (!Object.keys(needs.credentialEnv).length) return null;
  return { home: task.credentialHome ?? null, files: [], env: { ...needs.credentialEnv } };
}

/** What a turn may reach from its person's pod (HN-W15): its task's egress, without GitHub (that is the commands'). */
export function podTurnEgress(task: SandboxTask): EgressPolicy {
  const allow = task.egress.allow;
  return {
    ...task.egress,
    allow: allow === 'public' ? 'public' : allow.filter((h) => !GITHUB_ENDPOINTS.includes(h)),
  };
}

/**
 * The threads a turn belongs to (HN-W10: one turn per thread in a pod): the Hermes session it resumes, and its thread —
 * the thread it was asked in, else the one its message starts.
 */
export function podThreads(ctx: TurnScope['ctx']): string[] {
  return [
    ...(ctx.dispatch.providerSessionId ? [`session:${ctx.dispatch.providerSessionId}`] : []),
    `thread:${ctx.conversation.id}/${ctx.dispatch.threadRootId ?? ctx.dispatch.messageId ?? '-'}`,
  ];
}

/**
 * The turn in its person's pod (hermes-native.md HN-W01…HN-W10): a slot under the person's cap, the turn's commands,
 * logins and gateway token routed to its Hermes session once the provider names it (`TurnPod.bind`), and
 * Hermes's viewer from the pod (`TurnPod.spawnAcp`). The pod holds nothing of the turn (HN-W03).
 */
async function admitToPod(
  turn: Pick<TurnScope, 'ctx' | 'deps' | 'id' | 'resources' | 'stop'>,
  plan: SandboxPlan,
  task: SandboxTask,
  needs: PodNeeds,
  extra: {
    logins: Pick<LoginsRoute, 'entries' | 'fetchSecret' | 'ask'> | null;
    keptSites: TurnKeptSites | null;
  },
): Promise<void> {
  const { ctx, deps, id, resources, stop } = turn;
  const { managed, input, step } = plan;
  const pods = deps.pods;
  if (!pods) throw new Error('no pods here');
  const shape: PodShape = {
    profile: needs.profile,
    bin: needs.bin,
    installs: needs.installs,
    readable: needs.readable,
    path: needs.path,
    env: needs.env,
    credential: podCredential(plan, task, needs),
    denied: [...(managed.sandbox?.config.deniedPaths ?? []), ...(needs.denied ?? [])],
    mcpUrl: input.mcp.url,
    egress: {
      allow: [...(managed.egressAllow ?? [])],
      ...(managed.grants?.length ? { grants: managed.grants } : {}),
    },
  };
  const waited = Date.now();
  const podTurn = await pods.admit(
    shape,
    {
      dispatchId: id,
      commands: resources.commands,
      logins: extra.logins,
      keptSites: extra.keptSites,
      // The agent token for the pod's AI-gateway forwarder (HN-W08); Hermes holds a placeholder.
      gatewayToken: plan.gateway ? input.mcp.token : null,
      egress: podTurnEgress(task),
    },
    stop.signal,
    { threads: podThreads(ctx) },
  );
  resources.pod = podTurn;
  if (Date.now() - waited > 1000)
    deps.log('info', `${ctx.agent.name} · waited ${Date.now() - waited} ms for its pod`, { dispatchId: id });
  step('pod');
  input.pod = {
    mcpUrl: podTurn.mcpUrl,
    spawnAcp: (cwd) => podTurn.spawnAcp(cwd),
    bind: (session) => podTurn.bind(session),
  };
  input.host = { ...input.host, spawn: (_c, _a, o) => podTurn.spawnAcp(o.cwd ?? input.cwd) };
  if (podTurn.mcpUrl) input.mcp = { ...input.mcp, url: podTurn.mcpUrl };
}
