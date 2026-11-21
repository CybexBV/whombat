/**
 * The runtime's admin socket (MA-10, MA-11, MA-13; `@whombat/control-contracts/local`, CT-23, docs/local-ipc.md):
 * HTTP/1.1 with JSON bodies on a unix socket (`WHOMBAT_ADMIN_SOCKET`, `/run/whombat/admin.sock`), for the manager
 * and the backup service only.
 *
 *   GET  /health        → RuntimeHealth (200, or 503 when not ok): local health only — database, schema
 *                         compatibility, the session endpoint; never a provider call. `external` is informational,
 *                         and so is `checks.maintenance` (housekeeping jobs that stopped finishing their runs).
 *   POST /drain         DrainRequest {v, requestId, reason, scope, releaseId?, leaseMs} → DrainStatus
 *                         {v, requestId, draining, safe, blockers[], estimatedMs}; 409 `busy` while another request id
 *                         holds it. Idempotent per request id, which also renews the lease.
 *   POST /resume        ResumeRequest {v, requestId} → ResumeResponse
 *   POST /claim-window  ClaimWindowRequest {v, required, openUntil} → AdminOk
 *   POST /claim-lookup  ClaimLookupLeaseRequest {v, lookup, expiresAt} | {v, lookup: null} → AdminOk: the lookup
 *                         number control leased to this device (CC-03); it is the box's "waiting to be claimed"
 *                         presence: the console shows the letters only while it is live, never the number (CC-13)
 *   POST /facts         FactsRequest {v, backup, update} → AdminOk (feeds `appliance.status`); read tolerantly, so a
 *                         newer manager's facts are taken as far as this runtime understands them (MD-19, `facts.ts`)
 *   GET  /facts         RuntimeFacts {v, activeSessions, claimed, claimReported, recovery, revocations, draining,
 *                         relay, clientAdapters} for the manager's `status.report` (0.9.0: the adapter levels, CT-73)
 *   POST /clients       ClientsPushRequest {v, clients, channel} → AdminOk: the manager's AI clients (CT-73), whenever
 *                         one changes and at runtime start; the runner runs exactly the installed executables
 *   POST /licence       LicencePushRequest {v, token | null, highWater} → LicencePushResponse {v, licence}: the
 *                         manager's licence token and time high-water mark (LC-06, CT-77, MR-57); 400 `bad_request`
 *                         for a token that doesn't verify, 409 `stale` for an older `iat`; `licence` is null
 *                         while unclaimed
 *
 * Access: Node can't read a unix socket peer's credentials (no SO_PEERCRED), so the socket is created 0660 in a
 * directory the manager and the backup service reach through their group (systemd `RuntimeDirectory` with the
 * runtime user and an `whombat-admin` group); nothing else on the appliance can connect (MR-15).
 */
import { chmodSync, chownSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  ADMIN_PATHS,
  ClaimLookupLeaseRequest,
  ClaimWindowRequest,
  ClientsPushRequest,
  claimLookupLeaseValid,
  type DrainBlocker,
  DrainRequest,
  type DrainStatus,
  LicencePushRequest,
  LicencePushResponse,
  LOCAL_API_VERSION,
  ResumeRequest,
  RuntimeFacts,
  type RuntimeHealth,
} from '@whombat/control-contracts/local';
import type { SkippedItem } from '@whombat/protocol/session';
import { inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { stepsInFlight } from '../automations/store';
import { aiClients, clientAdapters, ManagerClients } from '../clients/service';
import { checkSchema } from '../db/migrate';
import { dispatches } from '../db/schema/index';
import { describeStale } from '../lib/housekeeping';
import { buildInfo } from '../version';
import { acceptFactsPush } from './facts';
import { groupId } from './groups';
import type { ManagedRuntime } from './runtime';
import type { SessionEndpoint } from './session/endpoint';
import { tellUpdateInbox } from './update-inbox';

const MAX_BODY = 64 * 1024;

/** `GET /facts`: runtime metadata for the manager's `status.report` (contracts 0.5.0 `RuntimeFacts`, CT-37). */
export const RUNTIME_FACTS_PATH = '/facts';

/** Printable ASCII for local IPC free text (CT-23): typographic quotes folded, the rest dropped. */
export function ascii(text: string, max = 300): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/·/g, '-')
    .replace(/[^\x20-\x7e]/g, '')
    .slice(0, max);
}

function ident(text: string): string {
  const clean = text.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64);
  return clean || 'unknown';
}

