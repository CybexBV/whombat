/**
 * The AI gateway's reads (docs/decisions/ai-gateway.md AIG-01, AIG-05, AIG-11): a burrow's gateway connection (at most
 * one, AIG-01), its switches as `Burrow.aiGateway` shows them, the key the relay sends, and what the poller last read.
 */
import {
  type BurrowAiGateway,
  catalogEntry,
  GATEWAY_KINDS,
  type GatewayKind,
  type GatewayProvider,
} from '@whombat/core';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { openConnectionSecret } from '../connections/crypto';
import type { CatalogConnectionRow } from '../connections/types';
import type { Db } from '../db/client';
import { burrows, catalogConnections, gatewayUsage, type StoredAiGateway } from '../db/schema/index';
import type { Services } from '../services';

export type GatewayUsageRow = typeof gatewayUsage.$inferSelect;

/** Whether a catalog entry is one of the gateway entries (`use: 'gateway'`, AIG-01). */
export function isGatewayCatalogId(catalogId: string): catalogId is GatewayKind {
  return (GATEWAY_KINDS as readonly string[]).includes(catalogId);
}

/** The burrow's gateway connection (shared, at most one: AIG-01), or null. */
export async function gatewayConnectionOf(db: Db, burrowId: string): Promise<CatalogConnectionRow | null> {
  const [row] = await db
    .select()
    .from(catalogConnections)
    .where(
      and(
        eq(catalogConnections.burrowId, burrowId),
        inArray(catalogConnections.catalogId, [...GATEWAY_KINDS]),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** A gateway connection's name as people read it: its label (else the entry's name), at most 80. */
export function gatewayName(row: Pick<CatalogConnectionRow, 'label' | 'catalogId'>): string {
  const label = row.label.trim() || catalogEntry(row.catalogId)?.name || 'AI gateway';
  return label.slice(0, 80);
}

/** The switches as stored for this connection (another connection's or none: both off). */
export function switchesOf(
  stored: StoredAiGateway | null | undefined,
  connectionId: string,
): { claude: boolean; codex: boolean } {
  const s = stored?.connectionId === connectionId ? stored : null;
  return { claude: s?.claude === true, codex: s?.codex === true };
}

/** `Burrow.aiGateway` (AIG-05, AIG-20): the gateway connection and its switches; null without one. */
export function aiGatewayOf(
  burrow: { aiGateway: StoredAiGateway | null },
  connection: CatalogConnectionRow | null,
): BurrowAiGateway | null {
  if (!connection || !isGatewayCatalogId(connection.catalogId)) return null;
  return {
    connectionId: connection.id,
    name: gatewayName(connection),
    kind: connection.catalogId,
    ...switchesOf(burrow.aiGateway, connection.id),
  };
}

/** `Burrow.aiGateway` of a burrow row, reading its gateway connection. */
export async function aiGatewayView(
  db: Db,
  burrow: { id: string; aiGateway: StoredAiGateway | null },
): Promise<BurrowAiGateway | null> {
  return aiGatewayOf(burrow, await gatewayConnectionOf(db, burrow.id));
}

/**
 * The provider a turn of an agent on `provider` goes through the gateway for (AIG-07), with the connection: the
 * burrow's switch for it is on and the connection it points to is still there. Null: the agent's own sign-in.
 */
export async function switchedGateway(
  db: Db,
  burrowId: string,
  provider: string,
): Promise<{
  provider: GatewayProvider;
  connection: CatalogConnectionRow | null;
  stored: StoredAiGateway;
} | null> {
  if (provider !== 'claude' && provider !== 'codex') return null;
  const [burrow] = await db
    .select({ aiGateway: burrows.aiGateway })
    .from(burrows)
    .where(eq(burrows.id, burrowId));
  const stored = burrow?.aiGateway ?? null;
  if (!stored?.[provider]) return null;
  const [connection] = await db
    .select()
    .from(catalogConnections)
    .where(and(eq(catalogConnections.id, stored.connectionId), eq(catalogConnections.burrowId, burrowId)));
  return { provider, connection: connection ?? null, stored };
}

/** Which tools go through a gateway anywhere on this Whombat (the runner's heartbeat, AIG-16). */
export async function gatewaySwitchesAnywhere(db: Db): Promise<{ claude: boolean; codex: boolean }> {
  const rows = await db
    .select({ aiGateway: burrows.aiGateway, id: catalogConnections.id })
    .from(burrows)
    .innerJoin(
      catalogConnections,
      and(
        eq(catalogConnections.burrowId, burrows.id),
        inArray(catalogConnections.catalogId, [...GATEWAY_KINDS]),
      ),
    )
    .where(isNotNull(burrows.aiGateway));
  const out = { claude: false, codex: false };
  for (const r of rows) {
    const s = switchesOf(r.aiGateway, r.id);
    out.claude ||= s.claude;
    out.codex ||= s.codex;
  }
  return out;
}

/**
 * The key the relay sends to the gateway (AIG-02, AIG-04, AIG-09): a Fusebox's client key Whombat made (null for an
 * open Fusebox, which takes none), the generic gateway's own key. `usable` false: there is none where there should be
 * one (`gateway.missing`).
 */
export function gatewayKeyOf(
  services: Pick<Services, 'custody'>,
  row: CatalogConnectionRow,
): { usable: boolean; key: string | null } {
  try {
    if (row.catalogId === 'fusebox') {
      if (row.clientSecretEnc)
        return {
          usable: true,
          key: openConnectionSecret(services.custody, row.id, 'client', row.clientSecretEnc),
        };
      // No client id either: an open Fusebox (AIG-02), which takes every request without a key.
      return { usable: !row.fields?.clientId, key: null };
    }
    if (row.catalogId === 'ai_gateway' && row.secretEnc)
      return { usable: true, key: openConnectionSecret(services.custody, row.id, 'secret', row.secretEnc) };
  } catch {
    return { usable: false, key: null };
  }
  return { usable: false, key: null };
}

/** What the poller last read of a gateway connection, or null before its first poll. */
export async function gatewayUsageOf(db: Db, connectionId: string): Promise<GatewayUsageRow | null> {
  const [row] = await db.select().from(gatewayUsage).where(eq(gatewayUsage.connectionId, connectionId));
  return row ?? null;
}
