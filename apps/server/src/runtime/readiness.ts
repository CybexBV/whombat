/**
 * Whether a person's turn with the agent could run on a provider now (chat-runtime.md CR-04): what Chat's popover greys
 * and `chats.setThreadRuntime` refuses. Ready means: the licence hasn't lapsed, a runner is connected, one of them has
 * the provider ready, and on a managed appliance the sign-in the turn runs on is there; for `local` (the model on the
 * person's network, hermes-engine.md HE-32), that the burrow has one.
 */

import type { AgentProvider } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { burrows } from '../db/schema/index';
import { switchedGateway } from '../gateway/store';
import { providerLogins } from '../managed/providers/service';
import type { PrincipalRow } from '../read/principals';
import type { Services } from '../services';

/** Why a turn couldn't run now. */
export type ReadyCode = 'no_runner' | 'provider_not_ready' | 'signin' | 'licence' | 'no_local_model';
export type Readiness = { ok: true } | { ok: false; code: ReadyCode };

const no = (code: ReadyCode): Readiness => ({ ok: false, code });

/**
 * Whether `person`'s turn with `agent` could run on `provider` now (docs/decisions/chat-runtime.md CR-04; chat-runtime-
 * server.md CR-S12): `agentReadiness`'s answer with the provider swapped, and on a managed appliance the sign-in that turn
 * would run on — the person's (one-person.md OP-S09) — unless the provider's turns go through the AI gateway. What Chat's popover greys and `chats.setThreadRuntime` refuses.
 */
export async function providerReadiness(
  services: Services,
  agent: PrincipalRow,
  provider: AgentProvider,
  person: Pick<PrincipalRow, 'accountId'> | null = null,
): Promise<Readiness> {
  return readinessOn(services, agent, provider, { personal: true, person });
}

async function readinessOn(
  services: Services,
  agent: PrincipalRow,
  provider: AgentProvider,
  options: { personal: boolean; person?: Pick<PrincipalRow, 'accountId'> | null },
): Promise<Readiness> {
  if (services.licence.lapsed) return no('licence');
  const runners = services.runtime.connectedRunners();
  if (runners.length === 0) return no('no_runner');
  if (!runners.some((r) => r.providers.includes(provider))) return no('provider_not_ready');
  // The model on the person's network (CT-1170): a runner that claims `local` runs it once the burrow has one.
  if (provider === 'local')
    return (await hasLocalModel(services, agent.burrowId)) ? { ok: true } : no('no_local_model');
  // The scripted Hermes of a server that allows it needs no sign-in (HE-46).
  if (runners.some((r) => r.providers.includes(provider) && services.runtime.scriptedRunner(r.runnerId)))
    return { ok: true };
  // The agent runs on the person's sign-in (one-person.md OP-S09): it must be there, checked where the person is named
  // (Chat's popover and `chats.setThreadRuntime`).
  if ((provider === 'claude' || provider === 'codex') && options.personal) {
    // Its tool goes through the AI gateway (ai-gateway.md AIG-07): no sign-in is needed.
    if (await switchedGateway(services.db, agent.burrowId, provider)) return { ok: true };
    const accountId = options.person?.accountId ?? null;
    if (!accountId || !(await providerLogins(services).record(provider))) return no('signin');
  }
  return { ok: true };
}

/** Whether the burrow has a model on its network (`burrows.local_model`). */
async function hasLocalModel(services: Services, burrowId: string): Promise<boolean> {
  const [row] = await services.db
    .select({ localModel: burrows.localModel })
    .from(burrows)
    .where(eq(burrows.id, burrowId));
  return !!row?.localModel;
}
