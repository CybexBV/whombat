/**
 * Everything a turn needs before its provider runs, in order: the turn as this runner can run it, its input and
 * working directory, the session it runs in, its files, whose sign-in it runs on, its task sandbox, its model's
 * effort, and what watches it. Each setup step's time goes in the runner's journal (TE-12); what a step acquires is the
 * turn's at once (`TurnResources`), so a step that fails leaves nothing behind.
 */

import { homedir } from 'node:os';
import {
  type AgentProvider,
  type EgressAllowance,
  endpointAllowance,
  type TurnInput,
} from '@whombat/agent-runtime';
import type { TurnCredential } from '@whombat/agent-runtime/providers';
import type { GatewayDispatchContext } from '@whombat/core';
import { ActivityRecorder } from '../activity';
import type { TurnKeys } from '../commands/api';
import { isAssessment } from '../feedback';
import { followUpsFor } from '../steering';
import { TurnRefusal } from '../workspace';
import { denySignIns, managedOwner, signInFor } from './credentials';
import { filesCacheOf, type TurnDeps } from './deps';
import { placeFiles } from './files';
import { buildTurnInput, reviewChanges } from './input';
import { TurnModel } from './model';
import { openSandbox } from './sandbox';
import type { TurnScope } from './scope';
import { planSession } from './session';
import { shapeOf } from './shape';

/** A turn ready for its provider. */
export interface ReadyTurn {
  provider: AgentProvider;
  /** The turn as the provider takes it. */
  input: TurnInput;
  /** The CLI it runs, Claude Code or Codex; null for any other provider. */
  live: 'claude' | 'codex' | null;
  model: TurnModel;
  /** The burrow's AI gateway the turn goes through (AIG-07): its readings are the gateway's pool, nobody's (AIG-10). */
  viaGateway: GatewayDispatchContext | null;
  /** The sign-in the provider's outcomes are recorded on (SUB-22, PV-04). */
  credential: TurnCredential | null;
  /** Observed activity of this attempt (activity.ts, work-supervision WS-11…WS-15). */
  activity: ActivityRecorder;
  /** Logs a setup step with its time (TE-12). */
  step: (name: string) => void;
}

/** One line per setup step in the runner's journal, with how long it took (turn-efficiency.md TE-12). */
function setupSteps({ ctx, deps, id }: Pick<TurnScope, 'ctx' | 'deps' | 'id'>): (name: string) => void {
  let stepAt = Date.now();
  return (name) => {
    const now = Date.now();
    deps.log('info', `${ctx.agent.name} · setup · ${name} ${now - stepAt} ms`, {
      dispatchId: id,
      step: name,
      ms: now - stepAt,
    });
    stepAt = now;
  };
}

export async function prepareTurn(
  turn: TurnScope,
  start: {
    provider: AgentProvider;
    viaGateway: GatewayDispatchContext | null;
  },
): Promise<ReadyTurn> {
  const { ctx, deps, id, stop, progress, resources } = turn;
  const { provider, viaGateway } = start;
  const step = setupSteps(turn);
  const shape = shapeOf(ctx, deps);
  const built = await buildTurnInput(shape.ctx, deps, step);
  resources.prepared = built.cwd;
  step('prompt');
  planSession(turn, { turnCtx: shape.ctx, provider, built });
  const { input } = built;
  denySignIns(deps, input);
  const files = await placeFiles(turn, { built, shape, provider, step });
  // Reviewing another agent's branch from a read-only checkout: what it changes, as data (BP-C26).
  const changes = await reviewChanges(ctx, built.cwd);
  if (changes) input.prompt += `\n${changes}`;
  if (built.cwd.note) deps.log('info', built.cwd.note, { dispatchId: id });
  const signIn = await signInFor(turn, { provider, viaGateway, input, step });
  // A model on the person's network (HE-32, HE-S52): its address is the only thing of the network the turn's egress opens
  // — with the turn person's Vault MCP servers' (HE-S154).
  const model = provider.kind === 'local' ? await localModelEndpoint(turn, input) : null;
  const vault = shape.commandsTurn ? await vaultMcpServers(turn, input) : null;
  const allowance = joinAllowances(model, vault?.allowance ?? null);
  // A turn on `local` signs in to nothing: no credential home in its sandbox. Nor does one on the scripted Hermes the
  // server sent without a sign-in (HE-46: only a server with WHOMBAT_ALLOW_SCRIPTED does).
  const owned =
    provider.kind === 'local' || (deps.registry.hermesScripted?.() && !ctx.credential)
      ? { owner: null, credential: null }
      : await managedOwner(turn, { managed: deps.managed, provider, signIn, viaGateway, input, step });
  const credential: TurnCredential | null = owned.credential;
  await openSandbox(turn, {
    managed: deps.managed,
    provider,
    input,
    cwd: built.cwd,
    shape,
    owner: owned.owner,
    gateway: signIn.gateway,
    allowance,
    keys: vault?.keys ?? null,
    files,
    step,
  });
  loopModel(input, provider.kind, deps.registry);
  const turnModel = new TurnModel(turn, signIn.live, Boolean(signIn.gateway), input.model);
  if (signIn.live) turnModel.apply(input);
  // The commit an assessment's read-only export really came from: the server binds a handoff to it, not to what the
  // agent says (review-2 F9).
  if (isAssessment(ctx) && built.cwd.head) progress.workspaceCommit = built.cwd.head;
  const activity = new ActivityRecorder({
    attempt: turn.lease.attempt ?? Math.max(1, ctx.dispatch.attempts ?? 1),
    cwd: input.cwd,
    home: deps.host?.home ?? homedir(),
    // A Feedback assessment reports kind and state only (WS-14).
    bare: isAssessment(ctx),
  });
  // Same-person follow-ups into this turn, where the provider can take them (steering.md SX-03).
  const followUps = followUpsFor(ctx, provider.capabilities(), {
    deps: { ...deps, filesCache: filesCacheOf(deps) },
    signal: stop.signal,
  });
  resources.followUps = followUps;
  if (followUps) input.steering = followUps;
  progress.watch(activity, followUps);
  return { provider, input, live: signIn.live, model: turnModel, viaGateway, credential, activity, step };
}

