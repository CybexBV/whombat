/**
 * Restoring your Vault (BF-02, BF-04, BF-06): only the person who made the file gets their entries back, as their own —
 * matched by kind and name, made through `vault.create` (an SSH key through `vault.create_ssh`, its key read again so
 * its comment names the new entry) with the secret sealed again under this Whombat's master key and the new entry's
 * AAD; then its SSH servers with their trusted host keys and the agent's switch as the file has it (on with its variable
 * and servers, or off; docs/decisions/vault-simplify.md VLT-10). A login's authenticator key and a server's kept password
 * are sealed again the same way (CT-1664). Tools come back with the next check of the entry (they are read from the
 * service itself).
 */
import { type BackupVaultEntryRecord, type BackupVaultLine, newId, vaultAuditText } from '@whombat/core';
import { and, eq, sql } from 'drizzle-orm';
import { vaultEntries, vaultSshServers } from '../../db/schema/index';
import { loadAgentRow, shortName } from '../../read/principals';
import { createVaultEntry, keyEventFields, publishVaultUpdated, switchedOn } from '../../vault/commands';
import { createVaultSshEntry } from '../../vault/ssh-commands';
import { importSshKey } from '../../vault/ssh-keys';
import { vaultSecretAad, vaultServerPasswordAad, vaultTotpAad } from '../../vault/store';
import type { RecordOutcome, RestoreRun } from './run';

export async function restoreVault(run: RestoreRun, record: BackupVaultLine): Promise<RecordOutcome> {
  return entry(run, record);
}

async function entry(run: RestoreRun, r: BackupVaultEntryRecord): Promise<RecordOutcome> {
  const here = await run.resolve(r.id);
  if (here && !run.isStandIn(here)) {
    const [row] = await run.db.select().from(vaultEntries).where(eq(vaultEntries.id, here));
    if (!row) return 'skipped';
    let secret: string | null = null;
    try {
      secret = row.sealed ? run.services.custody.open(vaultSecretAad(row.id), row.sealed) : null;
    } catch {
      secret = null;
    }
    const same =
      (row.description ?? '') === r.description &&
      (row.url ?? null) === (r.url ?? null) &&
      (r.kind === 'ssh' || secret === r.secret);
    await restoreServersAndKeys(run, here, r, false);
    if (!run.dry && r.kind === 'login' && r.totp && !row.totpSealed) await restoreTotp(run, here, r.totp);
    if (same) return 'unchanged';
    return run.different(async () => {
      await run.tx
        .update(vaultEntries)
        .set({
          description: r.description,
          ...(r.kind !== 'ssh' && r.kind !== 'secret' ? { url: r.url, auth: r.auth } : {}),
          ...(r.kind !== 'ssh' && r.secret
            ? {
                sealed: run.services.custody.seal(vaultSecretAad(here), r.secret),
                secretSetAt: run.ctx.now,
              }
            : {}),
          updatedAt: run.ctx.now,
        })
        .where(eq(vaultEntries.id, here));
    });
  }
  if (run.dry) {
    run.remember(r.id, run.standIn(r.id), 'vault_entry');
    return 'added';
  }
  let id: string;
  try {
    id = await run.tx.transaction(async () => {
      if (r.kind === 'ssh') {
        if (!r.secret) throw new Error('an SSH key without its key');
        const entryId = newId('vaultEntry');
        const key = importSshKey(entryId, r.secret);
        if (!key.ok) throw new Error(key.message);
        await createVaultSshEntry.apply(run.tx, run.ctx, {
          entryId,
          name: r.name,
          description: r.description,
          privateKey: key.key.privateKey,
          auth: key.key.auth as never,
        });
        return entryId;
      }
      const made = await createVaultEntry.apply(run.tx, run.ctx, {
        name: r.name,
        description: r.description,
        kind: r.kind,
        ...(r.kind !== 'secret' && r.url ? { url: r.url } : {}),
        ...(r.kind !== 'secret' && r.auth ? { auth: r.auth } : {}),
        ...(r.secret ? { secret: r.secret } : {}),
      } as never);
      return (made as { entryId: string }).entryId;
    });
  } catch (err) {
    run.services.log.info({ err: String(err), kind: r.kind }, 'backup restore: a Vault entry was not added');
    run.note('unreadable', 'vault');
    return 'skipped';
  }
  run.remember(r.id, id, 'vault_entry');
  if (r.kind === 'login' && r.totp) await restoreTotp(run, id, r.totp);
  await restoreServersAndKeys(run, id, r, true);
  return 'added';
}

