/**
 * Chat and Feedback as an inbox (Whombat chat-inbox.md CIB-01…CIB-11; app chat-inbox.md): a thread's two-line row,
 * the filters, which thread opens after one is settled, and the choices for settling by itself. Pure; web and phone
 * share it.
 */
import {
  CHAT_THREAD_TEXT_MAX,
  type ChatSubject,
  type ChatThread,
  type ChatThreadLast,
  chatThreadHref,
  type Handoff,
  type HandoffOutcome,
  type Message,
  threadPreview,
} from '@whombat/core';
import { interpolate } from '@whombat/core/i18n';
import { currentStep, handoffMinutes, T3_CODE_NAME } from '../handoff';
import { doneWhen } from '../home/time';
import { clientTree } from '../i18n/catalog';
import { CHAT_AREA_WORDS } from '../i18n/messages/chatWork/chat';
import { WORK_AREA_WORDS } from '../i18n/messages/chatWork/work';
import { canSettle } from './settle';
import { threadStageWords } from './stage';
import { threadTitle } from './threads';

/** The inbox's words in a locale (English when none). `{agent}` is the assistant's name. */
export function inboxWords(locale?: string | null) {
  const w = clientTree(locale, CHAT_AREA_WORDS).inbox;
  return {
    all: w.all,
    unread: w.unread,
    waiting: w.waiting,
    /** A row's and an open thread's status while something in it waits for the person. */
    waitingForYou: w.waitingForYou,
    /** A row's status while the assistant works on it; the Working filter. */
    working: w.working,
    /** The Done filter, and a row's status once its job finished. */
    done: w.done,
    waitingChecks: w.waitingChecks,
    didntFinish: w.didntFinish,
    stopped: w.stopped,
    nothingWorking: w.nothingWorking,
    nothingWorkingHint: w.nothingWorkingHint,
    nothingDone: w.nothingDone,
    nothingDoneHint: w.nothingDoneHint,
    you: w.you,
    /** A row's second line under the person's own question before any reply; never a title. */
    noReply: w.noReply,
    /** A thread's title when its first message has nothing to call it by (a server older than its card titles). */
    yourMessage: w.yourMessage,
    markUnread: w.markUnread,
    markRead: w.markRead,
    markedUnread: w.markedUnread,
    /** Above the first new message of an open thread. */
    newLine: w.newLine,
    /** The filters' group, for screen readers. */
    show: w.show,
    nothingNew: w.nothingNew,
    nothingNewHint: w.nothingNewHint,
    nothingWaits: w.nothingWaits,
    allSettled: w.allSettled,
    allSettledHint: w.allSettledHint,
    /** Settings: when threads settle by themselves (CIB-09). */
    quietChoice: w.quietChoice,
    quietChoiceHint: w.quietChoiceHint,
  };
}

/** The inbox's words, verbatim. */
export const INBOX_WORDS = inboxWords();

/** “From Dusty”: the second line of a thread someone else started, before any reply. */
export function fromLine(name: string, locale?: string | null): string {
  return interpolate(clientTree(locale, CHAT_AREA_WORDS).inbox.fromLine, { name });
}

/** “Message from Dusty”: a thread's title when its first message has nothing to call it by. */
export function messageFromTitle(name: string, locale?: string | null): string {
  return interpolate(clientTree(locale, CHAT_AREA_WORDS).inbox.messageFrom, { name });
}

/** “New replies, 2”: a row's count of new messages for screen readers. */
export function newCountLabel(n: number, locale?: string | null): string {
  return clientTree(locale, CHAT_AREA_WORDS).inbox.newCount(n);
}

/* Settling by itself (CIB-09) -------------------------------------------------------------------------------------- */

/** One of the quiet days people choose from. */
export interface SettleQuietChoice {
  days: number | null;
  label: string;
}

/** The quiet days people choose from (`Preferences.chat.settleQuietDays`), in a locale: never, a day, 3 days, a week. */
export function settleQuietChoices(locale?: string | null): readonly SettleQuietChoice[] {
  const q = clientTree(locale, CHAT_AREA_WORDS).inbox.quiet;
  return [
    { days: null, label: q.never },
    { days: 1, label: q.day },
    { days: 3, label: q.threeDays },
    { days: 7, label: q.week },
  ];
}

/** The quiet days people choose from: never, a day, three days, a week. */
export const SETTLE_QUIET_CHOICES = settleQuietChoices();

