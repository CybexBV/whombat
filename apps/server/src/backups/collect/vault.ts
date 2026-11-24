/**
 * Your Vault (`vault.jsonl`, BF-05, BF-06): the person's entries with their secrets unsealed (an SSH entry's private
 * key, a login's authenticator key), which tools are on, whether each is switched on for the agent (with an API's
 * variable and an SSH key's servers, docs/decisions/vault-simplify.md VLT-10) and the SSH servers with their trusted host
 * keys and kept passwords, and the 1Password item each entry is kept in step with.
 */
import {
  type BackupVaultLine,
  OnePasswordItemId,
  VAULT_DESCRIPTION_MAX,
  VAULT_NAME_MAX,
  VAULT_SECRET_MAX,
  VAULT_SSH_PRIVATE_KEY_MAX,
  VAULT_SSH_SERVER_NAME_MAX,
  VAULT_SSH_SERVER_PASSWORD_MAX,
  VAULT_SSH_SERVERS_MAX,
  VAULT_TOOLS_MAX,
  VAULT_URL_MAX,
} from '@whombat/core';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { vaultEntries, vaultOnePasswordLinks, vaultSshServers, vaultTools } from '../../db/schema/index';
import { iso } from '../../lib/time';
import type { Services } from '../../services';
import { agentKeyOf, vaultSecretAad, vaultServerPasswordAad, vaultTotpAad } from '../../vault/store';
import type { CategoryOut, CollectScope } from './scope';

const rec = (v: BackupVaultLine) => v as BackupVaultLine & { type: string } & Record<string, unknown>;

export async function collectVault(scope: CollectScope, out: CategoryOut): Promise<void> {
  const { db, burrow, services } = scope;
  const entries = await db
    .select()
    .from(vaultEntries)
    .where(and(eq(vaultEntries.burrowId, burrow.id), eq(vaultEntries.ownerId, scope.maker.id)))
    .orderBy(asc(vaultEntries.createdAt));
  const ids = entries.map((e) => e.id);
  const tools = ids.length
    ? await db
        .select()
        .from(vaultTools)
        .where(inArray(vaultTools.entryId, ids))
        .orderBy(asc(vaultTools.position))
    : [];
  const servers = ids.length
    ? await db
        .select()
        .from(vaultSshServers)
        .where(inArray(vaultSshServers.entryId, ids))
        .orderBy(asc(vaultSshServers.createdAt))
    : [];
  // The 1Password item each entry is kept in step with (onepassword-sync.md OPW-42): a restore relinks to it.
  const items = new Map(
    (ids.length
      ? await db
          .select({ entryId: vaultOnePasswordLinks.entryId, itemId: vaultOnePasswordLinks.itemId })
          .from(vaultOnePasswordLinks)
          .where(and(inArray(vaultOnePasswordLinks.entryId, ids), eq(vaultOnePasswordLinks.state, 'synced')))
      : []
    )
      .filter((l) => l.itemId && OnePasswordItemId.safeParse(l.itemId).success)
      .map((l) => [l.entryId as string, l.itemId as string]),
  );
  let leftOut = 0;
  for (const e of entries) {
    let secret: string | null = null;
    if (e.sealed)
      try {
        secret = services.custody.open(vaultSecretAad(e.id), e.sealed) || null;
      } catch {
        secret = null;
      }
    // A secret that doesn't open (or is longer than the Vault holds) is said in the restore preview (BF-S12).
    const max = e.kind === 'ssh' ? VAULT_SSH_PRIVATE_KEY_MAX : VAULT_SECRET_MAX;
    if (e.sealed && (!secret || secret.length > max)) leftOut++;
    // A login's authenticator key and a server's kept password come along as the secret does (vault-simplify.md CT-1664).
    const totp =
      e.kind === 'login' && e.totpSealed ? openOrNull(services, vaultTotpAad(e.id), e.totpSealed) : null;
    const key = agentKeyOf(e);
    const entryServers = servers.filter((s) => s.entryId === e.id).slice(0, VAULT_SSH_SERVERS_MAX);
    out.ref(e.id, ...entryServers.map((s) => s.id));
    await out.record(
      rec({
        type: 'vault_entry',
        id: e.id,
        totp: totp && totp.length <= VAULT_SECRET_MAX ? totp : null,
        kind: e.kind,
        name: e.name.slice(0, VAULT_NAME_MAX),
        description: (e.description ?? '').slice(0, VAULT_DESCRIPTION_MAX),
        url: e.url && e.url.length <= VAULT_URL_MAX ? e.url : null,
        auth: e.auth ?? null,
        secret: secret && secret.length <= max ? secret : null,
        tools: tools
          .filter((t) => t.entryId === e.id)
          .slice(0, VAULT_TOOLS_MAX)
          .map((t) => ({ name: t.name.slice(0, 200), enabled: t.enabled, hash: t.hash.slice(0, 128) })),
        // The agent's switch: null while it is off (one-agent.md OA-10).
        key: key ? { envName: key.envName, servers: key.servers } : null,
        sshServers: entryServers.map((s) => ({
          id: s.id,
          name: s.name.slice(0, VAULT_SSH_SERVER_NAME_MAX),
          host: s.host,
          port: s.port,
          username: s.username,
          production: s.production,
          password: s.passwordSealed ? serverPassword(services, s) : null,
          hostKey:
            s.hostKeyAlgorithm && s.hostKeyFingerprint
              ? {
                  algorithm: s.hostKeyAlgorithm,
                  fingerprint: s.hostKeyFingerprint,
                  blob: s.hostKeyBlob ?? null,
                }
              : null,
        })),
        ...(items.has(e.id) ? { onepasswordItemId: items.get(e.id) } : {}),
        createdAt: iso(e.createdAt),
      }),
    );
  }
  out.note('sign_in_left_out', leftOut);
}

/** A sealed value opened, or null when it doesn't open (it is left out of the file, as a secret is). */
function openOrNull(services: Services, aad: string, sealed: string): string | null {
  try {
    return services.custody.open(aad, sealed) || null;
  } catch {
    return null;
  }
}

/** A server's kept password for the file, or null when it doesn't open or is longer than the Vault keeps. */
function serverPassword(services: Services, s: typeof vaultSshServers.$inferSelect): string | null {
  const value = openOrNull(services, vaultServerPasswordAad(s.entryId, s.id), s.passwordSealed as string);
  return value && value.length <= VAULT_SSH_SERVER_PASSWORD_MAX ? value : null;
}
