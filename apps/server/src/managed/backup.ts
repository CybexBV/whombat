/**
 * The person's backup operations (appliance BK-11, BK-15, BK-17; docs/decisions/managed-runtime.md
 * MR-19; contracts 0.5.0 CT-30 — `configureDestination` is a `secret` op, so its receipt keeps no input digest). Each calls the backup service's local API
 * (`WHOMBAT_BACKUP_SOCKET`, `/run/whombat-backup/api.sock`, which answers these routes only to the runtime's uid):
 *
 *   backup.status               {}  → {status: BackupServiceStatus | null, summary: BackupStatus}   GET  /v1/status
 *   backup.configureDestination {repository, restUser?, restPassword?, caCert?, adoptPassword?, allowInit?,
 *                                s3AccessKeyId?, s3SecretAccessKey?, s3Region?, sftpUser?, sftpHostKey?}
 *                                   → {repositoryId, appendOnly, generation, kind?, hostKeyFingerprint?}
 *                                                                                                   PUT  /v1/destination
 *   backup.sshPublicKey         {}  → {publicKey, fingerprint} (the box's SFTP key, made on first use) GET /v1/ssh-public-key
 *   backup.recoveryMaterial     {}  → whombat.backup-recovery-material/1 (for the kit; never stored) GET  /v1/recovery-material
 *   backup.runNow               {}  → {ref, verified, id, seq, snapshotId, createdAt, schemaVersion} POST /v1/checkpoints
 *
 * The person only. Configuring, running and showing recovery material are signed appliance events (no credentials in
 * them). `recoveryMaterial` is a read, so its answer (secrets) is never kept in a command receipt. Drill status is
 * `status.recoverability.lastDrill`. Destinations (contracts CT-142, MD-17): a restic REST server (`rest:`), an
 * S3-compatible bucket (`s3:`), SFTP (`sftp:`, with the box's own key) or the attached backup disk (`disk:`); the
 * input goes to the backup service unchanged, and a refusal's text never carries a credential the person sent.
 */
import { BackupServiceStatus, summarizeBackup } from '@whombat/control-contracts/local';
import {
  type BackupConfigureDestinationInput,
  BackupConfigureDestinationOutput,
  type BackupDestinationKind,
  BackupScope,
  BackupSshPublicKey,
} from '@whombat/protocol/session';
import type { z } from 'zod';
import { oneAtATime } from '../backup-places/lock';
import { externalEffect } from '../commit/scope';
import { ApiError } from '../lib/errors';
import type { Services } from '../services';
import { appendApplianceEvent } from './audit';
import { withBringBack } from './backup-key';
import { BACKUP_DOWN_TEXT, type BackupPort, BackupServiceDown, READ } from './backup-port';
import type { SessionOpContext } from './dispatcher';
import { requirePerson } from './trust';

export {
  BACKUP_ANSWER_MAX_BYTES,
  BACKUP_CALL_TIMEOUT_MS,
  BACKUP_DOWN_TEXT,
  BACKUP_LIST_DEADLINE_MS,
  BACKUP_LIST_MAX_BYTES,
  BACKUP_READ_DEADLINE_MS,
  type BackupCallOptions,
  type BackupPort,
  BackupServiceDown,
  BackupSocketClient,
  LIST,
  READ,
} from './backup-port';

/** The refusal people get when the backup service doesn't answer. */
export function backupDownError(): ApiError {
  return new ApiError('unavailable', BACKUP_DOWN_TEXT, { details: { code: 'backup_unavailable' } });
}

/** A port whose silence is the plain refusal (`backupDownError`), for the session's ops. */
export function sessionPort(backup: BackupPort): BackupPort {
  return {
    call: (method, path, body, options) =>
      backup.call(method, path, body, options).catch((err: unknown) => {
        throw err instanceof BackupServiceDown ? backupDownError() : err;
      }),
  };
}

export function port(c: SessionOpContext): BackupPort {
  if (!c.backup)
    throw new ApiError('not_allowed', 'This appliance has no backup service.', {
      details: { code: 'backup_unavailable' },
    });
  return sessionPort(c.backup);
}

/** How much of the backup service's refusal an answer carries. */
const REFUSAL_MAX = 300;

/** The backup service's refusal text, whole (bounded by the answer's size). */
function refusalText(body: unknown): string {
  const b = body as { error?: unknown; reason?: unknown } | null;
  // The service answers the contract's LocalError, `{error: {code, message}}`.
  const e = b?.error as { message?: unknown } | string | undefined;
  if (e && typeof e === 'object' && typeof e.message === 'string') return e.message;
  return String(b?.reason ?? (typeof e === 'string' ? e : 'the backup service refused'));
}

export function reason(body: unknown): string {
  return refusalText(body).slice(0, REFUSAL_MAX);
}

type DestinationInput = z.output<typeof BackupConfigureDestinationInput>;