/** The choice to show for stored quiet days: the nearest offered one (a value set elsewhere, 1–90, reads as it). */
export function quietChoiceOf(days: number | null, locale?: string | null): SettleQuietChoice {
  const choices = locale ? settleQuietChoices(locale) : SETTLE_QUIET_CHOICES;
  const [never, first] = choices as [SettleQuietChoice, SettleQuietChoice];
  if (days === null) return never;
  let best = first;
  for (const c of choices)
    if (c.days !== null && Math.abs(c.days - days) < Math.abs((best.days as number) - days)) best = c;
  return best;
}

/** “after 3 quiet days”, “after a quiet day”, “after a quiet week”: how a thread settled by itself (`settledMeta`). */
export function quietDaysWords(days: number, locale?: string | null): string {
  const w = clientTree(locale, CHAT_AREA_WORDS).inbox;
  if (days === 1) return w.quietDay;
  if (days === 7) return w.quietWeek;
  return interpolate(w.quietDays, { days });
}

/* Rows (CIB-01…CIB-04) --------------------------------------------------------------------------------------------- */

/** A link as plain words in a row: no `https://`, no `www.` (CIB-01). */
export function plainLinks(text: string): string {
  return text.replace(/\bhttps?:\/\/(www\.)?/gi, '');
}

/** One row of the inbox. */
export interface InboxRow {
  rootId: string;
  /** `/chat?thread=<root>`, `/feedback?thread=<root>`. */
  href: string;
  /** The first line of the thread's first message (CIB-02). */
  title: string;
  /** Who wrote the second line (“You”, “Dusty”), or null when the line is a note (“No reply yet”). */
  who: string | null;
  /** The second line's words: the newest reply, plain, links as words. */
  line: string;
  /** “10:48”, “Thu”, “3 Oct”: the thread's last activity. */
  when: string;
  /** New messages in it for the person; 0 for the thread open on screen (it is being read). */
  unread: number;
  /** Something in it waits for the person: a card or question of the assistant's, or T3 Code asking for their OK. */
  waiting: boolean;
  /** Work goes on from it (the assistant's turn, a run, a council, a checklist or T3 Code): it can't settle now. */
  working: boolean;
  /** Where it stands, said in front of its line and marked on its icon; null when nothing goes on and nothing ended. */
  status: RowStatus | null;
  /** It may be settled now (`canSettle`). */
  settleable: boolean;
  /** Something in it came from someone else, so Mark as unread can do something. */
  markable: boolean;
  /**
   * The name shown before the line on the phone's row: `who`, except the assistant's own replies, which go without
   * (the row's icon says whose chat it is). Null when nothing goes before the line.
   */
  shownWho: string | null;
  /** The title without its quiet tail: all of `title` when it has none. */
  titleHead: string;
  /** “ · shop”: the end of a repository thread's title that names its repository, drawn quieter; null when none. */
  titleTail: string | null;
  /** What the row's icon shows: the repository's icon, the thing it is about, or the assistant's face. */
  icon: InboxIcon;
  /** The repository its work is in (`ChatThread.repo`): its name, and its icon's attachment URL when it has one. */
  repoName: string | null;
  repoIconUrl: string | null;
  /** The repository's letter, for its tile until or unless its icon shows. */
  repoLetter: string | null;
  /** What the thread is about (`ChatThread.subject`): a server, a connection or a device. */
  subjectKind: ChatSubject['kind'] | null;
  subjectId: string | null;
  subjectName: string | null;
}

/**
 * Where a row's thread stands, in the order one wins over another: something waits for the person; the assistant or
 * T3 Code works on it; it waits for a pull request's checks (nothing to do); its latest job finished, didn't finish or
 * was stopped.
 */
export const ROW_STATUS_KINDS = ['waiting', 'working', 'checks', 'failed', 'stopped', 'done'] as const;
export type RowStatusKind = (typeof ROW_STATUS_KINDS)[number];

export interface RowStatus {
  kind: RowStatusKind;
  /** In front of the line: “Waiting for you”, “Dusty is working”, “T3 Code is working”, “Done”. */
  words: string;
  /** The words start with a name (the assistant's, T3 Code's), so they keep their capitals when read out. */
  named: boolean;
  /** For work handed to T3 Code: when its run started, for the clock after the words (`· 6m`); null without one. */
  since: number | null;
  /** In place of the newest reply: what T3 Code does now, or what it asks the person to approve. Null keeps the reply. */
  line: string | null;
}

/** Two statuses that read the same, so a row that didn't change keeps its drawing. */
export function sameRowStatus(a: RowStatus | null, b: RowStatus | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.words === b.words && a.since === b.since && a.line === b.line;
}

