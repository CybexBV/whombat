/**
 * The runner side of the agent runtime (ARCHITECTURE "Agent runtime", runtime-server.md):
 *
 * - `claim` long-polls for a queued dispatch the runner can run and leases it (`claimed`, lease + attempt).
 *   Invariant: at most one in-flight turn per (agent, conversation, thread), and a turn at a conversation's top level
 *   alone there (hermes-native.md HN-T01, HN-T02) — claims are serialized by an advisory lock and skip any dispatch
 *   whose agent already has a claimed / running turn in its place; later requests there coalesce into the queued
 *   follow-up (domain/dispatch.ts) and run as the next turn.
 * - `progress` renews the lease, keeps "{name} is thinking" alive, stores the provider session and answers
 *   `cancel` when a person paused or took over the run (or the dispatch was cancelled).
 * - `complete` finishes the dispatch. A failure (crash) is retried once after a backoff; the second failure
 *   is final: live runs of the dispatch stop as failed and the agent posts a quiet error.
 * - `heartbeat` is runner liveness: it renews leases of the dispatches the runner still holds and lists the
 *   ones to stop. `sweep` requeues dispatches whose lease expired (runner gone) under the same retry rule.
 *   Each beat also carries what the runner found on the host (Claude Code / Codex ready or not,
 *   docs/decisions/agent-setup.md): `setupStatus` summarizes it for Settings and onboarding, and a queued
 *   dispatch no connected runner can run ends with the agent saying why (`sweepUnrunnable`).
 * - `gitCredentials` hands out a short-lived token for the agent's branch; pushing needs the branch key.
 *
 * Dispatch bookkeeping is operational state: it goes through `pipeline.transactAccount` (transaction, no
 * signed events), like issuing agent tokens. What agents *do* is signed through the commands.
 */

import { isScriptedHermes } from '@whombat/agent-runtime';
import {
  claudeExtraUsageRequired,
  hermesProfileBusy,
  providerDeclinedContent,
} from '@whombat/agent-runtime/failures';
import {
  type AgentProvider,
  type AgentSetupStatus,
  type ChatRuntime,
  type DispatchContext,
  defaultAgentProvider,
  LIVE_PROVIDERS,
  type ProviderSetup,
  RUNNER_SHUTDOWN,
  type RunnerLease,
  type RunnerStatus,
  type runnerApi,
  type TurnFailureReport,
  topics,
  type UnrunnableCause,
  unrunnableReply,
} from '@whombat/core';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { forgetEndedTurnSecrets, forgetTurnSecrets } from '../agent-commands/secrets';
import { slidTokenExpiry } from '../auth/agent-tokens';
import { HANDED_OVER_ERROR } from '../automations/handed-over';
import { forgetLateMailSession } from '../automations/mail-text';
import { previewsFor } from '../browser/previews';
import { correctRanOn } from '../chats/ran-on';
import { clientJustInstalled } from '../clients/service';
import { failDispatchRuns } from '../commands/agent-runs';
import { settleAgentStatus } from '../commands/agent-status';
import type { Tx } from '../db/client';
import { dispatches, feedbackAssessments, principals, runs, searchAnswers } from '../db/schema/index';
import { CACHE_MISS_WARN_AFTER, type CacheJudgement, type StoredUsage } from '../domain/cache-result';
import { followDispatch } from '../domain/plan-follow';
import { personOfAccountIn } from '../domain/turn-person';
import { stoppableTurn } from '../domain/turn-stop';
import { AssessmentRefused, parseRefusedError, refusedError } from '../feedback/assessment';
import { AssessmentAlreadyRecorded } from '../feedback/dispatch';
import { gatewayRoute, recordGatewayRoute, sessionOnOtherRoute } from '../gateway/claim';
import { gatewaySwitchesAnywhere } from '../gateway/store';
import { homeOf, sessionForgotten } from '../hermes-home/housekeeping';
import { ApiError, notFound } from '../lib/errors';
import { DEFAULT_MCP_LIMITS, type McpLimits, McpRateLimiter } from '../mcp/rate-limit';
import { mcpToolList } from '../mcp/server';
import { loadPrincipalRow } from '../read/principals';
import { toSearchAnswer } from '../read/search';
import type { Services } from '../services';
import {
  interruptActivity,
  orphanedDispatches,
  publishDispatch,
  publishDispatches,
  recordActivity,
} from './activity';
import { buildDispatchContext, type DispatchRow, previousSessionForRun } from './context';
import { failureReportOf, publicRefusal, recordTurnFailure, requeueSuperseded } from './failure';
import { noteModelFallback } from './model-fallback';
import { outsidersTurn } from './person';
import { holdsItsPlace, outsidersTurnsInFlight, placeKey } from './places';
import { afterRunTurn, reconcileLiveRuns } from './run-recovery';
import { chooseSession, resumedCacheResult, resumedEarlierSession, usesSessions } from './sessions';
import { FollowUps } from './steering';
import { turnProvider, turnProviderSql } from './turn-runtime';

export type ClaimBody = z.output<typeof runnerApi.claim.body>;
export type ProgressBody = z.output<typeof runnerApi.progress.body>;
export type ProgressResponse = z.output<typeof runnerApi.progress.response>;
export type CompleteBody = z.output<typeof runnerApi.complete.body>;
export type HeartbeatBody = z.output<typeof runnerApi.heartbeat.body>;
export type CancelReason = 'paused' | 'taken_over' | 'cancelled';

export interface RuntimeOptions {
  /** Lease a claim holds without a progress / heartbeat before it is requeued. */
  leaseMs: number;
  /**
   * How often expired leases (and dispatches no runner takes) are swept: a housekeeping job (server-efficiency.md
   * SV-03). A queued dispatch also gets its own unrunnable check `unrunnableMs` after it is queued.
   */
  sweepMs: number;
  /** Delay before a crashed dispatch is claimable again. */
  retryBackoffMs: number;
  /** Claims per dispatch: 2 = one retry after a crash. */
  maxAttempts: number;
  /**
   * Long-poll safety re-check (SV-03): every dispatch change (`dispatch.updated`, a new turn's “thinking”) wakes
   * waiting claims at once; this only catches what nothing announces (a `notBefore` passing, a drain ending).
   */
  pollMs: number;
  /** MCP tool-call rate limits per agent and per dispatch. */
  mcp: McpLimits;
  /** A queued dispatch no connected runner can run gets the agent's quiet reply after this long. */
  unrunnableMs: number;
  /** Check a queued dispatch for a runner `unrunnableMs` after it is queued, not only at the sweep (SV-03). */
  unrunnableSoon: boolean;
  /** …and after this long when no runner is connected at all (and the server has been up this long). */
  noRunnerMs: number;
}

export const DEFAULT_RUNTIME_OPTIONS: RuntimeOptions = {
  leaseMs: 60_000,
  sweepMs: 15_000,
  retryBackoffMs: 10_000,
  maxAttempts: 2,
  pollMs: 5_000,
  mcp: DEFAULT_MCP_LIMITS,
  unrunnableMs: 5_000,
  unrunnableSoon: true,
  noRunnerMs: 60_000,
};

/**
 * How long after it was queued an outsiders' turn that found its Hermes profile busy is still queued again rather than
 * failed (`finalizeIn`).
 */
export const OUTSIDERS_PROFILE_WAIT_MAX_MS = 24 * 3_600_000;

/** The runner stopped on purpose (shutdown): requeue at once, without counting it as a crash. */
export { RUNNER_SHUTDOWN };

/**
 * What a beat or the completion says about the turn's session (HE-18). A session the server forgot meanwhile (an edited
 * message, a deleted thread) isn't named again: no later turn resumes it (hermes-native.md HN-K02).
 */
