/**
 * A Looks ahead check's turn (docs/decisions/looks-ahead.md): what it is told (`DispatchContext.ahead`), its own tools
 * (`search_web`, `read_web_page`, `ahead_read_docs`, `ahead_report`; a triage pass only `ahead_triage`), what it may
 * read of the person's (mail, Drive / OneDrive files, Paperless / Notion docs — only where Allowed: nobody is there to
 * ask), the person's word on a finding afterwards (`ahead_feedback`), and what the person asks Whombat to keep an eye
 * on in their own turn (`ahead_watch`).
 */
import {
  type AheadDispatchContext,
  type AheadKind,
  type AheadReportInput,
  type AheadTriageMail,
  type AheadWatchInput,
  aheadHours,
  aheadQueryRefusal,
  aheadSkip,
  aheadStageVersion,
  aheadVersion,
  type KeyId,
  LOOKS_AHEAD_WORDS,
  type LooksAheadMatter,
  MCP_TOOLS,
  type McpToolName,
  mailFromAddress,
  WEATHER_CREDIT,
  WEATHER_DAYS_MAX,
} from '@whombat/core';
import { and, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { aheadChecks, aheadMatters, burrows, connections, principals } from '../db/schema/index';
import { thePerson } from '../domain/the-person';
import { forbidden } from '../lib/errors';
import { placeOfBurrow } from '../place/store';
import type { DispatchRow } from '../runtime/context';
import { dispatchPerson } from '../runtime/person';
import type { Services } from '../services';
import { weatherFor } from '../weather/service';
import { aheadForecastOf } from '../weather/view';
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
  matterContext,
  matterItem,
  openMatters,
  personBeganTurn,
  startAheadMatter,
  stopAheadMatter,
} from './matters';
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
import { keyAllowedIn } from './store';
import { NOT_A_TRIAGE, TRIAGE_ONLY, triageAhead } from './triage';
import { braveSearch, httpUrl, readPage, WebRefusal } from './web';

export { NOT_AN_AHEAD_CHECK, NOT_AN_AHEAD_THREAD } from './commands';
export { NOT_A_TRIAGE, TRIAGE_ONLY } from './triage';

/** What a mail check hears when it reports a finding or a matter before reading its own mail. */
export const READ_THE_MAIL_FIRST = 'Read this mail with mail_read first, then report.';

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

/** The longest field values a triage pass's list carries (`AheadTriageMail`). */
const TRIAGE_MAIL_CUT = { from: 160, subject: 200, date: 64, snippet: 240, account: 120 } as const;

/**
 * `DispatchContext.ahead`: the plan, mail or matter a check is about (plus schedule, rules, dismissals, prior notes and
 * the matter it is about), the new mail of a triage pass with the open matters, or what was told in a finding's thread.
 */