/**
 * Where a turn on `local` reaches the model on the person's network (HE-S52): through a narrow egress allowance for its
 * address and port (`endpointAllowance`; a local name by the address it resolved to). Without a model there, or one at
 * an address a turn may not reach, the turn doesn't start.
 */
async function localModelEndpoint(
  turn: Pick<TurnScope, 'ctx' | 'deps' | 'id'>,
  input: TurnInput,
): Promise<EgressAllowance | null> {
  const { ctx, deps, id } = turn;
  const local = ctx.localModel;
  if (!local)
    throw new TurnRefusal(
      'I can’t reply yet: the custom AI model isn’t set up. Set it up in Settings → AI, then ask me again.',
      'local_model_missing',
    );
  const allowance = await endpointAllowance(local.baseUrl);
  if (!allowance) {
    deps.log('warn', `${ctx.agent.name} · the custom AI model can’t be reached at ${local.baseUrl}`, {
      dispatchId: id,
    });
    throw new TurnRefusal(
      'I can’t reach the custom AI model at the address it was set up with. You can check it under Settings → AI.',
      'local_model_unreachable',
    );
  }
  input.modelEndpoint = allowance.url;
  return allowance;
}

/**
 * The turn person's Vault MCP entries switched on for the agent (contracts CT-1241; hermes-engine.md HE-S154): the turn's
 * keys are fetched before Hermes starts (and handed to its commands, which don't ask again); each server is Hermes's
 * for this turn at the address a narrow egress allowance opens, like a model on the person's network. One the turn
 * can't reach is left out. Only in a person's turn whose context names such an entry: never an outsiders' turn (the
 * server gives those none).
 */
async function vaultMcpServers(
  turn: Pick<TurnScope, 'ctx' | 'deps' | 'id' | 'lease'>,
  input: TurnInput,
): Promise<{ keys: TurnKeys; allowance: EgressAllowance | null } | null> {
  const { ctx, deps, id, lease } = turn;
  const commands = deps.commands;
  if (!commands || !ctx.vault?.entries.some((e) => e.kind === 'mcp')) return null;
  let keys: TurnKeys;
  try {
    keys = await commands.api.turnKeys(id, {
      runnerId: lease.runnerId ?? '',
      attempt: lease.attempt ?? Math.max(1, ctx.dispatch.attempts ?? 1),
    });
  } catch (err) {
    deps.log('warn', `${ctx.agent.name} · no Vault MCP servers this turn: ${String(err)}`, {
      dispatchId: id,
    });
    return null;
  }
  const servers: NonNullable<TurnInput['vaultMcpServers']> = [];
  let allowance: EgressAllowance | null = null;
  for (const server of keys.mcpServers) {
    const opened = await endpointAllowance(server.url);
    if (!opened) {
      deps.log('warn', `${ctx.agent.name} · the Vault MCP server ${server.name} can’t be reached this turn`, {
        dispatchId: id,
      });
      continue;
    }
    servers.push({ ...server, url: opened.url });
    allowance = joinAllowances(allowance, opened);
  }
  if (servers.length) input.vaultMcpServers = servers;
  return { keys, allowance };
}

/** Two egress allowances as one (either may be null). */
function joinAllowances(a: EgressAllowance | null, b: EgressAllowance | null): EgressAllowance | null {
  if (!a || !b) return a ?? b;
  return { allow: [...a.allow, ...b.allow], grants: [...a.grants, ...b.grants], url: a.url };
}

/**
 * A turn on Hermes's own loop — the AI gateway, an organisation key — names the model's API id (HE-S48): the agent's,
 * else the CLI's own default from the runner's list. A CLI turn without a model runs on the CLI's own default.
 */
function loopModel(input: TurnInput, kind: AgentProvider['kind'], registry: TurnDeps['registry']): void {
  if (kind === 'local' || input.model) return;
  const fallback = loopDefault(input, kind, registry);
  if (fallback) input.model = fallback;
}

/**
 * The model a turn on Hermes's own loop names when it names none or falls back (HE-S48): the CLI's default from the
 * runner's list, or the burrow's configured Custom AI model default for `local`. Undefined for a turn that runs on the
 * CLI's own default (no model named); null when the list or Custom config doesn't say.
 */
export function loopDefault(
  input: Pick<TurnInput, 'gateway' | 'credential' | 'context'>,
  kind: AgentProvider['kind'],
  registry: TurnDeps['registry'],
): string | null | undefined {
  if (kind === 'local') return input.context.localModel?.defaultModel?.trim() || null;
  if (!input.gateway && input.credential?.authMode !== 'api_key') return undefined;
  const models = registry.models?.(kind) ?? null;
  return models?.find((m) => m.isDefault)?.id ?? models?.[0]?.id ?? null;
}
