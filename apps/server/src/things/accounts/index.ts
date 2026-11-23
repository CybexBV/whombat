/**
 * A page for each of the person's accounts (`things.page` for Google, Microsoft 365, Email, GitHub and Website
 * feedback; docs/decisions/connection-dashboards.md): which account a thing id is for this viewer, and its page in
 * slots with Worth a look and the head every connection's page has. The apps add Activity and the account's own settings
 * as its Connection tab (`settings: true`).
 *
 * - **Who sees it**: a Google, Microsoft 365 or Email account only its own person (the connector row's account), as Home
 *   lists it; GitHub when it is connected for the Whombat; Website feedback when it is on here, has a site, and the
 *   viewer is the person. Anyone else gets `not_found`.
 * - A catalog connection with the same id wins: `findThing` asks here only when there is none.
 */
import {
  type AccountPageId,
  FEEDBACK_THING_ID,
  GITHUB_THING_ID,
  type ThingKind,
  type ThingPage,
  type ThingPagePanel,
  type ThingStatus,
} from '@whombat/core';
import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { ConnectionViewer } from '../../connections/store';
import { ConnectionUnavailableError, GoogleApiError } from '../../connectors/types';
import { automations, automationVersions, connections } from '../../db/schema/index';
import { todayWindow } from '../../desk/widgets/account-views';
import { githubShown } from '../../home/github-thing';
import {
  accountName,
  COUNTED,
  isAccountThing,
  lastMailCount,
  MAIL_CHECKS,
  mailCountFailed,
  mailLines,
} from '../../home/mail-glance';
import type { Services } from '../../services';
import { slotProblems } from '../kinds/slots';
import type { KindView } from '../kinds/types';
import { refreshOf, verdictField } from '../page';
import { BADGE, layout, SUMMARY_TAB } from '../panels';
import { thingQuiet, thingStates } from '../quiet/store';
import type { KindCheck, LooseNotice } from '../quiet/types';
import { markLines } from '../quiet/wire';
import { clip } from '../words';
import { feedbackShown, feedbackView, readFeedback } from './feedback';
import { githubView, readGithub } from './github';
import { type MailProvider, mailAccountView, type Part, signedOutWords, spaceCheck, spaceLine } from './mail';
import {
  accountCalendar,
  accountQuota,
  accountRecentFiles,
  accountUnread,
  type Held,
  heldQuota,
} from './reads';

export type ConnectorRow = typeof connections.$inferSelect;

/** An account a thing id names, as this viewer may see it. */
export type AccountTarget =
  | { kind: 'mail'; id: string; row: ConnectorRow & { provider: MailProvider } }
  | { kind: 'github'; id: string }
  | { kind: 'feedback'; id: string };

/** Where each account lands when it is clicked: its page, built here (the landing test reads it). */
export const ACCOUNT_LANDINGS: Record<AccountPageId, string> = {
  google: 'its account page (mail.ts)',
  microsoft: 'its account page (mail.ts)',
  imap: 'its account page (mail.ts)',
  github: 'its account page (github.ts)',
  feedback: 'its account page (feedback.ts)',
};

/** How long a provider may take before its part says it isn't answering. */
const READ_DEADLINE_MS = 8_000;
/** The head's words while all is well. */
const FINE = 'Fine';

/** The person's own Google, Microsoft 365 or Email connection behind `id`, as Home lists it; null otherwise. */
async function mailRow(
  services: Services,
  viewer: ConnectionViewer,
  id: string,
): Promise<(ConnectorRow & { provider: MailProvider }) | null> {
  if (!viewer.accountId) return null;
  const [row] = await services.db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.id, id),
        eq(connections.accountId, viewer.accountId),
        inArray(connections.provider, [...COUNTED]),
      ),
    );
  return row && isAccountThing(row) ? (row as ConnectorRow & { provider: MailProvider }) : null;
}

/** The account behind a thing id for this viewer, or null (another person's account is never named). */
export async function findAccount(
  services: Services,
  viewer: ConnectionViewer,
  parsed: { kind: ThingKind; id: string },
): Promise<AccountTarget | null> {
  if (parsed.kind !== 'connection') return null;
  const id = `connection:${parsed.id}`;
  if (id === GITHUB_THING_ID)
    return viewer.principal.kind === 'person' && (await githubShown(services, viewer.burrowId))
      ? { kind: 'github', id }
      : null;
  if (id === FEEDBACK_THING_ID)
    return (await feedbackShown(services, viewer)) ? { kind: 'feedback', id } : null;
  const row = await mailRow(services, viewer, parsed.id);
  return row ? { kind: 'mail', id, row } : null;
}