export async function aheadContextOf(
  services: Services,
  db: Db,
  dispatch: DispatchRow,
): Promise<AheadDispatchContext | null> {
  const row = (await aheadCheckOfTurn(db, dispatch)) ?? (await aheadThreadOf(db, dispatch));
  if (!row) return null;
  const settings = await aheadSettingsOf(db, dispatch.burrowId);
  const isCheck = dispatch.trigger === 'ahead';
  const timeZone = row.event.timeZone;
  const [matter] = row.matterId
    ? await db.select().from(aheadMatters).where(eq(aheadMatters.id, row.matterId))
    : [];

  const base: AheadDispatchContext = {
    source: row.source,
    stage: row.stage,
    summary: row.summary.slice(0, 300),
    start: row.event.start,
    end: row.event.end,
    location: row.location.slice(0, 500),
    description: row.event.description.slice(0, 2000),
    calendar: row.calendar.slice(0, 120),
    timeZone,
    ...(row.event.allDay ? { allDay: true } : {}),
    stopped: settings.stopped.filter((k): k is AheadKind => typeof k === 'string') as AheadKind[],
    ...(row.event.daySchedule?.length ? { daySchedule: row.event.daySchedule.slice(0, 30) } : {}),
    ...(settings.rules.length ? { rules: [...settings.rules] } : {}),
  };

  // The person's own turn in a finding's thread: what was told, and the matter it is about.
  if (!isCheck) {
    const { mail } = row.event;
    return {
      ...base,
      ...(mail ? { mail: mailContext(mail) } : {}),
      ...(row.state === 'told' && row.kind && row.text
        ? {
            found: {
              kind: row.kind,
              text: row.text,
              ...(row.actionLabel ? { action: row.actionLabel } : {}),
              ...(matter ? { matter: { title: matter.title, asked: matter.origin === 'person' } } : {}),
            },
          }
        : {}),
    };
  }

  const recentDismissed = await dismissedOf(db, dispatch.burrowId);

  // A triage pass: the numbered new mail and the open matters, nothing to read.
  if (row.source === 'triage') {
    const triage = row.event.triage;
    const listed = triage?.mails ?? [];
    const several = new Set(listed.map((m) => m.account)).size > 1;
    const mails: AheadTriageMail[] = listed.map((m) => ({
      ref: m.ref,
      from: m.from.slice(0, TRIAGE_MAIL_CUT.from),
      subject: m.subject.slice(0, TRIAGE_MAIL_CUT.subject),
      date: m.date.slice(0, TRIAGE_MAIL_CUT.date),
      snippet: m.snippet.slice(0, TRIAGE_MAIL_CUT.snippet),
      ...(m.unread ? { unread: true } : {}),
      ...(several ? { account: m.account.slice(0, TRIAGE_MAIL_CUT.account) } : {}),
    }));
    const refs = triage?.matters ?? [];
    const shown = refs.length
      ? await db
          .select()
          .from(aheadMatters)
          .where(
            and(
              inArray(
                aheadMatters.id,
                refs.map((r) => r.id),
              ),
              eq(aheadMatters.state, 'open'),
            ),
          )
      : [];
    const byId = new Map(shown.map((m) => [m.id, m]));
    // As a list: never a matter's note, which a check wrote from a mail, beside other strangers' mail.
    const matters = refs.flatMap((r) => {
      const m = byId.get(r.id);
      return m ? [matterContext(m, r.ref, timeZone)] : [];
    });
    return {
      ...base,
      triage: { mails },
      ...(matters.length ? { matters } : {}),
      ...(recentDismissed.length ? { recentDismissed } : {}),
    };
  }

  let mailProviders: ('google' | 'microsoft' | 'imap')[] | undefined;
  let hasFiles: boolean | undefined;
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
  const docSources = await aheadDocSources(db, dispatch.burrowId);

  // Earlier checks of THIS same event, or of the same matter (never general memory).
  const about =
    row.source === 'calendar'
      ? eq(aheadChecks.eventKey, row.eventKey)
      : row.matterId
        ? and(eq(aheadChecks.matterId, row.matterId), ne(aheadChecks.source, 'triage'))
        : null;
  const prior = about
    ? await db
        .select({
          stage: aheadChecks.stage,
          state: aheadChecks.state,
          kind: aheadChecks.kind,
          note: aheadChecks.note,
          text: aheadChecks.text,
        })
        .from(aheadChecks)
        .where(and(eq(aheadChecks.burrowId, dispatch.burrowId), about, ne(aheadChecks.id, row.id)))
        .orderBy(desc(aheadChecks.startedAt))
        .limit(6)
    : [];
  const priorChecks = prior
    .filter((p): p is typeof p & { state: 'quiet' | 'told' | 'failed' } => p.state !== 'checking')
    .map((p) => ({
      stage: p.stage,
      state: p.state,
      ...(p.kind ? { kind: p.kind } : {}),
      ...(p.note ? { note: p.note } : {}),
      ...(p.state === 'told' && p.text ? { text: p.text } : {}),
    }));

  const { mail } = row.event;
  const openMatter = matter?.state === 'open' ? matter : null;
  // Where a follow-up or a matter's mail check looks: the mails its earlier checks were about, newest first, rather than
  // a search by a title written from mail.
  const messageIds = openMatter ? await matterMessageIds(db, dispatch.burrowId, openMatter.id, row.id) : [];
  const weather = row.source === 'calendar' ? await planForecast(services, dispatch, row) : null;
  return {
    ...base,
    ...(weather ? { weather } : {}),
    ...(mail ? { mail: mailContext(mail) } : {}),
    ...(mailProviders?.length ? { mailProviders } : {}),
    ...(hasFiles ? { hasFiles: true } : {}),
    ...(docSources.length ? { docSources: docSources.slice(0, 10) } : {}),
    ...(recentDismissed.length ? { recentDismissed } : {}),
    ...(priorChecks.length ? { priorChecks } : {}),
    // The matter it is about is always `k1` in this check.
    ...(openMatter
      ? {
          matter: matterContext(openMatter, 'k1', timeZone, {
            ...(row.event.matter?.reason ? { reason: row.event.matter.reason } : {}),
            messageIds,
          }),
        }
      : {}),
  };
}

