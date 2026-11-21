/**
 * Customer-approved diagnostic bundles (contracts 0.5.3 CT-52, assignment §12; docs/decisions/managed-runtime.md
 * MR-42). The person generates a bundle from chosen scopes, reads exactly what it contains (`preview`), downloads it
 * through an export stream and sends it to support themselves. **Nothing is uploaded**: no code here talks to control,
 * the manager or the network.
 *
 * Each scope is filled only from allowlisted sources (versions, local health, the manager's update facts, the backup
 * summary, connectivity counters, session error codes) and every value goes through the contract's strict schemas,
 * so free text (health details, backup reasons, messages, names, paths) can't enter. A bundle is stored only when
 * `DiagnosticBundle` parses it and `diagnosticBundleProblems` finds nothing. Bundles expire after 7 days; create,
 * download, delete and expiry are signed appliance events.
 */

import { createHash, randomBytes } from 'node:crypto';
import { PROVIDER_BUNDLES } from '@whombat/agent-runtime/providers';
import { summarizeBackup } from '@whombat/control-contracts/local';
import {
  BackupScope,
  DIAGNOSTIC_BUNDLE_FORMAT,
  DIAGNOSTICS_MAX_BUNDLES,
  DIAGNOSTICS_TTL_S,
  DIAGNOSTICS_WINDOW_S,
  DiagnosticBundle,
  type DiagnosticScope,
  diagnosticBundleBytes,
  diagnosticBundleProblems,
  SESSION_PROTOCOL,
} from '@whombat/protocol/session';
import { ReleaseId, VersionString } from '@whombat/release';
import { and, asc, count, eq, gt, lte } from 'drizzle-orm';
import { z } from 'zod';
import { checkSchema } from '../db/migrate';
import { diagnosticBundles } from '../db/schema/index';
import { ApiError, notFound } from '../lib/errors';
import type { Services } from '../services';
import { buildInfo } from '../version';
import { appendApplianceEvent } from './audit';
import { boxBackupStatus } from './box-backup';
import type { RuntimeCounters } from './counters';
import type { ApplianceFacts } from './dispatcher';
import { providerLogins, signInsAvailable } from './providers/service';
import type { RelayStatus } from './session/relay-client';
import { requirePerson, type SessionPrincipal, type TrustService } from './trust';

type Row = typeof diagnosticBundles.$inferSelect;

/** Codes and names in a bundle (`LocalIdent`): anything else becomes null. */
const Code = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const code = (v: unknown): string | null => (Code.safeParse(v).success ? (v as string) : null);
const valid = <T>(schema: z.ZodType<T>, v: unknown): T | null => {
  const r = schema.safeParse(v);
  return r.success ? r.data : null;
};

export interface DiagnosticsContext {
  services: Services;
  trust: TrustService;
  counters: RuntimeCounters;
  facts: () => ApplianceFacts;
  relay: () => RelayStatus;
  activeSessions: () => number;
}

