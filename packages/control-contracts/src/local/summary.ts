/** Pure mappings from local facts to what clients see. */
import { sha256Bytes } from '@whombat/core/audit';
import { base64urlEncode } from '@whombat/protocol';
import type { BackupIncomplete, BackupScope, BackupStatus, UpdateStatus } from '@whombat/protocol/session';
import type { BackupServiceStatus, UpdateFacts } from './index.js';

const iso = (t: string) => new Date(t).toISOString();

/**
 * `appliance.status.backup` from the backup service's status (null → unprotected). Unknown coverage classes of a
 * newer backup service are left out rather than misnamed.
 */
export function summarizeBackup(status: BackupServiceStatus | null, known: readonly string[]): BackupStatus {
  if (!status)
    return {
      state: 'unprotected',
      lastSuccessAt: null,
      ageS: null,
      coverage: [],
      unprotected: [],
      relogin: [],
      lastFailure: null,
      recoverable: false,
    };
  const ids = (pick: (c: BackupServiceStatus['coverage'][number]) => boolean) =>
    status.coverage.filter((c) => pick(c) && known.includes(c.id)).map((c) => c.id as BackupScope);
  return {
    state: status.state,
    lastSuccessAt: status.lastSuccess ? iso(status.lastSuccess.at) : null,
    ageS: status.lastSuccess ? status.lastSuccess.ageSeconds : null,
    coverage: ids((c) => c.covered),
    unprotected: ids((c) => !c.covered),
    relogin: ids((c) => c.covered && c.relogin === true),
    lastFailure: status.lastFailure
      ? { at: iso(status.lastFailure.at), stage: status.lastFailure.stage, reason: status.lastFailure.reason }
      : null,
    recoverable: status.recoverability.lastDrill?.ok === true,
    ...incompleteOf(status.lastSuccess?.incomplete),
  };
}

/** What the last backup left out, in the summary's bounds (a whole one says nothing). */
function incompleteOf(gap: BackupIncomplete | undefined): Pick<BackupStatus, 'incomplete'> {
  if (!gap) return {};
  const reason = gap.reason.replace(/\s+/g, ' ').trim();
  if (!reason && !gap.attachments && !gap.servers) return {};
  const cut = reason.length > 500 ? `${reason.slice(0, 499).trimEnd()}…` : reason;
  return {
    incomplete: {
      reason: cut,
      ...(gap.attachments ? { attachments: gap.attachments } : {}),
      ...(gap.servers ? { servers: true } : {}),
    },
  };
}

/**
 * `appliance.status.update` from the manager's facts; the failure detail, waiting and last update pass through
 * (CT-138), their times as ISO timestamps.
 */
export function summarizeUpdate(update: UpdateFacts | null): UpdateStatus | null {
  if (!update) return null;
  const { failureDetail, waiting, lastUpdate, ...rest } = update;
  return {
    ...rest,
    lastCheckedAt: update.lastCheckedAt ? iso(update.lastCheckedAt) : null,
    ...(failureDetail ? { failureDetail } : {}),
    ...(waiting ? { waiting: { ...waiting, since: iso(waiting.since) } } : {}),
    ...(lastUpdate ? { lastUpdate: { ...lastUpdate, at: iso(lastUpdate.at) } } : {}),
  };
}

/**
 * Opaque revocation reference control sees for an endpoint revocation (`revocations.report`): the first 22
 * base64url characters of sha256("whombat-revocation-ref/v1:" + peerId) — stable, not reversible to the PeerId.
 */
export function revocationRef(peerId: string): string {
  return base64urlEncode(sha256Bytes(`whombat-revocation-ref/v1:${peerId}`)).slice(0, 22);
}
