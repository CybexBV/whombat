/**
 * Mollie's page when it was connected with “Sign in with Mollie” (its own MCP server, https://mcp.mollie.com/mcp): the
 * page a key gives, as far as the server's tools that only read reach. Mollie lists the tools' names (its connector in
 * Claude's directory) but publishes neither their arguments nor their answers, so the page gives each tool only what its
 * server says it takes, when its schema names it: a `limit` and a `from` (the payment to go on from). A tool that
 * requires anything else is left out. Its answers are read as Mollie API v2's (`_embedded.payments`, `_links.next`), by
 * the same code as the key's; an answer of another shape leaves the part out.
 *
 * `ListPaymentsFromGivenIDOnwards` gives the payments: the newest 25 every read, and up to 4 pages back to the month's
 * start kept 5 minutes (a page must fit the 64 KiB Whombat keeps of an answer, and a payment is about a kilobyte);
 * `GetNextSettlement` the next payout. The server has no tool for refunds or chargebacks: those parts are left out, and
 * the chargeback check counts as not seen. The health pass reads only the newest page.
 */
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import { list, rec } from '../../words';
import {
  argsFor,
  propNamed,
  readToolSchemas,
  type ToolCall,
  type ToolSchema,
  toolCaller,
} from '../mcp-tools';
import { cachedRead, latestRead, ReadProblem } from '../read';
import type { KindSeen } from '../registry';
import type { KindCtx, KindView } from '../types';
import { amountOf, cannotRead, loader, optional, viewOrProblem } from './common';
import {
  DASHBOARD,
  HISTORY_CACHE_MS,
  MCP_ONLY,
  type MolliePayment,
  type MollieSnapshot,
  molliePayment,
  mollieSeen,
  mollieView,
  parsePayments,
  sinceOf,
} from './mollie';

const NAME = 'Mollie';

/** The server's tools the page reads. */
export const MOLLIE_TOOLS = {
  payments: 'ListPaymentsFromGivenIDOnwards',
  next: 'GetNextSettlement',
} as const;

/** Payments per call. */
export const MCP_PAGE = 25;
/** Calls back to the month's start at most; past them the month's figures say “at least”. */
export const MCP_PAGES = 4;
/** The pages back must end before the whole read's deadline: the newest page still shows. */
const HISTORY_DEADLINE_MS = 12_000;

/** What a tool's schema may call the page's size and the payment to go on from. */
const LIMIT = ['limit', 'pageSize', 'perPage'];
const FROM = ['from', 'fromId', 'startingAfter'];

/** A page of payments, newest first; `more` when the server says there are older ones. */
export interface PaymentsPage {
  payments: MolliePayment[];
  next: string | null;
  more: boolean;
}

/**
 * A payments answer: Mollie API's `_embedded.payments` with the next page's `from`, else a plain list of payments (more
 * of them when the list is full).
 */
export function paymentsOf(body: Record<string, unknown>): PaymentsPage {
  const byDate = (ps: MolliePayment[]) => ps.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  if (Array.isArray(rec(body._embedded).payments)) {
    const parsed = parsePayments(body);
    return { payments: byDate(parsed.payments), next: parsed.next, more: parsed.next !== null };
  }
  const plain = [body.payments, body.data, body.items].find(Array.isArray);
  const payments = list(plain)
    .map(molliePayment)
    .filter((p): p is MolliePayment => p !== null);
  return { payments: byDate(payments), next: null, more: payments.length >= MCP_PAGE };
}

/** One page of payments, from `from` on (the newest without it). */
export async function paymentsPage(
  call: ToolCall,
  schema: ToolSchema,
  from: string | null = null,
): Promise<PaymentsPage> {
  const args = argsFor(schema, [
    { names: LIMIT, value: MCP_PAGE },
    { names: FROM, value: from ?? undefined },
  ]);
  if (!args) throw new ReadProblem('Mollie’s payments tool asks for more than Whombat knows to give it.');
  return paymentsOf(await call(MOLLIE_TOOLS.payments, args));
}

interface History {
  payments: MolliePayment[];
  partial: boolean;
  nextPayout: { value: number; currency: string } | null;
}

