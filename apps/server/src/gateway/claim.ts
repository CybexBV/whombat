/**
 * A turn's route at claim (docs/decisions/ai-gateway.md AIG-07, AIG-12, AIG-22): while the burrow's switch for the
 * agent's provider is on, the turn goes through the gateway — `DispatchContext.gateway`, no credential source, recorded
 * on the dispatch (`gateway_provider`) so the turn keeps its route whatever the switch does meanwhile.
 *
 * When the gateway is gone or doesn't answer, the turn runs on the person's own Claude or ChatGPT subscription instead:
 * the same tool's first, then the other's. Only when neither can take it, or when the pool is used up, is it refused
 * with the agent's line (`gatewayRefusalText`).
 */
import {
  type ChatRuntime,
  type GatewayDispatchContext,
  type GatewayProvider,
  type GatewayRefusalCode,
  gatewayRefusalText,
} from '@whombat/core';
import { and, desc, eq, isNotNull, ne } from 'drizzle-orm';
import type { Db } from '../db/client';
import { burrows, dispatches, principals } from '../db/schema/index';
import { providerLogins } from '../managed/providers/service';
import { loadPrincipalRow } from '../read/principals';
import type { DispatchRow } from '../runtime/context';
import { turnProvider, turnProviderSql } from '../runtime/turn-runtime';
import type { Services } from '../services';
import { fallbackProvider, fallsBack, gatewayRefusal, type OwnSignIn } from './logic';
import { gatewayKeyOf, gatewayName, gatewayUsageOf, isGatewayCatalogId, switchedGateway } from './store';

export type GatewayRoute =
  /** The agent's own sign-in (no switch on for its provider). */
  | { kind: 'own' }
  | { kind: 'gateway'; context: GatewayDispatchContext }
  /**
   * The switch is on but the gateway can't take the turn (`code`): it runs on the person's own sign-in of `provider`,
   * which is `from` (the turn's own tool) or the other one.
   */
  | {
      kind: 'fallback';
      provider: GatewayProvider;
      from: GatewayProvider;
      code: GatewayRefusalCode;
      name: string;
    }
  | { kind: 'refused'; code: GatewayRefusalCode; text: string };

/** What a gateway is called when its connection is gone (its name went with it). */
const GONE_NAME = 'The AI gateway';

/**
 * The person's own Claude and ChatGPT sign-ins as the runner keeps them (none when they can't be read now): what a turn
 * the gateway can't take may fall back on.
 */
export async function ownSignIns(services: Services): Promise<Partial<Record<GatewayProvider, OwnSignIn>>> {
  const logins = providerLogins(services);
  if (!logins.readable) return {};
  const records = await logins.personSignIns().catch((err: unknown) => {
    services.log.warn({ err: String(err) }, 'ai gateway: couldn’t read the person’s own sign-ins');
    return [];
  });
  const out: Partial<Record<GatewayProvider, OwnSignIn>> = {};
  for (const r of records)
    if (r.provider === 'claude' || r.provider === 'codex')
      out[r.provider] = {
        authMode: r.meta.authMode,
        signal: r.meta.signal ? { state: r.meta.signal.state, until: r.meta.signal.until } : null,
      };
  return out;
}

/**
 * The route of a dispatch whose agent is about to start (AIG-07, AIG-12, AIG-22), by the provider the turn runs on (its
 * Chat thread's choice, else its agent's; chat-runtime-server.md CR-S03). `claimable`: the providers the claiming runner
 * runs, which a fallback must be one of. Reads only.
 */
