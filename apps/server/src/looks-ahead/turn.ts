/**
 * A Looks ahead check's turn (docs/decisions/looks-ahead.md): what it is told (`DispatchContext.ahead`), its own tools
 * (`search_web`, `read_web_page`, `ahead_read_docs`, `ahead_report`), what it may read of the person's (mail, Drive /
 * OneDrive files, Paperless / Notion docs — only where Allowed: nobody is there to ask), and the person's word on a
 * finding afterwards (`ahead_feedback`).
 */
import {
  type AheadDispatchContext,
  type AheadKind,
  type AheadReportInput,
  aheadHours,
  aheadQueryRefusal,
  aheadSkip,
  aheadStageVersion,
  aheadVersion,
  decide,
  type KeyId,
  MCP_TOOLS,
  type McpToolName,
} from '@whombat/core';
import { and, desc, eq, isNotNull, ne } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { aheadChecks, burrows, connections, principals } from '../db/schema/index';
import { thePerson } from '../domain/the-person';
import { forbidden } from '../lib/errors';
import { loadGrants } from '../read/principals';
import type { DispatchRow } from '../runtime/context';
import type { Services } from '../services';
import { openWebSearchKey } from '../web-search/store';
import { calendarAccounts, calendarKey, currentEvent } from './calendars';
import {
  aheadFeedback,
  aheadSettingsOf,
  CHECKING_MAX_MS,
  markAheadMailRead,
  NOT_AN_AHEAD_CHECK,
  reportAhead,
  toldCheckOfThread,
} from './commands';
import { aheadDocSources, searchAheadDocs } from './docs';
import { mailAccounts } from './mail';
import {
  forgetSeen,
  sawBlockedFallback,
  sawLink,
  sawLinks,
  sawSource,
  sawSourceKind,
  seenOf,
  takePage,
  takeSearch,
} from './seen';
import { braveSearch, httpUrl, readPage, WebRefusal } from './web';

export { NOT_AN_AHEAD_CHECK, NOT_AN_AHEAD_THREAD } from './commands';

/** What a check hears when it calls anything it isn't served. */
export const AHEAD_TOOL_REFUSED =
  'While checking ahead you only search and read public pages, then read mail, files or connected docs, and end with ahead_report.';

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