async function sessionReport(
  tx: Tx,
  row: Pick<DispatchRow, 'onBehalfOfAccountId'>,
  body: { providerSessionId?: string | undefined },
) {
  if (!body.providerSessionId) return {};
  if (await sessionForgotten(tx, homeOf(row.onBehalfOfAccountId), body.providerSessionId)) return {};
  return { providerSessionId: body.providerSessionId };
}

/** What the agent says when its turn failed for good. Quiet: no mentions, no follow-up work. */
export const QUIET_ERROR =
  'I couldn’t finish this. Something went wrong on my side, so I stopped. Ask me again to retry.';

/** Git hosting for agent workspaces: the GitHub service (the host's gh or FakeGitHub, github/service.ts). */
export interface GitHost {
  credentials(req: {
    burrowId: string;
    repo: string;
    branch: string;
    operation: 'fetch' | 'push';
    /** The agent the token is for (a push of `sha` is later attributed to it). */
    agentId?: string;
    dispatchId?: string;
    /** Push only: the commit the runner is pushing. */
    sha?: string;
  }): Promise<{ token: string; expiresAt: string; remoteUrl: string }>;
}

interface RunnerInfo {
  runnerId: string;
  name: string | null;
  providers: AgentProvider[];
  lastSeen: number;
  /** What it last reported about the host (heartbeat `status`); null from runners that don't say. */
  status: RunnerStatus | null;
}

const LIVE = ['claimed', 'running'] as const;
const CLAIM_LOCK = 0x57484e52; // "WHNR": serializes claims so the in-flight invariant cannot race.

/**
 * Whether the lease a runner names (runner + claim) is no longer the dispatch's: it was requeued after the
 * lease expired, or claimed again (by another runner, or by the same one as a new attempt). A body without
 * a lease (an older runner) is taken at its word.
 */
export function lostLease(
  row: Pick<DispatchRow, 'runnerId' | 'attempts'>,
  lease: RunnerLease,
  /**
   * Managed mode (docs/decisions/managed-sandbox.md MSB-10): the lease is a fencing token every call must carry
   * whole — a call without the runner (and its generation, in its id) or the attempt is a stale or foreign
   * writer, refused like one.
   */
  strict = false,
): boolean {
  if (strict && (lease.runnerId === undefined || lease.attempt === undefined)) return true;
  if (lease.runnerId === undefined) return false;
  return row.runnerId !== lease.runnerId || (lease.attempt !== undefined && row.attempts !== lease.attempt);
}

/** Row conditions for "still held by this lease" (none for a body without one). */
function holding(lease: RunnerLease) {
  if (lease.runnerId === undefined) return [];
  return [
    eq(dispatches.runnerId, lease.runnerId),
    ...(lease.attempt !== undefined ? [eq(dispatches.attempts, lease.attempt)] : []),
  ];
}

export class RunnerRuntime {
  readonly options: RuntimeOptions;
  private readonly runners = new Map<string, RunnerInfo>();
  /** “Check again”: runners still to be told, and when it was asked (pending until they report after it). */
  private readonly recheckFor = new Set<string>();
  private recheckAskedAt: number | null = null;
  private readonly startedAt = Date.now();
  /** Runners that claimed since this server started: it knows the providers they run. */
  private readonly claimers = new Set<string>();
  private readonly waiters = new Set<() => void>();
  /**
   * The turn whose beat last showed “{name} is thinking”, per indicator. A run's turn may run beside the turn that
   * started it, in its thread (health-run-start.md HRS-01): only the turn that shows the indicator clears it (HRS-04).
   */
  private readonly thinkingTurns = new Map<string, string>();
  /** Same-person follow-ups offered to running turns and merged into them (steering.md). */
  private readonly followUps: FollowUps;
  /** Removes the sweep from housekeeping. */
  private sweeper: (() => void) | null = null;
  /** The unrunnable check a queued dispatch set off (one at a time). */
  private unrunnableTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private offBus: (() => void) | null = null;
  gitHost: GitHost | null = null;
  mcpLimiter: McpRateLimiter;

  constructor(
    private readonly services: Services,
    options: Partial<RuntimeOptions> = {},
  ) {
    this.options = { ...DEFAULT_RUNTIME_OPTIONS, ...options };
    this.mcpLimiter = new McpRateLimiter(this.options.mcp);
    this.followUps = new FollowUps(services);
    // A new dispatch starts a "thinking" indicator, and every dispatch change (queued, ended, cancelled) is a
    // `dispatch.updated` frame: wake waiting claims instead of waiting for the safety re-check (SV-03). A queued one
    // is checked for a runner that can take it once `unrunnableMs` has passed.
    this.offBus = services.bus.onFrame((frame) => {
      const event = frame.event;
      if (event.type === 'typing' && event.active) this.wake();
      else if (event.type === 'dispatch.updated') {
        this.wake();
        if (event.dispatch.state === 'queued') this.unrunnableSoon();
      }
    });
  }

  /** `lostLease`, strict (the lease is a mandatory fencing token). */
  private lost(row: Pick<DispatchRow, 'runnerId' | 'attempts'>, lease: RunnerLease): boolean {
    return lostLease(row, lease, true);
  }

  /* Runners -------------------------------------------------------------------------------------- */

  /** Runner tokens: `RUNNER_TOKEN` (comma-separated for several runners); `dev-runner-token` outside production. */
  tokens(): string[] {
    const configured = this.services.config.RUNNER_TOKEN;
    if (configured)
      return configured
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
    return this.services.config.NODE_ENV === 'production' ? [] : ['dev-runner-token'];
  }

  seen(runnerId: string, info: Partial<Omit<RunnerInfo, 'runnerId' | 'lastSeen'>> = {}): void {
    const prev = this.runners.get(runnerId);
    this.runners.set(runnerId, {
      runnerId,
      name: info.name ?? prev?.name ?? null,
      providers: info.providers ?? prev?.providers ?? [],
      lastSeen: Date.now(),
      status: info.status ?? prev?.status ?? null,
    });
    this.startSweeper();
  }

  /** Starts the sweeps with the server, so dispatches no runner takes are answered even with no runner. */
  start(): void {
    this.startSweeper();
    // Activity left running by turns that ended while the server was down (WS-15: “· restarted”).
    this.interruptOrphans('restarted').catch((err) =>
      this.services.log.warn({ err: String(err) }, 'could not settle activity after a restart'),
    );
  }

  /**
   * Activity rows still running for turns that no longer run (a take over, an automation or an assessment ended
   * them, or a restart left them): interrupted, never done (WS-15). Returns how many rows changed.
   */
  async interruptOrphans(why: 'stopped' | 'restarted' = 'stopped'): Promise<number> {
    // What ended turns used once is forgotten (vault-self-serve.md VS-11).
    await forgetEndedTurnSecrets(this.services).catch((err: unknown) =>
      this.services.log.warn({ err: String(err) }, 'could not forget what ended turns used once'),
    );
    const ids = await orphanedDispatches(this.services.db);
    if (!ids.length) return 0;
    const now = this.services.clock();
    return this.services.pipeline.transactAccount((tx, session) =>
      interruptActivity(tx, session, ids, now, why),
    );
  }