export async function gatewayRoute(
  services: Services,
  db: Db,
  dispatch: { burrowId: string; agentId: string; runtime?: ChatRuntime | null },
  claimable: readonly string[],
): Promise<GatewayRoute> {
  const agent = await loadPrincipalRow(db, dispatch.agentId);
  const provider = turnProvider(agent?.runtime, { runtime: dispatch.runtime ?? null });
  const switched = await switchedGateway(db, dispatch.burrowId, provider);
  if (!switched) return { kind: 'own' };
  const connection =
    switched.connection && isGatewayCatalogId(switched.connection.catalogId) ? switched.connection : null;
  const usage = connection ? await gatewayUsageOf(db, connection.id) : null;
  const now = services.clock();
  const refusal = gatewayRefusal({
    usable: connection ? gatewayKeyOf(services, connection).usable : false,
    kind: connection && isGatewayCatalogId(connection.catalogId) ? connection.catalogId : null,
    usage,
    provider: switched.provider,
    now,
  });
  const name = connection ? gatewayName(connection) : GONE_NAME;
  if (refusal || !connection || !isGatewayCatalogId(connection.catalogId)) {
    const code = refusal?.code ?? 'gateway.missing';
    if (fallsBack(code)) {
      const own = fallbackProvider({
        provider: switched.provider,
        signIns: await ownSignIns(services),
        claimable,
        now,
      });
      if (own) return { kind: 'fallback', provider: own, from: switched.provider, code, name };
    }
    const [burrow] = await db
      .select({ timeZone: burrows.timeZone })
      .from(burrows)
      .where(eq(burrows.id, dispatch.burrowId));
    return {
      kind: 'refused',
      code,
      text: gatewayRefusalText({
        code,
        name,
        provider: switched.provider,
        until: refusal?.until ?? null,
        now,
        timeZone: burrow?.timeZone ?? 'UTC',
      }),
    };
  }
  return {
    kind: 'gateway',
    context: {
      v: 1,
      provider: switched.provider,
      connectionId: connection.id,
      name,
      kind: connection.catalogId,
    },
  };
}

/**
 * Whether the session a turn would resume last ran on another route than the one it starts on now: another provider,
 * or through the gateway and now not (or the other way). Hermes can't carry a session across routes, so the turn starts
 * a fresh one with the conversation's window instead of failing once to find that out.
 */
export async function sessionOnOtherRoute(
  db: Db,
  row: Pick<DispatchRow, 'id' | 'agentId' | 'providerSessionId'>,
  next: { provider: string; gatewayProvider: GatewayProvider | null },
): Promise<boolean> {
  if (!row.providerSessionId) return false;
  const [last] = await db
    .select({ gatewayProvider: dispatches.gatewayProvider, provider: turnProviderSql })
    .from(dispatches)
    .innerJoin(principals, eq(principals.id, dispatches.agentId))
    .where(
      and(
        eq(dispatches.providerSessionId, row.providerSessionId),
        eq(dispatches.agentId, row.agentId),
        ne(dispatches.id, row.id),
        isNotNull(dispatches.finishedAt),
      ),
    )
    .orderBy(desc(dispatches.finishedAt))
    .limit(1);
  if (!last) return false;
  return last.provider !== next.provider || (last.gatewayProvider ?? null) !== next.gatewayProvider;
}

/**
 * Records the route a claimed turn starts on (`gateway_provider`, AIG-07): its provider, or null for its own sign-in.
 * `fresh`: it starts without the session its last attempt ran (another route, another CLI home: AIG-10). `runtime`: a
 * fallback onto the other tool's sign-in runs the turn on that tool, with its own default model.
 */
export async function recordGatewayRoute(
  services: Services,
  dispatchId: string,
  provider: GatewayDispatchContext['provider'] | null,
  options: { fresh?: boolean; runtime?: ChatRuntime } = {},
): Promise<void> {
  await services.pipeline.transactAccount((tx) =>
    tx
      .update(dispatches)
      .set({
        gatewayProvider: provider,
        gatewayAccount: null,
        ...(options.fresh ? { providerSessionId: null } : {}),
        ...(options.runtime ? { runtime: options.runtime } : {}),
      })
      .where(eq(dispatches.id, dispatchId)),
  );
}
