/**
 * `whombat_backup` (Whombat first-day.md, backup-places.md): this Whombat's own backups for its assistant, in a turn for
 * the person. It reads whether the box is backed up, the copy somewhere else (offsite-copy.md: read only, the person sets
 * it up), the places on the network that could keep its backups and the key
 * it signs in to an SFTP server with, and — only while nothing backs it up, or only this Whombat's own disk does
 * (BPL-06) — sets where backups go: a backup place Whombat sets up, a folder on a server over SFTP, or the disk labelled
 * WHOMBAT-BACKUP. The person's yes on the Inbox proposal is what asks for it; any other move stays theirs (Settings →
 * This Whombat). The signed appliance event names the assistant beside the person's account.
 *
 * What the agent passes on is Whombat's own sentence (`say`, backup-places.md BPL-16): where by name and whether the
 * first backup runs, never an address, port or path.
 */
import { BACKUP_PLACE_TEXT, type WhombatBackupInput, type WhombatBackupOutput } from '@whombat/core';
import { type BackupOffsite, BackupSshPublicKey, offsitePlaceName } from '@whombat/protocol/session';
import type { z } from 'zod';
import { placesNow } from '../backup-places/places';
import { usePlace } from '../backup-places/use';
import { ApiError } from '../lib/errors';
import type { ToolContext } from '../mcp/tools';
import { ownTurn } from '../vault/self-serve';
import { setBackupDestination } from './backup';
import { offsiteNow, offsiteStepText } from './backup-offsite';
import { boxBackupOf, boxBackupStatus } from './box-backup';

type Input = z.output<typeof WhombatBackupInput>;

/** What the tool answers the agent with (to the agent, never the chat). */
export const WHOMBAT_BACKUP_TEXT = {
  notHere: 'Only in a turn for the person: their Whombat’s backups are theirs.',
  unavailable: 'This Whombat has no backup service (a development box): nothing to set up.',
  already: (where: string) =>
    `It backs up to ${where} already. Moving its backups is the person’s, in Settings → This Whombat → Backups.`,
  unknown:
    'The backup service doesn’t say where backups go right now, so nothing was changed. Tell the person it isn’t answering and try again in a few minutes.',
} as const;

/** The second place as the agent reads it (pure): where by name, how it does, and why it fails, in plain English. */
export function offsiteForAgent(offsite: BackupOffsite) {
  return {
    place: offsitePlaceName(offsite),
    state: offsite.state,
    lastCopyAt: offsite.lastCopyAt,
    newestInCopyAt: offsite.newestInCopyAt,
    problem: offsite.lastFailure ? offsiteStepText(offsite.lastFailure.step, null) : null,
  };
}

const fail = (reason: Extract<WhombatBackupOutput, { status: 'failed' }>['reason'], message: string) =>
  ({ status: 'failed', reason, message }) satisfies WhombatBackupOutput;

/** restic's SFTP repository: `sftp:host:/path`, or `sftp://host:port//path` with a port (there is no third form). */
export function sftpRepository(host: string, path: string, port?: number): string {
  return port && port !== 22 ? `sftp://${host}:${port}/${path}` : `sftp:${host}:${path}`;
}

export async function whombatBackupTool(ctx: ToolContext, input: Input): Promise<WhombatBackupOutput> {
  const { services } = ctx;
  const turn = await ownTurn(services.db, ctx);
  if (!turn?.person.accountId) return fail('not_here', WHOMBAT_BACKUP_TEXT.notHere);
  const box = boxBackupOf(services);
  if (!box) return fail('unavailable', WHOMBAT_BACKUP_TEXT.unavailable);
  const status = await boxBackupStatus(services);
  // Unknown is never “nothing set”: replacing the destination waits until the backup service says where it is.
  if (input.set && !status) return fail('unavailable', WHOMBAT_BACKUP_TEXT.unknown);
  const configured = status?.destination.configured === true;
  const now = input.set && !configured ? null : await placesNow(services).catch(() => null);
  // A place by its name; anything else as the backup service shows it.
  const current = now?.places.find((p) => p.id === now.currentPlaceId);
  const where = configured ? (current?.name ?? status?.destination.display ?? 'its destination') : null;

  if (!input.set) {
    const key = await box.port.call('GET', '/v1/ssh-public-key').catch(() => null);
    const parsed = key?.status === 200 ? BackupSshPublicKey.safeParse(key.body) : null;
    const offsite = await offsiteNow(services).catch(() => undefined);
    return {
      status: 'ok',
      state: status?.state ?? 'unprotected',
      destination: where,
      ...(offsite === undefined ? {} : { offsite: offsite && offsiteForAgent(offsite) }),
      publicKey: parsed?.success ? parsed.data.publicKey : null,
      places: (now?.places ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        state: p.state,
        reason: p.reason,
        ...(p.locations.length
          ? {
              locations: p.locations.map((l) => ({
                id: l.id,
                name: l.name,
                recommended: l.recommended,
                note: l.note,
              })),
            }
          : {}),
      })),
    };
  }
  // Only from nothing or from this Whombat's own disk: a backup there is no protection against losing the box.
  if (where && status?.destination.kind !== 'local')
    return fail('already_set', WHOMBAT_BACKUP_TEXT.already(where));

  if (input.set === 'place') {
    const agent = turn.agent;
    try {
      const out = await usePlace(
        services,
        box.port,
        { placeId: input.place ?? '', ...(input.location ? { location: input.location } : {}) },
        {
          accountId: turn.person.accountId,
          endpointId: null,
          agentId: ctx.agentId,
          actor: { id: ctx.agentId, name: `${agent.name} for ${turn.name}`, role: 'operator' },
        },
        // The thread the person said yes in hears how the first backup went.
        {
          burrowId: ctx.burrowId,
          agentId: ctx.agentId,
          conversationId: ctx.dispatch.conversationId,
          threadRootId: ctx.dispatch.threadRootId ?? null,
        },
      );
      return {
        status: 'set',
        kind: 'place',
        destination: out.destination,
        say: BACKUP_PLACE_TEXT.setSay(out.destination, out.locationName, out.firstBackup),
        hostKeyFingerprint: null,
      };
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      const code = (err.extra.details as { code?: string } | undefined)?.code;
      if (code === 'move_needed') return fail('already_set', err.message);
      const notReady =
        code === 'backup_place_not_ready' || code === 'backup_place_gone' || code === 'backup_location_gone';
      return fail(notReady ? 'place_not_ready' : 'refused', err.message);
    }
  }

  const sftp = input.set === 'sftp' && input.host && input.user && input.path;
  const repository = sftp ? sftpRepository(input.host ?? '', input.path ?? '', input.port) : 'disk:';
  try {
    const out = await setBackupDestination(
      services,
      box.port,
      { repository, allowInit: true, ...(sftp ? { sftpUser: input.user } : {}) },
      { accountId: turn.person.accountId, endpointId: null, agentId: ctx.agentId },
    );
    // Needs you's proposal goes as soon as the service says so, not at the manager's next report.
    await boxBackupStatus(services, { fresh: true });
    return {
      status: 'set',
      kind: sftp ? 'sftp' : 'disk',
      destination: sftp ? (input.host ?? '') : 'the disk WHOMBAT-BACKUP',
      hostKeyFingerprint: out.hostKeyFingerprint ?? null,
    };
  } catch (err) {
    if (err instanceof ApiError) return fail('refused', err.message);
    throw err;
  }
}
