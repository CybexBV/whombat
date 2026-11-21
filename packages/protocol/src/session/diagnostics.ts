/**
 * Customer-approved diagnostic bundles (CT-52, assignment §12): an owner generates a bundle on the appliance, reads
 * exactly what it contains, downloads it and sends it to support themselves. Nothing is uploaded to Whombat's cloud.
 * Bundles are scoped (the owner picks the scopes), expire after 7 days, and every create, download, delete and expiry
 * is a signed appliance event.
 *
 * The bundle is an allowlist: each scope has a fixed set of fields, and every string in it is an enum, a version, a
 * release id, an operation name or a code, matched by a pattern without spaces or `/`. Message content, prompts, file
 * paths, SQL, environment variables, names, emails, labels, account ids and free-text details (health `detail`,
 * backup `reason`, update `explanation`) can't be expressed, let alone included. The runtime validates a bundle with
 * `DiagnosticBundle` (strict at every level) before storing it and refuses to store one that doesn't pass.
 */
import { canonicalJson, utf8ToBytes } from '@whombat/core/audit';
import { JsonValue, Timestamp } from '@whombat/core/domain';
import { AccountId } from '@whombat/core/ids';
import { ClientFloor, ProviderName, ReleaseId, UpdateJournalState, VersionString } from '@whombat/release';
import { z } from 'zod';
import { LocalIdent } from './backup.js';
import { OpName, PeerIdString } from './common.js';
import { BackupScope, BackupState, ProviderState } from './enrollment.js';
import { AppErrorCodeName } from './errors.js';

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const Count = z.number().int().min(0).max(1_000_000_000);
/** Check, mode and state names: lower-case identifiers. */
const Name = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][A-Za-z0-9_.-]*$/);
/** Failure and wait codes from the manager or the relay (`health_timeout`, `task_running`, `4401`). */
const Code = LocalIdent(64);

export const DiagnosticBundleId = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

/** Bundles are deleted 7 days after creation (a signed `diagnostics.expired` event). */
export const DIAGNOSTICS_TTL_S = 604_800;
/** At most this many bundles exist at a time (`diagnostics_limit`: delete one first). */
export const DIAGNOSTICS_MAX_BUNDLES = 10;
/** A bundle's canonical JSON never exceeds this. */
export const DIAGNOSTIC_BUNDLE_MAX_BYTES = 262_144;
/** Counters and error codes cover this window before `createdAt`. */
export const DIAGNOSTICS_WINDOW_S = 604_800;

export const DiagnosticScope = z.enum(['versions', 'health', 'updates', 'backup', 'connectivity', 'errors']);
export type DiagnosticScope = z.infer<typeof DiagnosticScope>;

/** What each scope contains (its complete field allowlist is the matching `Diagnostic*` schema). */
export const DIAGNOSTIC_SCOPES = {
  versions: 'Runtime, database schema and protocol versions, the running release id, provider CLI versions.',
  health:
    'Runtime health (status, check names with ok/failed, external states), uptime, draining/quarantine, claim and recovery-kit flags, revocation counts, provider sign-in states by provider and mode (no whose, no labels).',
  updates:
    'The update journal summary: state, current/known-good/candidate release ids, hold, read-only, failure and wait codes, last check, the client security floor.',
  backup:
    'Backup state, coverage classes, last success and age, last failure time and stage (no reason text, no destination), restore-drill result.',
  connectivity:
    'Relay connection state, last connection time and error code, active sessions, and 7-day counters of relay connects/disconnects and sessions opened/refused.',
  errors: 'Session error codes and application codes counted per operation name over 7 days.',
} as const satisfies Record<DiagnosticScope, string>;

export const DiagnosticVersions = z.strictObject({
  runtimeVersion: VersionString,
  schemaVersion: z.number().int().min(0).max(1_000_000).nullable(),
  protocol: z.strictObject({
    major: z.number().int().min(1).max(65_535),
    minor: z.number().int().min(0).max(65_535),
  }),
  releaseId: ReleaseId.nullable(),
  providers: z.array(z.strictObject({ provider: ProviderName, version: VersionString.nullable() })).max(16),
});

