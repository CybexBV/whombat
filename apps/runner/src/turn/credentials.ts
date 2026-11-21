/**
 * Which sign-in a turn runs on, and that no tool in its shell reads one: the installed client (SUB-09), the burrow's AI
 * gateway — nobody's sign-in (AIG-10) — or the person's own login or API key (MA-10, PV-04; one-person.md OP-09).
 * Never the operator's, or a paid fallback.
 */

import type { AgentProvider, CredentialOwner, TurnGateway, TurnInput } from '@whombat/agent-runtime';
import { prepareGatewayHome, type TurnCredential } from '@whombat/agent-runtime/providers';
import type { GatewayDispatchContext } from '@whombat/core';
import { gatewayBaseUrl, gatewayUnusableText } from '../gateway';
import { gatewayOwner, type ManagedPolicy, managedTurnCredential } from '../managed';
import { TurnRefusal } from '../workspace';
import { hostFromEnv, type TurnDeps } from './deps';
import type { TurnScope } from './scope';

type Live = 'claude' | 'codex';

/**
 * People's sign-ins are never a turn's to read, wherever the root is (CON-3; `confinementFor` has the host's root, this
 * the one the runner was given).
 */
export function denySignIns(deps: Pick<TurnDeps, 'managed'>, input: TurnInput): void {
  const signInRoot = deps.managed.credentialsRoot;
  const confinement = input.host?.confinement;
  if (signInRoot && confinement && !confinement.denyRead.includes(signInRoot))
    confinement.denyRead.push(signInRoot);
}

export interface TurnSignIn {
  /** The subscription provider of the turn, Claude or ChatGPT (`codex`); null for any other (it signs in to nothing here). */
  live: Live | null;
  /** Through the burrow's AI gateway (AIG-10): its home and base URL, set on the input. */
  gateway: TurnGateway | null;
}

/** The client and the sign-in a turn runs with, set on its input; a turn that can't have them is refused. */
export async function signInFor(
  turn: Pick<TurnScope, 'ctx' | 'deps' | 'id'>,
  plan: {
    provider: AgentProvider;
    viaGateway: GatewayDispatchContext | null;
    input: TurnInput;
    step: (name: string) => void;
  },
): Promise<TurnSignIn> {
  const { deps } = turn;
  const { provider, viaGateway } = plan;
  const live = provider.kind === 'claude' || provider.kind === 'codex' ? provider.kind : null;
  // The installed client this turn runs (SUB-09): Claude Code, DirectSDK's model client; one that should be installed
  // and isn't refuses the turn. ChatGPT runs on Hermes alone (HN-04); the scripted Hermes runs no CLI (HE-46).
  if (live === 'claude' && deps.clients && !deps.registry.hermesScripted?.()) {
    const client = await deps.clients.prepare(live);
    if (!client.ok) throw new TurnRefusal(client.message, client.code);
    plan.step('client');
  }
  const gateway = live && viaGateway ? await gatewayFor(turn, live, viaGateway, plan) : null;
  return { live, gateway };
}

/**
 * Through the burrow's AI gateway (AIG-10): nobody's sign-in — no credential is resolved, and the CLI runs with the
 * gateway's home and the gateway's base URL (the sandbox's bridge), the agent token its key.
 */
async function gatewayFor(
  turn: Pick<TurnScope, 'ctx' | 'deps' | 'id'>,
  live: Live,
  viaGateway: GatewayDispatchContext,
  plan: { input: TurnInput; step: (name: string) => void },
): Promise<TurnGateway> {
  const { ctx, deps, id } = turn;
  const { input } = plan;
  const host = deps.host ?? hostFromEnv();
  const base = deps.managed.credentialsRoot ?? host.whombatHome;
  let home: string;
  try {
    home = await prepareGatewayHome(base, viaGateway.connectionId, live);
  } catch (err) {
    deps.log('error', `${ctx.agent.name} · the AI gateway’s home can’t be used: ${String(err)}`, {
      dispatchId: id,
    });
    throw new TurnRefusal(gatewayUnusableText(viaGateway.name), 'gateway_unavailable');
  }
  const gateway: TurnGateway = {
    name: viaGateway.name,
    home,
    baseUrl: gatewayBaseUrl(live),
  };
  input.gateway = gateway;
  // The gateway's home is the CLI's own: no tool in its shell may read it (as a sign-in's home).
  const confinement = input.host?.confinement;
  if (confinement)
    input.host = {
      ...input.host,
      confinement: { ...confinement, denyRead: [...confinement.denyRead, home] },
    };
  plan.step('gateway');
  deps.log('info', `${ctx.agent.name} · through the AI gateway ${viaGateway.name} · ${live}`, {
    dispatchId: id,
  });
  return gateway;
}

/**
 * A turn's login, which the task mounts as its provider's home: the gateway's (AIG-10), else the person's own (MA-10),
 * never the host user's — missing is refused, with no fallback. `credential`: the sign-in the provider's outcomes are
 * recorded on.
 */
export async function managedOwner(
  turn: Pick<TurnScope, 'ctx' | 'deps' | 'id' | 'verdict'>,
  plan: {
    managed: ManagedPolicy;
    provider: AgentProvider;
    signIn: TurnSignIn;
    viaGateway: GatewayDispatchContext | null;
    input: TurnInput;
    step: (name: string) => void;
  },
): Promise<{ owner: CredentialOwner; credential: TurnCredential | null }> {
  const { ctx, deps, id, verdict } = turn;
  const { signIn, viaGateway, input } = plan;
  // The gateway's home; its confinement was set with it (`gatewayFor`).
  if (signIn.gateway && signIn.live && viaGateway)
    return {
      owner: gatewayOwner(viaGateway.connectionId, signIn.live, signIn.gateway.home),
      credential: null,
    };
  const credentials = await managedTurnCredential(plan.managed, ctx, plan.provider.kind);
  if (!credentials.ok) {
    if (credentials.outcome) verdict.managedOutcome = credentials.outcome;
    // The resolver's own code (`provider.not_signed_in`, `managed.provider_gated`, …), not the outcome's.
    throw new TurnRefusal(credentials.refusal, credentials.code);
  }
  input.credential = credentials.credential;
  plan.step('credential');
  const owner = credentials.owner;
  deps.log('info', `${ctx.agent.name} · sign-in ${owner.provider} · ${owner.authMode}`, { dispatchId: id });
  // The home is the provider's login, and no tool in its shell may read it (the provider's own sandbox).
  const confinement = input.host?.confinement;
  input.host = {
    ...input.host,
    credentialHome: owner.home,
    ...(confinement
      ? { confinement: { ...confinement, denyRead: [...confinement.denyRead, owner.home] } }
      : {}),
  };
  return { owner, credential: credentials.credential };
}