const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export class DiagnosticsService {
  constructor(private readonly ctx: DiagnosticsContext) {}

  private get db() {
    return this.ctx.services.db;
  }

  private now(): Date {
    return this.ctx.services.clock();
  }

  private summary(row: Row) {
    return {
      bundleId: row.id,
      scopes: row.scopes as DiagnosticScope[],
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      createdBy: row.createdByAccountId,
      size: row.size,
      sha256: row.sha256,
      downloads: row.downloads,
      lastDownloadedAt: row.lastDownloadedAt?.toISOString() ?? null,
    };
  }

  private payload(row: Pick<Row, 'id' | 'scopes' | 'size' | 'sha256'>, by: string | null) {
    return { bundleId: row.id, scopes: row.scopes, size: row.size, sha256: row.sha256, byAccountId: by };
  }

  /** A live (unexpired) bundle, or `not_found`. */
  private async live(bundleId: string): Promise<Row> {
    const [row] = await this.db
      .select()
      .from(diagnosticBundles)
      .where(and(eq(diagnosticBundles.id, bundleId), gt(diagnosticBundles.expiresAt, this.now())));
    if (!row) throw notFound('Diagnostic bundle');
    return row;
  }

  /* Sections: allowlisted sources only ---------------------------------------------------------------------- */

  private versions() {
    const build = buildInfo();
    const releaseId =
      valid(ReleaseId, this.ctx.services.config.WHOMBAT_RELEASE_ID) ??
      valid(ReleaseId, this.ctx.facts().update?.current);
    return {
      runtimeVersion: valid(VersionString, build.version) ?? '0.0.0',
      schemaVersion: this.ctx.facts().appliance.schemaVersion,
      protocol: { major: SESSION_PROTOCOL.major, minor: SESSION_PROTOCOL.minor },
      releaseId,
      // The pinned provider runtimes (PV-01): a managed turn runs on nothing else.
      providers: Object.entries(PROVIDER_BUNDLES).map(([provider, b]) => ({
        provider,
        version: valid(VersionString, b.version),
      })),
    };
  }

  private async health(principal: SessionPrincipal) {
    const services = this.ctx.services;
    let dbOk = true;
    try {
      await services.sql`select 1`;
    } catch {
      dbOk = false;
    }
    let migrationsOk = false;
    if (dbOk)
      try {
        migrationsOk = (await checkSchema(services.sql)).access !== 'none';
      } catch {
        migrationsOk = false;
      }
    const relay = this.ctx.relay();
    const status = await this.ctx.trust.applianceStatus();
    // The sign-ins wherever this runtime holds them: its own root or the runner's, through the bridge (SUB-56).
    const logins = providerLogins(services);
    const rows =
      signInsAvailable(services.config) && logins.readable
        ? await logins.statusRows(principal).catch(() => [])
        : [];
    const ok = dbOk && migrationsOk;
    return {
      status: ok ? ('ok' as const) : ('degraded' as const),
      uptimeS: Math.max(0, Math.floor((this.now().getTime() - this.ctx.counters.startedAt.getTime()) / 1000)),
      checks: [
        { name: 'db', ok: dbOk },
        { name: 'migrations', ok: migrationsOk },
        { name: 'sessionEndpoint', ok: relay !== 'stopped' },
      ],
      external: [
        {
          name: 'relay',
          state:
            relay === 'connected'
              ? ('ok' as const)
              : relay === 'backoff'
                ? ('down' as const)
                : ('unknown' as const),
        },
      ],
      draining: services.maintenance.draining,
      quarantined: services.maintenance.quarantined,
      claimed: status.claimed,
      claimReported: status.claimReported,
      recovery: { enrolled: status.recovery.enrolled, kitVerified: status.recovery.kitVerified },
      revocations: { pending: status.revocationsPending, applied: status.revocationsApplied },
      // Provider, mode and state: the person's sign-ins (one-person.md OP-S09), never a label.
      providers: rows.map((r) => ({
        provider: r.provider,
        authMode: r.authMode,
        kind: 'account' as const,
        state: r.state,
      })),
    };
  }

  private updates() {
    const update = this.ctx.facts().update;
    if (!update)
      throw new ApiError(
        'conflict',
        'The appliance has no update facts from its manager yet. Leave out “updates” for now.',
      );
    return {
      state: update.state,
      current: valid(ReleaseId, update.current) ?? 'unknown',
      // Not facts the runtime is told (the manager's journal has them).
      knownGood: null,
      candidate: valid(ReleaseId, update.candidate),
      hold: false,
      readOnly: this.ctx.services.schemaAccess === 'read-only',
      failure: code(update.failure),
      deferredReason: code(update.deferredReason),
      lastCheckedAt: update.lastCheckedAt,
      clientFloor: this.ctx.trust.clientFloor,
    };
  }

  private async backup() {
    // The service's own status when the manager's facts carry none (the manager doesn't forward it).
    const b = summarizeBackup(
      (await boxBackupStatus(this.ctx.services)) ?? this.ctx.facts().backup,
      BackupScope.options,
    );
    return {
      state: b.state,
      lastSuccessAt: b.lastSuccessAt,
      ageS: b.ageS,
      coverage: b.coverage,
      unprotected: b.unprotected,
      relogin: b.relogin,
      // The time and stage, never the reason text or the destination.
      lastFailure: b.lastFailure ? { at: b.lastFailure.at, stage: b.lastFailure.stage } : null,
      recoverable: b.recoverable,
    };
  }

  private connectivity() {
    const c = this.ctx.counters;
    return {
      relay: this.ctx.relay(),
      lastConnectedAt: c.lastRelayConnectedAt?.toISOString() ?? null,
      lastErrorCode: code(c.lastRelayErrorCode),
      activeSessions: this.ctx.activeSessions(),
      counters: {
        relayConnects: c.count('relayConnects'),
        relayDisconnects: c.count('relayDisconnects'),
        sessionsOpened: c.count('sessionsOpened'),
        sessionsRefusedVersion: c.count('sessionsRefusedVersion'),
        handshakeFailures: c.count('handshakeFailures'),
      },
    };
  }

  private errors() {
    const all = this.ctx.counters.errorCounts();
    return {
      entries: all.slice(0, 200).map((e) => ({
        code: e.code,
        appCode: e.appCode,
        op: e.op,
        count: e.count,
        lastAt: e.lastAt.toISOString(),
      })),
      truncated: all.length > 200,
    };
  }

  /* Ops ------------------------------------------------------------------------------------------------------ */

  /** `diagnostics.create {scopes}` (the person). */
  async create(viewer: SessionPrincipal, input: { scopes: DiagnosticScope[] }) {
    const { endpointId, account } = requirePerson(viewer);
    const scopes = [...new Set(input.scopes)];
    const now = this.now();
    const [{ n } = { n: 0 }] = await this.db
      .select({ n: count() })
      .from(diagnosticBundles)
      .where(gt(diagnosticBundles.expiresAt, now));
    if (n >= DIAGNOSTICS_MAX_BUNDLES)
      throw new ApiError('conflict', 'There are already 10 diagnostic bundles. Delete one first.', {
        details: { code: 'diagnostics_limit' },
      });
    const id = `diag_${randomBytes(12).toString('base64url')}`;
    const expiresAt = new Date(now.getTime() + DIAGNOSTICS_TTL_S * 1000);
    const draft: Record<string, unknown> = {
      format: DIAGNOSTIC_BUNDLE_FORMAT,
      bundleId: id,
      appliance: this.ctx.trust.appliancePeerId,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      windowS: DIAGNOSTICS_WINDOW_S,
      scopes,
    };
    if (scopes.includes('versions')) draft.versions = this.versions();
    if (scopes.includes('health')) draft.health = await this.health(viewer);
    if (scopes.includes('updates')) draft.updates = this.updates();
    if (scopes.includes('backup')) draft.backup = await this.backup();
    if (scopes.includes('connectivity')) draft.connectivity = this.connectivity();
    if (scopes.includes('errors')) draft.errors = this.errors();
    // The contract is the allowlist: a bundle that doesn't parse, or has sections nobody chose, is never stored.
    const parsed = DiagnosticBundle.safeParse(draft);
    const problems = parsed.success ? diagnosticBundleProblems(parsed.data) : ['schema'];
    if (!parsed.success || problems.length) {
      this.ctx.services.log.error(
        { problems: problems.slice(0, 5) },
        'diagnostic bundle refused by its schema',
      );
      throw new ApiError('internal', 'The diagnostic bundle couldn’t be built safely. Nothing was stored.');
    }
    const bytes = diagnosticBundleBytes(parsed.data);
    const row = {
      id,
      scopes,
      bundle: parsed.data as unknown as Record<string, unknown>,
      createdByAccountId: account.id,
      createdAt: now,
      expiresAt,
      size: bytes.length,
      sha256: sha256Hex(bytes),
    };
    await this.ctx.services.pipeline.transactAccount(async (tx) => {
      await tx.insert(diagnosticBundles).values(row);
      await appendApplianceEvent(tx, this.ctx.services.custody, {
        type: 'diagnostics.created',
        actorAccountId: account.id,
        endpointId,
        payload: this.payload(row, account.id),
        at: now,
      });
    });
    return this.summary({ ...row, downloads: 0, lastDownloadedAt: null });
  }

  /** `diagnostics.preview` (the person, a query): the stored document unchanged. */
  async preview(viewer: SessionPrincipal, input: { bundleId: string }) {
    requirePerson(viewer);
    const row = await this.live(input.bundleId);
    return { summary: this.summary(row), bundle: row.bundle };
  }

  async list(viewer: SessionPrincipal) {
    requirePerson(viewer);
    const rows = await this.db
      .select()
      .from(diagnosticBundles)
      .where(gt(diagnosticBundles.expiresAt, this.now()))
      .orderBy(asc(diagnosticBundles.createdAt))
      .limit(DIAGNOSTICS_MAX_BUNDLES);
    return { bundles: rows.map((r) => this.summary(r)) };
  }

  async delete(viewer: SessionPrincipal, input: { bundleId: string }) {
    const { endpointId, account } = requirePerson(viewer);
    const now = this.now();
    const deleted = await this.ctx.services.pipeline.transactAccount(async (tx) => {
      const [row] = await tx
        .delete(diagnosticBundles)
        .where(eq(diagnosticBundles.id, input.bundleId))
        .returning();
      if (!row) return false;
      await appendApplianceEvent(tx, this.ctx.services.custody, {
        type: 'diagnostics.deleted',
        actorAccountId: account.id,
        endpointId,
        payload: this.payload(row, account.id),
        at: now,
      });
      return true;
    });
    return { deleted };
  }

  /**
   * `diagnostics.download` (an export stream only): the stored document's bytes, and a signed `downloaded` event.
   * The bytes are re-derived from the stored document and must hash to the summary's sha256.
   */
  async download(viewer: SessionPrincipal, input: { bundleId: string }) {
    const { endpointId, account } = requirePerson(viewer);
    const row = await this.live(input.bundleId);
    const bytes = diagnosticBundleBytes(row.bundle);
    if (sha256Hex(bytes) !== row.sha256)
      throw new ApiError('internal', 'The stored bundle changed. Delete it.');
    const now = this.now();
    await this.ctx.services.pipeline.transactAccount(async (tx) => {
      await tx
        .update(diagnosticBundles)
        .set({ downloads: row.downloads + 1, lastDownloadedAt: now })
        .where(eq(diagnosticBundles.id, row.id));
      await appendApplianceEvent(tx, this.ctx.services.custody, {
        type: 'diagnostics.downloaded',
        actorAccountId: account.id,
        endpointId,
        payload: this.payload(row, account.id),
        at: now,
      });
    });
    return { bytes, name: `whombat-diagnostics-${row.id}.json` };
  }

  /** Deletes expired bundles, each with a signed `diagnostics.expired` event. */
  async sweep(): Promise<number> {
    const now = this.now();
    return this.ctx.services.pipeline.transactAccount(async (tx) => {
      const gone = await tx
        .delete(diagnosticBundles)
        .where(lte(diagnosticBundles.expiresAt, now))
        .returning();
      for (const row of gone)
        await appendApplianceEvent(tx, this.ctx.services.custody, {
          type: 'diagnostics.expired',
          actorAccountId: null,
          endpointId: null,
          payload: this.payload(row, null),
          at: now,
        });
      return gone.length;
    });
  }
}