/** What Whombat watches on an account: sign-in and counting for mail, Drive or OneDrive almost full with files. */
export function accountChecks(target: AccountTarget): readonly KindCheck[] {
  if (target.kind !== 'mail') return [];
  const { provider, services } = target.row;
  return provider !== 'imap' && services.includes('files')
    ? [...MAIL_CHECKS, spaceCheck(provider)]
    : MAIL_CHECKS;
}

/** An account's Worth a look lines now, from what is kept (no read): what Ignore and Home compare. */
export function accountLines(services: Services, target: AccountTarget): LooseNotice[] {
  if (target.kind !== 'mail') return [];
  const row = target.row;
  return [
    ...mailLines(row, mailCountFailed(services, row.id)),
    ...(row.status === 'active' ? spaceLine(row.provider, heldQuota(services, row.id)?.value) : []),
  ];
}

/** Why a read failed, in one line the person can act on. */
function problemOf(err: unknown, provider: MailProvider): string {
  const name = accountName(provider);
  if (err instanceof ConnectionUnavailableError) return signedOutWords(provider);
  if (err instanceof GoogleApiError) {
    if (err.reason === 'unauthorized') return signedOutWords(provider);
    if (err.reason === 'no_scope' || err.reason === 'api_disabled')
      return `${name} didn’t let Whombat read this. Connect it again to show it here.`;
  }
  return `${name} isn’t answering right now.`;
}

/** A read as a part of the page: what it gave, or why not, within the deadline. */
async function partOf<T>(
  services: Services,
  provider: MailProvider,
  read: () => Promise<Held<T>>,
): Promise<Part<T>> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<Part<T>>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, problem: `${accountName(provider)} isn’t answering right now.` }),
      READ_DEADLINE_MS,
    );
    timer.unref?.();
  });
  const work = read().then(
    (held): Part<T> => ({ ok: true, value: held.value, at: held.at }),
    (err): Part<T> => {
      if (!(err instanceof ConnectionUnavailableError))
        services.log.warn({ err: String(err), provider }, 'account page: a part wasn’t read');
      return { ok: false, problem: problemOf(err, provider) };
    },
  );
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** How many live automations start on this connection's new mail. */
export async function mailAutomations(services: Services, burrowId: string, connectionId: string) {
  const [row] = await services.db
    .select({ n: count() })
    .from(automations)
    .innerJoin(
      automationVersions,
      and(
        eq(automationVersions.automationId, automations.id),
        eq(automationVersions.n, automations.currentVersion),
      ),
    )
    .where(
      and(
        eq(automations.burrowId, burrowId),
        eq(automations.status, 'published'),
        isNull(automations.deletedAt),
        sql`exists (select 1 from jsonb_array_elements(${automationVersions.definition} -> 'triggers') as t
          where t ->> 'kind' = 'mail' and t ->> 'connectionId' = ${connectionId})`,
      ),
    );
  return row?.n ?? 0;
}

/** A Google, Microsoft 365 or Email account's view, from the reads it shares with the desk. */
async function mailView(
  services: Services,
  viewer: ConnectionViewer,
  row: ConnectorRow & { provider: MailProvider },
  timeZone: string,
) {
  const now = services.clock();
  const { provider } = row;
  const has = (s: string) => row.services.includes(s as never);
  const off = provider === 'google' && services.google.mode === 'off';
  const signedIn = row.status === 'active';
  const reads = signedIn && !off;
  const ref = { id: row.id, provider };
  const offPart = <T>(): Part<T> => ({ ok: false, problem: 'Google isn’t turned on for this Whombat.' });
  const part = <T>(want: boolean, read: () => Promise<Held<T>>): Promise<Part<T> | null> =>
    !want ? Promise.resolve(null) : off ? Promise.resolve(offPart<T>()) : partOf(services, provider, read);
  const [calendar, unread, quota, recent, automationsOn] = await Promise.all([
    part(reads && provider !== 'imap' && has('calendar'), () =>
      accountCalendar(services, viewer.accountId, ref, todayWindow(now, timeZone)),
    ),
    part(reads && has('mail'), () => accountUnread(services, viewer.accountId, ref)),
    part(reads && provider !== 'imap' && has('files'), () => accountQuota(services, viewer.accountId, ref)),
    part(reads && provider === 'google' && has('files'), () =>
      accountRecentFiles(services, viewer.accountId, ref),
    ),
    has('mail') ? mailAutomations(services, viewer.burrowId, row.id) : Promise.resolve(0),
  ]);
  const counted = lastMailCount(services, row.id);
  return mailAccountView({
    provider,
    email: row.email,
    services: row.services,
    signedIn,
    calendar,
    unread,
    quota,
    recent,
    automations: automationsOn,
    ...(provider === 'imap'
      ? { checked: { at: counted?.at ?? null, host: row.mailSettings?.imap.host ?? null } }
      : {}),
    countFailed: mailCountFailed(services, row.id),
    now,
    timeZone,
  });
}

