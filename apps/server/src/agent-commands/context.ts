/**
 * `DispatchContext.commands` (docs/decisions/one-person.md OP-07, OP-S42, OP-S114): what the runner needs
 * for the guard and the commands' network in a turn of the person's.
 *
 * - **Production servers**: every SSH server marked Production in the Vault, whether or not the agent holds a key to it
 *   (the network closes them all unless a person opened one, AC-DS06) — name, host, port and the addresses the host
 *   resolves to now. Only addresses commands could otherwise reach are listed: public ones and ones inside the home
 *   network list (anything else the network rejects anyway).
 * - **Home networks**: the Vault's home network list (VT-12), as CIDRs, opened as extra allow rules.
 * - **lan**: “Agents may reach your local network” (RA-41).
 *
 * Null for turns that run no commands: search answers, outsiders' turns (OP-17: the runner applies their own rules) and
 * Whombat's own signers.
 */
import {
  addressIsPublic,
  agentsReachLanOn,
  type DispatchCommandsContext,
  parseCidr,
  parseIp,
  parseVaultSshHost,
} from '@whombat/core';
import { and, asc, eq } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { burrows, vaultSshServers } from '../db/schema/index';
import { outsidersTurn } from '../runtime/person';
import type { Services } from '../services';
import { vaultless } from '../vault/context';
import { resolveSshHost } from '../vault/ssh';
import { listedNetworks } from '../vault/store';

/** The most addresses one server lists (`CommandProductionServer.addresses`). */
const ADDRESSES_MAX = 16;

/** Whether an address is inside a CIDR (same family). */
function inCidr(address: string, cidr: string): boolean {
  const ip = parseIp(address);
  const net = parseCidr(cidr);
  if (!ip || !net || ip.family !== net.family) return false;
  let bits = net.prefix;
  for (let i = 0; i < ip.bytes.length && bits > 0; i++) {
    const take = Math.min(8, bits);
    const mask = (0xff << (8 - take)) & 0xff;
    if (((ip.bytes[i] ?? 0) & mask) !== ((net.bytes[i] ?? 0) & mask)) return false;
    bits -= take;
  }
  return true;
}

/** A production server's host as addresses the commands could reach otherwise: public, or on a home network. */
export function reachableAddresses(addresses: readonly string[], homeNetworks: readonly string[]): string[] {
  return [
    ...new Set(addresses.filter((a) => addressIsPublic(a) || homeNetworks.some((cidr) => inCidr(a, cidr)))),
  ].slice(0, ADDRESSES_MAX);
}

/** Every production server of the burrow's Vault, with the addresses its host resolves to now. */
export async function productionServers(
  services: Services,
  db: Db | Tx,
  burrowId: string,
  homeNetworks: readonly string[],
): Promise<DispatchCommandsContext['productionServers']> {
  const rows = await db
    .select()
    .from(vaultSshServers)
    .where(and(eq(vaultSshServers.burrowId, burrowId), eq(vaultSshServers.production, true)))
    .orderBy(asc(vaultSshServers.name), asc(vaultSshServers.id));
  return Promise.all(
    rows.slice(0, 200).map(async (s) => {
      const parsed = parseVaultSshHost(s.host);
      const resolved = parsed?.hostKind === 'name' ? await resolveSshHost(services, s.host) : [s.host];
      return {
        entryId: s.entryId,
        name: s.name,
        host: s.host,
        port: s.port,
        addresses: reachableAddresses(resolved, homeNetworks),
      };
    }),
  );
}

/** `DispatchContext.commands` for a turn, or null (a turn that runs no commands). */
export async function commandsContextFor(
  services: Services,
  agent: { system: string | null },
  dispatch: Parameters<typeof commandsTurn>[1] & { burrowId: string },
): Promise<DispatchCommandsContext | null> {
  if (!commandsTurn(agent, dispatch)) return null;
  const homeNetworks = (await listedNetworks(services.db)).map((n) => n.cidr).slice(0, 64);
  return {
    productionServers: await productionServers(services, services.db, dispatch.burrowId, homeNetworks),
    homeNetworks,
    // “Agents may reach your local network” (resourceful-agents.md RA-41): on by default.
    lan: await agentsReachLanOf(services.db, dispatch.burrowId),
  };
}

/** Whether the burrow lets the agent's commands reach the local network (RA-41; absent = on). */
export async function agentsReachLanOf(db: Db | Tx, burrowId: string): Promise<boolean> {
  const [row] = await db
    .select({ agentsReachLan: burrows.agentsReachLan })
    .from(burrows)
    .where(eq(burrows.id, burrowId));
  return row ? agentsReachLanOn({ agentsReachLan: row.agentsReachLan ?? undefined }) : false;
}

/**
 * Whether a turn runs commands (AC-23; one-person.md OP-07, OP-17): the person's turns, but for search answers and
 * other vaultless ones; never an outsiders' turn or one of Whombat's own signers.
 */
export function commandsTurn(
  agent: { system: string | null },
  dispatch: Parameters<typeof vaultless>[0] & { onBehalfOfAccountId: string | null },
): boolean {
  return agent.system === null && !vaultless(dispatch) && !outsidersTurn(dispatch);
}
