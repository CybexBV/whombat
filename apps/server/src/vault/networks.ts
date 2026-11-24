/**
 * This Whombat's home network list (docs/decisions/vault.md VT-12, VT-59): the private networks and ports Vault
 * entries may reach. Instance-level and not secret: the person reads and changes it, as account-level writes (no
 * burrow, so no signed burrow event; the row keeps who and when).
 *
 * With `WHOMBAT_VAULT_NETWORKS_FILE` set (the appliance), the list is also written there at boot and after every
 * change — core `vaultNetworksFile`: `{"version":1,"networks":[…]}`, sorted, no notes or names — atomically (temp
 * file + rename, mode 0644), for the privileged side to open exactly those networks and ports for the server.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  canonicalCidr,
  newId,
  sortedPorts,
  topics,
  VAULT_LIMIT_MESSAGES,
  VAULT_NETWORKS_MAX,
  type VaultNetworksResponse,
  vaultNetworkProblem,
  vaultNetworksFile,
} from '@whombat/core';
import { eq, sql } from 'drizzle-orm';
import { principals, vaultNetworks } from '../db/schema/index';
import { notFound } from '../lib/errors';
import type { Services } from '../services';
import { fieldError, vaultError } from './commands';
import { vaultReachChanged } from './reach-changed';
import { listedNetworks, networkViews } from './store';

/** The home network list: the person changes it (one-person.md OP-S65). */
export async function networksResponse(services: Services): Promise<VaultNetworksResponse> {
  return { networks: await networkViews(services.db), max: VAULT_NETWORKS_MAX };
}

/** Replaces `file` atomically with `text` (mode 0644): the reader never sees half a file. */
export function writeFileAtomically(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, text, { mode: 0o644 });
    chmodSync(tmp, 0o644);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Writes the list to `WHOMBAT_VAULT_NETWORKS_FILE` when it is set (VT-59). */
export async function writeNetworksFile(services: Services): Promise<boolean> {
  const file = services.config.WHOMBAT_VAULT_NETWORKS_FILE;
  if (!file) return false;
  const doc = vaultNetworksFile(await listedNetworks(services.db));
  writeFileAtomically(file, `${JSON.stringify(doc)}\n`);
  return true;
}

/** After a change: the file for the appliance, and `vault.updated {null}` so open Vault pages refetch the list. */
function afterChange(services: Services, session: { after(hook: () => Promise<void>): void }) {
  session.after(async () => {
    await writeNetworksFile(services).catch((err: unknown) =>
      services.log.error({ err: String(err) }, 'could not write the Vault home network file'),
    );
    // What was held for an address Whombat may not reach is looked at again.
    vaultReachChanged(services);
  });
}

async function publishAll(
  tx: Parameters<Parameters<Services['pipeline']['transactAccount']>[0]>[0],
  session: Parameters<Parameters<Services['pipeline']['transactAccount']>[0]>[1],
) {
  const people = await tx.select({ id: principals.id }).from(principals).where(eq(principals.kind, 'person'));
  for (const p of people) session.publish(topics.me(p.id), { type: 'vault.updated', entryId: null });
}

/** Adds a network: a private range at most a /16 or /48 wide, 1–16 ports (VT-12). */
export async function addNetwork(
  services: Services,
  accountId: string,
  body: { cidr: string; ports: number[]; note: string },
): Promise<void> {
  const problem = vaultNetworkProblem(body.cidr, body.ports);
  if (problem) throw fieldError({ [problem.field]: [problem.message] });
  const cidr = canonicalCidr(body.cidr);
  if (!cidr) throw fieldError({ cidr: ['That isn’t a network. Write it like 192.168.1.0/24.'] });
  await services.pipeline.transactAccount(async (tx, session) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('whombat/vault-networks'))`);
    const rows = await tx.select({ cidr: vaultNetworks.cidr }).from(vaultNetworks);
    if (rows.some((r) => r.cidr === cidr)) throw vaultError('network_listed');
    if (rows.length >= VAULT_NETWORKS_MAX)
      throw vaultError(
        'limit_reached',
        { limit: 'networks', max: VAULT_NETWORKS_MAX },
        VAULT_LIMIT_MESSAGES.networks,
      );
    await tx.insert(vaultNetworks).values({
      id: newId('vaultNetwork'),
      cidr,
      ports: sortedPorts(body.ports),
      note: body.note,
      addedByAccountId: accountId,
      addedAt: services.clock(),
    });
    await publishAll(tx, session);
    afterChange(services, session);
  });
  services.log.info({ cidr, ports: sortedPorts(body.ports) }, 'Vault home network added');
}

/** Removes a network: entries on it stay, and their calls are refused from now on (VT-13). */
export async function removeNetwork(services: Services, networkId: string): Promise<void> {
  await services.pipeline.transactAccount(async (tx, session) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('whombat/vault-networks'))`);
    const removed = await tx
      .delete(vaultNetworks)
      .where(eq(vaultNetworks.id, networkId))
      .returning({ cidr: vaultNetworks.cidr });
    if (!removed.length) throw notFound('Home network');
    await publishAll(tx, session);
    afterChange(services, session);
    services.log.info({ cidr: removed[0]?.cidr }, 'Vault home network removed');
  });
}
