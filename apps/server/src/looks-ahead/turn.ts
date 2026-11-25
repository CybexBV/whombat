/**
 * A Looks ahead check's turn (docs/decisions/looks-ahead.md): what it is told (`DispatchContext.ahead`), its own tools
 * (`search_web`, `read_web_page`, `ahead_report`), what it may read of the person's (calendar and mail, only where the
 * keys say Allowed: nobody is there to ask), and the person's word on a finding afterwards (`ahead_feedback`).
 */
import {
  type AheadDispatchContext,
  type AheadKind,
  type AheadReportInput,
  aheadQueryRefusal,
  aheadSkip,
  aheadVersion,
  decide,
  type KeyId,
  MCP_TOOLS,
  type McpToolName,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { aheadChecks, burrows } from '../db/schema/index';
import { thePerson } from '../domain/the-person';
import { forbidden } from '../lib/errors';
import { loadGrants } from '../read/principals';
import type { DispatchRow } from '../runtime/context';
import type { Services } from '../services';
import { openWebSearchKey } from '../web-search/store';
import { calendarAccounts, currentEvent } from './calendars';
import {
  aheadFeedback,
  aheadSettingsOf,
  NOT_AN_AHEAD_CHECK,
  reportAhead,
  toldCheckOfThread,
} from './commands';
import {
  forgetSeen,
  sawLink,
  sawLinks,
  sawSource,
  sawSourceOf,
  seenOf,
  takePage,
  takeSearch,
  webClosed,
} from './seen';
import { braveSearch, readPage, WebRefusal } from './web';

export { NOT_AN_AHEAD_CHECK, NOT_AN_AHEAD_THREAD } from './commands';

/** What a check hears when it calls anything it isn't served. */
export const AHEAD_TOOL_REFUSED =
  'While checking ahead you only read the calendar and the mail, search and read public pages, and end with ahead_report.';

type AheadCheckRow = typeof aheadChecks.$inferSelect;

/** The check a Looks ahead turn works on, or null. */
export async function aheadCheckOfTurn(
  db: Db | Tx,
  dispatch: Pick<DispatchRow, 'id' | 'trigger' | 'burrowId'>,
): Promise<AheadCheckRow | null> {
  if (dispatch.trigger !== 'ahead') return null;
  const [row] = await db
    .select()
    .from(aheadChecks)
    .where(and(eq(aheadChecks.burrowId, dispatch.burrowId), eq(aheadChecks.dispatchId, dispatch.id)));
  return row ?? null;
}

/** The finding whose thread the person's own turn is in, or null. */
export async function aheadThreadOf(
  db: Db | Tx,
  dispatch: Pick<DispatchRow, 'trigger' | 'burrowId' | 'threadRootId' | 'onBehalfOfAccountId'>,
): Promise<AheadCheckRow | null> {
  if (dispatch.trigger === 'ahead' || !dispatch.onBehalfOfAccountId) return null;
  return toldCheckOfThread(db, dispatch.burrowId, dispatch.threadRootId);
}

/** `DispatchContext.ahead`: the event a check is about, or what a finding told in the thread the person writes in. */
export async function aheadContextOf(db: Db, dispatch: DispatchRow): Promise<AheadDispatchContext | null> {
  const row = (await aheadCheckOfTurn(db, dispatch)) ?? (await aheadThreadOf(db, dispatch));
  if (!row) return null;
  const settings = await aheadSettingsOf(db, dispatch.burrowId);
  return {
    summary: row.summary.slice(0, 300),
    start: row.event.start,
    end: row.event.end,
    location: row.location.slice(0, 500),
    description: row.event.description.slice(0, 2000),
    calendar: row.calendar.slice(0, 120),
    timeZone: row.event.timeZone,
    stopped: settings.stopped.filter((k): k is AheadKind => typeof k === 'string') as AheadKind[],
    ...(row.state === 'told' && row.kind && row.text ? { found: { kind: row.kind, text: row.text } } : {}),
  };
}

/** The check's row, or a refusal: only while it is going on. */
async function liveCheck(services: Services, dispatch: DispatchRow): Promise<AheadCheckRow> {
  const row = await aheadCheckOfTurn(services.db, dispatch);
  if (!row) throw forbidden(NOT_AN_AHEAD_CHECK);
  if (row.state !== 'checking') throw forbidden('This check has ended.');
  return row;
}

/** Whether the agent's key is Allowed (not Ask, not Off): nobody is there to say yes while it checks ahead. */
export async function keyAllowed(services: Services, agentId: string, key: KeyId): Promise<boolean> {
  const grants = await loadGrants(services.db, agentId);
  return decide({ id: agentId, kind: 'agent' }, grants, key).outcome === 'allow';
}

/**
 * Before any tool runs in a check: only while the check goes on and Looks ahead is on (else only `ahead_report`, to end
 * it); the person's own tools (the calendar, the mail) only when their key is Allowed — nobody is there to say yes, and
 * a card would land in a thread that isn't there — and the calendar only the check's own calendar. Null when it may
 * run, else what the check hears.
 */
export async function aheadToolRefusal(
  services: Services,
  dispatch: DispatchRow,
  name: McpToolName,
  input: unknown,
): Promise<string | null> {
  if (name === 'ahead_report') return null;
  const row = await aheadCheckOfTurn(services.db, dispatch);
  if (!row || row.state !== 'checking') return 'This check has ended.';
  if (!(await aheadSettingsOf(services.db, dispatch.burrowId)).on)
    return 'Looks ahead was switched off: end with ahead_report, found false.';
  if (name === 'calendar_events') {
    const calendarId = (input as { calendarId?: unknown } | null)?.calendarId ?? 'primary';
    if (calendarId !== row.event.calendarId)
      return `Read only the calendar this event is on (calendarId ${row.event.calendarId}).`;
  }
  const key = MCP_TOOLS[name].requiredKey;
  // A key that depends on the input is never one of a check's tools (calendar and mail read have fixed keys).
  if (!key || key === 'by_input') return null;
  return (await keyAllowed(services, dispatch.agentId, key))
    ? null
    : 'This needs the person’s yes, and nobody is there to ask while you check ahead: go on without it.';
}

/** The most of one mail's text a check reads. */
const AHEAD_MAIL_BODY_MAX = 8000;

/**
 * A sender as a finding names them: their name as plain words (“Ticketmaster”), never an address or a link; “mail” when
 * nothing of it is left.
 */
export function senderName(from: unknown): string {
  const text = typeof from === 'string' ? from : '';
  const name = text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\S*(?:@|:\/\/|www\.)\S*/gi, ' ')
    .replace(/[^\p{L}\p{N} &'.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (name || 'mail').slice(0, 60);
}

/**
 * After one of the person's tools ran in a check: once it read mail, its web is closed; the mails it read may be named
 * as sources, by their sender, and each mail's text it gets is cut to `AHEAD_MAIL_BODY_MAX`.
 */
export async function aheadToolRan(
  services: Services,
  dispatch: DispatchRow,
  name: McpToolName,
  out: unknown,
): Promise<void> {
  if (dispatch.trigger !== 'ahead' || (name !== 'mail_read' && name !== 'mail_search')) return;
  const seen = seenOf(services, dispatch.id);
  // Strangers' words are in its context now: nothing more of this check goes to the web.
  seen.mailRead = true;
  if (name !== 'mail_read') return;
  const found =
    (out as { messages?: { id?: unknown; from?: unknown; body?: unknown; bodyTruncated?: unknown }[] } | null)
      ?.messages ?? [];
  for (const m of found) {
    if (typeof m.id === 'string') seen.mails.set(m.id, senderName(m.from));
    // A check needs the gist of a mail, not all of a newsletter: what it reads stays small.
    if (typeof m.body === 'string' && m.body.length > AHEAD_MAIL_BODY_MAX) {
      m.body = `${m.body.slice(0, AHEAD_MAIL_BODY_MAX)}…`;
      m.bodyTruncated = true;
    }
  }
}

/* The check's own tools ---------------------------------------------------------------------------------------------- */

/** Words of the person's own that never go into a search: their name and addresses. */
async function privateWords(services: Services, burrowId: string): Promise<string[]> {
  const person = await thePerson(services.db, burrowId);
  if (!person) return [];
  const accounts = person.accountId ? await calendarAccounts(services.db, person.accountId) : [];
  const addresses = accounts.flatMap((a) => [a.email, a.email.split('@')[0] ?? '']);
  return [...person.name.split(/\s+/), ...addresses].filter((w) => w.length >= 3);
}

/** What a check hears when it reaches for the web after reading mail. */
const WEB_CLOSED =
  'You read mail in this check, so nothing more goes to the web: decide with what you found, then ahead_report.';

export async function searchWebTool(services: Services, dispatch: DispatchRow, query: string) {
  await liveCheck(services, dispatch);
  const seen = seenOf(services, dispatch.id);
  if (webClosed(seen, dispatch.claimedAt)) throw forbidden(WEB_CLOSED);
  const refusal = aheadQueryRefusal(query, await privateWords(services, dispatch.burrowId));
  if (refusal) throw forbidden(refusal);
  const [burrow] = await services.db.select().from(burrows).where(eq(burrows.id, dispatch.burrowId));
  if (!burrow?.webSearch || !burrow.webSearchKeyEnc)
    throw forbidden(
      'There is no web search here (no Brave Search key): go on with the calendar and the mail.',
    );
  let key: string;
  try {
    key = openWebSearchKey(services.custody, burrow.id, burrow.webSearchKeyEnc);
  } catch {
    throw forbidden('The web search key can’t be used right now: go on with the calendar and the mail.');
  }
  if (!takeSearch(seen))
    throw forbidden('That was the last search for this check: decide with what you found.');
  try {
    const results = await braveSearch(services, key, query);
    sawLinks(
      seen,
      results.map((r) => r.url),
    );
    for (const r of results) sawSource(seen, r.url);
    return { status: 'ok' as const, results };
  } catch (err) {
    if (err instanceof WebRefusal) throw forbidden(err.message);
    throw err;
  }
}

export async function readWebPageTool(services: Services, dispatch: DispatchRow, url: string) {
  await liveCheck(services, dispatch);
  const seen = seenOf(services, dispatch.id);
  if (webClosed(seen, dispatch.claimedAt)) throw forbidden(WEB_CLOSED);
  if (!sawLink(seen, url))
    throw forbidden(
      'Only a link exactly as you saw it in a search result or on a page you read: links in the event or a mail aren’t opened.',
    );
  if (!takePage(seen)) throw forbidden('That was the last page for this check: decide with what you found.');
  try {
    const page = await readPage(services, url, (next) => sawLink(seen, next));
    sawLinks(seen, page.links);
    sawSource(seen, url);
    sawSource(seen, page.url);
    return { status: 'ok' as const, title: page.title, text: page.text, links: page.links };
  } catch (err) {
    if (err instanceof WebRefusal) throw forbidden(err.message);
    throw err;
  }
}

/** A source as Whombat names it on the finding: the site, or the mail's sender. */
export interface NamedSource {
  label: string;
  url?: string;
}

/** The site a page is on, as people say it: “ziggodome.nl”. */
function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').slice(0, 60);
  } catch {
    return 'web';
  }
}