  /** Whether agents can reply, and with what: the connected runners' reports combined. */
  setupStatus(): AgentSetupStatus {
    const runners = this.connectedRunners();
    const reported = runners
      .filter((r): r is RunnerInfo & { status: RunnerStatus } => r.status !== null)
      .sort((a, b) => b.lastSeen - a.lastSeen);
    const latest = reported[0]?.status ?? null;
    const providers: ProviderSetup[] = LIVE_PROVIDERS.map((provider) => {
      // A provider is ready when any runner has it ready; otherwise the latest report says why not.
      const checks = reported.flatMap((r) => r.status.providers.filter((c) => c.provider === provider));
      const check = checks.find((c) => c.state === 'ready') ?? checks[0];
      if (!check) return { provider, state: 'unknown', version: null, detail: null, sandboxProblem: null };
      const sandbox = reported.find((r) => r.status.providers.includes(check))?.status.sandbox?.[provider];
      // The models it offers (model-effort.md ME-04): the chosen runner's list, else the latest one any runner listed.
      const models = check.models ?? checks.find((c) => c.models)?.models;
      return {
        provider,
        state: check.state,
        version: check.version,
        detail: check.detail,
        sandboxProblem: check.state === 'ready' && sandbox && !sandbox.ok ? sandbox.detail : null,
        ...(models ? { models } : {}),
      };
    });
    const everSeen = [...this.runners.values()].map((r) => r.lastSeen);
    const seenAt = everSeen.length ? new Date(Math.max(...everSeen)).toISOString() : null;
    const asked = this.recheckAskedAt;
    if (asked !== null && Date.now() - asked > 60_000) this.recheckAskedAt = null;
    const recheckPending =
      this.recheckAskedAt !== null &&
      runners.length > 0 &&
      !reported.some((r) => Date.parse(r.status.checkedAt) >= (this.recheckAskedAt ?? 0));
    // Hermes as the latest report says (CT-1160); a ready one wins, as for the CLIs.
    const hermes = reported.find((r) => r.status.hermes.ready)?.status.hermes ?? latest?.hermes ?? null;
    return {
      runner: { connected: runners.length > 0, seenAt },
      hermes,
      providers,
      defaultProvider: defaultAgentProvider(providers),
      checkedAt: latest?.checkedAt ?? null,
      recheckPending,
    };
  }

  /** “Check again”: the connected runners re-check their providers at their next beat. */
  requestRecheck(): void {
    for (const r of this.connectedRunners()) this.recheckFor.add(r.runnerId);
    this.recheckAskedAt = Date.now();
  }

  /**
   * Whether a runner's turns may run without a sign-in (HE-46): this server allows it (`WHOMBAT_ALLOW_SCRIPTED`) and
   * the runner's last report says its Hermes is the scripted stand-in. A real Hermes never is.
   */
  scriptedRunner(runnerId: string): boolean {
    if (!this.services.config.WHOMBAT_ALLOW_SCRIPTED) return false;
    const hermes = this.runners.get(runnerId)?.status?.hermes;
    return !!hermes?.ready && isScriptedHermes(hermes.version);
  }

  /** Runners seen within two leases. */
  connectedRunners(): RunnerInfo[] {
    const cutoff = Date.now() - 2 * this.options.leaseMs;
    return [...this.runners.values()].filter((r) => r.lastSeen >= cutoff);
  }

  /** Wakes long-polling claims (a dispatch was queued). */
  wake(): void {
    for (const w of [...this.waiters]) w();
  }