/** The payments back to `since` and the next payout. */
export async function readHistory(
  call: ToolCall,
  tools: ReadonlyMap<string, ToolSchema>,
  since: Date,
): Promise<History> {
  const schema = tools.get(MOLLIE_TOOLS.payments) ?? null;
  // Without a `from` the server can't be asked for older payments.
  const goesOn = propNamed(schema, FROM) !== null;
  const payments: MolliePayment[] = [];
  let from: string | null = null;
  let partial = true;
  for (let page = 0; page < MCP_PAGES; page++) {
    const read = await paymentsPage(call, schema, from);
    payments.push(...read.payments);
    const oldest = read.payments.at(-1);
    if (!read.more || !oldest || oldest.createdAt < since) {
      partial = false;
      break;
    }
    if (!goesOn || !read.next) break;
    from = read.next;
  }
  const nextSchema = tools.get(MOLLIE_TOOLS.next);
  const nextArgs = nextSchema !== undefined ? argsFor(nextSchema, []) : null;
  const next = nextArgs ? await optional(call(MOLLIE_TOOLS.next, nextArgs)) : null;
  return {
    payments: payments.filter((p) => p.createdAt >= since),
    partial,
    nextPayout: next ? amountOf(next.amount) : null,
  };
}

/** The page's snapshot: the newest page as it is now over the kept history, back to `since`. */
export function snapshotOf(
  latest: PaymentsPage,
  history: History | null,
  now: Date,
  since: Date,
): MollieSnapshot {
  const seen = new Set(latest.payments.map((p) => p.id));
  const payments = [...latest.payments, ...(history?.payments ?? []).filter((p) => !seen.has(p.id))]
    .filter((p) => p.createdAt >= since)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const oldest = latest.payments.at(-1);
  return {
    readAt: now,
    payments,
    partial: history ? history.partial : latest.more && !!oldest && oldest.createdAt >= since,
    refunds: null,
    chargebacks: null,
    nextPayout: history?.nextPayout ?? null,
  };
}

/** The read-only tools, or null when the server offers no payments to read. */
async function toolsFor(services: Services, row: CatalogConnectionRow) {
  const tools = await readToolSchemas(services, row.id);
  if (!tools.has(MOLLIE_TOOLS.payments)) return null;
  return { tools, call: toolCaller(services, row, new Set(tools.keys())) };
}

function latestPage(
  services: Services,
  row: CatalogConnectionRow,
  call: ToolCall,
  tools: ReadonlyMap<string, ToolSchema>,
) {
  return cachedRead(
    services,
    `mollie-mcp-latest:${row.id}`,
    row,
    loader(NAME, () => paymentsPage(call, tools.get(MOLLIE_TOOLS.payments) ?? null)),
  );
}

async function readAll(
  services: Services,
  row: CatalogConnectionRow,
  call: ToolCall,
  tools: ReadonlyMap<string, ToolSchema>,
  now: Date,
  timeZone: string,
): Promise<MollieSnapshot> {
  const since = sinceOf(now, timeZone);
  const [latest, history] = await Promise.all([
    latestPage(services, row, call, tools),
    optional(
      cachedRead(
        services,
        `mollie-mcp-history:${row.id}:${timeZone}`,
        row,
        loader(NAME, () => readHistory(call, tools, since), HISTORY_DEADLINE_MS),
        HISTORY_CACHE_MS,
      ),
    ),
  ]);
  return snapshotOf(latest, history, now, since);
}

/** Mollie's read for its page through the MCP server (PS-01): null when the server offers no payments to read. */
export async function mollieMcpLatest(
  services: Services,
  row: CatalogConnectionRow,
  now = services.clock(),
  timeZone = 'UTC',
) {
  const found = await toolsFor(services, row);
  if (!found) return null;
  return latestRead(
    services,
    `mollie-mcp:${row.id}:${timeZone}`,
    row,
    loader(NAME, () => readAll(services, row, found.call, found.tools, now, timeZone)),
  );
}

/** The page signed in with Mollie: the key's page without refunds and chargebacks, or why there is none. */
export async function mollieMcpPage(ctx: KindCtx): Promise<KindView> {
  const open = { label: 'Open Mollie', url: DASHBOARD };
  const read = await mollieMcpLatest(ctx.services, ctx.row, ctx.now, ctx.timeZone);
  if (!read) return cannotRead(MCP_ONLY, open);
  return viewOrProblem(read, NAME, open, (snapshot) =>
    mollieView({ snapshot, now: ctx.now, timeZone: ctx.timeZone }),
  );
}

/** The health pass signed in with Mollie: the card and the checks from the newest page only. */
export async function mollieMcpSeen(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
  skippedAll: readonly string[],
): Promise<KindSeen> {
  const found = await toolsFor(services, row);
  if (!found) return { glance: { facts: [] }, points: {}, notices: [], skipped: [...skippedAll] };
  const latest = await latestPage(services, row, found.call, found.tools);
  return mollieSeen({ snapshot: snapshotOf(latest, null, now, sinceOf(now, timeZone)), now, timeZone });
}
