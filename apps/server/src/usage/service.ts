/**
 * Subscription usage (docs/decisions/ui-improvements.md UI-R09…UI-R14; contracts CT-153…CT-156): the latest snapshot
 * of the person's Claude and Codex sign-ins, from probes through the unmodified CLIs (the sign-in executor: this
 * server's own when self-hosted, the runner's in a task sandbox on an appliance) and from the rate-limit readings turns
 * report; `usage.list` / `usage.refresh`; `usage.updated` frames on the person's `me` topic; and the agent's alerts in
 * the person's Chat when a window crosses 80 % or 95 % or its limit was hit (one-person.md OP-S74: nobody else's).
 *
 * The snapshots are account-level operational state (UI-R09): written here in account transactions, never signed.
 * The alerts are messages, posted by the agent through the commit pipeline.
 */
import {
  type GatewayPool,
  type ProbeUsage,
  type SubscriptionUsage,
  type TurnRateLimits,
  topics,
  USAGE_PROVIDER_LABELS,
  UsageProvider,
  usageAlertText,
} from '@whombat/core';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { applyContext } from '../commit/pipeline';
import type { Tx } from '../db/client';
import { accounts, dispatches, principals, subscriptionUsage } from '../db/schema/index';
import { postMessage } from '../domain/messages';
import { gatewayPoolFor } from '../gateway/service';
import { agentContext, personalPlace, recentPlaces } from '../guides/place';
import { ApiError, forbidden, notFound } from '../lib/errors';
import { iso } from '../lib/time';
import { signInPerson } from '../managed/providers/credential-owner';
import { providerLogins } from '../managed/providers/service';
import { loadPrincipalRow, type PrincipalRow, personAccountId, shortName, toActor } from '../read/principals';
import { turnProvider } from '../runtime/turn-runtime';
import type { Services } from '../services';
import {
  type AlertPlace,
  applyReading,
  type DueAlert,
  dueAlerts,
  emptyRow,
  probeDueAt,
  refreshWaitSeconds,
  type UsageRow,
} from './logic';

const PROVIDERS = UsageProvider.options;
/** How long a list of the sign-ins is used before it is read again. */
const SIGN_INS_TTL_MS = 5 * 60_000;
/** The scheduler's tick, and how many probes one tick runs at most (one at a time). */
const TICK_MS = 60_000;
const FIRST_TICK_MS = 30_000;
const PROBES_PER_TICK = 20;
/** After a runner answered that it can't probe (an older release), probes wait this long. */
const UNSUPPORTED_BACKOFF_MS = 60 * 60_000;
/** After a probe no runner answered in time, the schedule waits this long. */
const RUNNER_AWAY_BACKOFF_MS = 5 * 60_000;

/** A reading's outcome, as the probe source answers it (tests replace the source). */
export type ProbeAnswer = { ok: true; usage: ProbeUsage } | { ok: false; code: string; message: string };

/** Where sign-ins and probes come from: the sign-in service (tests give their own). */
export interface UsageSource {
  signIns(): Promise<{ accountId: string; provider: UsageProvider; authMode: string }[]>;
  probe(accountId: string, provider: UsageProvider): Promise<ProbeAnswer>;
}

type SignInMap = Map<string, string>;
const keyOf = (accountId: string, provider: UsageProvider) => `${accountId}/${provider}`;

export class UsageService {
  /** Removes the schedule from housekeeping. */
  #timer: (() => void) | null = null;
  #first: ReturnType<typeof setTimeout> | null = null;
  #pending = new Set<Promise<unknown>>();
  #signIns: { at: number; map: SignInMap } | null = null;
  #loadingSignIns: Promise<SignInMap> | null = null;
  #probing = new Map<string, Promise<UsageRow>>();
  #unsupportedUntil = 0;
  #ticking = false;
  #source: UsageSource;