/**
 * A row's status as a screen reader hears it after the title: the inbox's own words in lower case (“waiting for you”,
 * “done”), and words that start with a name as they are (“Dusty is working”, “T3 Code is working”).
 */
export function rowStatusSpoken(status: Pick<RowStatus, 'words' | 'named'>): string {
  return status.named ? status.words : status.words.toLowerCase();
}

/** A row's status words with its clock: “T3 Code is working · 6m”. */
export function rowStatusWords(status: RowStatus, nowMs: number): string {
  return status.since === null ? status.words : `${status.words} · ${handoffMinutes(status.since, nowMs)}`;
}

const msOf = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

const ENDED_KIND: Record<HandoffOutcome, RowStatusKind> = {
  completed: 'done',
  failed: 'failed',
  stopped: 'stopped',
};

/**
 * Where one thread stands (`InboxRow.status`), read from its flags, the assistant's live work there (`live`) and the
 * hand-overs to T3 Code from it (`handoffs`, the thread's own, oldest first). How its latest job ended comes from the
 * server's `job`, or from a hand-over that ended since the list was read, unless the person wrote after that end.
 */
export function rowStatus(
  t: Pick<ChatThread, 'waiting' | 'working' | 'handedOver' | 'job' | 'last'>,
  handoffs: readonly Handoff[],
  o: { live: boolean; me: string | null | undefined; agentName: string; locale?: string | null },
): RowStatus | null {
  const words = o.locale ? inboxWords(o.locale) : INBOX_WORDS;
  const w = clientTree(o.locale, CHAT_AREA_WORDS).inbox;
  const hw = clientTree(o.locale, WORK_AREA_WORDS).handoff;
  const t3 = T3_CODE_NAME;
  const active = handoffs.filter((h) => h.state !== 'ended');
  const needsOk = active.find((h) => h.state === 'needs_ok');
  if (t.waiting || needsOk) {
    const line =
      !t.waiting && needsOk
        ? needsOk.asks
          ? interpolate(hw.approveAsks, { t3, asks: needsOk.asks })
          : interpolate(hw.approve, { t3 })
        : null;
    return { kind: 'waiting', words: words.waitingForYou, named: false, since: null, line };
  }
  if (t.working || o.live)
    return {
      kind: 'working',
      words: threadStageWords(o.locale).working(o.agentName),
      named: true,
      since: null,
      line: null,
    };
  const doing = active.filter((h) => h.state !== 'checks');
  const now = doing.at(-1);
  if (now) {
    const step = currentStep(now);
    const said =
      now.state === 'finishing'
        ? interpolate(hw.lineFinishing, { t3 })
        : now.state === 'asked'
          ? interpolate(hw.lineAsked, { t3, agentName: o.agentName })
          : interpolate(w.t3Working, { t3 });
    return {
      kind: 'working',
      words: said,
      named: true,
      since: now.state === 'working' ? msOf(now.since) : null,
      line: now.state === 'asked' ? now.asks : (step?.text ?? null),
    };
  }
  if (active.length)
    return { kind: 'checks', words: words.waitingChecks, named: false, since: null, line: null };
  // A council or a checklist at work from it, or T3 Code before the hand-overs were read.
  if (t.handedOver) return { kind: 'working', words: words.working, named: false, since: null, line: null };
  const job = t.job ?? null;
  let outcome: HandoffOutcome | null = job?.outcome ?? null;
  let endedAt = msOf(job?.endedAt);
  for (const h of handoffs) {
    const at = msOf(h.endedAt);
    if (h.state === 'ended' && h.outcome && at !== null && (endedAt === null || at > endedAt)) {
      outcome = h.outcome;
      endedAt = at;
    }
  }
  if (!outcome || endedAt === null) return null;
  // The person wrote after it ended: their new question is the thread's news now.
  const wrote = t.last && t.last.authorId === o.me ? msOf(t.last.at) : null;
  if (wrote !== null && wrote > endedAt) return null;
  const kind = ENDED_KIND[outcome];
  const said = kind === 'done' ? words.done : kind === 'failed' ? words.didntFinish : words.stopped;
  return { kind, words: said, named: false, since: null, line: null };
}

/** A row's icon: a repository's (its own picture, else its letter), a thing's mark, or the assistant's face. */
export type InboxIcon = 'repo' | 'subject' | 'agent';