export const DiagnosticHealth = z.strictObject({
  status: z.enum(['ok', 'degraded', 'starting']),
  uptimeS: Count,
  /** Local checks (`db`, `migrations`, `sessionEndpoint`, …): ok or not, never their detail text. */
  checks: z.array(z.strictObject({ name: Name, ok: z.boolean() })).max(32),
  /** Informational external states (`relay`, `control`, `providers`). */
  external: z
    .array(z.strictObject({ name: Name, state: z.enum(['ok', 'degraded', 'down', 'unknown']) }))
    .max(8),
  draining: z.boolean(),
  quarantined: z.boolean(),
  claimed: z.boolean(),
  claimReported: z.boolean(),
  recovery: z.strictObject({ enrolled: z.boolean(), kitVerified: z.boolean() }),
  revocations: z.strictObject({ pending: Count, applied: Count }),
  /** One row per sign-in: provider, mode, personal or organization, state. Whose it is stays out. */
  providers: z
    .array(
      z.strictObject({
        provider: ProviderName,
        authMode: Name,
        kind: z.enum(['account', 'org']),
        state: ProviderState,
      }),
    )
    .max(64),
});

export const DiagnosticUpdates = z.strictObject({
  state: UpdateJournalState,
  current: ReleaseId,
  knownGood: ReleaseId.nullable(),
  candidate: ReleaseId.nullable(),
  hold: z.boolean(),
  readOnly: z.boolean(),
  failure: Code.nullable(),
  deferredReason: Code.nullable(),
  lastCheckedAt: Timestamp.nullable(),
  /** The running release's client floor (CT-53), or null. */
  clientFloor: ClientFloor.nullable(),
});

export const DiagnosticBackup = z.strictObject({
  state: BackupState,
  lastSuccessAt: Timestamp.nullable(),
  ageS: Count.nullable(),
  coverage: z.array(BackupScope).max(32),
  unprotected: z.array(BackupScope).max(32),
  relogin: z.array(BackupScope).max(32),
  lastFailure: z
    .strictObject({
      at: Timestamp,
      stage: z.enum(['preflight', 'quiesce', 'snapshot', 'dump', 'upload', 'verify']),
    })
    .nullable(),
  recoverable: z.boolean(),
});

export const DiagnosticConnectivity = z.strictObject({
  relay: z.enum(['stopped', 'connecting', 'connected', 'backoff']),
  lastConnectedAt: Timestamp.nullable(),
  /** The relay close code or reason of the last failed connection (`4401`, `wrong_worker`). */
  lastErrorCode: Code.nullable(),
  activeSessions: Count,
  /** Over `DIAGNOSTICS_WINDOW_S` before `createdAt`. */
  counters: z.strictObject({
    relayConnects: Count,
    relayDisconnects: Count,
    sessionsOpened: Count,
    /** Refused at `hello`: no common version or below the client floor. */
    sessionsRefusedVersion: Count,
    handshakeFailures: Count,
  }),
});

export const DiagnosticErrors = z.strictObject({
  /** Most frequent first; `truncated` when more combinations occurred. */
  entries: z
    .array(
      z.strictObject({
        /** `SessionErrorCode` (`internal`, `unavailable`, …). */
        code: Name,
        /** `error.details.code`, if any. */
        appCode: AppErrorCodeName.nullable(),
        /** The request's operation, or null for session-level errors. */
        op: OpName.nullable(),
        count: Count,
        lastAt: Timestamp,
      }),
    )
    .max(200),
  truncated: z.boolean(),
});

export const DIAGNOSTIC_BUNDLE_FORMAT = 'whombat-diagnostics/1';

/**
 * The bundle document: exactly one section per chosen scope, nothing else. Its bytes are
 * `diagnosticBundleBytes(bundle)` (UTF-8 canonical JSON), what `diagnostics.download` streams and
 * `DiagnosticBundleSummary.sha256` hashes.
 */
export const DiagnosticBundle = z.strictObject({
  format: z.literal(DIAGNOSTIC_BUNDLE_FORMAT),
  bundleId: DiagnosticBundleId,
  /** The appliance's content PeerId, so support knows which appliance it describes. */
  appliance: PeerIdString,
  createdAt: Timestamp,
  expiresAt: Timestamp,
  windowS: z.literal(DIAGNOSTICS_WINDOW_S),
  scopes: z.array(DiagnosticScope).min(1).max(6),
  versions: DiagnosticVersions.optional(),
  health: DiagnosticHealth.optional(),
  updates: DiagnosticUpdates.optional(),
  backup: DiagnosticBackup.optional(),
  connectivity: DiagnosticConnectivity.optional(),
  errors: DiagnosticErrors.optional(),
});
export type DiagnosticBundle = z.infer<typeof DiagnosticBundle>;