/** How far ahead the forecast goes. */
const FORECAST_AHEAD_MS = WEATHER_DAYS_MAX * 24 * 3_600_000;

/**
 * A calendar check's forecast where the Whombat is, for the plan's day (weather-news.md), when the day is within the
 * forecast's week; the check may then name it as a source. Null otherwise, or when MET can't be read.
 */
async function planForecast(services: Services, dispatch: DispatchRow, row: AheadCheckRow) {
  const start = Date.parse(row.event.start);
  const now = services.clock();
  if (!Number.isFinite(start) || start - now.getTime() > FORECAST_AHEAD_MS) return null;
  const [burrow] = await services.db.select().from(burrows).where(eq(burrows.id, dispatch.burrowId));
  const place = burrow ? placeOfBurrow(burrow) : null;
  if (!burrow || !place) return null;
  const forecast = await weatherFor(services)
    .forecast(place.lat, place.lon)
    .catch(() => null);
  const found = forecast
    ? aheadForecastOf(place, forecast, now, burrow.timeZone, { start: row.event.start, end: row.event.end })
    : null;
  if (found) seenOf(services, dispatch.id).weather = true;
  return found;
}

/** The message ids of the mails a matter's earlier checks were about, newest first, without this check's own. */
async function matterMessageIds(
  db: Db,
  burrowId: string,
  matterId: string,
  rowId: string,
): Promise<string[]> {
  const rows = await db
    .select({ messageId: sql<string | null>`${aheadChecks.event}->'mail'->>'messageId'` })
    .from(aheadChecks)
    .where(
      and(
        eq(aheadChecks.burrowId, burrowId),
        eq(aheadChecks.matterId, matterId),
        ne(aheadChecks.id, rowId),
        isNotNull(sql`${aheadChecks.event}->'mail'->>'messageId'`),
      ),
    )
    .orderBy(desc(aheadChecks.startedAt))
    .limit(10);
  return [...new Set(rows.flatMap((r) => (r.messageId ? [r.messageId] : [])))];
}

/** A mail as a check reads it: what the row keeps, without the thread a matter is matched by. */
function mailContext(
  mail: NonNullable<AheadCheckRow['event']['mail']>,
): NonNullable<AheadDispatchContext['mail']> {
  return {
    provider: mail.provider,
    messageId: mail.messageId,
    from: mail.from.slice(0, 320),
    subject: mail.subject.slice(0, 300),
    date: mail.date.slice(0, 64),
    snippet: mail.snippet.slice(0, 600),
  };
}