/** A login's authenticator key, sealed again for the entry here (the file holds `vaultTotpCanonical`'s form). */
async function restoreTotp(run: RestoreRun, entryId: string, totp: string): Promise<void> {
  await run.tx
    .update(vaultEntries)
    .set({ totpSealed: run.services.custody.seal(vaultTotpAad(entryId), totp), totpSetAt: run.ctx.now })
    .where(eq(vaultEntries.id, entryId));
}

/**
 * An entry's SSH servers (by name), added where missing, and the agent's switch: a new entry (switched on as it was
 * made) is set as the file has it, on or off; an entry that was here is switched on when the file has it on and it is
 * off, never switched off.
 */
async function restoreServersAndKeys(
  run: RestoreRun,
  entryId: string,
  r: BackupVaultEntryRecord,
  made: boolean,
): Promise<void> {
  if (run.dry) return;
  const now = run.ctx.now;
  for (const s of r.sshServers) {
    const [have] = await run.tx
      .select({ id: vaultSshServers.id })
      .from(vaultSshServers)
      .where(
        and(
          eq(vaultSshServers.entryId, entryId),
          sql`lower(${vaultSshServers.name}) = ${s.name.toLowerCase()}`,
        ),
      );
    if (have) {
      run.remember(s.id, have.id, 'vault_ssh_server');
      continue;
    }
    const id = newId('vaultSshServer');
    // Its kept password, sealed again with this server (the commands sign in with it, as before).
    const password = s.password
      ? {
          passwordSealed: run.services.custody.seal(vaultServerPasswordAad(entryId, id), s.password),
          passwordSetAt: now,
        }
      : {};
    await run.tx.insert(vaultSshServers).values({
      id,
      burrowId: run.burrow.id,
      entryId,
      name: s.name,
      host: s.host,
      port: s.port,
      username: s.username,
      production: s.production,
      ...(s.hostKey
        ? {
            hostKeyAlgorithm: s.hostKey.algorithm,
            hostKeyFingerprint: s.hostKey.fingerprint,
            hostKeyBlob: s.hostKey.blob,
            hostKeyTrustedAt: now,
          }
        : {}),
      ...password,
      createdAt: now,
      updatedAt: now,
    });
    run.remember(s.id, id, 'vault_ssh_server');
  }
  await restoreSwitch(run, entryId, r.key, made);
}

/** The agent's switch as the file has it (one-agent.md OA-10), signed like the person's own switching. */
async function restoreSwitch(
  run: RestoreRun,
  entryId: string,
  k: BackupVaultEntryRecord['key'],
  made: boolean,
): Promise<void> {
  const agent = await loadAgentRow(run.tx, run.burrow.id);
  const [row] = await run.tx.select().from(vaultEntries).where(eq(vaultEntries.id, entryId));
  if (!agent || !row || row.kind === 'secret') return;
  if (k) {
    // An entry that was here and is on stays as it is.
    if (row.agentOnAt && !made) return;
    const servers = row.kind === 'ssh' && k.servers ? (await run.resolveAll(k.servers)).ids : null;
    const on = switchedOn({ ...row, envName: k.envName }, undefined, row.agentOnAt ?? run.ctx.now);
    await run.tx
      .update(vaultEntries)
      .set({ ...on, agentServers: servers })
      .where(eq(vaultEntries.id, entryId));
    if (row.agentOnAt) return;
    await run.ctx.emit({
      type: 'vault.key.given',
      kind: 'Vault',
      text: vaultAuditText('key.given', { agentName: shortName(agent) }),
      ...keyEventFields(row, agent),
    });
  } else {
    // Off in the file: an entry made here (switched on as every new one is) goes back off.
    if (!made || !row.agentOnAt) return;
    await run.tx.update(vaultEntries).set({ agentOnAt: null }).where(eq(vaultEntries.id, entryId));
    await run.ctx.emit({
      type: 'vault.key.taken',
      kind: 'Vault',
      text: vaultAuditText('key.taken', { agentName: shortName(agent) }),
      ...keyEventFields(row, agent),
    });
  }
  publishVaultUpdated(run.ctx, row.ownerId, entryId);
}
