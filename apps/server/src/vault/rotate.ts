/**
 * Keys the agent's commands had (docs/decisions/agent-computer.md AC-34): nothing stays there beyond a turn, but the
 * agent may have kept a copy. When such an entry is switched off for the agent or removed, the person is told to rotate
 * the secret — in their Chat with the agent, like every other note the Vault leaves them (VT-D24). For an SSH key the
 * note offers “Generate a new key” and lists the servers whose `authorized_keys` need the new public key.
 */
import { VAULT_SSH_COPY, vaultRotateNotice, vaultSshServerTarget } from '@whombat/core';
import { asc, eq } from 'drizzle-orm';
import type { ApplyContext } from '../commit/types';
import { vaultSshServers } from '../db/schema/index';
import type { VaultEntryRow } from './store';
import { tellPerson } from './tell';

/** The servers of an `ssh` entry as the note lists them: “web-1 · deploy@203.0.113.7:22”. */
async function serverLines(ctx: ApplyContext, entryId: string): Promise<string[]> {
  const rows = await ctx.tx
    .select()
    .from(vaultSshServers)
    .where(eq(vaultSshServers.entryId, entryId))
    .orderBy(asc(vaultSshServers.name));
  return rows.map((s) => `- ${s.name} · ${vaultSshServerTarget(s)}`);
}

/**
 * The note's text (AC-34): `vaultRotateNotice`, then for an SSH key its servers and where “Generate a new key” is. An
 * entry being removed can't get a new key: its note says to take the old public key off the servers instead.
 */
export async function rotateNoticeText(
  ctx: ApplyContext,
  entry: Pick<VaultEntryRow, 'id' | 'name' | 'kind'>,
  agentName: string,
  removed: boolean,
): Promise<string> {
  const notice = vaultRotateNotice({ agentName, entryName: entry.name, kind: entry.kind });
  if (entry.kind !== 'ssh') return notice.text;
  const servers = await serverLines(ctx, entry.id);
  const head = removed
    ? `${agentName} had “${entry.name}” in its commands and may have kept a copy. Take its public key off the servers below to be sure.`
    : `${notice.text} In the Vault, open “${entry.name}” and choose ${notice.action ?? VAULT_SSH_COPY.generateNew}.`;
  return servers.length ? `${head}\n\n${servers.join('\n')}` : head;
}

/** Tells the person to rotate it (AC-34); nothing when the person has no Chat with the agent (the mock world). */
export async function tellPersonToRotate(
  ctx: ApplyContext,
  entry: Pick<VaultEntryRow, 'id' | 'name' | 'kind'>,
  agentName: string,
  options: { removed?: boolean } = {},
): Promise<void> {
  await tellPerson(ctx, await rotateNoticeText(ctx, entry, agentName, options.removed ?? false));
}