/** The last 10 findings the person marked “Not useful”, for calibration. */
async function dismissedOf(
  db: Db,
  burrowId: string,
): Promise<NonNullable<AheadDispatchContext['recentDismissed']>> {
  const dismissed = await db
    .select({
      source: aheadChecks.source,
      summary: aheadChecks.summary,
      kind: aheadChecks.kind,
      feedbackNote: aheadChecks.feedbackNote,
    })
    .from(aheadChecks)
    .where(
      and(
        eq(aheadChecks.burrowId, burrowId),
        eq(aheadChecks.feedback, 'not_useful'),
        isNotNull(aheadChecks.kind),
      ),
    )
    .orderBy(desc(aheadChecks.reportedAt))
    .limit(10);
  return dismissed
    .filter((d): d is typeof d & { kind: AheadKind } => d.kind !== null)
    .map((d) => ({
      // A mail's subject (or a matter's title from mail) never rides along into later checks: only a plan's title does.
      title: d.source === 'calendar' ? d.summary.slice(0, 300) : '',
      kind: d.kind,
      ...(d.feedbackNote ? { reason: d.feedbackNote } : {}),
    }));
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
  return keyAllowedIn(services.db, agentId, key);
}

const PRIVATE_READ_TOOLS = new Set<McpToolName>([
  'mail_search',
  'mail_read',
  'mail_attachment_open',
  'files_search',
  'files_read',
  'ahead_read_docs',
]);

/** Whether a matter a check is about is still open. */
async function matterOpen(db: Db | Tx, matterId: string): Promise<boolean> {
  const [m] = await db
    .select({ state: aheadMatters.state })
    .from(aheadMatters)
    .where(eq(aheadMatters.id, matterId));
  return m?.state === 'open';
}

/**
 * Whether what a check that isn't about a calendar event reads (mail, a matter) may still be read and told: Looks ahead
 * and incoming mail on, `mail.read` Allowed, and the matter it is about still open.
 */
async function mailSourceOn(services: Services, dispatch: DispatchRow, row: AheadCheckRow): Promise<boolean> {
  const settings = await aheadSettingsOf(services.db, dispatch.burrowId);
  if (!settings.on || !settings.mailOn) return false;
  if (!(await keyAllowed(services, dispatch.agentId, 'mail.read'))) return false;
  return !row.matterId || (await matterOpen(services.db, row.matterId));
}

/**
 * Before any tool runs in a check: a triage pass only `ahead_triage`, and `ahead_triage` nowhere else; only while the
 * check goes on and Looks ahead is on (else only `ahead_report`, to end it); private tools (mail, files) only when their
 * key is Allowed — nobody is there to say yes — and the web only while “Browse the web” is Allowed and before any
 * private data was read. Null when it may run, else what the check hears.
 */
