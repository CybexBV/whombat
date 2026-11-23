/**
 * The person's own accounts' widgets in the runtime (docs/decisions/desk-display.md DK-159; desk-display-server.md
 * DK-S250…): which accounts the screen's person has (*Your accounts* in *Add a widget*) and what each widget reads.
 *
 * - **As the screen's person.** An `account:<id>` is one of `connections` with the viewer's own account; anyone else's
 *   says it isn't connected. Its calendar and mail are read with the person's own token (one refresh on a 401, as the
 *   connector tools do); `account:github` is the Whombat's mirror of its repositories' pull requests.
 * - **At its own pace.** What's read is kept, not the view: the calendar for today 5 minutes, unread mail 2 minutes,
 *   pull requests a minute; *Next meeting*'s “in 12 min” and *Today*'s what's left are drawn from what's kept each
 *   minute. A new day reads its own calendar.
 * - **Failures say why.** Signed out, a service not connected or not allowed say what to do in Settings; a provider
 *   that didn't answer keeps what was read before, or says it isn't answering.
 */
import {
  type CalendarEvent,
  type ConnectorProvider,
  type ConnectorService,
  DESK_ACCOUNT_GITHUB,
  type DeskCatalogGroup,
  type DeskWidgetSpec,
} from '@whombat/core';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { ConnectionUnavailableError, GoogleApiError, type InboxUnread } from '../../connectors/types';
import { connections, prChecks, principals, prReviewers, pullRequests, repos } from '../../db/schema/index';
import type { Services } from '../../services';
import { accountCalendar, accountUnread, heldAt, UNREAD_NEWEST } from '../../things/accounts/reads';
import {
  ACCOUNT_PANELS,
  ACCOUNT_REFRESH_S,
  ACCOUNT_WORDS,
  type AccountInfo,
  type AccountPanel,
  type AccountPull,
  accountGroup,
  accountPanelOf,
  accountPanels,
  accountProblemView,
  isPrivatePanel,
  nextView,
  providerWord,
  pullsView,
  reviewsView,
  todayView,
  todayWindow,
  unreadView,
} from './account-views';
import { type Kept, RETRY_MS } from './resolve';
import type { Resolved, WidgetCtx } from './types';

/** How long each read is kept (ms); the calendar and mail are read through the reads an account's page shares. */
export const ACCOUNT_KEEP_MS = { calendar: 5 * 60_000, mail: 2 * 60_000, github: 60_000 } as const;
/** The newest unread mails read with the count. */
export { UNREAD_NEWEST };

/** Open pull requests read at most (the widgets show twelve; the rest are counted). */
const PULLS_MAX = 200;

/** One of the person's connections, as the widgets read it. */
export interface AccountRow {
  id: string;
  provider: ConnectorProvider;
  email: string;
  services: ConnectorService[];
  status: string;
}

/** What the widgets read; the database and the providers unless a test says otherwise. */
export interface AccountReads {
  /** The viewer's own connections (any status). */
  accounts(ctx: WidgetCtx): Promise<AccountRow[]>;
  /** Today's calendar items of an account, read with its person's token. */
  calendar(ctx: WidgetCtx, row: AccountRow, window: { from: string; to: string }): Promise<CalendarEvent[]>;
  /** Its inbox's unread count and the newest unread. */
  unread(ctx: WidgetCtx, row: AccountRow, newest: number): Promise<InboxUnread>;
  /** Whether the Whombat has a repository whose pull requests it mirrors. */
  hasRepos(ctx: WidgetCtx): Promise<boolean>;
  /** Its open pull requests, as the mirror knows them. */
  pulls(ctx: WidgetCtx): Promise<AccountPull[]>;
  /**
   * When the calendar or mail just read was read, when the read came from what an account's page read earlier (the
   * widget keeps it only what is left of its time); absent or null: now.
   */
  readAt?(ctx: WidgetCtx, row: AccountRow, source: 'calendar' | 'mail'): Date | null;
}

type Source = 'calendar' | 'mail' | 'github';

/** What's kept for one account's source. */
type AccountData =
  | { kind: 'problem'; provider: ConnectorProvider | 'github'; text: string }
  | { kind: 'calendar'; provider: ConnectorProvider; email: string; events: CalendarEvent[]; at: number }
  | { kind: 'mail'; provider: ConnectorProvider; unread: InboxUnread; at: number }
  | { kind: 'github'; pulls: AccountPull[]; at: number };

const SOURCE_OF: Record<AccountPanel, Source> = {
  today: 'calendar',
  next: 'calendar',
  unread: 'mail',
  pulls: 'github',
  reviews: 'github',
};

