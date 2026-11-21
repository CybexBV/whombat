/**
 * The AI gateway's watcher (docs/decisions/ai-gateway.md AIG-11, AIG-13, AIG-14): every minute on the housekeeping
 * tick it reads each gateway connection — a Fusebox's accounts and faults (`GET /api/accounts`, `GET /api/faults`,
 * `GET /api/faults/dismissed`, with the management key), the generic gateway's `GET /v1/models` (with its key) — 10 s a call, one poll at a time per
 * connection, skipped while maintenance is paused. What it read goes into `gateway_usage` (account transactions,
 * never signed); a change of the accounts, faults, reachability or error is published as `usage.gateway_updated` on
 * the burrow topic; the alerts it is due go to the person's Chat (where usage alerts go, UI-R11/UI-R12; one-person.md
 * OP-S74), once per fault and `until`.
 *
 * Reachable means it answered: two polls in a row that got no answer (or a server error) make it unreachable, and so
 * does a turn's call the relay couldn't get to it (`noteRelayFailure`), so the next turns don't wait for the polls.
 * While it is unreachable, turns run on the person's own Claude or ChatGPT subscription, or don't start without one
 * (AIG-12, AIG-22). A refused management key is an answer: the accounts stay as last read and `error` says why.
 */
import {
  canonicalJson,
  GATEWAY_CALL_TIMEOUT_MS,
  GATEWAY_POLL_MS,
  GATEWAY_UNREACHABLE_FAILURES,
  type GatewayAccountUsage,
  type GatewayPool,
  gatewayAlertText,
  thingId,
  topics,
  USAGE_ERROR_MAX,
} from '@whombat/core';
import { eq, inArray } from 'drizzle-orm';
import { applyContext } from '../commit/pipeline';
import { credentialFor } from '../connections/credentials';
import { connectionFetch, jsonOf, outboundText } from '../connections/http';
import type { CatalogConnectionRow } from '../connections/types';
import type { Tx } from '../db/client';
import {
  accounts as accountsTable,
  burrows,
  catalogConnections,
  gatewayUsage,
  type StoredGatewayFault,
} from '../db/schema/index';
import { postMessage } from '../domain/messages';
import { thePerson } from '../domain/the-person';
import { agentContext, personalPlace } from '../guides/place';
import { iso } from '../lib/time';
import { type PrincipalRow, toActor } from '../read/principals';
import type { Services } from '../services';
import { quietNow } from '../things/quiet/defaults';
import { NO_QUIET, thingQuiet } from '../things/quiet/store';
import { ownSignIns } from './claim';
import {
  faultsByKey,
  gatewayAccountKey,
  mapFuseboxAccounts,
  mergeFaults,
  parseFuseboxFaults,
} from './fusebox';
import { dueGatewayAlerts, fallbackSignIns, type GatewayAlertDue, unreachable } from './logic';
import {
  type GatewayUsageRow,
  gatewayConnectionOf,
  gatewayName,
  gatewayUsageOf,
  isGatewayCatalogId,
  switchesOf,
} from './store';

/** Each answer may be this large (a pool of 64 accounts with their quota and models). */
const ANSWER_MAX_BYTES = 4 * 1024 * 1024;

/** What one poll read. */
export type PollReading =
  | {
      ok: true;
      accounts: GatewayAccountUsage[] | null;
      faults: StoredGatewayFault[] | null;
      error: string | null;
    }
  | { ok: false; error: string };

/** What one poll did (tests, logs). */
export interface GatewayPollResult {
  skipped?: 'gone' | 'paused';
  reachable?: boolean;
  changed?: boolean;
  alerts?: GatewayAlertDue[];
}

/** The same value however jsonb ordered its keys. */
const json = (v: unknown) => canonicalJson(v ?? null);

export class GatewayService {
  #ticker: (() => void) | null = null;
  #closed = false;
  readonly #running = new Map<string, Promise<GatewayPollResult>>();
  readonly #pending = new Set<Promise<unknown>>();
  /** Test seam: how a connection is read. */
  readFor: (row: CatalogConnectionRow) => Promise<PollReading> = (row) => this.read(row);

  constructor(private readonly services: Services) {}