/** The page's view of an account. */
type AccountView = Pick<
  KindView,
  'panels' | 'slots' | 'notices' | 'verdict' | 'readAt' | 'open' | 'problem' | 'refreshS'
>;

/** What the page shows of an account: its name and mark, its address, and its view. */
async function built(
  services: Services,
  viewer: ConnectionViewer,
  target: AccountTarget,
  timeZone: string,
  now: Date,
): Promise<{ name: string; catalogId: AccountPageId; address: string | null; view: AccountView }> {
  if (target.kind === 'mail') {
    const { provider, email } = target.row;
    const view = await mailView(services, viewer, target.row, timeZone);
    return { name: accountName(provider), catalogId: provider, address: email, view };
  }
  if (target.kind === 'github') {
    const read = await readGithub(services, viewer.burrowId, viewer.principal.id, now);
    const view = githubView({ ...read, now, timeZone });
    return { name: 'GitHub', catalogId: 'github', address: read.login ? `@${read.login}` : null, view };
  }
  const read = await readFeedback(services, viewer.burrowId, now);
  return {
    name: 'Website feedback',
    catalogId: 'feedback',
    address: null,
    view: feedbackView({ ...read, now, timeZone }),
  };
}

/** An account's page: its Summary in slots under Worth a look, and the head as every connection's page has it. */
export async function accountPage(
  services: Services,
  viewer: ConnectionViewer,
  target: AccountTarget,
  timeZone: string,
): Promise<ThingPage> {
  const now = services.clock();
  const [{ name, catalogId, address, view }, quiet, states] = await Promise.all([
    built(services, viewer, target, timeZone, now),
    thingQuiet(services.db, viewer.burrowId, target.id),
    thingStates(services.db, target.id),
  ]);
  const misplaced = slotProblems(view);
  if (misplaced.length)
    services.log.warn({ catalogId, problems: misplaced }, 'account page: slots out of place');
  // Worth a look with what is quiet now, and the head from its active lines, as on every connection's page.
  const marked = await markLines(services.db, view.notices, { quiet, states, now, timeZone });
  const status: { status: ThingStatus; badge: string } =
    marked.status === 'ok'
      ? { status: 'ok', badge: FINE }
      : { status: marked.status, badge: (marked.badge ?? BADGE[marked.status]).slice(0, 60) };
  const summary: ThingPagePanel[] = [];
  if (marked.items.length)
    summary.push({
      kind: 'notices',
      id: 'notices',
      place: 'top',
      title: 'Worth a look',
      items: marked.items,
    });
  summary.push(...view.panels);
  return {
    id: target.id,
    kind: 'connection',
    ...(target.kind === 'mail' ? { connectionId: target.row.id as ThingPage['connectionId'] } : {}),
    catalogId,
    name,
    // Google's mark, Microsoft's, Email's envelope, GitHub's, Website feedback's.
    icon: catalogId,
    status: status.status,
    badge: status.badge,
    ...verdictField(name, status, view),
    facts: [],
    ...(address ? { address: clip(address, 200) } : {}),
    ...(view.open ? { open: view.open } : {}),
    runsOn: null,
    settings: true,
    tabs: [{ ...SUMMARY_TAB, panels: layout(summary).slice(0, 24) }],
    actions: [],
    readAt: view.readAt ? view.readAt.toISOString() : null,
    ...(view.problem ? { problem: clip(view.problem, 200) } : {}),
    refreshS: refreshOf(view),
  };
}