export interface AdminSocketOptions {
  runtime: ManagedRuntime;
  endpoint: SessionEndpoint | null;
  /** The release the manager activated (`WHOMBAT_RELEASE_ID`), else this build's version. */
  releaseId?: string;
  /** How long a turn or job is expected to take to finish, for `estimatedMs`. */
  estimateMs?: number;
}

export class AdminSocket {
  private server: Server | null = null;
  private readonly skippedLogged = new Set<string>();

  constructor(private readonly options: AdminSocketOptions) {}

  async listen(path: string): Promise<void> {
    if (existsSync(path)) unlinkSync(path);
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.options.runtime.services.log.error({ err: String(err) }, 'admin socket request failed');
        send(res, 500, { error: { code: 'internal', message: 'internal error' } });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => resolve());
    });
    chmodSync(path, 0o660);
    this.applyGroup(path);
    this.server = server;
  }

  /**
   * The socket's group is the access control (MR-15): `WHOMBAT_ADMIN_GROUP` (`whombat-admin`). A setgid runtime
   * directory already gives it that group; otherwise it is set here when this process is a member of the group. A
   * socket without it is reported: the manager couldn't connect.
   */
  private applyGroup(path: string): void {
    const services = this.options.runtime.services;
    const name = services.config.WHOMBAT_ADMIN_GROUP;
    const gid = groupId(name);
    if (gid === null) {
      services.log.warn({ group: name }, 'admin socket: no such group; only this user can connect');
      return;
    }
    if (statSync(path).gid === gid) return;
    const mine = [process.getgid?.(), ...(process.getgroups?.() ?? [])];
    if (!mine.includes(gid)) {
      services.log.warn(
        { group: name },
        'admin socket: this user is not in its group; the manager can’t connect',
      );
      return;
    }
    chownSync(path, -1, gid);
  }

  /** What a facts push had that this runtime doesn't know, logged once per path and value (MD-19). */
  private logSkipped(skipped: SkippedItem[], kept: string[]): void {
    for (const s of skipped) {
      const key = `${s.path.join('.')}=${s.value}`;
      if (this.skippedLogged.has(key)) continue;
      if (this.skippedLogged.size >= 256) return;
      this.skippedLogged.add(key);
      this.options.runtime.services.log.warn(
        { path: s.path.join('.'), value: ident(s.value), action: s.action, kept },
        'facts: the manager sent something this runtime doesn’t know; left it out',
      );
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === ADMIN_PATHS.health) {
      const health = await this.health();
      send(res, health.status === 'ok' ? 200 : 503, health);
      return;
    }
    if (req.method === 'GET' && path === RUNTIME_FACTS_PATH) {
      send(res, 200, await this.runtimeFacts());
      return;
    }
    if (req.method !== 'POST') {
      send(res, 404, { error: { code: 'not_found', message: 'no such endpoint' } });
      return;
    }
    const body = await readJson(req);
    if (body === undefined) {
      send(res, 400, { error: { code: 'bad_request', message: 'the body must be JSON (at most 64 KiB)' } });
      return;
    }
    const parse = <S extends z.ZodType>(schema: S): z.output<S> | null => {
      const parsed = schema.safeParse(body);
      if (parsed.success) return parsed.data;
      send(res, 400, {
        error: { code: 'bad_request', message: ascii(parsed.error.issues[0]?.message ?? 'invalid', 500) },
      });
      return null;
    };
    const { runtime } = this.options;
    const gate = runtime.services.maintenance;
    switch (path) {
      case ADMIN_PATHS.drain: {
        const input = parse(DrainRequest);
        if (!input) return;
        const held = gate.drain(input.reason, runtime.services.clock(), {
          requestId: input.requestId,
          scope: input.scope,
          leaseMs: input.leaseMs,
        });
        if (held === 'busy') {
          send(res, 409, { error: { code: 'busy', message: 'another drain holds the runtime' } });
          return;
        }
        send(res, 200, await this.drainStatus(input.requestId, input.scope));
        return;
      }
      case ADMIN_PATHS.resume: {
        const input = parse(ResumeRequest);
        if (!input) return;
        if (gate.resume(input.requestId) === 'busy') {
          send(res, 409, { error: { code: 'busy', message: 'another drain holds the runtime' } });
          return;
        }
        // Approved actions that waited are re-evaluated; the engines pick up the rest on their own ticks.
        void runtime.services.approvals.recover().catch(() => {});
        void runtime.services.automations.tick().catch(() => {});
        send(res, 200, { v: LOCAL_API_VERSION, requestId: input.requestId, draining: gate.draining });
        return;
      }
      case ADMIN_PATHS.claimWindow: {
        const input = parse(ClaimWindowRequest);
        if (!input) return;
        await runtime.trust.setClaimWindow({
          required: input.required,
          openUntil: input.openUntil ? new Date(input.openUntil) : null,
        });
        send(res, 200, { v: LOCAL_API_VERSION, ok: true });
        return;
      }
      case ADMIN_PATHS.claimLookup: {
        const input = parse(ClaimLookupLeaseRequest);
        if (!input) return;
        if (!claimLookupLeaseValid(input)) {
          send(res, 400, {
            error: { code: 'bad_request', message: 'expiresAt goes with a lookup number and nothing else' },
          });
          return;
        }
        // Memory only (MR-53): the manager pushes it again at every renewal and after a runtime restart.
        runtime.trust.ceremony.setLease(
          input.lookup !== null && input.expiresAt
            ? { lookup: input.lookup, expiresAt: new Date(input.expiresAt) }
            : null,
        );
        send(res, 200, { v: LOCAL_API_VERSION, ok: true });
        return;
      }
      case ADMIN_PATHS.facts: {
        // Tolerantly (MD-19): a newer manager's facts are taken as far as this runtime understands them.
        const push = acceptFactsPush(runtime.dispatcher.facts, body);
        if (!push.ok) {
          send(res, 400, {
            error: { code: 'bad_request', message: ascii(push.error.issues[0]?.message ?? 'invalid', 500) },
          });
          return;
        }
        this.logSkipped(push.skipped, push.kept);
        const before = runtime.dispatcher.facts.update;
        runtime.dispatcher.facts = { ...runtime.dispatcher.facts, backup: push.backup, update: push.update };
        // An update came to wait for the owner's yes, or stopped waiting: the Inbox reads again (ask-before-updating.md).
        await tellUpdateInbox(runtime.services, before, push.update).catch(() => undefined);
        // The running tuple's client floor (CT-53): kept across restarts; no update facts keep the last one.
        await runtime.trust.setClientFloor(push.clientFloor);
        send(res, 200, { v: LOCAL_API_VERSION, ok: true });
        return;
      }
      case ADMIN_PATHS.clients: {
        const input = parse(ClientsPushRequest);
        if (!input) return;
        const clients = await aiClients(runtime.services);
        if (clients instanceof ManagerClients) await clients.apply(input);
        send(res, 200, { v: LOCAL_API_VERSION, ok: true });
        return;
      }
      case ADMIN_PATHS.licence: {
        const input = parse(LicencePushRequest);
        if (!input) return;
        const outcome = await runtime.licence.push(input);
        if (!outcome.ok) {
          send(res, outcome.status, { error: { code: outcome.code, message: ascii(outcome.message) } });
          return;
        }
        send(res, 200, LicencePushResponse.parse({ v: LOCAL_API_VERSION, licence: outcome.licence }));
        return;
      }
      default:
        send(res, 404, { error: { code: 'not_found', message: 'no such endpoint' } });
    }
  }

  /**
   * What the manager reports to control (`status.report`) and can't know itself: metadata only, no content
   * (contracts 0.5.0 `RuntimeFacts`, CT-37; validated before it is sent).
   */
  async runtimeFacts(): Promise<RuntimeFacts> {
    const { runtime, endpoint } = this.options;
    const status = await runtime.trust.applianceStatus();
    return RuntimeFacts.parse({
      v: LOCAL_API_VERSION,
      activeSessions: runtime.sessions.size,
      claimed: status.claimed,
      claimReported: status.claimReported,
      recovery: { enrolled: status.recovery.enrolled, kitVerified: status.recovery.kitVerified },
      revocations: { pending: status.revocationsPending, applied: status.revocationsApplied },
      draining: runtime.services.maintenance.draining,
      quarantined: runtime.services.maintenance.quarantined,
      relay: endpoint?.status().relay ?? 'stopped',
      // The bundles the manager may install for this runtime (CT-73): its adapter level per provider.
      clientAdapters: clientAdapters(),
    });
  }

  /** Local health only (MA-11): never a provider or network call. */
  async health(): Promise<RuntimeHealth> {
    const { runtime, endpoint } = this.options;
    const services = runtime.services;
    const build = buildInfo();
    let db: RuntimeHealth['checks']['db'] = { ok: true };
    let migrations: RuntimeHealth['checks']['migrations'] = {
      ok: false,
      compatible: false,
      access: 'none',
      schemaVersion: 0,
    };
    try {
      await services.sql`select 1`;
    } catch (err) {
      db = { ok: false, detail: ascii(String(err), 500) };
    }
    if (db.ok) {
      try {
        const check = await checkSchema(services.sql);
        migrations = {
          ok: check.access !== 'none',
          compatible: check.access !== 'none',
          access: check.access,
          verdict: ident(check.verdict),
          schemaVersion: check.database.version,
          ...(check.access === 'none' ? { detail: ascii(check.reason, 500) } : {}),
        };
      } catch (err) {
        migrations = { ...migrations, detail: ascii(String(err), 500) };
      }
    }
    const status = endpoint?.status();
    const sessionEndpoint = endpoint
      ? {
          ok: true,
          detail: ascii(
            `relay ${status?.relay}, direct ${status?.direct?.listening ? `:${status.direct.port} (${status.direct.sessions} sessions)` : 'off'}, ${status?.sessions} sessions`,
          ),
        }
      : { ok: false, detail: 'the session endpoint is not configured' };
    const relay = status?.relay === 'connected' ? 'ok' : status?.relay === 'backoff' ? 'down' : 'unknown';
    const stale = describeStale(services.housekeeping.jobs());
    const maintenance = stale ? { ok: false, detail: ascii(stale, 500) } : { ok: true };
    // A stale job is reported, not counted against `status`: a job can keep failing for a reason outside the box (a
    // service that's down), and a degraded runtime makes the manager undo an update.
    const ok = db.ok && migrations.ok && sessionEndpoint.ok;
    return {
      v: LOCAL_API_VERSION,
      status: ok ? 'ok' : 'degraded',
      releaseId: ident(this.options.releaseId ?? build.version),
      version: ident(build.version),
      checks: { db, migrations, sessionEndpoint, maintenance },
      external: { relay },
      draining: services.maintenance.draining,
    };
  }

  /** What still runs: turns, approved executions, automation steps mid-call, session commands, write transactions. */
  async drainStatus(requestId: string, scope: 'all' | 'writes'): Promise<DrainStatus> {
    const { runtime } = this.options;
    const services = runtime.services;
    const now = services.clock();
    const blockers: z.input<typeof DrainBlocker>[] = [];
    if (scope === 'all') {
      const turns = await services.db
        .select({ id: dispatches.id, claimedAt: dispatches.claimedAt })
        .from(dispatches)
        .where(inArray(dispatches.state, ['claimed', 'running']))
        .limit(100);
      for (const t of turns)
        blockers.push({
          kind: 'turn',
          id: ident(t.id),
          description: 'an agent turn is finishing',
          since: (t.claimedAt ?? now).toISOString(),
          estimatedMs: this.options.estimateMs ?? 60_000,
        });
      const executing = await services.db.execute<{ id: string }>(
        sql`select id from approvals where execution->>'state' = 'running' limit 100`,
      );
      for (const row of executing as unknown as { id: string }[])
        blockers.push({
          kind: 'approval-execution',
          id: ident(row.id),
          description: 'an approved action is executing',
          since: now.toISOString(),
        });
      for (const step of await stepsInFlight(services.db, now))
        blockers.push({
          kind: 'job',
          id: ident(`${step.runId}.${step.idx}`),
          description: ascii(`an automation step is finishing: ${step.name}`),
          since: step.since.toISOString(),
          estimatedMs: 10_000,
        });
      if (runtime.receipts.inflightCount > 0)
        blockers.push({
          kind: 'job',
          id: 'session-commands',
          description: ascii(`${runtime.receipts.inflightCount} session command(s) are executing`),
          since: now.toISOString(),
          estimatedMs: 5_000,
        });
    }
    if (services.maintenance.activeWrites > 0)
      blockers.push({
        kind: 'other',
        id: 'write-transactions',
        description: ascii(`${services.maintenance.activeWrites} write transaction(s) in flight`),
        since: now.toISOString(),
        estimatedMs: 1_000,
      });
    // A turn that only waits for a T3 Code thread hands that wait over once it hears an update waits for it.
    if (scope === 'all' && blockers.some((b) => b.kind === 'turn')) services.maintenance.noteUpdateWaits(now);
    const estimatedMs = Math.min(
      86_400_000,
      blockers.reduce((max, b) => Math.max(max, b.estimatedMs ?? 1_000), 0),
    );
    return {
      v: LOCAL_API_VERSION,
      requestId,
      draining: services.maintenance.held !== null,
      safe: blockers.length === 0,
      blockers,
      estimatedMs,
    } as DrainStatus;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return undefined;
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