/** Whether a widget names one of the person's accounts. */
export const isAccountRef = (ref: string | undefined): ref is string => !!ref?.startsWith('account:');

const idOf = (ref: string) => ref.slice('account:'.length);
const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);

/** The providers whose accounts have widgets now (Google only when it's on). */
function offered(services: Services, provider: ConnectorProvider): boolean {
  return provider !== 'google' || services.google.mode !== 'off';
}

/** Why a read failed, in words, when it's something the person can fix; null when it's worth trying again. */
function fixable(err: unknown, row: AccountRow): string | null {
  const provider = providerWord(row.provider);
  if (err instanceof ConnectionUnavailableError)
    return row.provider === 'imap'
      ? ACCOUNT_WORDS.problems.password
      : fill(ACCOUNT_WORDS.problems.signIn, { provider });
  if (err instanceof GoogleApiError) {
    if (err.reason === 'unauthorized')
      return row.provider === 'imap'
        ? ACCOUNT_WORDS.problems.password
        : fill(ACCOUNT_WORDS.problems.signIn, { provider });
    if (err.reason === 'no_scope' || err.reason === 'api_disabled')
      return fill(ACCOUNT_WORDS.problems.notAllowed, { provider });
  }
  return null;
}

/** The checks of a head as one word: any failed, else any still going, else passing; null with none. */
export function checksOf(states: readonly string[]): AccountPull['checks'] {
  if (states.length === 0) return null;
  if (states.includes('failed')) return 'failing';
  if (states.some((s) => s === 'queued' || s === 'running')) return 'running';
  return 'passing';
}

/** The reads from the database and the person's own providers. */
export function dbAccountReads(services: Services): AccountReads {
  const db = services.db;
  return {
    async accounts(ctx) {
      const rows = await db
        .select({
          id: connections.id,
          provider: connections.provider,
          email: connections.email,
          services: connections.services,
          status: connections.status,
        })
        .from(connections)
        .where(eq(connections.accountId, ctx.viewer.accountId))
        .orderBy(connections.createdAt);
      return rows;
    },
    async calendar(ctx, row, window) {
      return (await accountCalendar(services, ctx.viewer.accountId, row, window)).value;
    },
    async unread(ctx, row, newest) {
      const { value } = await accountUnread(services, ctx.viewer.accountId, row);
      return { count: value.count, newest: value.newest.slice(0, newest) };
    },
    readAt(ctx, row, source) {
      return source === 'calendar'
        ? heldAt(services, 'calendar', row.id, todayWindow(ctx.now, ctx.timeZone))
        : heldAt(services, 'unread', row.id);
    },
    async hasRepos(ctx) {
      const [row] = await db
        .select({ n: count() })
        .from(repos)
        .where(and(eq(repos.burrowId, ctx.viewer.burrowId), eq(repos.enabled, true)));
      return (row?.n ?? 0) > 0;
    },
    async pulls(ctx) {
      const open = await db
        .select({
          id: pullRequests.id,
          number: pullRequests.number,
          title: pullRequests.title,
          draft: pullRequests.draft,
          openedAt: pullRequests.openedAt,
          authorLogin: pullRequests.authorLogin,
          authorId: pullRequests.authorId,
          repo: repos.fullName,
        })
        .from(pullRequests)
        .innerJoin(repos, eq(repos.id, pullRequests.repoId))
        .where(
          and(
            eq(pullRequests.burrowId, ctx.viewer.burrowId),
            eq(pullRequests.state, 'open'),
            eq(repos.enabled, true),
          ),
        )
        .orderBy(desc(pullRequests.openedAt))
        .limit(PULLS_MAX);
      if (open.length === 0) return [];
      const ids = open.map((p) => p.id);
      const authorIds = [...new Set(open.flatMap((p) => (p.authorId && !p.authorLogin ? [p.authorId] : [])))];
      const [checks, waiting, authors] = await Promise.all([
        db
          .select({ prId: prChecks.prId, state: prChecks.state })
          .from(prChecks)
          .where(inArray(prChecks.prId, ids)),
        db
          .select({
            prId: prReviewers.prId,
            principalId: prReviewers.principalId,
            name: principals.name,
            shortName: principals.shortName,
          })
          .from(prReviewers)
          .innerJoin(principals, eq(principals.id, prReviewers.principalId))
          .where(and(inArray(prReviewers.prId, ids), eq(prReviewers.state, 'pending')))
          .orderBy(prReviewers.position),
        authorIds.length
          ? db
              .select({ id: principals.id, name: principals.name, shortName: principals.shortName })
              .from(principals)
              .where(inArray(principals.id, authorIds))
          : Promise.resolve([]),
      ]);
      const authorName = new Map(authors.map((a) => [a.id, a.shortName || a.name]));
      return open.map((p) => ({
        repo: p.repo.slice(p.repo.lastIndexOf('/') + 1),
        number: p.number,
        title: p.title,
        author: p.authorLogin ?? (p.authorId ? (authorName.get(p.authorId) ?? null) : null),
        draft: p.draft,
        openedAt: p.openedAt,
        checks: checksOf(checks.filter((c) => c.prId === p.id).map((c) => c.state)),
        waitingOn: waiting
          .filter((w) => w.prId === p.id)
          .map((w) => ({ name: w.shortName || w.name, viewer: w.principalId === ctx.viewer.principal.id })),
      }));
    },
  };
}