/** Which icon a thread's row shows: its repository wins over what it is about; everything else is a chat. */
export function inboxIcon(t: Pick<ChatThread, 'repo' | 'subject'>): InboxIcon {
  if (t.repo) return 'repo';
  if (t.subject) return 'subject';
  return 'agent';
}

/** The letter on a repository's tile: its name's first letter or digit, upper case (“shop” → “S”); “?” for none. */
export function repoLetter(name: string): string {
  const first = [...name].find((c) => /[\p{L}\p{N}]/u.test(c));
  return first ? first.toLocaleUpperCase() : '?';
}

/** What a thread's icon is drawn from, wherever its row is (the inbox, Settled). */
export type ThreadIconFields = Pick<
  InboxRow,
  'icon' | 'repoName' | 'repoIconUrl' | 'repoLetter' | 'subjectKind' | 'subjectId' | 'subjectName'
>;

export function threadIconFields(t: Pick<ChatThread, 'repo' | 'subject'>): ThreadIconFields {
  const repo = t.repo ?? null;
  return {
    icon: inboxIcon(t),
    repoName: repo?.name ?? null,
    repoIconUrl: repo?.iconUrl ?? null,
    repoLetter: repo ? repoLetter(repo.name) : null,
    subjectKind: t.subject?.kind ?? null,
    subjectId: t.subject?.id ?? null,
    subjectName: t.subject?.name ?? null,
  };
}

/**
 * A title split in two where it ends with “ · ” and the repository's name (any case): the head as the title and the tail
 * quieter. Without that ending the whole title is the head.
 */
export function splitRepoTitle(
  title: string,
  repoName: string | null | undefined,
): { head: string; tail: string | null } {
  if (!repoName) return { head: title, tail: null };
  const tail = ` · ${repoName}`;
  const at = title.length - tail.length;
  if (at > 0 && title.slice(at).toLocaleLowerCase() === tail.toLocaleLowerCase())
    return { head: title.slice(0, at), tail: title.slice(at) };
  return { head: title, tail: null };
}

export interface InboxRowOptions {
  /** The person's own principal id: their messages read “You”. */
  me: string | null | undefined;
  /** The assistant's principal id and name. */
  agentId: string | null | undefined;
  agentName: string;
  /** Anyone else's short name (a reporter in Feedback); “Someone” when unknown. */
  nameOf?: (principalId: string) => string | null | undefined;
  now: Date | number;
  timeZone: string;
  /** The thread open on screen: never shown as new. */
  openRootId?: string | null;
  /** The person's language (English when none). */
  locale?: string | null;
  /** The conversation's hand-overs to T3 Code (`conversations.handoffs`): what each row's T3 Code job is doing. */
  handoffs?: readonly Handoff[];
  /** The assistant's own work going on in a thread that the list may not know of yet (its live turn, a run). */
  live?: (rootId: string) => boolean;
}

function whoOf(id: string, o: InboxRowOptions): string {
  if (id === o.me) return clientTree(o.locale, CHAT_AREA_WORDS).inbox.you;
  if (id === o.agentId) return o.agentName;
  return o.nameOf?.(id) || clientTree(o.locale, CHAT_AREA_WORDS).inbox.someone;
}

/** The inbox's rows, in the threads' order (newest activity first, as `chats.threads` sends them). */
export function inboxRows(
  threads: readonly ChatThread[],
  unread: ReadonlyMap<string, number>,
  o: InboxRowOptions,
): InboxRow[] {
  const words = o.locale ? inboxWords(o.locale) : INBOX_WORDS;
  const byRoot = new Map<string, Handoff[]>();
  for (const h of o.handoffs ?? []) if (h.rootId) byRoot.set(h.rootId, [...(byRoot.get(h.rootId) ?? []), h]);
  return threads.map((t) => {
    const last = t.last;
    let who: string | null;
    let line: string;
    if (last) {
      who = whoOf(last.authorId, o);
      line = plainLinks(last.text);
    } else if (t.authorId === o.me) {
      who = null;
      line = t.working ? '' : words.noReply;
    } else {
      who = null;
      line = fromLine(whoOf(t.authorId, o), o.locale);
    }
    // A title names the thread, never its state: a thread that starts with a card is called by the card (the server
    // and `threadOfMessage` put its title in `text`), and only an older server sends nothing at all.
    const title =
      plainLinks(threadTitle(t.text)) ||
      (t.authorId === o.me ? words.yourMessage : messageFromTitle(whoOf(t.authorId, o), o.locale));
    const split = splitRepoTitle(title, t.repo?.name);
    const handed = byRoot.get(t.rootId) ?? [];
    const live = o.live?.(t.rootId) ?? false;
    const status = rowStatus(t, handed, { live, me: o.me, agentName: o.agentName, locale: o.locale });
    const working =
      t.working ||
      live ||
      !!t.handedOver ||
      handed.some((h) => h.state !== 'ended' && h.state !== 'needs_ok');
    const waiting = !!t.waiting || status?.kind === 'waiting';
    return {
      rootId: t.rootId,
      href: chatThreadHref(t.room, t.rootId),
      title,
      who,
      line,
      when: doneWhen(t.lastAt, o.now, o.timeZone, o.locale),
      unread: t.rootId === o.openRootId ? 0 : (unread.get(t.rootId) ?? 0),
      waiting,
      working,
      status,
      settleable: canSettle(t) && !working && !waiting,
      markable: t.authorId !== o.me || (!!last && last.authorId !== o.me) || t.replyCount > 0,
      shownWho: last && last.authorId === o.agentId ? null : who,
      titleHead: split.head,
      titleTail: split.tail,
      ...threadIconFields(t),
    };
  });
}