/** The members of a destination that identify or open it: never in a refusal's text, an event or a receipt. */
const CREDENTIAL_MEMBERS = [
  'restPassword',
  'adoptPassword',
  's3AccessKeyId',
  's3SecretAccessKey',
  'restUser',
  'sftpUser',
] as const;

const REDACTED = '[redacted]';

/** A credential's beginning this long at the end of a text counts as the credential, cut off (by the service or us). */
const CUT_PREFIX_MIN = 8;

/**
 * `text` without any credential of `input` in it: every whole value anywhere (the longest first, so no part of a
 * longer one survives a shorter one), then a credential's beginning of at least 8 characters where the text ends.
 */
export function withoutCredentials(text: string, input: DestinationInput): string {
  const values = CREDENTIAL_MEMBERS.map((m) => input[m])
    .filter((v): v is string => typeof v === 'string' && v.length >= 4)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const v of values) out = out.split(v).join(REDACTED);
  for (const v of values)
    for (let n = Math.min(v.length - 1, out.length); n >= CUT_PREFIX_MIN; n--)
      if (out.endsWith(v.slice(0, n))) {
        out = `${out.slice(0, out.length - n)}${REDACTED}`;
        break;
      }
  return out;
}

/**
 * A destination refusal for the person and the receipt: credentials removed from the whole text first, then cut to
 * `REFUSAL_MAX`, then checked again at the cut (a credential the service itself had cut short may end up there).
 */
export function destinationRefusal(body: unknown, input: DestinationInput): string {
  return withoutCredentials(withoutCredentials(refusalText(body), input).slice(0, REFUSAL_MAX), input);
}

/** The destination's kind, from the repository's prefix (`rest:`, `s3:`, `sftp:`, `disk:`; anything else is local). */
export function destinationKind(repository: string): BackupDestinationKind {
  const prefix = /^([a-z0-9]+):/.exec(repository)?.[1];
  return prefix === 'rest' || prefix === 's3' || prefix === 'sftp' || prefix === 'disk' ? prefix : 'local';
}

/** The host a destination names, for the audit event (never a path, a user or a credential). */
export function destinationHost(repository: string): string {
  const kind = destinationKind(repository);
  if (kind === 'disk') return 'disk';
  if (kind === 'local') return 'local';
  const rest = repository.slice(kind.length + 1);
  try {
    // `rest:https://host/…`, `s3:https://host/bucket/…`, `sftp://host:port//path`.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rest) || kind === 'rest') return new URL(rest).host || 'unknown';
    if (kind === 'sftp' && rest.startsWith('//')) return new URL(`sftp:${rest}`).host || 'unknown';
  } catch {
    return 'unknown';
  }
  // `s3:host/bucket/…`, `sftp:host:/path`, `sftp:[::1]:/path`.
  const host =
    kind === 's3'
      ? rest.split('/')[0]
      : rest.startsWith('[')
        ? rest.slice(0, rest.indexOf(']') + 1)
        : rest.split(':')[0];
  return host || 'unknown';
}

async function audit(
  c: SessionOpContext,
  type: 'backup.destination_set' | 'backup.recovery_material_viewed' | 'backup.run_requested',
  payload: Record<string, unknown>,
): Promise<void> {
  const { endpointId, account, agentId } = requirePerson(c.principal);
  await c.services.pipeline.transactAccount(async (tx) => {
    await appendApplianceEvent(tx, c.services.custody, {
      type,
      actorAccountId: account.id,
      endpointId,
      payload: agentId ? { ...payload, agentId } : payload,
      at: c.services.clock(),
    });
  });
}

const destinationWatchers = new WeakMap<Services, Map<string, () => void>>();

/**
 * Runs `fn` after every destination this box sets (a new place, the place's new address or password): what a new
 * Whombat needs to open the backups changed. `fn` is called without waiting for it; one per `name`.
 */
export function whenDestinationSet(services: Services, name: string, fn: () => void): void {
  const watchers = destinationWatchers.get(services) ?? new Map<string, () => void>();
  watchers.set(name, fn);
  destinationWatchers.set(services, watchers);
}

/**
 * Sets where backups go (CT-142): the input goes to the backup service unchanged, its refusal comes back without any
 * credential the input carried, and the signed appliance event says who set it — the person from their device, or
 * their assistant on their word (`agentId`, Whombat first-day.md). Throws `ApiError` (`backup_destination_failed`).
 */