export async function aheadToolRefusal(
  services: Services,
  dispatch: DispatchRow,
  name: McpToolName,
): Promise<string | null> {
  const row = await aheadCheckOfTurn(services.db, dispatch);
  if (row?.source === 'triage') return name === 'ahead_triage' ? null : TRIAGE_ONLY;
  if (name === 'ahead_triage') return NOT_A_TRIAGE;
  if (name === 'ahead_report') return null;
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
  const mailOff = row.source !== 'calendar' && !(await mailSourceOn(services, dispatch, row));
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

/** The most of one mail's, attachment's or file's text a check reads. */
const AHEAD_PRIVATE_BODY_MAX = 8000;

/**
 * A mail as a finding names it: the site its sender's address is at (“ticketmaster.example”), never the name the sender
 * chose for themselves; “mail” when there is no address.
 */
export function senderName(from: unknown): string {
  const address = mailFromAddress(typeof from === 'string' ? from : '');
  const domain = address?.split('@')[1] ?? '';
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? domain.slice(0, 60) : 'mail';
}

/**
 * After one of the person's tools ran in a check: mails and files it read may be named as sources, and their text (an
 * opened attachment's too) is cut to `AHEAD_PRIVATE_BODY_MAX`.
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
  if (name === 'mail_attachment_open') {
    const opened = (out as { attachment?: { text?: unknown; truncated?: unknown } } | null)?.attachment;
    if (opened && typeof opened.text === 'string' && opened.text.length > AHEAD_PRIVATE_BODY_MAX) {
      opened.text = `${opened.text.slice(0, AHEAD_PRIVATE_BODY_MAX)}…`;
      opened.truncated = true;
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

/** What a check hears when it asks the weather of another place after the web closed. */
export const WEATHER_ELSEWHERE_CLOSED =
  'The web is closed in this check: weather_forecast only for where the person’s Whombat is now (leave place out).';

/**
 * Before a check asks the weather of another place (`weather_forecast` with `place`, looked up on OpenStreetMap): only
 * while its web is open, and only by public words (`aheadQueryRefusal`), as a search. Throws what the check hears.
 */
export async function aheadPlaceAllowed(
  services: Services,
  dispatch: DispatchRow,
  place: string,
): Promise<void> {
  const row = await liveCheck(services, dispatch);
  const seen = seenOf(services, dispatch.id);
  if (row.mailReadAt || seen.mailRead || row.source !== 'calendar') throw forbidden(WEATHER_ELSEWHERE_CLOSED);
  const refusal = aheadQueryRefusal(place, await privateWords(services, dispatch.burrowId, row));
  if (refusal) throw forbidden(refusal.replace('The search holds', 'The place holds'));
}

/** After `weather_forecast` ran in a check: the forecast may be a finding's source. */
export function aheadSawWeather(services: Services, dispatch: DispatchRow): void {
  if (dispatch.trigger === 'ahead') seenOf(services, dispatch.id).weather = true;
}

/**
 * After `news_headlines` ran in a check: each headline's link may be read with `read_web_page` and named as a source
 * (the site said it, in its own headline).
 */
export function aheadSawHeadlines(services: Services, dispatch: DispatchRow, links: readonly string[]): void {
  if (dispatch.trigger !== 'ahead') return;
  const seen = seenOf(services, dispatch.id);
  sawLinks(seen, links);
  for (const link of links) sawSource(seen, link);
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
 * doc, the person's own calendar schedule, or the matter the check is about — named by Whombat; and a matter it updates
 * is the one it was given. Throws what the check hears otherwise.
 */
export async function aheadReportSources(
  services: Services,
  dispatch: DispatchRow,
  report: AheadReportInput,
): Promise<NamedSource[]> {
  const row = await liveCheck(services, dispatch);
  if (row.source === 'triage') throw forbidden(TRIAGE_ONLY);
  // The only matter a check can update or close is the one it was given, as k1.
  const ref = row.source !== 'calendar' ? report.matter?.ref : undefined;
  if (ref && !row.matterId)
    throw forbidden(
      'This check was given nothing kept an eye on: leave ref out to start keeping an eye on something new.',
    );
  if (ref && ref !== 'k1') throw forbidden(`${ref} isn’t what this check was given: use k1.`);
  const seen = seenOf(services, dispatch.id);
  // A mail check speaks only about its own mail, read: a finding or a change to a matter needs that mail read first.
  if (row.source === 'mail' && (report.found || report.matter)) {
    const own = row.event.mail?.messageId;
    if (!own || !seen.mails.has(own)) throw forbidden(READ_THE_MAIL_FIRST);
  }
  if (!report.found) return [];
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
      named.push({ label: sender === 'mail' ? 'mail' : `${sender} (mail)` });
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
    } else if ('matter' in source) {
      if (row.source !== 'matter' || !row.matterId)
        throw forbidden('matter is a source only in a follow-up: name the mail you read instead.');
      named.push({ label: LOOKS_AHEAD_WORDS.matters });
    } else if ('weather' in source) {
      if (!seen.weather)
        throw forbidden(
          'weather is a source only when this check was given a forecast or you read one with weather_forecast.',
        );
      // MET Norway's licence asks for its credit wherever its data is shown.
      named.push({ label: WEATHER_CREDIT });
    }
  }
  return named;
}

/**
 * Whether a calendar event is still as the check began it, read from the calendar just before a finding is told: gone,
 * changed, unreadable or no longer the assistant's to read (its key), the finding is kept quiet. A mail check or a
 * follow-up is anchored to the mail or the matter instead: incoming mail still on and readable, its matter still open.
 */