/**
 * Before `ahead_report` commits: the check is going on, and every source of a finding is something it really read or
 * found — a page it read or a search result, a mail it read — named by Whombat. Throws what the check hears otherwise.
 */
export async function aheadReportSources(
  services: Services,
  dispatch: DispatchRow,
  report: AheadReportInput,
): Promise<NamedSource[]> {
  await liveCheck(services, dispatch);
  if (!report.found) return [];
  const seen = seenOf(services, dispatch.id);
  const named: NamedSource[] = [];
  for (const source of report.sources ?? []) {
    if ('url' in source) {
      if (!sawSourceOf(seen, source.url))
        throw forbidden(
          `${source.url} isn’t a page you read or found in this check: name only what you saw.`,
        );
      named.push({ label: siteOf(source.url), url: source.url });
    } else {
      const sender = seen.mails.get(source.mailId);
      if (!sender) throw forbidden('A mail you name must be one you read with mail_read in this check.');
      named.push({ label: `${sender} (mail)` });
    }
  }
  return named;
}

/**
 * Whether the event is still as the check began it, read from the calendar just before a finding is told: gone,
 * changed, unreadable or no longer the assistant's to read (its key), the finding is kept quiet.
 */
export async function aheadEventCurrent(services: Services, dispatch: DispatchRow): Promise<boolean> {
  const row = await aheadCheckOfTurn(services.db, dispatch);
  if (!row?.event.connectionId) return false;
  if (!(await keyAllowed(services, dispatch.agentId, 'calendar.read'))) return false;
  const person = await thePerson(services.db, dispatch.burrowId);
  const account = person?.accountId
    ? (await calendarAccounts(services.db, person.accountId)).find(
        (a) => a.connectionId === row.event.connectionId,
      )
    : undefined;
  if (!account) return false;
  try {
    const event = await currentEvent(services, account, row.event.calendarId, row.event.eventId);
    return !!event && !aheadSkip(event) && aheadVersion(event) === row.version;
  } catch {
    return false;
  }
}

export { aheadFeedback, forgetSeen, reportAhead };