/** `DispatchContext.ahead`: the plan or email a check is about (plus schedule, rules, dismissals, prior notes), or what was told in a finding's thread. */
export async function aheadContextOf(
  services: Services,
  db: Db,
  dispatch: DispatchRow,
): Promise<AheadDispatchContext | null> {
  const row = (await aheadCheckOfTurn(db, dispatch)) ?? (await aheadThreadOf(db, dispatch));
  if (!row) return null;
  const settings = await aheadSettingsOf(db, dispatch.burrowId);
  const isCheck = dispatch.trigger === 'ahead';

  let mailProviders: ('google' | 'microsoft' | 'imap')[] | undefined;
  let hasFiles: boolean | undefined;
  let docSources: string[] | undefined;
  let recentDismissed: AheadDispatchContext['recentDismissed'];
  let priorChecks: AheadDispatchContext['priorChecks'];

  if (isCheck) {
    const person = await thePerson(db, dispatch.burrowId);
    if (person?.accountId) {
      const mails = await mailAccounts(services, db, person.accountId);
      mailProviders = [...new Set(mails.map((m) => m.provider))];
      const fileConns = await db
        .select({ services: connections.services, status: connections.status })
        .from(connections)
        .where(eq(connections.accountId, person.accountId));
      hasFiles = fileConns.some((c) => c.status === 'active' && c.services.includes('files'));
    }
    const docs = await aheadDocSources(db, dispatch.burrowId);
    if (docs.length) docSources = docs;

    // Last 10 “Not useful” findings for calibration.
    const dismissed = await db
      .select({
        summary: aheadChecks.summary,
        kind: aheadChecks.kind,
        feedbackNote: aheadChecks.feedbackNote,
      })
      .from(aheadChecks)
      .where(
        and(
          eq(aheadChecks.burrowId, dispatch.burrowId),
          eq(aheadChecks.feedback, 'not_useful'),
          isNotNull(aheadChecks.kind),
        ),
      )
      .orderBy(desc(aheadChecks.reportedAt))
      .limit(10);
    if (dismissed.length) {
      recentDismissed = dismissed
        .filter((d): d is typeof d & { kind: AheadKind } => d.kind !== null)
        .map((d) => ({
          title: d.summary.slice(0, 300),
          kind: d.kind,
          ...(d.feedbackNote ? { reason: d.feedbackNote } : {}),
        }));
    }

    // Earlier check stages of THIS same event only (never general memory).
    if (row.source === 'calendar') {
      const prior = await db
        .select({
          stage: aheadChecks.stage,
          state: aheadChecks.state,
          kind: aheadChecks.kind,
          note: aheadChecks.note,
          text: aheadChecks.text,
        })
        .from(aheadChecks)
        .where(
          and(
            eq(aheadChecks.burrowId, dispatch.burrowId),
            eq(aheadChecks.eventKey, row.eventKey),
            ne(aheadChecks.id, row.id),
          ),
        )
        .orderBy(desc(aheadChecks.startedAt))
        .limit(6);
      if (prior.length) {
        priorChecks = prior
          .filter((p): p is typeof p & { state: 'quiet' | 'told' | 'failed' } => p.state !== 'checking')
          .map((p) => ({
            stage: p.stage,
            state: p.state,
            ...(p.kind ? { kind: p.kind } : {}),
            ...(p.note ? { note: p.note } : {}),
            ...(p.state === 'told' && p.text ? { text: p.text } : {}),
          }));
      }
    }
  }

  return {
    source: row.source,
    stage: row.stage,
    summary: row.summary.slice(0, 300),
    start: row.event.start,
    end: row.event.end,
    location: row.location.slice(0, 500),
    description: row.event.description.slice(0, 2000),
    calendar: row.calendar.slice(0, 120),
    timeZone: row.event.timeZone,
    ...(row.event.allDay ? { allDay: true } : {}),
    stopped: settings.stopped.filter((k): k is AheadKind => typeof k === 'string') as AheadKind[],
    ...(row.event.daySchedule?.length ? { daySchedule: row.event.daySchedule } : {}),
    ...(row.event.mail ? { mail: row.event.mail } : {}),
    ...(mailProviders?.length ? { mailProviders } : {}),
    ...(hasFiles ? { hasFiles: true } : {}),
    ...(docSources?.length ? { docSources } : {}),
    ...(settings.rules.length ? { rules: [...settings.rules] } : {}),
    ...(recentDismissed?.length ? { recentDismissed } : {}),
    ...(priorChecks?.length ? { priorChecks } : {}),
    ...(row.state === 'told' && row.kind && row.text
      ? { found: { kind: row.kind, text: row.text, ...(row.actionLabel ? { action: row.actionLabel } : {}) } }
      : {}),
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

const PRIVATE_READ_TOOLS = new Set<McpToolName>([
  'mail_search',
  'mail_read',
  'files_search',
  'files_read',
  'ahead_read_docs',
]);

/**
 * Before any tool runs in a check: only while the check goes on and Looks ahead is on (else only `ahead_report`, to end
 * it); private tools (mail, files) only when their key is Allowed — nobody is there to say yes — and the web only while
 * “Browse the web” is Allowed and before any private data was read. Null when it may run, else what the check hears.
 */
export async function aheadToolRefusal(
  services: Services,
  dispatch: DispatchRow,
  name: McpToolName,
): Promise<string | null> {
  if (name === 'ahead_report') return null;
  const row = await aheadCheckOfTurn(services.db, dispatch);
  if (row?.state !== 'checking') return 'This check has ended.';
  // A check that ran late (claimed after its time, or past its two hours) does nothing more.
  const now = services.clock();
  const [burrow] = await services.db
    .select({ timeZone: burrows.timeZone })
    .from(burrows)
    .where(eq(burrows.id, dispatch.burrowId));
  if (
    !aheadHours(now, burrow?.timeZone ?? 'UTC') ||
    now.getTime() - row.startedAt.getTime() >= CHECKING_MAX_MS
  )
    return 'This check is over: end with ahead_report, found false.';
  const settings = await aheadSettingsOf(services.db, dispatch.burrowId);
  const calendarOff =
    row.source === 'calendar' &&
    settings.calendarsOff.includes(calendarKey(row.event.connectionId, row.event.calendarId));
  const mailOff = row.source === 'mail' && !settings.mailOn;
  if (!settings.on || calendarOff || mailOff)
    return 'Looks ahead or this source was switched off: end with ahead_report, found false.';
  // The web tools need no key of their own elsewhere; here they are “Browse the web”, as Hermes's own web search is.
  const key = name === 'search_web' || name === 'read_web_page' ? 'web.browse' : MCP_TOOLS[name].requiredKey;
  if (key && key !== 'by_input' && !(await keyAllowed(services, dispatch.agentId, key)))
    return 'This needs the person’s yes, and nobody is there to ask while you check ahead: go on without it.';
  // Private data (mail, Drive/OneDrive files, Paperless/Notion docs) is about to reach the model: close the web now.
  if (PRIVATE_READ_TOOLS.has(name)) {
    seenOf(services, dispatch.id).mailRead = true;
    const res = await services.pipeline.commit(
      markAheadMailRead,
      { dispatchId: dispatch.id },
      { burrowId: dispatch.burrowId, actorId: dispatch.agentId },
    );
    if (res.status !== 'ok') return 'Private sources can’t be read in this check now.';
  }
  return null;
}

/** The most of one mail's or file's text a check reads. */
const AHEAD_PRIVATE_BODY_MAX = 8000;

/**
 * A mail as a finding names it: the site its sender's address is at (“ticketmaster.example”), never the name the sender
 * chose for themselves; “mail” when there is no address.
 */
export function senderName(from: unknown): string {
  const text = typeof from === 'string' ? from : '';
  const address = /<([^<>\s]+@[^<>\s]+)>/.exec(text)?.[1] ?? /[^\s<>"]+@[^\s<>"]+/.exec(text)?.[0] ?? '';
  const domain =
    address
      .split('@')[1]
      ?.toLowerCase()
      .replace(/[^a-z0-9.-]/g, '') ?? '';
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? domain.slice(0, 60) : 'mail';
}

/**
 * After one of the person's tools ran in a check: mails and files it read may be named as sources, and their text is
 * cut to `AHEAD_PRIVATE_BODY_MAX`.
 */
export async function aheadToolRan(
  services: Services,
  dispatch: DispatchRow,
  name: McpToolName,
  out: unknown,
): Promise<void> {
  if (dispatch.trigger !== 'ahead') return;
  const seen = seenOf(services, dispatch.id);
  if (name === 'mail_read') {
    const found =
      (
        out as {
          messages?: { id?: unknown; from?: unknown; body?: unknown; bodyTruncated?: unknown }[];
        } | null
      )?.messages ?? [];
    for (const m of found) {
      if (typeof m.id === 'string') seen.mails.set(m.id, senderName(m.from));
      if (typeof m.body === 'string' && m.body.length > AHEAD_PRIVATE_BODY_MAX) {
        m.body = `${m.body.slice(0, AHEAD_PRIVATE_BODY_MAX)}…`;
        m.bodyTruncated = true;
      }
    }
    return;
  }
  if (name === 'files_read') {
    const file = out as {
      file?: { id?: unknown; webUrl?: unknown };
      content?: unknown;
      truncated?: unknown;
    } | null;
    const id = file?.file?.id;
    if (typeof id === 'string') {
      const url = typeof file?.file?.webUrl === 'string' ? file.file.webUrl : '';
      const label = /onedrive|sharepoint|1drv/i.test(url) ? 'OneDrive' : 'Google Drive';
      seen.files.set(id, label);
    }
    if (typeof file?.content === 'string' && file.content.length > AHEAD_PRIVATE_BODY_MAX) {
      file.content = `${file.content.slice(0, AHEAD_PRIVATE_BODY_MAX)}…`;
      file.truncated = true;
    }
  }
}

/* The check's own tools ---------------------------------------------------------------------------------------------- */

/**
 * Words that never go into a search: the names and addresses of the people on this Whombat and of the event's guests.
 * Venue, town and date words stay allowed.
 */
async function privateWords(services: Services, burrowId: string, row: AheadCheckRow): Promise<string[]> {
  const people = await services.db
    .select({ name: principals.name })
    .from(principals)
    .where(and(eq(principals.burrowId, burrowId), eq(principals.kind, 'person')));
  const person = await thePerson(services.db, burrowId);
  // Every account of the person's (mail-only ones too), as the turn's preface names them.
  const addresses = person?.accountId
    ? (
        await services.db
          .select({ email: connections.email })
          .from(connections)
          .where(eq(connections.accountId, person.accountId))
      ).map((c) => c.email)
    : [];
  // In the same pieces the search is cut into: “john.pals@example.com” is “john”, “pals”, “example”, “com”.
  return [...people.map((p) => p.name), ...addresses, ...(row.event.guests ?? [])]
    .flatMap((w) => w.split(/[^\p{L}\p{N}]+/u))
    .filter((w) => w.length >= 3 && !COMMON_WORDS.has(w.toLowerCase()));
}

/** Pieces of addresses that are everyone's, not a person's. */
const COMMON_WORDS = new Set([
  'com',
  'net',
  'org',
  'gmail',
  'outlook',
  'hotmail',
  'icloud',
  'live',
  'example',
]);

/** What a check hears when it reaches for the web after reading private sources (or in a mail-triggered check). */
const WEB_CLOSED =
  'The web is closed in this check (private mail, files or docs were read): decide with what you found, then ahead_report.';

export async function searchWebTool(services: Services, dispatch: DispatchRow, query: string) {
  const row = await liveCheck(services, dispatch);
  const seen = seenOf(services, dispatch.id);
  if (row.mailReadAt || seen.mailRead) throw forbidden(WEB_CLOSED);
  const refusal = aheadQueryRefusal(query, await privateWords(services, dispatch.burrowId, row));
  if (refusal) throw forbidden(refusal);
  const [burrow] = await services.db.select().from(burrows).where(eq(burrows.id, dispatch.burrowId));
  if (!burrow?.webSearch || !burrow.webSearchKeyEnc)
    throw forbidden('There is no web search here (no Brave Search key): go on with the mail.');
  let key: string;
  try {
    key = openWebSearchKey(services.custody, burrow.id, burrow.webSearchKeyEnc);
  } catch {
    throw forbidden('The web search key can’t be used right now: go on with the mail.');
  }
  if (!takeSearch(seen))
    throw forbidden('That was the last search for this check: decide with what you found.');
  try {
    const results = await braveSearch(services, key, query);
    sawLinks(
      seen,
      results.map((r) => r.url),
      true,
    );
    return { status: 'ok' as const, results };
  } catch (err) {
    if (err instanceof WebRefusal) throw forbidden(err.message);
    throw err;
  }
}

export async function readWebPageTool(services: Services, dispatch: DispatchRow, url: string) {
  const row = await liveCheck(services, dispatch);
  const seen = seenOf(services, dispatch.id);
  if (row.mailReadAt || seen.mailRead) throw forbidden(WEB_CLOSED);
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
    if (err instanceof WebRefusal) {
      if (err.blocked) sawBlockedFallback(seen, url);
      throw forbidden(err.message);
    }
    throw err;
  }
}

export async function readDocsTool(services: Services, dispatch: DispatchRow, query: string) {
  await liveCheck(services, dispatch);
  const docs = await searchAheadDocs(services, dispatch.burrowId, query);
  const seen = seenOf(services, dispatch.id);
  for (const d of docs) seen.docs.set(d.docId, d.source);
  return { status: 'ok' as const, docs };
}

/** A source as Whombat names it on the finding: the site, mail sender, Drive/OneDrive, Paperless/Notion or calendar. */
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
 * Before `ahead_report` commits: the check is going on, and every source of a finding is something it really read —
 * a page it read (or tried to read when the site blocked fetching), a mail, Drive/OneDrive file, Paperless/Notion
 * doc, or the person's own calendar schedule — named by Whombat. Throws what the check hears otherwise.
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
      const kind = sawSourceKind(seen, source.url);
      if (!kind)
        throw forbidden(
          `${source.url} isn’t a page you read in this check: read it with read_web_page first (a search result is only a lead).`,
        );
      // Pages are read over https: the link is the page as Whombat read it.
      const link = (httpUrl(source.url) ?? source.url).replace(/^http:/, 'https:');
      named.push({
        label: kind === 'search' ? `${siteOf(source.url)} (search)` : siteOf(source.url),
        url: link,
      });
    } else if ('mailId' in source) {
      const sender = seen.mails.get(source.mailId);
      if (!sender) throw forbidden('A mail you name must be one you read with mail_read in this check.');
      named.push({ label: `${sender} (mail)` });
    } else if ('fileId' in source) {
      const label = seen.files.get(source.fileId);
      if (!label) throw forbidden('A file you name must be one you read with files_read in this check.');
      named.push({ label });
    } else if ('docId' in source) {
      const label = seen.docs.get(source.docId);
      if (!label)
        throw forbidden('A document you name must be one you read with ahead_read_docs in this check.');
      named.push({ label });
    } else if ('calendar' in source) {
      named.push({ label: 'Your calendar' });
    }
  }
  return named;
}

/**
 * Whether a calendar event is still as the check began it, read from the calendar just before a finding is told: gone,
 * changed, unreadable or no longer the assistant's to read (its key), the finding is kept quiet. Mail checks return
 * true (they are anchored to the email, not a calendar version).
 */
export async function aheadEventCurrent(services: Services, dispatch: DispatchRow): Promise<boolean> {
  const row = await aheadCheckOfTurn(services.db, dispatch);
  if (!row) return false;
  if (row.source === 'mail') {
    const settings = await aheadSettingsOf(services.db, dispatch.burrowId);
    return settings.on && settings.mailOn;
  }
  if (!row.event.connectionId) return false;
  const settings = await aheadSettingsOf(services.db, dispatch.burrowId);
  if (
    !settings.on ||
    settings.calendarsOff.includes(calendarKey(row.event.connectionId, row.event.calendarId))
  )
    return false;
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
    return !!event && !aheadSkip(event) && aheadStageVersion(aheadVersion(event), row.stage) === row.version;
  } catch {
    return false;
  }
}

export { aheadFeedback, forgetSeen, reportAhead };