export async function aheadEventCurrent(services: Services, dispatch: DispatchRow): Promise<boolean> {
  const row = await aheadCheckOfTurn(services.db, dispatch);
  if (!row) return false;
  if (row.source !== 'calendar') return mailSourceOn(services, dispatch, row);
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

/* What the person asks Whombat to keep an eye on ---------------------------------------------------------------- */

/** What the assistant hears outside a turn the person began themselves. */
export const NOT_THE_PERSONS_ASK =
  'ahead_watch works only when the person asks you themselves in Chat to tell them when something arrives.';

/** Why nothing can be kept an eye on now, in one plain sentence the assistant passes on; null when it can. */
async function watchRefusal(services: Services, dispatch: DispatchRow): Promise<string | null> {
  const settings = await aheadSettingsOf(services.db, dispatch.burrowId);
  if (!settings.on) return 'Looks ahead is off: it can be switched on in Settings first.';
  if (!settings.mailOn)
    return 'Incoming mail is off in Looks ahead: it can be switched on in Settings first.';
  const person = await thePerson(services.db, dispatch.burrowId);
  const boxes = person?.accountId ? await mailAccounts(services, services.db, person.accountId) : [];
  if (!boxes.length) return 'No mailbox is connected yet: connect Google, Microsoft 365 or Email first.';
  if (!(await keyAllowed(services, dispatch.agentId, 'mail.read')))
    return 'Reading mail isn’t Allowed for the assistant yet: it can be allowed in Settings first.';
  return null;
}

/**
 * `ahead_watch`, only in a turn the person began themselves: `start` keeps an eye on something in their mail, told in
 * this thread (when they asked at the top level of Chat, under their ask); `list` what is kept an eye on; `stop` one.
 */
export async function aheadWatchTool(
  services: Services,
  dispatch: DispatchRow,
  input: AheadWatchInput,
): Promise<{ status: 'ok'; matter?: LooksAheadMatter; matters?: LooksAheadMatter[] }> {
  if (!(await personBeganTurn(services.db, dispatch))) throw forbidden(NOT_THE_PERSONS_ASK);
  const as = { burrowId: dispatch.burrowId, actorId: dispatch.agentId };
  if (input.action === 'list')
    return { status: 'ok', matters: (await openMatters(services.db, dispatch.burrowId)).map(matterItem) };
  if (input.action === 'stop') {
    const res = await services.pipeline.commit(stopAheadMatter, { matterId: input.id ?? '' }, as);
    if (res.status !== 'ok') throw forbidden(res.message ?? 'That can’t be stopped now.');
    return { status: 'ok', matter: matterItem(res.result.matter) };
  }
  const refusal = await watchRefusal(services, dispatch);
  if (refusal) throw forbidden(refusal);
  const person = await dispatchPerson(services.db, dispatch);
  if (!person) throw forbidden(NOT_THE_PERSONS_ASK);
  const res = await services.pipeline.commit(
    startAheadMatter,
    {
      personId: person.id,
      title: input.title ?? '',
      ...(input.who ? { who: input.who } : {}),
      senders: input.senders ?? [],
      words: input.words ?? [],
      waitingOn: input.waitingOn,
      ...(input.due ? { due: input.due } : {}),
      conversationId: dispatch.conversationId,
      // The thread they asked in; asked at the top level of Chat, under their own ask.
      threadRootId: dispatch.threadRootId ?? dispatch.messageId,
    },
    as,
  );
  if (res.status !== 'ok') throw forbidden(res.message ?? 'That can’t be started now.');
  return { status: 'ok', matter: matterItem(res.result.matter) };
}

/** Whether a turn may be served `ahead_watch`: one the person began themselves. */
export async function aheadWatchServed(
  db: Db | Tx,
  dispatch:
    | (Pick<DispatchRow, 'trigger' | 'burrowId' | 'onBehalfOfAccountId' | 'messageId'> & {
        retryOfId?: string | null;
      })
    | undefined,
): Promise<boolean> {
  return !!dispatch && (await personBeganTurn(db, dispatch));
}

export { aheadFeedback, forgetSeen, reportAhead, triageAhead };