  constructor(private readonly services: Services) {
    this.#source = {
      signIns: async () => {
        // The sign-ins are the person's (one-person.md OP-S09): their usage rows are under their account.
        const accountId = await personAccountId(services.db);
        if (!accountId) return [];
        const records = await providerLogins(services).personSignIns();
        return records.flatMap((r) =>
          r.provider === 'claude' || r.provider === 'codex'
            ? [{ accountId, provider: r.provider, authMode: r.meta.authMode }]
            : [],
        );
      },
      probe: async (_accountId, provider) =>
        (await providerLogins(services).usageProbe(provider)) ?? {
          ok: false,
          code: 'unsupported',
          message: 'This Whombat has no place for sign-ins.',
        },
    };
  }

  /** Tests: where sign-ins and probe answers come from. */
  useSource(source: UsageSource): void {
    this.#source = source;
    this.#signIns = null;
  }

  /** Runs `work` in the background (a hook that must not hold its caller up), logging failures. */
  track(what: string, work: () => Promise<unknown>): void {
    const p = work()
      .catch((err) => this.services.log.warn({ err: String(err) }, `usage: ${what} failed`))
      .finally(() => this.#pending.delete(p));
    this.#pending.add(p);
  }

  /** Waits for background work (tests). */
  async settle(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }

  /* Sign-ins ------------------------------------------------------------------------------------------------------ */

  /** `<account>/<provider>` → auth mode of the person's Claude and Codex sign-ins, read at most every 5 minutes. */
  async signIns(force = false): Promise<SignInMap> {
    const now = Date.now();
    if (!force && this.#signIns && now - this.#signIns.at < SIGN_INS_TTL_MS) return this.#signIns.map;
    this.#loadingSignIns ??= (async () => {
      try {
        const list = await this.#source.signIns();
        const map: SignInMap = new Map(list.map((s) => [keyOf(s.accountId, s.provider), s.authMode]));
        this.#signIns = { at: Date.now(), map };
        return map;
      } catch (err) {
        // The runner may be away (an appliance restarting it): the last list stands.
        this.services.log.warn({ err: String(err) }, 'usage: sign-ins couldn’t be listed');
        return this.#signIns?.map ?? new Map();
      } finally {
        this.#loadingSignIns = null;
      }
    })();
    return this.#loadingSignIns;
  }

  /* Reads (usage.list) -------------------------------------------------------------------------------------------- */

  /** `usage.list` (UI-R14): the person's own sign-ins (people only; agents are refused). */
  async list(
    viewer: PrincipalRow,
    burrowId: string,
  ): Promise<{
    mine: SubscriptionUsage[];
    gateway: GatewayPool | null;
  }> {
    const accountId = this.personAccount(viewer, burrowId);
    const signIns = await this.signIns();
    const rows = await this.rowsOf([accountId]);
    const mine = PROVIDERS.flatMap((provider) => {
      const authMode = signIns.get(keyOf(accountId, provider));
      if (authMode === undefined) return [];
      return [toView(provider, authMode, rows.get(keyOf(accountId, provider)) ?? null)];
    });
    // The burrow's AI gateway, with its account emails (ai-gateway.md AIG-13).
    const gateway = await gatewayPoolFor(this.services, burrowId);
    return { mine, gateway };
  }

  /* Refresh (usage.refresh) --------------------------------------------------------------------------------------- */

  /**
   * `usage.refresh` (UI-R14): probes the caller's own subscription now, at most once a minute (429 `rate_limited` with
   * `details.retryAfter`); no sign-in for the provider is 404. While a turn runs on it, the turn's own readings stand
   * and nothing is started (UI-R07).
   */
  async refresh(viewer: PrincipalRow, burrowId: string, provider: UsageProvider): Promise<SubscriptionUsage> {
    const accountId = this.personAccount(viewer, burrowId);
    let authMode = (await this.signIns()).get(keyOf(accountId, provider));
    if (authMode === undefined) authMode = (await this.signIns(true)).get(keyOf(accountId, provider));
    if (authMode === undefined) throw notFound(`Your ${USAGE_PROVIDER_LABELS[provider]} sign-in`);
    const now = this.services.clock();
    const claimed = await this.services.pipeline.transactAccount(async (tx) => {
      const row = await lockRow(tx, accountId, provider);
      const wait = refreshWaitSeconds(row, now);
      if (wait > 0) return wait;
      await tx
        .update(subscriptionUsage)
        .set({ refreshedAt: now })
        .where(and(eq(subscriptionUsage.accountId, accountId), eq(subscriptionUsage.provider, provider)));
      return 0;
    });
    if (claimed > 0)
      throw new ApiError('rate_limited', 'You can check again in a minute.', {
        details: { retryAfter: claimed },
      });
    const row = (await this.turnRunning(accountId, provider))
      ? ((await this.rowsOf([accountId])).get(keyOf(accountId, provider)) ?? emptyRow(accountId, provider))
      : await this.probe(accountId, provider);
    return toView(provider, authMode, row);
  }

  /* Probes -------------------------------------------------------------------------------------------------------- */

  /** Probes one subscription now (one at a time per subscription) and stores what it read. */
  probe(accountId: string, provider: UsageProvider): Promise<UsageRow> {
    const key = keyOf(accountId, provider);
    const running = this.#probing.get(key);
    if (running) return running;
    const p = this.#probe(accountId, provider).finally(() => this.#probing.delete(key));
    this.#probing.set(key, p);
    return p;
  }

  async #probe(accountId: string, provider: UsageProvider): Promise<UsageRow> {
    const answer = await this.#source.probe(accountId, provider);
    const now = this.services.clock();
    if (!answer.ok && answer.code === 'unsupported')
      this.#unsupportedUntil = now.getTime() + UNSUPPORTED_BACKOFF_MS;
    // No runner answered in time: the round stops, the next tries again in a few minutes.
    if (!answer.ok && answer.code === 'runner_away')
      this.#unsupportedUntil = now.getTime() + RUNNER_AWAY_BACKOFF_MS;
    if (!answer.ok && answer.code === 'provider.not_signed_in') this.#signIns = null;
    return this.store(accountId, provider, (row) =>
      answer.ok
        ? applyReading(row, answer.usage, 'probe', now)
        : { ...row, probedAt: now, error: answer.message.slice(0, 300) },
    );
  }

  /**
   * A turn's rate-limit reading (UI-R08): stored for the subscription the turn ran on — the person's (one-person.md
   * OP-S09); the AI gateway or the operator's own login is nobody's subscription and is dropped.
   */
  async fromTurn(dispatchId: string, reading: TurnRateLimits): Promise<void> {
    const [dispatch] = await this.services.db
      .select({
        agentId: dispatches.agentId,
        onBehalfOf: dispatches.onBehalfOfAccountId,
        gatewayProvider: dispatches.gatewayProvider,
        runtime: dispatches.runtime,
      })
      .from(dispatches)
      .where(eq(dispatches.id, dispatchId));
    // A turn through the AI gateway ran on nobody's own subscription (ai-gateway.md AIG-10, AIG-15).
    if (!dispatch || dispatch.gatewayProvider) return;
    const agent = await loadPrincipalRow(this.services.db, dispatch.agentId);
    if (agent?.kind !== 'agent') return;
    // The provider the turn ran on: its Chat thread's choice, else the agent's (chat-runtime-server.md CR-S03).
    if (turnProvider(agent.runtime, dispatch) !== reading.provider) return;
    // The person's sign-in ran it (one-person.md OP-S09).
    const accountId =
      dispatch.onBehalfOf ?? (await signInPerson(this.services.db, agent.burrowId))?.accountId ?? null;
    if (!accountId) return;
    const authMode = (await this.signIns()).get(keyOf(accountId, reading.provider));
    // Only a person's own sign-in on this Whombat is theirs to report (self-hosted turns without one ran on the
    // operator's login).
    if (authMode === undefined) return;
    const now = this.services.clock();
    await this.store(accountId, reading.provider, (row) => applyReading(row, reading, 'turn', now));
  }

  /**
   * Changes one subscription's row under a lock (probes and turns may report at once), keeps the alert keys of what it
   * is due, then publishes the snapshot and posts the alerts (UI-R11).
   */
  async store(
    accountId: string,
    provider: UsageProvider,
    change: (row: UsageRow) => UsageRow,
  ): Promise<UsageRow> {
    const now = this.services.clock();
    const { row, alerts } = await this.services.pipeline.transactAccount(async (tx) => {
      const before = await lockRow(tx, accountId, provider);
      const changed = change(before);
      const due = dueAlerts(changed);
      const next = { ...changed, alerts: due.keys };
      await tx
        .update(subscriptionUsage)
        .set({
          kind: next.kind,
          plan: next.plan,
          windows: next.windows,
          observedAt: next.observedAt,
          source: next.source,
          error: next.error,
          probedAt: next.probedAt,
          refreshedAt: next.refreshedAt,
          usedAt: next.usedAt,
          alerts: next.alerts,
          updatedAt: now,
        })
        .where(and(eq(subscriptionUsage.accountId, accountId), eq(subscriptionUsage.provider, provider)));
      return { row: next, alerts: due.alerts };
    });
    await this.publish(row);
    if (alerts.length) this.track('alerts', () => this.postAlerts(row, alerts));
    return row;
  }

  /* Realtime ------------------------------------------------------------------------------------------------------ */

  /** `usage.updated` (UI-R14) on `me:<principal>` of the subscription's person. Never on `burrow:`. */
  async publish(row: UsageRow): Promise<void> {
    const authMode = (await this.signIns()).get(keyOf(row.accountId, row.provider));
    if (authMode === undefined) return;
    const places = await this.personsOf(row.accountId);
    const at = iso(this.services.clock());
    for (const person of places) {
      const usage = toView(row.provider, authMode, row);
      this.services.bus.publish({
        topic: topics.me(person.id),
        event: { type: 'usage.updated', usage },
        eventId: null,
        at,
        outboxId: null,
      });
    }
  }

  /* Alerts -------------------------------------------------------------------------------------------------------- */

  /** Posts each due alert in the person's Chat, in the burrow they were last active in (UI-R12). */
  async postAlerts(row: UsageRow, due: readonly DueAlert[]): Promise<number> {
    const rows = await this.personsOf(row.accountId);
    const [first] = await recentPlaces(this.services, row.accountId);
    if (!rows.length || !first) return 0;
    const place: AlertPlace = { ...first, accountId: row.accountId };
    const person = rows.find((p) => p.burrowId === place.burrowId);
    let posted = 0;
    for (const alert of due)
      if (await this.postAlert(place, row, alert, person ? shortName(person) : 'Someone')) posted++;
    return posted;
  }

  async #timeZoneOf(accountId: string, burrowTimeZone: string): Promise<string> {
    const [account] = await this.services.db
      .select({ preferences: accounts.preferences })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    const zone = (account?.preferences as { timeZone?: string | null } | null)?.timeZone;
    return zone || burrowTimeZone;
  }

  /** One alert in the person's Chat, posted by the agent (it notifies them; nobody is woken). */
  async postAlert(place: AlertPlace, row: UsageRow, alert: DueAlert, personName: string): Promise<boolean> {
    const posted = await this.services.pipeline.transact(place.burrowId, async (session) => {
      const where = await personalPlace(session.tx, place.burrowId, place.personId);
      if (!where) return false;
      const now = this.services.clock();
      const text = usageAlertText({
        level: alert.level,
        provider: row.provider,
        window: alert.window,
        personName,
        forOwner: true,
        now,
        timeZone: await this.#timeZoneOf(place.accountId, where.burrow.timeZone),
      });
      const ctx = applyContext(session, {
        burrow: where.burrow,
        actor: toActor(where.agent),
        now,
        at: iso(now),
        decision: null,
        requirement: null,
        approvalId: null,
        onBehalfOf: {},
      });
      await postMessage(agentContext(ctx, where.agent), {
        conversation: where.dm,
        text,
        dispatch: false,
        notifyDmPerson: true,
      });
      return true;
    });
    return posted.result;
  }

  /* The schedule (UI-R10) ------------------------------------------------------------------------------------------ */

  /**
   * Probes what is due: the person's Claude and Codex subscriptions every 15 minutes while a turn used it in the last
   * 24 hours, hourly otherwise; never an API key, never one a turn is running on, never while draining. Snapshots of
   * sign-ins that are gone are dropped.
   */
  async tick(): Promise<number> {
    if (this.#ticking || this.services.maintenance.paused) return 0;
    const now = this.services.clock();
    if (now.getTime() < this.#unsupportedUntil) return 0;
    this.#ticking = true;
    try {
      // The list as cached (5 minutes, SV-03): a sign-in made since is probed at the next read at the latest, and
      // snapshots are only dropped against a list read in this tick.
      const readAt = Date.now();
      const signIns = await this.signIns();
      const fresh = (this.#signIns?.at ?? 0) >= readAt;
      const accountIds = [...new Set([...signIns.keys()].map((k) => k.split('/')[0] ?? ''))];
      const rows = await this.rowsOf(accountIds);
      if (fresh) await this.dropGone(signIns);
      let probed = 0;
      for (const [key, authMode] of signIns) {
        if (probed >= PROBES_PER_TICK || this.services.clock().getTime() < this.#unsupportedUntil) break;
        const [accountId = '', provider] = key.split('/') as [string, UsageProvider];
        if (authMode === 'api_key') continue;
        const row = rows.get(key) ?? emptyRow(accountId, provider);
        if (probeDueAt(row, now) > now) continue;
        if (await this.turnRunning(accountId, provider)) continue;
        await this.probe(accountId, provider);
        probed++;
      }
      return probed;
    } finally {
      this.#ticking = false;
    }
  }

  /** The first look 30 seconds after the start, then every minute on the housekeeping tick (SV-03). */
  start(): void {
    if (this.#timer) return;
    const tick = () => this.track('tick', () => this.tick());
    this.#timer = this.services.housekeeping.add('usage', TICK_MS, async () => tick());
    this.#first = setTimeout(tick, FIRST_TICK_MS);
    this.#first.unref?.();
  }

  close(): void {
    this.#timer?.();
    if (this.#first) clearTimeout(this.#first);
    this.#timer = null;
    this.#first = null;
  }

  /* Helpers ------------------------------------------------------------------------------------------------------- */

  /** The viewer's account, when they are a person of this burrow; agents and others are refused. */
  private personAccount(viewer: PrincipalRow, burrowId: string): string {
    if (viewer.kind !== 'person' || viewer.burrowId !== burrowId || !viewer.accountId || viewer.system)
      throw forbidden('Only people see subscription usage.');
    return viewer.accountId;
  }

  private async rowsOf(accountIds: readonly string[]): Promise<Map<string, UsageRow>> {
    if (!accountIds.length) return new Map();
    const rows = await this.services.db
      .select()
      .from(subscriptionUsage)
      .where(inArray(subscriptionUsage.accountId, [...accountIds]));
    return new Map(rows.map((r) => [keyOf(r.accountId, r.provider), r as UsageRow]));
  }

  /** Removes the snapshots of sign-ins that are gone (signed out), when the list could be read. */
  private async dropGone(signIns: SignInMap): Promise<void> {
    if (!this.#signIns) return;
    const rows = await this.services.db
      .select({ accountId: subscriptionUsage.accountId, provider: subscriptionUsage.provider })
      .from(subscriptionUsage);
    const gone = rows.filter((r) => !signIns.has(keyOf(r.accountId, r.provider)));
    if (!gone.length) return;
    await this.services.pipeline.transactAccount(async (tx) => {
      for (const r of gone)
        await tx
          .delete(subscriptionUsage)
          .where(
            and(eq(subscriptionUsage.accountId, r.accountId), eq(subscriptionUsage.provider, r.provider)),
          );
    });
  }

  /** The account's person principals (one per burrow they're in). */
  private personsOf(accountId: string): Promise<PrincipalRow[]> {
    return this.services.db
      .select()
      .from(principals)
      .where(
        and(eq(principals.accountId, accountId), eq(principals.kind, 'person'), isNull(principals.system)),
      );
  }

  /**
   * Whether a turn is running on the subscription now (UI-R07): a claimed or running dispatch of an agent on that
   * provider, for that person. Probes wait for it (the turn reports the windows itself). A
   * turn through the AI gateway doesn't count: it runs on nobody's subscription (ai-gateway.md AIG-15).
   */
  async turnRunning(accountId: string, provider: UsageProvider): Promise<boolean> {
    const rows = await this.services.sql<{ n: number }[]>`
      select count(*)::int as n
        from dispatches d join principals a on a.id = d.agent_id
       where d.state in ('claimed', 'running')
         and d.gateway_provider is null
         and coalesce(d.runtime->>'provider', a.runtime->>'provider') = ${provider}
         and d.on_behalf_of_account_id = ${accountId}`;
    return (rows[0]?.n ?? 0) > 0;
  }
}

/** The subscription's row, created if missing, locked for the rest of the transaction. */
async function lockRow(tx: Tx, accountId: string, provider: UsageProvider): Promise<UsageRow> {
  await tx.insert(subscriptionUsage).values({ accountId, provider }).onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(subscriptionUsage)
    .where(and(eq(subscriptionUsage.accountId, accountId), eq(subscriptionUsage.provider, provider)))
    .for('update');
  return (row as UsageRow | undefined) ?? emptyRow(accountId, provider);
}

/** The snapshot (`SubscriptionUsage`). An API key has no windows: “see Spend”. */
export function toView(provider: UsageProvider, authMode: string, row: UsageRow | null): SubscriptionUsage {
  const apiKey = authMode === 'api_key' || row?.kind === 'api_key';
  return {
    provider,
    kind: apiKey ? 'api_key' : 'subscription',
    connected: true,
    plan: apiKey ? null : (row?.plan ?? null),
    windows: apiKey ? [] : (row?.windows ?? []),
    observedAt: row?.observedAt ? iso(row.observedAt) : null,
    source: row?.source ?? null,
    error: row?.error ?? null,
  };
}