export async function setBackupDestination(
  services: Services,
  backup: BackupPort,
  input: DestinationInput,
  by: { accountId: string | null; endpointId: string | null; agentId?: string },
): Promise<z.output<typeof BackupConfigureDestinationOutput>> {
  // Unchanged: the service reads every member (CT-142); the op is `secret`, so its receipt keeps no digest of it.
  const res = await externalEffect('backup.destination', () => backup.call('PUT', '/v1/destination', input));
  if (res.status !== 200)
    throw new ApiError('conflict', destinationRefusal(res.body, input), {
      details: { code: 'backup_destination_failed' },
    });
  const parsed = BackupConfigureDestinationOutput.safeParse(res.body);
  if (!parsed.success)
    throw new ApiError('conflict', 'The backup service’s answer wasn’t understood. Try again.', {
      details: { code: 'backup_destination_failed' },
    });
  const out = parsed.data;
  // Committing the audit event accepts the command; nothing secret is in it.
  await services.pipeline.transactAccount(async (tx) => {
    await appendApplianceEvent(tx, services.custody, {
      type: 'backup.destination_set',
      actorAccountId: by.accountId,
      endpointId: by.endpointId,
      payload: {
        kind: out.kind ?? destinationKind(input.repository),
        host: destinationHost(input.repository),
        repositoryId: out.repositoryId,
        appendOnly: out.appendOnly,
        generation: out.generation,
        adopted: Boolean(input.adoptPassword),
        ...(by.agentId ? { agentId: by.agentId } : {}),
      },
      at: services.clock(),
    });
  });
  for (const fn of destinationWatchers.get(services)?.values() ?? []) fn();
  return {
    repositoryId: out.repositoryId,
    appendOnly: out.appendOnly,
    generation: out.generation,
    ...(out.kind ? { kind: out.kind } : {}),
    ...(out.hostKeyFingerprint ? { hostKeyFingerprint: out.hostKeyFingerprint } : {}),
  };
}

// biome-ignore lint/suspicious/noExplicitAny: each handler receives its op's parsed input.
type BackupHandler = (c: SessionOpContext, input: any) => Promise<unknown>;

export const BACKUP_HANDLERS: Readonly<Record<string, BackupHandler>> = {
  'backup.status': async (c) => {
    requirePerson(c.principal);
    const res = await port(c).call('GET', '/v1/status', undefined, READ);
    if (res.status !== 200)
      throw new ApiError('conflict', reason(res.body), { details: { code: 'backup_unavailable' } });
    const parsed = BackupServiceStatus.safeParse(res.body);
    const status = parsed.success ? parsed.data : null;
    return {
      status,
      summary: await withBringBack(c.services, summarizeBackup(status, BackupScope.options), status),
    };
  },

  'backup.configureDestination': async (c, input: DestinationInput) => {
    const { endpointId, account, agentId } = requirePerson(c.principal);
    const backup = port(c);
    // Accepted before the service is called (an empty transaction marks the receipt, MR-06): setting up a destination
    // can't be cancelled halfway and may outlast the request's deadline (a disk is formatted and mounted first, up to
    // ~2 minutes), so the client must not be told “nothing was done” after it started (MD-17).
    await c.services.pipeline.transactAccount(async () => {});
    // After the place flows (a set-up, a move, the keep-the-place-right job): each reads where backups go first.
    return oneAtATime(c.services, () =>
      setBackupDestination(c.services, backup, input, {
        accountId: account.id,
        endpointId,
        ...(agentId ? { agentId } : {}),
      }),
    );
  },

  'backup.sshPublicKey': async (c) => {
    requirePerson(c.principal);
    const res = await port(c).call('GET', '/v1/ssh-public-key');
    if (res.status === 404)
      throw new ApiError('not_implemented', 'This Whombat’s backup service can’t back up over SFTP yet.', {
        details: { code: 'backup_unavailable' },
      });
    if (res.status !== 200)
      throw new ApiError('conflict', reason(res.body), { details: { code: 'backup_unavailable' } });
    const key = BackupSshPublicKey.safeParse(res.body);
    if (!key.success)
      throw new ApiError('conflict', 'The backup service’s answer wasn’t understood. Try again.', {
        details: { code: 'backup_unavailable' },
      });
    return key.data;
  },

  'backup.recoveryMaterial': async (c) => {
    requirePerson(c.principal);
    const res = await port(c).call('GET', '/v1/recovery-material', undefined, READ);
    if (res.status !== 200)
      throw new ApiError('conflict', reason(res.body), { details: { code: 'backup_unprotected' } });
    const material = res.body as { generation?: number; repositoryId?: string };
    await audit(c, 'backup.recovery_material_viewed', {
      generation: material.generation ?? null,
      repositoryId: material.repositoryId ?? null,
    });
    return material;
  },

  'backup.runNow': async (c) => {
    // Recorded (and so accepted) first: the checkpoint itself takes a while and can't be cancelled.
    await audit(c, 'backup.run_requested', {});
    const res = await externalEffect('backup.checkpoint', () =>
      port(c).call('POST', '/v1/checkpoints', { reason: 'manual' }),
    );
    if (res.status === 200) return res.body;
    if (res.status === 409)
      throw new ApiError('conflict', 'A backup is already running.', { details: { code: 'backup_busy' } });
    if (res.status === 412)
      throw new ApiError('conflict', 'No backup destination is set up yet.', {
        details: { code: 'backup_unprotected' },
      });
    const b = res.body as { stage?: string } | null;
    throw new ApiError('conflict', reason(res.body), {
      details: { code: 'backup_failed', ...(b?.stage ? { stage: b.stage } : {}) },
    });
  },
};