/** The bytes of a bundle: UTF-8 of its canonical JSON (RFC 8785; integers only). */
export function diagnosticBundleBytes(bundle: unknown): Uint8Array {
  return utf8ToBytes(canonicalJson(bundle));
}

/**
 * A bundle's problems beyond its schema: scopes unique, and exactly the chosen scopes' sections present. An empty
 * list means valid. The runtime stores a bundle only when `DiagnosticBundle` parses it and this returns nothing.
 */
export function diagnosticBundleProblems(bundle: DiagnosticBundle): string[] {
  const problems: string[] = [];
  const chosen = new Set(bundle.scopes);
  if (chosen.size !== bundle.scopes.length) problems.push('duplicate_scope');
  for (const scope of DiagnosticScope.options) {
    const present = bundle[scope] !== undefined;
    if (present && !chosen.has(scope)) problems.push(`unrequested_section:${scope}`);
    if (!present && chosen.has(scope)) problems.push(`missing_section:${scope}`);
  }
  if (diagnosticBundleBytes(bundle).length > DIAGNOSTIC_BUNDLE_MAX_BYTES) problems.push('too_large');
  return problems;
}

export const DiagnosticBundleSummary = z.object({
  bundleId: DiagnosticBundleId,
  scopes: z.array(DiagnosticScope).min(1).max(6),
  createdAt: Timestamp,
  expiresAt: Timestamp,
  /** The owner who created it. */
  createdBy: AccountId,
  /** Byte length and sha256 of `diagnosticBundleBytes(bundle)`. */
  size: z.number().int().min(1).max(DIAGNOSTIC_BUNDLE_MAX_BYTES),
  sha256: Sha256Hex,
  downloads: Count,
  lastDownloadedAt: Timestamp.nullable(),
});
export type DiagnosticBundleSummary = z.infer<typeof DiagnosticBundleSummary>;

/** Owners: generate a bundle now from the chosen scopes (unique). `diagnostics_limit` at `DIAGNOSTICS_MAX_BUNDLES`. */
export const DiagnosticsCreateInput = z.strictObject({
  scopes: z.array(DiagnosticScope).min(1).max(6),
});
export const DiagnosticsCreateOutput = DiagnosticBundleSummary;

export const DiagnosticsRefInput = z.strictObject({ bundleId: DiagnosticBundleId });

/**
 * Owners: the exact content (a query). `bundle` is the stored document unchanged (not stripped); the client checks
 * `sha256(diagnosticBundleBytes(bundle)) === summary.sha256`, so what it shows is what a download contains, and may
 * parse it with `DiagnosticBundle` for a structured view (showing the raw JSON when a newer runtime's bundle doesn't
 * parse).
 */
export const DiagnosticsPreviewOutput = z.object({
  summary: DiagnosticBundleSummary,
  bundle: JsonValue,
});

/**
 * Owners: `diagnostics.download {bundleId}` is an export op, read only through `open{spec: {kind: 'export', op,
 * input}}`: `opened.meta {contentType: 'application/json', name: 'whombat-diagnostics-<bundleId>.json', size}`, DATA
 * = `diagnosticBundleBytes(bundle)`, `stream_done.sha256 === summary.sha256`. Each download is a signed
 * `diagnostics.downloaded` event.
 */
export const DiagnosticsDownloadInput = DiagnosticsRefInput;

export const DiagnosticsListInput = z.strictObject({});
export const DiagnosticsListOutput = z.object({
  bundles: z.array(DiagnosticBundleSummary).max(DIAGNOSTICS_MAX_BUNDLES),
});

/** `deleted: false` when it was already gone (expired or deleted). */
export const DiagnosticsDeleteOutput = z.object({ deleted: z.boolean() });

/** Payload of the signed `diagnostics.*` appliance events. */
export const DiagnosticsAuditPayload = z.object({
  bundleId: DiagnosticBundleId,
  scopes: z.array(DiagnosticScope).min(1).max(6),
  size: z.number().int().min(1).max(DIAGNOSTIC_BUNDLE_MAX_BYTES),
  sha256: Sha256Hex,
  /** The owner who acted; null for expiry. */
  byAccountId: AccountId.nullable(),
});