/** The person's accounts' widgets: their catalogue groups, and each widget's reads and view. */
export class AccountWidgets {
  readonly #reads: AccountReads;

  constructor(
    private readonly services: Services,
    reads: Partial<AccountReads> = {},
  ) {
    this.#reads = { ...dbAccountReads(services), ...reads };
  }

  /**
   * *Your accounts*: a group for each of the person's own active connections with a calendar or mail connected, then
   * the Whombat's GitHub when it has repositories; with `ref`, only that one's.
   */
  async groups(ctx: WidgetCtx, ref?: string): Promise<DeskCatalogGroup[]> {
    const out: DeskCatalogGroup[] = [];
    if (!ref || ref !== DESK_ACCOUNT_GITHUB) {
      const rows = await this.#reads.accounts(ctx);
      for (const row of rows) {
        if (row.status !== 'active' || !offered(this.services, row.provider)) continue;
        const info: AccountInfo = {
          ref: `account:${row.id}`,
          provider: row.provider,
          email: row.email,
          services: row.services,
        };
        if (ref && info.ref !== ref) continue;
        const group = accountGroup(info);
        if (group) out.push(group);
      }
    }
    if ((!ref || ref === DESK_ACCOUNT_GITHUB) && (await this.#reads.hasRepos(ctx))) {
      const group = accountGroup('github');
      if (group) out.push(group);
    }
    return out;
  }

  /** The panel a spec asks for and the source it reads; null when the account has no widget like that. */
  #want(spec: DeskWidgetSpec): { panel: AccountPanel | null; source: Source } | null {
    const github = spec.ref === DESK_ACCOUNT_GITHUB;
    if (spec.type === 'figures')
      return github ? { panel: 'pulls', source: 'github' } : { panel: null, source: 'calendar' };
    const panel = spec.opts?.panel as AccountPanel | undefined;
    if (!panel || !ACCOUNT_PANELS.includes(panel)) return null;
    const source = SOURCE_OF[panel];
    if ((source === 'github') !== github) return null;
    return { panel, source };
  }