  start(): void {
    if (this.#ticker || this.#closed) return;
    this.#ticker = this.services.housekeeping.add('ai gateway', GATEWAY_POLL_MS, () => this.tick(), {
      first: 'tick',
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#ticker?.();
    this.#ticker = null;
    await Promise.allSettled([...this.#running.values()]);
    await this.settle();
  }

  /** Waits for the alerts being posted (tests, shutdown). */
  async settle(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }

  /** Polls every gateway connection, one after another. Returns how many were read. */
  async tick(): Promise<number> {
    if (this.#closed || this.services.maintenance.paused) return 0;
    const rows = await this.services.db
      .select({ id: catalogConnections.id })
      .from(catalogConnections)
      .where(inArray(catalogConnections.catalogId, ['fusebox', 'ai_gateway']));
    let polled = 0;
    for (const { id } of rows) {
      if (this.#closed) break;
      const result = await this.pollNow(id).catch((err: unknown) => {
        this.services.log.warn({ err: String(err), connectionId: id }, 'ai gateway: poll failed');
        return null;
      });
      if (result && !result.skipped) polled++;
    }
    return polled;
  }

  /** Polls one connection now (single flight per connection). */
  pollNow(connectionId: string): Promise<GatewayPollResult> {
    const running = this.#running.get(connectionId);
    if (running) return running;
    const p = this.#poll(connectionId).finally(() => this.#running.delete(connectionId));
    this.#running.set(connectionId, p);
    return p;
  }

  async #poll(connectionId: string): Promise<GatewayPollResult> {
    if (this.services.maintenance.paused) return { skipped: 'paused' };
    const [row] = await this.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, connectionId));
    if (!row || !isGatewayCatalogId(row.catalogId)) return { skipped: 'gone' };
    const reading = await this.readFor(row);
    return this.store(row, reading);
  }

  /* Reading ------------------------------------------------------------------------------------------------------- */

  /** One GET under the connection's destination policy, as the connection; throws `OutboundError`. */
  async #get(row: CatalogConnectionRow, path: string) {
    const credential = await credentialFor(this.services, row, { evenIfNeedsReauth: true });
    const pin = row.fields?.fingerprint?.trim();
    return connectionFetch(
      this.services,
      `${row.baseUrl.replace(/\/+$/, '')}${path}`,
      { method: 'GET', headers: { accept: 'application/json', ...credential.headers } },
      {
        deadlineMs: GATEWAY_CALL_TIMEOUT_MS,
        maxBytes: ANSWER_MAX_BYTES,
        effect: 'gateway.poll',
        ...(pin ? { pinnedCertSha256: pin } : {}),
      },
    );
  }

  /**
   * Reads the gateway: a Fusebox's accounts and faults, the generic gateway's models. No answer (or a server error) is a
   * failed poll; a refused key is an answer that says so.
   */
  async read(row: CatalogConnectionRow): Promise<PollReading> {
    const name = gatewayName(row);
    try {
      if (row.catalogId === 'fusebox') {
        const accounts = await this.#get(row, '/api/accounts');
        if (accounts.status >= 500) return { ok: false, error: `${name} answered with an error.` };
        if (accounts.status === 401 || accounts.status === 403)
          return {
            ok: true,
            accounts: null,
            faults: null,
            error: `${name} refused the management key, so Whombat can’t read its limits. Replace it under Settings → Connections → ${name}.`,
          };
        if (accounts.status !== 200)
          return { ok: true, accounts: null, faults: null, error: `${name} didn’t list its accounts.` };
        const faults = await this.#get(row, '/api/faults');
        if (faults.status >= 500) return { ok: false, error: `${name} answered with an error.` };
        // Faults dismissed in Fusebox's dashboard still hold (an older Fusebox answers 404: none). Unreadable, the
        // faults stay as last read: taking them as none would announce room that isn't back.
        const dismissed = await this.#get(row, '/api/faults/dismissed');
        if (dismissed.status >= 500) return { ok: false, error: `${name} answered with an error.` };
        const hidden = dismissed.status === 404 ? [] : dismissed.status === 200 ? jsonOf(dismissed) : null;
        if (!Array.isArray(hidden))
          return { ok: true, accounts: null, faults: null, error: `${name} didn’t list its faults.` };
        // The list once more: a fault dismissed or shown again between the two reads is in one of the three.
        const again = dismissed.status === 200 ? await this.#get(row, '/api/faults') : null;
        if (again && again.status >= 500) return { ok: false, error: `${name} answered with an error.` };
        const parsedFaults = mergeFaults(
          parseFuseboxFaults(faults.status === 200 ? jsonOf(faults) : []),
          parseFuseboxFaults(hidden),
          parseFuseboxFaults(again?.status === 200 ? jsonOf(again) : []),
        );
        return {
          ok: true,
          accounts: mapFuseboxAccounts(row.id, jsonOf(accounts), parsedFaults, this.services.clock()),
          faults: parsedFaults,
          error: null,
        };
      }
      const models = await this.#get(row, '/v1/models');
      if (models.status >= 500) return { ok: false, error: `${name} answered with an error.` };
      if (models.status === 401 || models.status === 403)
        return { ok: true, accounts: [], faults: [], error: `${name} refused its key.` };
      return { ok: true, accounts: [], faults: [], error: null };
    } catch (err) {
      return { ok: false, error: outboundText(err) };
    }
  }

  /* Storing ------------------------------------------------------------------------------------------------------- */

  /** Stores what a poll read, publishes a change and posts the alerts it is due (AIG-11, AIG-14). */
  async store(row: CatalogConnectionRow, reading: PollReading): Promise<GatewayPollResult> {
    const burrowId = row.burrowId as string;
    const now = this.services.clock();
    // What the person quieted on Fusebox's page isn't messaged either (quiet-notices.md QN-S19).
    const quiet = await thingQuiet(this.services.db, row.burrowId, thingId('connection', row.id)).catch(
      () => NO_QUIET,
    );
    // Whose own sign-ins take the turns while it doesn't answer, for the alert that says so: read only then.
    const fallback = reading.ok ? undefined : fallbackSignIns(await ownSignIns(this.services), now);
    const result = await this.services.pipeline.transactAccount(async (tx) => {
      const before = await lockUsage(tx, row.id, burrowId);
      const [burrow] = await tx
        .select({ aiGateway: burrows.aiGateway })
        .from(burrows)
        .where(eq(burrows.id, burrowId));
      const failures = reading.ok ? 0 : before.failures + 1;
      const failingSince = reading.ok ? null : (before.failingSince ?? now);
      const accounts = reading.ok && reading.accounts ? reading.accounts : before.accounts;
      const faults = reading.ok && reading.faults ? reading.faults : before.faults;
      const labels = new Map<string, string>();
      if (reading.ok && reading.accounts)
        for (const f of faults) {
          // The fault's account by Fusebox's id → its label as the person reads it (alerts go to them).
          const label = accountLabelOf(row.id, f.accountId, accounts);
          if (f.accountId && label) labels.set(f.accountId, label);
        }
      const due = dueGatewayAlerts({
        switches: switchesOf(burrow?.aiGateway ?? null, row.id),
        faults,
        labelOf: (id) => labels.get(id) ?? null,
        reachability: { failures, failingSince },
        sent: before.alerts,
        now,
        ...(fallback ? { fallback } : {}),
        quiet: (f) =>
          f.kind === 'provider'
            ? quietNow(quiet, 'fusebox.used_up', `tool:${f.provider}`, now)
            : !!f.accountId &&
              quietNow(quiet, 'fusebox.signin', `account:${gatewayAccountKey(row.id, f.accountId)}`, now),
      });
      const next = {
        accounts,
        faults,
        reachable: !unreachable({ failures }),
        failures,
        observedAt: reading.ok ? now : before.observedAt,
        checkedAt: now,
        failingSince,
        error: (reading.error ?? null)?.slice(0, USAGE_ERROR_MAX) ?? null,
        alerts: due.keys,
        updatedAt: now,
      };
      await tx.update(gatewayUsage).set(next).where(eq(gatewayUsage.connectionId, row.id));
      const changed =
        json(before.accounts) !== json(next.accounts) ||
        json(faultsByKey(before.faults)) !== json(faultsByKey(next.faults)) ||
        before.reachable !== next.reachable ||
        before.error !== next.error;
      return { changed, alerts: due.alerts, reachable: next.reachable };
    });
    if (result.changed) this.publish(burrowId, row.id);
    if (result.alerts.length) this.#track(() => this.postAlerts(row, result.alerts));
    return result;
  }

  /** `usage.gateway_updated` on the burrow topic (clients read `usage.list` again). */
  publish(burrowId: string, connectionId: string): void {
    publishGatewayUsage(this.services, burrowId, connectionId);
  }

  /* Alerts (AIG-14) ----------------------------------------------------------------------------------------------- */

  #track(work: () => Promise<unknown>): void {
    const p = work()
      .catch((err: unknown) => this.services.log.warn({ err: String(err) }, 'ai gateway: alerts failed'))
      .finally(() => this.#pending.delete(p));
    this.#pending.add(p);
  }

  /** Posts the alerts in the person's Chat, by the agent. Returns how many. */
  async postAlerts(row: CatalogConnectionRow, alerts: readonly GatewayAlertDue[]): Promise<number> {
    const burrowId = row.burrowId as string;
    const person = await thePerson(this.services.db, burrowId);
    if (!person) return 0;
    let posted = 0;
    for (const alert of alerts) if (await this.postAlert(burrowId, person, row, alert)) posted++;
    return posted;
  }

  async postAlert(
    burrowId: string,
    person: PrincipalRow,
    row: CatalogConnectionRow,
    alert: GatewayAlertDue,
  ): Promise<boolean> {
    const posted = await this.services.pipeline.transact(burrowId, async (session) => {
      const where = await personalPlace(session.tx, burrowId, person.id);
      if (!where) return false;
      const now = this.services.clock();
      const text = gatewayAlertText({
        ...alert,
        name: gatewayName(row),
        now,
        timeZone: await timeZoneOf(this.services, where.accountId, where.burrow.timeZone),
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
}

/** `usage.gateway_updated` on the burrow topic (clients read `usage.list` again). */
function publishGatewayUsage(services: Services, burrowId: string, connectionId: string): void {
  services.bus.publish({
    topic: topics.burrow(burrowId),
    event: { type: 'usage.gateway_updated', connectionId },
    eventId: null,
    at: iso(services.clock()),
    outboxId: null,
  });
}

/**
 * A turn's call the relay couldn't get to the gateway at all (no connection, no answer before it gave up): the gateway
 * counts as unreachable now, as after the polls that failed, so the turn's retry and the next turns run on the person's
 * own sign-in without waiting a minute or two. Its next poll that gets an answer makes it reachable again; one that
 * doesn't carries on counting.
 */
export async function noteRelayFailure(
  services: Services,
  connectionId: string,
  burrowId: string,
): Promise<void> {
  const now = services.clock();
  const changed = await services.pipeline.transactAccount(async (tx) => {
    const before = await lockUsage(tx, connectionId, burrowId);
    if (unreachable(before)) return false;
    await tx
      .update(gatewayUsage)
      .set({
        failures: GATEWAY_UNREACHABLE_FAILURES,
        failingSince: before.failingSince ?? now,
        reachable: false,
        updatedAt: now,
      })
      .where(eq(gatewayUsage.connectionId, connectionId));
    return true;
  });
  if (!changed) return;
  services.log.warn(
    { connectionId },
    'ai gateway: a turn couldn’t reach it, so it counts as unreachable now',
  );
  publishGatewayUsage(services, burrowId, connectionId);
}

/** The usage row of a connection, made if missing, locked for the rest of the transaction. */
async function lockUsage(tx: Tx, connectionId: string, burrowId: string): Promise<GatewayUsageRow> {
  await tx.insert(gatewayUsage).values({ connectionId, burrowId }).onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(gatewayUsage)
    .where(eq(gatewayUsage.connectionId, connectionId))
    .for('update');
  if (!row) throw new Error('gateway usage row missing');
  return row;
}

/** The label (as the person reads it) of the account a fault is about, by Fusebox's id. */
function accountLabelOf(
  connectionId: string,
  fuseboxId: string | null,
  accounts: readonly GatewayAccountUsage[],
): string | null {
  if (!fuseboxId) return null;
  // Keys are hashes of Fusebox's ids (AIG-11): the same hash finds it.
  const key = gatewayAccountKey(connectionId, fuseboxId);
  return accounts.find((a) => a.key === key)?.label ?? null;
}

/** The account's own time zone, else the burrow's. */
async function timeZoneOf(services: Services, accountId: string, burrowTimeZone: string): Promise<string> {
  const [account] = await services.db
    .select({ preferences: accountsTable.preferences })
    .from(accountsTable)
    .where(eq(accountsTable.id, accountId));
  const zone = (account?.preferences as { timeZone?: string | null } | null)?.timeZone;
  return zone || burrowTimeZone;
}

/**
 * The burrow's gateway as Settings → AI → Usage shows it (AIG-13, `UsageListOutput.gateway`): the switches, whether it
 * answers, when it was last read, and a Fusebox's accounts with their emails. Null without a gateway connection.
 */
export async function gatewayPoolFor(services: Services, burrowId: string): Promise<GatewayPool | null> {
  const connection = await gatewayConnectionOf(services.db, burrowId);
  if (!connection || !isGatewayCatalogId(connection.catalogId)) return null;
  const [burrow] = await services.db
    .select({ aiGateway: burrows.aiGateway })
    .from(burrows)
    .where(eq(burrows.id, burrowId));
  const usage = await gatewayUsageOf(services.db, connection.id);
  const accounts = connection.catalogId === 'fusebox' ? (usage?.accounts ?? []) : [];
  return {
    connectionId: connection.id,
    name: gatewayName(connection),
    kind: connection.catalogId,
    ...switchesOf(burrow?.aiGateway ?? null, connection.id),
    reachable: !unreachable(usage),
    observedAt: usage?.observedAt ? iso(usage.observedAt) : null,
    error: usage?.error ?? null,
    accounts,
  };
}