export type InboxFilter = 'all' | 'waiting' | 'working' | 'done' | 'unread';

/** The filters in the order they show: All, Waiting, Working, Done, Unread. */
export const INBOX_FILTERS: readonly InboxFilter[] = ['all', 'waiting', 'working', 'done', 'unread'];

const isWorking = (r: Pick<InboxRow, 'status'>) =>
  r.status?.kind === 'working' || r.status?.kind === 'checks';
const isEnded = (r: Pick<InboxRow, 'status'>) =>
  r.status?.kind === 'done' || r.status?.kind === 'failed' || r.status?.kind === 'stopped';

/** The rows a filter shows (CIB-05): Working has work going on or waiting for checks, Done has work that ended. */
export function inboxFiltered(rows: readonly InboxRow[], filter: InboxFilter): readonly InboxRow[] {
  if (filter === 'unread') return rows.filter((r) => r.unread > 0);
  if (filter === 'waiting') return rows.filter((r) => r.waiting);
  if (filter === 'working') return rows.filter(isWorking);
  if (filter === 'done') return rows.filter(isEnded);
  return rows;
}

/** How many rows each filter would show, for the filters' numbers. */
export function inboxCounts(rows: readonly InboxRow[]): {
  unread: number;
  waiting: number;
  working: number;
  done: number;
} {
  let unread = 0;
  let waiting = 0;
  let working = 0;
  let done = 0;
  for (const r of rows) {
    if (r.unread > 0) unread++;
    if (r.waiting) waiting++;
    if (isWorking(r)) working++;
    if (isEnded(r)) done++;
  }
  return { unread, waiting, working, done };
}

/**
 * The thread to open after `rootId` leaves the list (settled on a computer): the one below it, else the one above;
 * null when it was the only one or isn't listed.
 */
export function nextRootAfter(rows: readonly Pick<InboxRow, 'rootId'>[], rootId: string): string | null {
  const at = rows.findIndex((r) => r.rootId === rootId);
  if (at < 0) return null;
  return rows[at + 1]?.rootId ?? rows[at - 1]?.rootId ?? null;
}

/** The row `step` away from `rootId` (J/K): the first row when nothing is open; null past either end. */
export function rowStep(
  rows: readonly Pick<InboxRow, 'rootId'>[],
  rootId: string | null | undefined,
  step: 1 | -1,
): string | null {
  if (!rows.length) return null;
  const at = rootId ? rows.findIndex((r) => r.rootId === rootId) : -1;
  if (at < 0) return rows[0]?.rootId ?? null;
  return rows[at + step]?.rootId ?? null;
}

/**
 * A reply as `ChatThread.last` (CIB-03): its plain preview as the server makes it (`threadPreview`: lines joined, links
 * as their words), else “A file” / “3 files”; null for a reply that is only a card (the row keeps what it had).
 */
export function lastOfMessage(
  m: Pick<Message, 'authorId' | 'text' | 'attachments' | 'createdAt'>,
  locale?: string | null,
): ChatThreadLast | null {
  const line = threadPreview(m.text, CHAT_THREAD_TEXT_MAX);
  const files = m.attachments?.length ?? 0;
  const w = clientTree(locale, CHAT_AREA_WORDS).inbox;
  const text = line ? line : files ? (files === 1 ? w.aFile : interpolate(w.files, { count: files })) : '';
  return text ? { authorId: m.authorId, text, at: m.createdAt } : null;
}