  /** What a spec's read is kept under: one read per person, account and source (and day, for the calendar). */
  #key(ctx: WidgetCtx, viewer: string, spec: DeskWidgetSpec, source: Source | 'figures'): string {
    const day =
      source === 'calendar' || source === 'figures'
        ? `\n${todayWindow(ctx.now, ctx.timeZone).day}\n${ctx.timeZone}`
        : '';
    return `account\n${viewer}\n${spec.ref}\n${source}${day}`;
  }

  #keyOf(ctx: WidgetCtx, viewer: string, spec: DeskWidgetSpec): string | null {
    const want = this.#want(spec);
    if (!want) return null;
    // An account's *Figures* is its next meeting, or its unread mail without a calendar: which, its row says.
    return this.#key(ctx, viewer, spec, spec.type === 'figures' && !want.panel ? 'figures' : want.source);
  }

  /** Starts the spec's read when it's due; the key it fills (none for a widget the account can't have). */
  start(kept: Kept, ctx: WidgetCtx, spec: DeskWidgetSpec, viewer: string): string[] {
    const key = this.#keyOf(ctx, viewer, spec);
    const want = this.#want(spec);
    if (!key || !want) return [];
    if (kept.due(key))
      kept.start([key], async () => {
        const data = await this.#read(ctx, spec, want, () => kept.peek(key).has);
        // What an account's page read a minute ago is kept only for what is left of its time.
        const keepMs =
          data.kind === 'problem'
            ? RETRY_MS
            : Math.max(
                RETRY_MS,
                ACCOUNT_KEEP_MS[
                  data.kind === 'calendar' ? 'calendar' : data.kind === 'mail' ? 'mail' : 'github'
                ] -
                  (ctx.now.getTime() - data.at),
              );
        return new Map([[key, { value: data, keepMs }]]);
      });
    return [key];
  }

  async #read(
    ctx: WidgetCtx,
    spec: DeskWidgetSpec,
    want: { panel: AccountPanel | null; source: Source },
    held: () => boolean,
  ): Promise<AccountData> {
    if (want.source === 'github') {
      if (!(await this.#reads.hasRepos(ctx)))
        return { kind: 'problem', provider: 'github', text: ACCOUNT_WORDS.problems.noRepos };
      return { kind: 'github', pulls: await this.#reads.pulls(ctx), at: ctx.now.getTime() };
    }
    const ref = spec.ref ?? '';
    const row = (await this.#reads.accounts(ctx)).find((r) => r.id === idOf(ref));
    if (!row || !offered(this.services, row.provider))
      return { kind: 'problem', provider: row?.provider ?? 'google', text: ACCOUNT_WORDS.problems.gone };
    const provider = providerWord(row.provider);
    if (row.status !== 'active')
      return {
        kind: 'problem',
        provider: row.provider,
        text:
          row.provider === 'imap'
            ? ACCOUNT_WORDS.problems.password
            : fill(ACCOUNT_WORDS.problems.signIn, { provider }),
      };
    let source: Source = want.source;
    if (!want.panel) {
      const panels = accountPanels(row);
      const panel = accountPanelOf(spec, panels);
      if (!panel) return { kind: 'problem', provider: row.provider, text: ACCOUNT_WORDS.problems.unknown };
      source = SOURCE_OF[panel];
    }
    const calendar = source === 'calendar';
    const needs: ConnectorService = calendar ? 'calendar' : 'mail';
    if (!row.services.includes(needs) || (calendar && row.provider === 'imap'))
      return {
        kind: 'problem',
        provider: row.provider,
        text: calendar ? ACCOUNT_WORDS.problems.noCalendar : ACCOUNT_WORDS.problems.noMail,
      };
    try {
      const readAt = (source: 'calendar' | 'mail') =>
        Math.min(ctx.now.getTime(), this.#reads.readAt?.(ctx, row, source)?.getTime() ?? ctx.now.getTime());
      if (calendar) {
        const window = todayWindow(ctx.now, ctx.timeZone);
        const events = await this.#reads.calendar(ctx, row, window);
        return { kind: 'calendar', provider: row.provider, email: row.email, events, at: readAt('calendar') };
      }
      const unread = await this.#reads.unread(ctx, row, UNREAD_NEWEST);
      return { kind: 'mail', provider: row.provider, unread, at: readAt('mail') };
    } catch (err) {
      const words = fixable(err, row);
      if (words) return { kind: 'problem', provider: row.provider, text: words };
      // Worth trying again: what was read before stays; never read, it says the provider isn't answering.
      if (held()) throw err;
      this.services.log.warn(
        { err: String(err), provider: row.provider },
        'desk: an account widget wasn’t read',
      );
      return {
        kind: 'problem',
        provider: row.provider,
        text: fill(ACCOUNT_WORDS.problems.notAnswering, { provider }),
      };
    }
  }

  /** The spec's resolution from what's kept, drawn for now; null before its first read. */
  now(kept: Kept, ctx: WidgetCtx, spec: DeskWidgetSpec, viewer: string): Resolved | null {
    const github = spec.ref === DESK_ACCOUNT_GITHUB;
    const key = this.#keyOf(ctx, viewer, spec);
    if (!key)
      return accountProblemView(spec.id, null, github ? 'github' : 'google', ACCOUNT_WORDS.problems.unknown);
    const got = kept.peek<AccountData>(key);
    if (!got.value) return null;
    const data = got.value;
    if (data.kind === 'problem') {
      const want = this.#want(spec);
      return accountProblemView(spec.id, want?.panel ?? null, data.provider, data.text);
    }
    const resolved = (panel: AccountPanel, view: Resolved['view']): Resolved => ({
      view,
      private: isPrivatePanel(panel),
      refreshS: ACCOUNT_REFRESH_S[panel],
    });
    const at = new Date(data.at);
    if (data.kind === 'github') {
      const panel = spec.type === 'figures' ? 'pulls' : (spec.opts?.panel as AccountPanel);
      return panel === 'reviews'
        ? resolved('reviews', reviewsView(spec.id, data.pulls, at))
        : resolved('pulls', pullsView(spec.id, data.pulls, at));
    }
    if (data.kind === 'mail') {
      const view = unreadView(spec.id, data.provider, {
        count: data.unread.count,
        newest: data.unread.newest,
        now: ctx.now,
        timeZone: ctx.timeZone,
        at,
      });
      return resolved('unread', view);
    }
    const input = { events: data.events, self: data.email, now: ctx.now, timeZone: ctx.timeZone, at };
    return spec.opts?.panel === 'today'
      ? resolved('today', todayView(spec.id, data.provider, input))
      : resolved('next', nextView(spec.id, data.provider, input));
  }
}