  private waitForWork(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      this.waiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  /* Claim ---------------------------------------------------------------------------------------- */

  async claim(body: ClaimBody, signal?: AbortSignal): Promise<DispatchContext | null> {
    this.claimers.add(body.runnerId);
    this.seen(body.runnerId, {
      providers: body.providers,
      ...(body.name ? { name: body.name } : {}),
    });
    const deadline = Date.now() + body.waitMs;
    for (;;) {
      if (this.closed || signal?.aborted) return null;
      const row = await this.claimOne(body.runnerId, body.providers);
      if (row) {
        // The AI gateway (ai-gateway.md AIG-07, AIG-12, AIG-22): with the switch on for the agent's provider the turn
        // goes through the gateway and no sign-in is used. When the gateway is gone or doesn't answer, the person's own
        // Claude or ChatGPT subscription takes it; with neither, or a used-up pool, it doesn't start.
        const route = await gatewayRoute(this.services, this.services.db, row, body.providers);
        if (route.kind === 'refused') {
          // A provider failure, as the runner classifies a gateway it can't use (AIG-D06): Try again, no requeue.
          await this.finalize(row.id, {
            outcome: 'failed',
            error: route.code,
            refusal: route.text,
            failure: { code: 'provider' },
          });
          continue;
        }
        const gateway = route.kind === 'gateway' ? route.context : null;
        const fallback = route.kind === 'fallback' ? route : null;
        if (fallback)
          this.services.log.info(
            { dispatchId: row.id, from: fallback.from, to: fallback.provider, code: fallback.code },
            'ai gateway: it can’t take this turn, so it runs on the person’s own sign-in',
          );
        if (gateway || fallback || row.gatewayProvider) {
          // A turn tried again on another route than its last attempt can't resume that attempt's session: it lives in
          // the other CLI home (AIG-10); nor can one whose thread's session last ran on another route.
          const runtime: ChatRuntime | undefined =
            fallback && fallback.provider !== fallback.from ? { provider: fallback.provider } : undefined;
          const provider =
            runtime?.provider ??
            gateway?.provider ??
            turnProvider((await loadPrincipalRow(this.services.db, row.agentId))?.runtime, row);
          const fresh =
            (row.attempts > 1 && (row.gatewayProvider ?? null) !== (gateway?.provider ?? null)) ||
            (await sessionOnOtherRoute(this.services.db, row, {
              provider,
              gatewayProvider: gateway?.provider ?? null,
            }));
          await recordGatewayRoute(this.services, row.id, gateway?.provider ?? null, { fresh, runtime });
          if (fresh) row.providerSessionId = null;
          if (runtime) row.runtime = runtime;
          row.gatewayProvider = gateway?.provider ?? null;
        }
        await this.settleStatus(row);
        try {
          return await buildDispatchContext(this.services, row, { gateway });
        } catch (err) {
          // A retried assessment turn whose assessment is already recorded: done, without a turn or a message.
          if (err instanceof AssessmentAlreadyRecorded) {
            await this.finalize(row.id, { outcome: 'done' });
            continue;
          }
          // Whombat refused an assessment after its start (feedback.md, review-2 F5): the turn fails for good (no
          // retry: it would only refuse again) and its report is blocked (or paused) with the reason.
          if (err instanceof AssessmentRefused) {
            this.services.log.warn(
              { dispatchId: row.id, reason: err.problem.reason },
              'refused a feedback assessment turn',
            );
            await this.finalize(row.id, {
              outcome: 'failed',
              error: refusedError(err.problem),
              refusal: err.problem.reason.slice(0, 500),
            });
            continue;
          }
          this.services.log.error(
            { err: String(err), dispatchId: row.id },
            'could not build dispatch context',
          );
          await this.finalize(row.id, { outcome: 'failed', error: `context: ${String(err)}` });
          continue;
        }
      }
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await this.waitForWork(Math.min(this.options.pollMs, left), signal);
    }
  }

  /** Leases the oldest claimable dispatch, or returns null. */
  async claimOne(runnerId: string, providers: readonly AgentProvider[]): Promise<DispatchRow | null> {
    // Draining for an update (MR-15): no new turns start; queued dispatches wait, durable, for the resume.
    if (this.services.maintenance.paused) return null;
    // A lapsed licence (LC-10): queued dispatches are held, not dropped; they run once the box is licensed again.
    if (this.services.licence.lapsed) return null;
    // Nothing queued that is due: no transaction and no claim lock (an idle long-poll costs one indexed read, SV-03).
    const now = this.services.clock();
    const [due] = await this.services.db
      .select({ id: dispatches.id })
      .from(dispatches)
      .where(
        and(eq(dispatches.state, 'queued'), or(isNull(dispatches.notBefore), lte(dispatches.notBefore, now))),
      )
      .limit(1);
    if (!due) return null;
    const claimed = await this.claimInTx(runnerId, providers);
    // A turn asked to do a plan step: the step says “Working” (work-supervision WS-05).
    if (claimed?.planId) await followDispatch(this.services, claimed);
    return claimed;
  }

  private async claimInTx(
    runnerId: string,
    providers: readonly AgentProvider[],
  ): Promise<DispatchRow | null> {
    const picked = await this.services.pipeline.transactAccount(async (tx, txSession) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${CLAIM_LOCK})`);
      const now = this.services.clock();
      const candidates = await tx
        .select({ d: dispatches })
        .from(dispatches)
        .innerJoin(principals, eq(principals.id, dispatches.agentId))
        .where(
          and(
            eq(dispatches.state, 'queued'),
            or(isNull(dispatches.notBefore), lte(dispatches.notBefore, now)),
            // The provider the turn runs on: its Chat thread's choice, else its agent's (chat-runtime-server.md CR-S03).
            inArray(turnProviderSql, [...providers]),
            // One turn in flight per (agent, conversation, thread) (hermes-native.md HN-T01): turns in different threads
            // of a conversation run side by side. A turn at the top level (no thread) runs alone in the conversation, as
            // every turn there reads the top level as its window (HN-T02), and two turns of one run never run at once,
            // whatever their threads (HN-T03). A run's turn isn't held back by the turn that started the run
            // (`runs.dispatch_id`), which may still be at work after its start_run (health-run-start.md HRS-01).
            // A turn a person stopped while its runner still holds it (RF-01) counts until the runner reports it ended
            // (`finalizeIn` clears the lease) or the lease runs out: the next turn resumes what it saw, and never beside it.
            sql`not exists (select 1 from ${dispatches} as inflight
                  where inflight.agent_id = ${dispatches.agentId}
                    and inflight.conversation_id = ${dispatches.conversationId}
                    and (inflight.thread_root_id is not distinct from ${dispatches.threadRootId}
                      or inflight.thread_root_id is null
                      or ${dispatches.threadRootId} is null
                      or inflight.run_id = ${dispatches.runId})
                    and ${holdsItsPlace('inflight', now)}
                    and not exists (select 1 from ${runs} as started
                      where started.id = ${dispatches.runId} and started.dispatch_id = inflight.id))`,
            // Outsiders' turns run one at a time on the box: they share Hermes's one outsiders' profile, which one Hermes
            // holds at a time. The next stays queued until none holds its place, and is then taken oldest first like any
            // other, instead of waiting for the profile on the runner and failing there after ten minutes. A person's
            // turn never waits for them.
            sql`(${dispatches.onBehalfOfAccountId} is not null
                  or not exists (${outsidersTurnsInFlight(sql`${dispatches.runId}`, now)}))`,
            // A top-level turn that is due goes before the conversation's later thread turns (HN-T02): it waits only for
            // the turns in flight when it was queued, never behind a stream of new threads.
            sql`(${dispatches.threadRootId} is null or not exists (select 1 from ${dispatches} as top
                  where top.agent_id = ${dispatches.agentId}
                    and top.conversation_id = ${dispatches.conversationId}
                    and top.state = 'queued'
                    and top.thread_root_id is null
                    and (top.not_before is null or top.not_before <= ${now.toISOString()}::timestamptz)
                    and (top.created_at, top.id) < (${dispatches.createdAt}, ${dispatches.id})))`,
          ),
        )
        .orderBy(asc(dispatches.createdAt), asc(dispatches.id))
        .limit(20);
      // Oldest first within a place (agent, conversation, thread): a pass considers only its oldest candidate.
      const taken = new Set<string>();
      for (const { d } of candidates) {
        const pair = placeKey(d);
        if (taken.has(pair)) continue;
        taken.add(pair);
        if (d.runId) {
          // Run control for a run a person paused, took over or that finished meanwhile: nothing to do.
          const [run] = await tx.select({ status: runs.status }).from(runs).where(eq(runs.id, d.runId));
          if (run && run.status !== 'live') {
            const [cancelled] = await tx
              .update(dispatches)
              .set({ state: 'cancelled', finishedAt: now, error: `run_${run.status}` })
              .where(eq(dispatches.id, d.id))
              .returning();
            if (cancelled) publishDispatch(txSession, cancelled);
            continue;
          }
        }
        // A turn queued again after a usage limit that a newer turn took over: not run.
        const moot = d.requeuedFor ? await requeueSuperseded(tx, d) : null;
        if (moot) {
          const [cancelled] = await tx
            .update(dispatches)
            .set({ state: 'cancelled', finishedAt: now, error: moot })
            .where(and(eq(dispatches.id, d.id), eq(dispatches.state, 'queued')))
            .returning();
          if (cancelled) publishDispatch(txSession, cancelled);
          taken.delete(pair);
          continue;
        }
        // Run control resumes the run's session; a retry keeps the one it had (or, without one, starts fresh). A chat
        // reply's first claim chooses its thread's session once the claim lock is released (`chooseClaimedSession`,
        // TE-12).
        // A Whombat Feedback assessment always starts a fresh session (feedback.md FB-21), even on its retry.
        const session =
          d.trigger === 'feedback'
            ? null
            : d.providerSessionId
              ? { providerSessionId: d.providerSessionId }
              : d.runId
                ? await previousSessionForRun(this.services, d.runId, d.id)
                : null;
        const [claimed] = await tx
          .update(dispatches)
          .set({
            state: 'claimed',
            runnerId,
            claimedAt: now,
            heartbeatAt: now,
            leaseExpiresAt: new Date(now.getTime() + this.options.leaseMs),
            attempts: d.attempts + 1,
            cancelReason: null,
            notBefore: null,
            providerSessionId: session?.providerSessionId ?? null,
            // An assessment counts only the access its runner reports for this claim (feedback.md, review-2 F4).
            ...(d.trigger === 'feedback' ? { access: null } : {}),
          })
          .where(and(eq(dispatches.id, d.id), eq(dispatches.state, 'queued')))
          .returning();
        if (claimed) {
          publishDispatch(txSession, claimed);
          return {
            claimed,
            queued: d,
            choose: session === null && d.trigger !== 'feedback' && d.attempts === 0,
          };
        }
      }
      return null;
    });
    if (!picked) return null;
    return picked.choose ? await this.chooseClaimedSession(picked.claimed, picked.queued) : picked.claimed;
  }

  /**
   * The session of a chat turn just claimed (runtime/sessions.ts, HE-40): its thread's Hermes session for the same
   * person. Chosen after the claim lock is released (turn-efficiency.md TE-12): the claim already holds the turn's place
   * (agent, conversation, thread; HN-T01), and `chooseSession` reads only that thread's turns, so none of them can be
   * claimed meanwhile. `queued` is the row as it was queued. The runner gets the context only after this.
   */
  private async chooseClaimedSession(claimed: DispatchRow, queued: DispatchRow): Promise<DispatchRow> {
    if (!usesSessions(queued)) return claimed;
    // What the turn is served now, as its MCP server will list it: a session that lacked one of them isn't resumed.
    // Unknown when the list can't be read now: the turn resumes as it would have, and its MCP server says why.
    const served = await mcpToolList(this.services, claimed.agentId, claimed.id).then(
      (tools) => tools.map((t) => t.name),
      () => null,
    );
    return this.services.pipeline.transactAccount(async (tx) => {
      const session = await chooseSession(tx, queued, served);
      if (!session && !served) return claimed;
      const [updated] = await tx
        .update(dispatches)
        .set({
          ...(served ? { servedTools: served } : {}),
          ...(session ? { providerSessionId: session } : {}),
        })
        .where(and(eq(dispatches.id, claimed.id), eq(dispatches.attempts, claimed.attempts)))
        .returning();
      return updated ?? claimed;
    });
  }

  /* Progress ------------------------------------------------------------------------------------- */

  private async load(id: string): Promise<DispatchRow> {
    const [row] = await this.services.db.select().from(dispatches).where(eq(dispatches.id, id));
    if (!row) throw notFound('Dispatch');
    return row;
  }

  /** A session a beat tells for a turn that no longer runs (`forgetLateMailSession`). */
  private async forgetLateSession(id: string, body: ProgressBody): Promise<void> {
    if (!body.providerSessionId) return;
    await this.services.pipeline.transactAccount((_tx, session) =>
      forgetLateMailSession(session, id, body.providerSessionId),
    );
  }

  /** Why the dispatch's turn must stop, if it must. */
  private async stopReason(tx: Tx | Services['db'], row: DispatchRow): Promise<CancelReason | null> {
    if (row.state === 'cancelled')
      return row.cancelReason ?? (row.error === 'taken_over' ? 'taken_over' : 'cancelled');
    if (row.state === 'done' || row.state === 'failed') return 'cancelled';
    if (row.cancelReason) return row.cancelReason;
    const runRows = await tx
      .select({ status: runs.status })
      .from(runs)
      .where(
        row.runId ? or(eq(runs.id, row.runId), eq(runs.dispatchId, row.id)) : eq(runs.dispatchId, row.id),
      );
    if (runRows.some((r) => r.status === 'taken_over')) return 'taken_over';
    if (runRows.some((r) => r.status === 'paused')) return 'paused';
    return null;
  }

  private typingKey(row: DispatchRow) {
    return { conversationId: row.conversationId, threadRootId: row.threadRootId, principalId: row.agentId };
  }

  /**
   * Shows the turn's “{name} is thinking”, naming the turn for Stop (review-features.md RF-01), or clears it unless
   * another turn shows it now (HRS-04).
   */
  private showThinking(row: DispatchRow, on: boolean) {
    const key = this.typingKey(row);
    const indicator = `${key.conversationId}|${key.threadRootId ?? ''}|${key.principalId}`;
    if (on) {
      this.thinkingTurns.set(indicator, row.id);
      this.services.typing.start(key, stoppableTurn(row) ? row.id : null);
      return;
    }
    const holder = this.thinkingTurns.get(indicator);
    if (holder !== undefined && holder !== row.id) return;
    this.thinkingTurns.delete(indicator);
    this.services.typing.stop(key);
  }

  /** A stopped turn's “thinking” clears at once (`dispatches.cancel`), unless another turn shows it now (HRS-04). */
  stopThinking(row: DispatchRow): void {
    this.showThinking(row, false);
  }

  async progress(id: string, body: ProgressBody): Promise<ProgressResponse> {
    const row = await this.load(id);
    // A runner that lost its lease stops and touches nothing: not the lease, the state or "thinking". Only the session
    // of a mail run's turn it names is forgotten, as no turn will name it again.
    if (this.lost(row, body)) {
      await this.forgetLateSession(id, body);
      return { cancel: true, reason: 'cancelled' };
    }
    const reason = await this.stopReason(this.services.db, row);
    if (row.state !== 'claimed' && row.state !== 'running') {
      await this.forgetLateSession(id, body);
      return { cancel: true, reason: reason ?? 'cancelled' };
    }
    const now = this.services.clock();
    let began = false;
    const renewed = await this.services.pipeline.transactAccount(async (tx, session) => {
      // Two first beats can both have loaded "claimed" before either commits.
      // Read the transition under the same row lock the update/finish paths use,
      // so only its owner publishes "running"; every beat still renews the lease
      // and records its activity under the existing runner/attempt fence.
      const [before] = await tx
        .select({ state: dispatches.state })
        .from(dispatches)
        .where(and(eq(dispatches.id, id), inArray(dispatches.state, [...LIVE]), ...holding(body)))
        .for('update');
      if (!before) return [];
      const held = await tx
        .update(dispatches)
        .set({
          state: 'running',
          heartbeatAt: now,
          leaseExpiresAt: new Date(now.getTime() + this.options.leaseMs),
          // A live turn keeps its Whombat tools however long it runs, within its wall time (EA-04).
          tokenExpiresAt: slidTokenExpiry(this.services, now),
          ...(await sessionReport(tx, row, body)),
          ...(reason ? { cancelReason: reason } : {}),
        })
        .where(and(eq(dispatches.id, id), inArray(dispatches.state, [...LIVE]), ...holding(body)))
        .returning();
      const current = held[0];
      if (!current) return held;
      began = before.state === 'claimed';
      if (began) publishDispatch(session, current);
      // Observed activity rides on the beat, under the same lease (WS-12): a runner that lost it writes nothing.
      if (body.activity?.length) await recordActivity(tx, session, current, body.activity, now);
      return held;
    });
    // The provider's rate-limit reading, when the turn's lease still holds (UI-R08): the subscription's snapshot.
    const limits = body.rateLimits;
    if (limits && renewed[0])
      this.services.usage.track('turn reading', () => this.services.usage.fromTurn(id, limits));
    // Changed since it was read: requeued or claimed again (lost lease), or ended by a Pause / Take over
    // that committed while this update waited for the row. Say why from the row as it is now, or a take
    // over racing a beat would reach the runner as a plain "cancelled".
    if (renewed.length === 0) {
      const current = await this.load(id);
      if (this.lost(current, body)) return { cancel: true, reason: 'cancelled' };
      const why = await this.stopReason(this.services.db, current);
      return { cancel: true, reason: why ?? reason ?? 'cancelled' };
    }
    if (row.runnerId) this.seen(row.runnerId);
    if (began && row.planId) await followDispatch(this.services, row);
    // A Feedback assessment's exported commit, as its runner reports it: the handoff binds it (review-2 F9).
    if (body.workspaceCommit && row.trigger === 'feedback') {
      const commit = body.workspaceCommit;
      await this.services.pipeline.transactAccount((tx) =>
        tx
          .update(feedbackAssessments)
          .set({ workspaceCommit: commit.toLowerCase() })
          .where(and(eq(feedbackAssessments.dispatchId, id), eq(feedbackAssessments.state, 'running'))),
      );
    }
    // "{name} is thinking" while a reply is being worked out; runs, answers and turns that already posted
    // clear the indicator the dispatch started.
    this.showThinking(row, !reason && body.thinking && row.mode !== 'answer');
    // Folders a browser_preview of this turn waits for (BT-48).
    const previews = previewsFor(this.services).forRunner(id);
    // The person's follow-ups: merged when the runner delivered them, offered while they wait (steering.md SX-07).
    const inject = reason ? [] : await this.followUps.beat(renewed[0] as DispatchRow, body.injected ?? []);
    return {
      cancel: reason !== null,
      reason,
      ...(previews.length ? { previews } : {}),
      ...(inject.length ? { inject } : {}),
    };
  }

  /**
   * The turn said something (an MCP posting tool): the first time over all its attempts is kept, so a retry
   * knows it already posted. Operational bookkeeping, like the rest of the dispatch row.
   */
  async markPosted(id: string): Promise<void> {
    await this.services.pipeline.transactAccount((tx) =>
      tx
        .update(dispatches)
        .set({ postedAt: this.services.clock() })
        .where(and(eq(dispatches.id, id), isNull(dispatches.postedAt))),
    );
  }

  /* Complete ------------------------------------------------------------------------------------- */

  async complete(id: string, body: CompleteBody): Promise<void> {
    const result = await this.finalize(id, body, { lease: body });
    if (result === 'lease_lost')
      throw new ApiError(
        'conflict',
        'This runner no longer holds the dispatch (its lease expired and it was handed out again).',
      );
    // The turn's last rate-limit reading (UI-R08): a refused turn's `limited` window arrives this way.
    const limits = body.rateLimits;
    if (limits) this.services.usage.track('turn reading', () => this.services.usage.fromTurn(id, limits));
    // What Whombat does after a coding turn (run-checkout.md RC-08…RC-11), off the runner's request.
    if (result === 'done')
      this.recovery = afterRunTurn(this.services, id, body).catch((err) =>
        this.services.log.warn({ err: String(err), dispatchId: id }, 'after the run turn'),
      );
  }

  /** The latest after-turn work (`afterRunTurn`), for tests that wait for it. */
  recovery: Promise<void> = Promise.resolve();

  /**
   * Ends a turn. `failed` is retried once (after `retryBackoffMs`) before it is final, unless its usage limit lasts
   * past that (the retry would only meet it; the failure queues it for after the reset, RA-32); the runner stopping
   * on purpose (`runner_shutdown`) requeues without counting, and so does an outsiders' turn that found its Hermes
   * profile busy (after the backoff). With a `lease`, only the runner holding it
   * may end the turn; with `expiredBy`, only a lease that expired by then is ended (the sweep); with
   * `queuedOnly`, only a dispatch nobody claimed.
   */
  async finalize(
    id: string,
    body: CompleteBody,
    guard: { lease?: RunnerLease; expiredBy?: Date; queuedOnly?: boolean } = {},
  ): Promise<DispatchRow['state'] | 'lease_lost'> {
    const now = this.services.clock();
    this.followUps.forget(id);
    const result = await this.services.pipeline.transactAccount(async (tx, session) => {
      const outcome = await this.finalizeIn(tx, id, body, guard, now);
      // A mail run's turn may tell its session only now, after Whombat ended it: forgotten with the email.
      await forgetLateMailSession(session, id, body.providerSessionId);
      if (outcome && outcome !== 'lease_lost') {
        // What the turn was still doing is interrupted, never done (WS-15); a new state is a lifecycle frame.
        await interruptActivity(tx, session, [id], now);
        if (outcome.changed) await publishDispatches(tx, session, [id]);
        // Its replies in Chat say what really ran (chat-runtime.md CR-07, CR-08; chat-runtime-server.md CR-S09).
        await correctRanOn(session, id, body);
      }
      return outcome;
    });
    if (!result) throw notFound('Dispatch');
    if (result === 'lease_lost') return result;
    const { row, state, final } = result;
    if (result.cache) this.noteCache(row, result.cache);
    // What the turn used once ends with the turn, requeued or not (vault-self-serve.md VS-11).
    forgetTurnSecrets(this.services, [id]);
    this.showThinking(row, false);
    // A plan step's turn ended, failed or was requeued: the step follows its current state (WS-05).
    if (row.planId) await followDispatch(this.services, row);
    // Ended for good, here or before (a take over ends the dispatch and the runner reports it after).
    if (state !== 'queued') await this.settleStatus(row);
    if (state === 'queued') {
      this.services.log.warn(
        { dispatchId: id, error: body.error },
        'dispatch failed; retrying after backoff',
      );
      setTimeout(() => this.wake(), this.options.retryBackoffMs + 10).unref?.();
    }
    if (final) await this.afterFinal(row, state, body.error, body.refusal, body.failure ?? null);
    return state;
  }

  /** `finalize`'s transaction body: the new state of the dispatch, or why nothing changed. */
  private async finalizeIn(
    tx: Tx,
    id: string,
    body: CompleteBody,
    guard: { lease?: RunnerLease; expiredBy?: Date; queuedOnly?: boolean },
    now: Date,
  ): Promise<
    | {
        row: DispatchRow;
        state: DispatchRow['state'];
        final: boolean;
        changed: boolean;
        /** A resumed chat turn's prompt cache result (PE-12). */
        cache?: CacheJudgement | null;
      }
    | 'lease_lost'
    | null
  > {
    {
      const [row] = await tx.select().from(dispatches).where(eq(dispatches.id, id)).for('update');
      if (!row) return null;
      const renewed =
        guard.expiredBy &&
        (!LIVE.includes(row.state as (typeof LIVE)[number]) ||
          !row.leaseExpiresAt ||
          row.leaseExpiresAt > guard.expiredBy);
      if ((guard.lease && this.lost(row, guard.lease)) || renewed) return 'lease_lost' as const;
      // The unrunnable sweep: a runner claimed it meanwhile after all.
      if (guard.queuedOnly && row.state !== 'queued') return 'lease_lost' as const;
      // The agent's model wasn't available for this turn, which ran on the default; or a turn on its own main model
      // finished, and the last fallback is history. Turns on a Chat thread's choice or the background model (and
      // background Look turns) never set or clear the main-model fallback warning.
      const fallback = await noteModelFallback(tx, row, body, now);
      if (fallback)
        this.services.log.info(
          {
            dispatchId: id,
            agentId: row.agentId,
            model: fallback.model,
            where: fallback.where,
            detail: fallback.detail,
          },
          'the agent’s model wasn’t available; the turn ran on the default model',
        );
      // Stopped by a person while the runner held it (RF-01): what the turn used and the session it ran still count, and
      // its lease ends, so the agent's next turn here may start (and resume it).
      // So does a step's turn Whombat stopped after it handed its T3 Code wait over: its usage counts in the step's limits.
      if (
        row.state === 'cancelled' &&
        (row.stoppedById || (row.waitsOn && row.error === HANDED_OVER_ERROR)) &&
        row.leaseExpiresAt &&
        guard.lease &&
        !guard.expiredBy
      ) {
        await tx
          .update(dispatches)
          .set({
            leaseExpiresAt: null,
            ...(body.outcome !== 'failed' ? await sessionReport(tx, row, body) : {}),
            ...(body.usage ? { usage: body.usage } : {}),
          })
          .where(eq(dispatches.id, id));
        return { row, state: row.state, final: false, changed: false };
      }
      if (row.state === 'done' || row.state === 'failed' || row.state === 'cancelled')
        return { row, state: row.state, final: false, changed: false };
      // A chat turn that resumed its session and ended: whether it read the session's prompt cache, stored with its
      // usage (PE-12).
      const cache =
        body.outcome === 'done' || body.outcome === 'cancelled'
          ? await resumedCacheResult(
              tx,
              row,
              body.providerSessionId ?? row.providerSessionId,
              body.usage,
              now,
            )
          : null;
      const usage: StoredUsage | undefined = body.usage
        ? { ...body.usage, ...(cache ? { cacheResult: cache.result } : {}) }
        : undefined;
      const base = {
        leaseExpiresAt: null,
        ...(await sessionReport(tx, row, body)),
        ...(usage ? { usage } : {}),
      };
      if (body.outcome === 'done') {
        await tx
          .update(dispatches)
          .set({ ...base, state: 'done', finishedAt: now, error: null })
          .where(eq(dispatches.id, id));
        return { row, state: 'done' as const, final: true, changed: true, cache };
      }
      if (body.outcome === 'cancelled') {
        const reason = (await this.stopReason(tx, row)) ?? 'cancelled';
        await tx
          .update(dispatches)
          .set({
            ...base,
            state: 'cancelled',
            finishedAt: now,
            cancelReason: reason,
            error: body.error ?? reason,
          })
          .where(eq(dispatches.id, id));
        return { row, state: 'cancelled' as const, final: true, changed: true, cache };
      }
      const shutdown = body.error === RUNNER_SHUTDOWN;
      // An outsiders' turn whose Hermes profile something else kept busy past the runner's wait (the claim lets one such
      // turn run at a time, but a Hermes-home step or a sign-in may hold the profile too) is queued again without
      // counting it, after the backoff: it never fails only for waiting. Up to a day after it was queued, so a profile
      // that never comes free still ends it.
      const waitedForProfile =
        outsidersTurn(row) &&
        hermesProfileBusy(body.error) &&
        now.getTime() - row.createdAt.getTime() < OUTSIDERS_PROFILE_WAIT_MAX_MS;
      const uncounted = shutdown || waitedForProfile;
      // A refusal (the host needs fixing first) is final: retrying would only refuse again. So is a usage limit that
      // resets after the retry would run, like the AI gateway's “no room until …” (ai-gateway.md AIG-D31).
      const resetsAt =
        body.failure?.code === 'usage_limit' ? Date.parse(body.failure.resetsAt ?? '') : Number.NaN;
      const limited = resetsAt > now.getTime() + this.options.retryBackoffMs;
      // Claude's third-party billing refusal needs an account action, not another attempt (HTTP 400, AIG-D32).
      const extraUsage = claudeExtraUsageRequired(body.error ?? '');
      // The model declined this request's content (a safety or content filter): the same request would be declined
      // again, so it is final — the person reword it or switches models.
      const declined = body.failure?.code === 'refused' || providerDeclinedContent(body.error ?? '');
      if (
        !body.refusal &&
        !limited &&
        !extraUsage &&
        !declined &&
        // A step's turn that handed its T3 Code wait over has nothing left to do: the step waits for its thread.
        !row.waitsOn &&
        (uncounted || row.attempts < this.options.maxAttempts)
      ) {
        // A resumed session that failed may be gone from Hermes: the retry starts fresh with the whole window (BP-B17).
        const freshRetry = !uncounted && (await resumedEarlierSession(tx, row));
        await tx
          .update(dispatches)
          .set({
            ...base,
            ...(freshRetry ? { providerSessionId: null } : {}),
            state: 'queued',
            runnerId: null,
            claimedAt: null,
            heartbeatAt: null,
            // The attempt that failed is over: its token stops (the next claim issues a new one). Left alone, a queued
            // turn's token stays live and, without a claim to cap it, slides with every call of the old attempt.
            tokenExpiresAt: null,
            error: body.error ?? 'failed',
            attempts: uncounted ? Math.max(0, row.attempts - 1) : row.attempts,
            notBefore: shutdown ? null : new Date(now.getTime() + this.options.retryBackoffMs),
          })
          .where(eq(dispatches.id, id));
        return { row, state: 'queued' as const, final: false, changed: true };
      }
      await tx
        .update(dispatches)
        .set({ ...base, state: 'failed', finishedAt: now, error: body.error ?? 'failed' })
        .where(eq(dispatches.id, id));
      return { row, state: 'failed' as const, final: true, changed: true };
    }
  }

  /** Resumed turns in a row of each agent whose prompt cache missed (PE-12); a hit starts the count over. */
  private readonly cacheMisses = new Map<string, number>();

  /**
   * A resumed chat turn's prompt cache result in the runtime log (PE-12), and a warning when one agent's resumed turns
   * keep missing within their cache's lifetime: something changes the prefix (a prompt, the tools, the history), and it
   * costs the session's whole context on every turn.
   */
  private noteCache(row: DispatchRow, cache: CacheJudgement) {
    const fields = {
      dispatchId: row.id,
      agentId: row.agentId,
      cache: cache.result,
      unreadTokens: cache.unreadTokens,
      priorContextTokens: cache.priorContextTokens,
      gapMs: cache.gapMs,
      ttlMs: cache.ttlMs,
    };
    this.services.log.info(fields, `resumed turn: prompt cache ${cache.result}`);
    if (cache.result === 'hit') this.cacheMisses.delete(row.agentId);
    if (cache.result !== 'miss') return;
    const misses = (this.cacheMisses.get(row.agentId) ?? 0) + 1;
    this.cacheMisses.set(row.agentId, misses);
    if (misses >= CACHE_MISS_WARN_AFTER)
      this.services.log.warn(
        { ...fields, misses },
        `${misses} resumed turns in a row missed the prompt cache: something changes the prefix (prompt-efficiency.md PE-12)`,
      );
  }

  /**
   * Working while a turn runs, then waiting or idle (agent-status.md AS-03); never holds up the turn. The person the turn
   * is for hears it on Home (HR-43; one-agent.md OA-S140).
   */
  private async settleStatus(row: DispatchRow) {
    try {
      const person = await personOfAccountIn(this.services.db, row.burrowId, row.onBehalfOfAccountId);
      await this.services.pipeline.commit(
        settleAgentStatus,
        {},
        {
          burrowId: row.burrowId,
          actorId: row.agentId,
          ...(person ? { onBehalfOf: { principalId: person.id } } : {}),
        },
      );
    } catch (err) {
      this.services.log.warn({ err: String(err), dispatchId: row.id }, 'could not settle agent status');
    }
  }

  /** Answer bookkeeping and the failure message (with its `turn_failed` card) for a turn that ended for good. */
  private async afterFinal(
    row: DispatchRow,
    state: DispatchRow['state'],
    error: string | undefined,
    refusal?: string,
    failure?: TurnFailureReport | null,
  ) {
    if (row.search) {
      // The search screen should not wait forever for an answer that is not coming.
      const status = state === 'failed' ? 'failed' : 'none';
      await this.services.pipeline.transactAccount(async (tx, session) => {
        const [answer] = await tx
          .update(searchAnswers)
          .set({ status, updatedAt: this.services.clock() })
          .where(and(eq(searchAnswers.id, row.search?.answerId ?? ''), eq(searchAnswers.status, 'pending')))
          .returning();
        if (answer)
          session.publish(topics.me(answer.askedById), {
            type: 'search.answer',
            answer: toSearchAnswer(answer),
          });
      });
    }
    // An automation waits for this turn (its dispatch_agent step): tell its engine now rather than at the next tick.
    if (row.trigger === 'automation') this.services.automations?.nudge();
    // A feedback report waits for its assessment (feedback.md FB-23): settle it now, with the runner's refusal.
    if (row.trigger === 'feedback')
      await this.services.feedback
        ?.dispatchEnded(row.id, state, error, refusal)
        .catch((err) =>
          this.services.log.warn(
            { err: String(err), dispatchId: row.id },
            'could not settle a feedback assessment',
          ),
        );
    // Refused by Whombat itself (review-2 F5): the report's thread already says why, in Whombat's words; the agent,
    // which never got the turn, says nothing.
    if (row.trigger === 'feedback' && parseRefusedError(error)) return;
    if (state !== 'failed') return;
    // A step's turn that handed its T3 Code wait to Whombat had already ended its part: what failed after it (mostly its
    // last line, which Whombat no longer takes from it) is no failure of the step, which goes on once its thread
    // finishes. A failure message would tell the person it stopped, and Try again would start the work twice.
    if (row.waitsOn) {
      this.services.log.info({ dispatchId: row.id, error }, 'a turn that handed its T3 Code wait over ended');
      return;
    }
    if (refusal)
      this.services.log.warn({ dispatchId: row.id, error, refusal }, 'dispatch refused by the runner');
    else this.services.log.error({ dispatchId: row.id, error }, 'dispatch failed after retrying');
    const opts = { burrowId: row.burrowId, actorId: row.agentId };
    // A refused run turn (its checkout couldn't be made, resourceful-agents.md RA-DS54) leaves its run failed in its own
    // words: the run card and page say what is missing and where it's fixed, beside Try again (RC-10).
    const said = row.runId ? publicRefusal(refusal) : null;
    const reason = said && said.length <= 280 ? said : 'Stopped after an error.';
    try {
      await this.services.pipeline.commit(failDispatchRuns, { dispatchId: row.id, reason }, opts);
    } catch (err) {
      this.services.log.warn(
        { err: String(err), dispatchId: row.id },
        'could not stop the failed turn’s runs',
      );
    }
    // Why it failed, where it was asked, with Try again (essentials-agents.md EA-08); a search answer only records it.
    const report = failureReportOf({
      error: error ?? null,
      refusal: refusal ?? null,
      failure: failure ?? null,
    });
    try {
      await this.services.pipeline.commit(
        recordTurnFailure,
        {
          dispatchId: row.id,
          code: report.code,
          resetsAt: report.resetsAt ?? null,
          refusal: refusal ?? null,
          fallbackText: refusal ?? QUIET_ERROR,
          error: error?.slice(0, 2000) ?? null,
        },
        opts,
      );
    } catch (err) {
      this.services.log.warn({ err: String(err), dispatchId: row.id }, 'could not post the failure message');
    }
  }

  /* Heartbeat and leases ------------------------------------------------------------------------- */

  async heartbeat(
    body: HeartbeatBody,
  ): Promise<{ cancel: string[]; recheck?: boolean; gateway?: { claude: boolean; codex: boolean } }> {
    this.seen(body.runnerId, body.status ? { status: body.status } : {});
    const recheck = this.recheckFor.delete(body.runnerId) ? { recheck: true } : {};
    // Which tools go through an AI gateway here (ai-gateway.md AIG-16): the runner claims them without a sign-in.
    // Absent while none does (both off, as from an older server).
    const switches = await gatewaySwitchesAnywhere(this.services.db);
    const gateway = switches.claude || switches.codex ? { gateway: switches } : {};
    if (body.active.length === 0) return { cancel: [], ...recheck, ...gateway };
    const rows = await this.services.db.select().from(dispatches).where(inArray(dispatches.id, body.active));
    const cancel = new Set(body.active.filter((id) => !rows.some((r) => r.id === id)));
    const renew: string[] = [];
    for (const row of rows) {
      const live = row.state === 'claimed' || row.state === 'running';
      if (!live || row.runnerId !== body.runnerId || (await this.stopReason(this.services.db, row)))
        cancel.add(row.id);
      else renew.push(row.id);
    }
    if (renew.length) {
      const now = this.services.clock();
      await this.services.pipeline.transactAccount((tx) =>
        tx
          .update(dispatches)
          .set({
            leaseExpiresAt: new Date(now.getTime() + this.options.leaseMs),
            tokenExpiresAt: slidTokenExpiry(this.services, now),
          })
          .where(and(inArray(dispatches.id, renew), inArray(dispatches.state, [...LIVE]))),
      );
    }
    return { cancel: [...cancel], ...recheck, ...gateway };
  }

  /** Requeues (or fails) dispatches whose runner stopped renewing the lease. Returns how many expired. */
  async sweep(): Promise<number> {
    const now = this.services.clock();
    const expired = await this.services.db
      .select({ id: dispatches.id, runnerId: dispatches.runnerId, attempts: dispatches.attempts })
      .from(dispatches)
      .where(and(inArray(dispatches.state, [...LIVE]), lte(dispatches.leaseExpiresAt, now)));
    let swept = 0;
    for (const row of expired) {
      // Only the lease that expired: a heartbeat or progress may have renewed it since it was read.
      const lease = { ...(row.runnerId ? { runnerId: row.runnerId } : {}), attempt: row.attempts };
      const state = await this.finalize(
        row.id,
        { outcome: 'failed', error: 'lease_expired' },
        { lease, expiredBy: now },
      );
      if (state !== 'lease_lost') swept++;
    }
    await this.interruptOrphans().catch((err) =>
      this.services.log.warn({ err: String(err) }, 'could not interrupt orphaned activity'),
    );
    await reconcileLiveRuns(this.services);
    return swept + (await this.sweepUnrunnable());
  }

  /**
   * Queued dispatches no connected runner can run (no runner is running, Hermes isn't ready there, or the agent's
   * provider isn't): the agent says why in a quiet reply instead of “thinking” until it times out. Returns how many were
   * answered.
   */
  async sweepUnrunnable(): Promise<number> {
    const runners = this.connectedRunners();
    const now = this.services.clock();
    const justStarted = Date.now() - this.startedAt < this.options.noRunnerMs;
    if (runners.length === 0 && justStarted) return 0;
    // Right after a start a runner's heartbeat may come before its first claim, which is what tells the server the
    // providers it runs: until it claimed, its turns aren't refused as ones nothing here can run.
    if (justStarted && runners.some((r) => !this.claimers.has(r.runnerId))) return 0;
    const claimable = new Set(runners.flatMap((r) => r.providers));
    // Hermes, which runs every turn (CT-1160): why not, when no connected runner that reported has it ready.
    const reported = runners.flatMap((r) => (r.status ? [r.status.hermes] : []));
    const engine = reported.length && !reported.some((h) => h.ready) ? reported[0] : null;
    const cutoff = new Date(
      now.getTime() - (runners.length ? this.options.unrunnableMs : this.options.noRunnerMs),
    );
    // A turn on its Chat thread's choice waits for that provider (chat-runtime.md CR-04, CR-S03).
    const provider = turnProviderSql;
    const rows = await this.services.db
      .select({ id: dispatches.id, provider, name: principals.name })
      .from(dispatches)
      .innerJoin(principals, eq(principals.id, dispatches.agentId))
      .where(
        and(
          eq(dispatches.state, 'queued'),
          or(isNull(dispatches.notBefore), lte(dispatches.notBefore, now)),
          lte(dispatches.createdAt, cutoff),
        ),
      )
      .limit(50);
    let answered = 0;
    for (const row of rows) {
      if (claimable.has(row.provider as AgentProvider)) continue;
      // The manager has just installed its client: the runners find it at their next re-check and claim it then.
      if (runners.length > 0 && !engine && clientJustInstalled(this.services, row.provider)) continue;
      const cause: UnrunnableCause =
        runners.length === 0
          ? { kind: 'no_runner' }
          : engine
            ? { kind: 'engine', problem: engine.problem ?? 'broken' }
            : row.provider === 'claude' || row.provider === 'codex'
              ? { kind: 'provider', provider: row.provider }
              : row.provider === 'local'
                ? { kind: 'local' }
                : { kind: 'no_provider' };
      const state = await this.finalize(
        row.id,
        { outcome: 'failed', error: `unrunnable:${cause.kind}`, refusal: unrunnableReply(cause) },
        { queuedOnly: true },
      );
      if (state === 'failed') answered++;
    }
    return answered;
  }

  /**
   * A dispatch was queued: once `unrunnableMs` has passed, the ones no connected runner can take get the agent's quiet
   * reply (SV-03), instead of at the next sweep. One timer at a time; the sweep catches the rest.
   */
  private unrunnableSoon(): void {
    if (this.unrunnableTimer || this.closed || !this.sweeper || !this.options.unrunnableSoon) return;
    this.unrunnableTimer = setTimeout(() => {
      this.unrunnableTimer = null;
      this.sweepUnrunnable().catch((err) =>
        this.services.log.warn({ err: String(err) }, 'unrunnable check failed'),
      );
    }, this.options.unrunnableMs + 250);
    this.unrunnableTimer.unref?.();
  }

  private startSweeper(): void {
    if (this.sweeper || this.closed) return;
    this.sweeper = this.services.housekeeping.add(
      'runtime sweep',
      () => this.options.sweepMs,
      () => this.sweep().catch((err) => this.services.log.warn({ err: String(err) }, 'lease sweep failed')),
      { first: 'tick' },
    );
  }

  /* Git credentials ------------------------------------------------------------------------------ */

  async liveDispatch(id: string, lease: RunnerLease = {}): Promise<DispatchRow> {
    const row = await this.load(id);
    if (row.state !== 'claimed' && row.state !== 'running')
      throw new ApiError('conflict', 'This dispatch is not running.');
    if (this.lost(row, lease)) throw new ApiError('conflict', 'This runner no longer holds the dispatch.');
    return row;
  }

  close(): void {
    this.closed = true;
    this.sweeper?.();
    this.sweeper = null;
    if (this.unrunnableTimer) clearTimeout(this.unrunnableTimer);
    this.unrunnableTimer = null;
    this.offBus?.();
    this.offBus = null;
    this.wake();
  }
}
