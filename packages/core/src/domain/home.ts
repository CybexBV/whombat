/**
 * Home (called Dashboard in 0.93, CT-447, and Connections since 0.94, CT-451), Watch, Done recently and pinned widgets
 * of the one-Whombat shell (Whombat one-whombat.md ONE-04…ONE-10, contracts 0.80.0, CT-336…). Read models only: the server assembles them from its sources
 * (approvals, questions, the hosts service, connections, devices, automations) and clients draw them as they come.
 *
 * Links are `href`s: app paths relative to the burrow (`/things/server:pve-02`, `/chat?thread=msg_…`, `/watch`), so a
 * newer server can point at a screen without a new union member (`thingHref`, `chatThreadHref`, `chatHref`).
 */
import { z } from 'zod';
import { ChangeId, ConversationId, MessageId, PrincipalId, WidgetId } from '../ids.js';
import { AutomationId } from './automation.js';
import { Count, JsonObject, Timestamp } from './common.js';
import { CHAT_ROOMS, type ChatRoom } from './conversation.js';
import { LookResearch } from './look-research.js';
import { NoticeCheck, NoticeNature, NoticeSubject } from './quiet.js';
import { ThingLogo } from './thing-logo.js';

/* References and links ---------------------------------------------------------------------------- */

/** An app path relative to the burrow: `/things/server:pve-02`, `/chat?thread=msg_x`, `/watch`, `/automations/aut_x`. */
export const HomeHref = z.string().regex(/^\/[^\s]{0,500}$/);
export type HomeHref = z.infer<typeof HomeHref>;

/**
 * What a Needs you or Watch item is about (CT-336): `approval` (an approval's number as text), `question` (a message
 * id), `alert` (a hosts alert id), `hint`, `enrollment`, `connection` (a connection id), `device_skill` (a proposal
 * id), `automation_run`, `check`, `address_change` (0.117, CT-912; BF-16: this Whombat's address changed, the change's
 * time as id), `backup` (Whombat first-day.md: this Whombat isn't backed up, `this-whombat`), `feature_request` (3.12, a
 * tracker's feature request waiting for the person, Whombat report-trackers.md TA-44). Open text on the wire: a
 * newer server may add kinds, clients treat them as opaque.
 */
export const HOME_REF_KINDS = [
  'approval',
  'question',
  'alert',
  'hint',
  'enrollment',
  'connection',
  'device_skill',
  'automation_run',
  'check',
  'address_change',
  'backup',
  'feature_request',
] as const;
export const HomeRef = z.object({
  kind: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  id: z.string().min(1).max(200),
});
export type HomeRef = z.infer<typeof HomeRef>;

/** Severity of a Needs you or Watch item: the dot's colour (bad = red, warn = amber, info = neutral). */
export const HomeSeverity = z.enum(['bad', 'warn', 'info']);
export type HomeSeverity = z.infer<typeof HomeSeverity>;

/* Needs you --------------------------------------------------------------------------------------- */

/**
 * What a Needs you item is. `hint`, `automation_run` and `device` (3.11; Whombat needs-you-list.md NYL-03) come from
 * what Watch had and `backup` (Whombat first-day.md: the assistant's proposal of where this Whombat's backups go, while
 * nothing backs it up) is the Whombat's own; they appear only in `HomeOverview.needsYouList`, never in `needsYou`, which
 * an older app reads.
 */
export const NEEDS_YOU_KINDS = [
  'approval',
  'alert',
  'question',
  'connection',
  'device_skill',
  'enrollment',
  'hint',
  'automation_run',
  'device',
  'backup',
] as const;
/** The kinds an older app's `HomeOverview.needsYou` may hold (the rest are only in `needsYouList`). */
export const NEEDS_YOU_FIRST_KINDS: readonly NeedsYouKind[] = [
  'approval',
  'alert',
  'question',
  'connection',
  'device_skill',
  'enrollment',
];
export const NeedsYouKind = z.enum(NEEDS_YOU_KINDS);
export type NeedsYouKind = z.infer<typeof NeedsYouKind>;

/**
 * Where an item sits in the one Needs you list (3.11; Whombat needs-you-list.md NYL-01, NYL-02): `you` (only the person
 * can do it or decide: asks, only-you lines, a problem the assistant found something about or isn't looking at), the
 * only group that counts; `assistant` (the assistant is looking into it, taking its step or just fixed it); `fyi`
 * (heads-ups, folded, never counted); `quiet` (ignored or to be reminded later, at the foot with Bring it back).
 */
export const NEEDS_YOU_GROUPS = ['you', 'assistant', 'fyi', 'quiet'] as const;
export const NeedsYouGroup = z.enum(NEEDS_YOU_GROUPS);
export type NeedsYouGroup = z.infer<typeof NeedsYouGroup>;

/**
 * A button of a Needs you item (mock 1): `approve` (`approvals.decide`), `approve_later` (`approvals.decide` with
 * `executeAt` = `at`, “Tonight at 03:00”), `decline`, `snooze` (`needsYou.snooze` until `at`, or tomorrow 09:00 local
 * when absent: “Remind me tomorrow”, “Not now”), `open` (go to `href`), `investigate` (“Look into it”: `chats.start` with
 * the item's subject), `ask` (Whombat first-day.md: the person's yes to what the assistant proposes — `text`, in their
 * words, goes to the assistant as their message in a new thread, “Yes, do it”).
 */
export const NEEDS_YOU_ACTION_KINDS = [
  'approve',
  'approve_later',
  'decline',
  'snooze',
  'open',
  'investigate',
  'ask',
] as const;
export const NeedsYouActionKind = z.enum(NEEDS_YOU_ACTION_KINDS);
export type NeedsYouActionKind = z.infer<typeof NeedsYouActionKind>;

export const NeedsYouAction = z.object({
  id: z.string().min(1).max(60),
  label: z.string().min(1).max(60),
  style: z.enum(['primary', 'secondary']),
  kind: NeedsYouActionKind,
  /** `approve_later`: when it runs; `snooze`: until when. */
  at: Timestamp.optional(),
  href: HomeHref.optional(),
  /** `ask`: what the person says to the assistant (“Yes, back up this Whombat to nas-01.”). */
  text: z.string().min(1).max(500).optional(),
});
export type NeedsYouAction = z.infer<typeof NeedsYouAction>;

/**
 * The check behind a Needs you or Watch line, for *Stop watching this* (`things.setWatch` on `thing` with `check` and
 * `subject`; Whombat on-purpose.md): when something is how the person set it up on purpose, Ignore ends once it
 * changes, and switching the check off keeps it quiet until they turn it on again. `name` is what the toast says
 * Whombat stopped watching (the item, “Garage AP”, else the line in quotes). Absent: nothing to switch off (an ask, a
 * failed run, a sign-in) or an older Whombat.
 */
export const NeedsYouWatch = z.object({
  thing: z.string().min(1).max(220),
  check: NoticeCheck,
  subject: NoticeSubject.optional(),
  name: z.string().min(1).max(220),
});
export type NeedsYouWatch = z.infer<typeof NeedsYouWatch>;

export const NeedsYouItem = z.object({
  id: z.string().min(1).max(200),
  ref: HomeRef,
  kind: NeedsYouKind,
  severity: HomeSeverity,
  /** “Restart pve-02 to finish its updates”. */
  title: z.string().min(1).max(200),
  /** One or two plain sentences. */
  body: z.string().max(600),
  at: Timestamp,
  actions: z.array(NeedsYouAction).max(4),
  /** What it is about, for “Look into it” (a chat with that subject). */
  subject: z
    .object({
      kind: z.enum(['server', 'connection', 'device']),
      id: z.string().min(1).max(200),
      name: z.string().max(120),
    })
    .optional(),
  /** An approval's number (`approvals.decide`), when `kind` is `approval`. */
  approvalNumber: z.number().int().positive().optional(),
  /**
   * Problem or Only you (0.122, CT-1064; Whombat quiet-notices.md QN-01, QN-02): a problem keeps “Look into it”, an
   * only-you leads to where it is done. A heads-up (`fyi`) is only in `needsYouList`, folded (3.11). Absent: neither
   * (asks).
   */
  nature: NoticeNature.optional(),
  /**
   * What the assistant found out about the server, connection or device it is about (3.5; Whombat look-research.md): its
   * words replace the item's while it has them, its step's button (`looks.fix`) and *Ask {assistant}* (the thread) come
   * first, *Look into it* goes. An older client ignores it and shows the item as before.
   */
  research: LookResearch.optional(),
  /** Its group in the one list (3.11, `needsYouGroupOf`). Absent from an older Whombat: `you`. */
  group: NeedsYouGroup.optional(),
  /** Where it is, to look at it or fix it by hand: the server's tab, the guest, the connection, the run (3.11). */
  href: HomeHref.optional(),
  /**
   * Whether it is quiet for the person (3.11, as `WatchItem.state`): `acknowledged` ignored, `snoozed` until
   * `snoozedUntil` (Remind me tomorrow). Absent: open.
   */
  state: z.enum(['open', 'acknowledged', 'snoozed']).optional(),
  snoozedUntil: Timestamp.optional(),
  /** An only-you line the assistant can carry out once asked (3.11, as `WatchItem.fixable`): Ask {assistant} to fix it. */
  fixable: z.literal(true).optional(),
  /** The check behind a line, for *Stop watching this* (`NeedsYouWatch`). */
  watch: NeedsYouWatch.optional(),
});
export type NeedsYouItem = z.infer<typeof NeedsYouItem>;

/** Kinds that are a line Whombat watches (not an ask): without `nature` (an older source) they count as problems. */
const NEEDS_YOU_LINE_KINDS: ReadonlySet<NeedsYouKind> = new Set([
  'alert',
  'hint',
  'connection',
  'automation_run',
  'device',
]);

/**
 * The group of an item (3.11; Whombat needs-you-list.md NYL-02), the one rule the Whombat, web and phone share. Quiet
 * first (ignored or reminded later), then heads-ups. A problem goes by what the assistant does about it: while it looks,
 * takes a step or has just fixed it, it is the assistant's; once it found something, or when it isn't looking, it needs
 * the person. An only-you line needs the person unless the assistant is taking the step the person said yes to. Asks
 * (approvals, questions, enrolments) always need the person.
 */
export function needsYouGroupOf(
  item: Pick<NeedsYouItem, 'kind' | 'nature' | 'research' | 'state'>,
): NeedsYouGroup {
  if (item.state === 'acknowledged' || item.state === 'snoozed') return 'quiet';
  if (item.nature === 'fyi') return 'fyi';
  const research = item.research?.state;
  if (research === 'fixing') return 'assistant';
  const problem = item.nature === 'problem' || (!item.nature && NEEDS_YOU_LINE_KINDS.has(item.kind));
  if (problem && (research === 'looking' || research === 'fixed')) return 'assistant';
  return 'you';
}

/** How many items need the person: the `you` group's (the sidebar's badge, the phone's tab, the status line). */
export function needsYouCount(items: readonly Pick<NeedsYouItem, 'group'>[]): number {
  return items.filter((i) => (i.group ?? 'you') === 'you').length;
}

/* Working on -------------------------------------------------------------------------------------- */

export const WorkingStepState = z.enum(['done', 'active', 'waiting', 'todo']);
export type WorkingStepState = z.infer<typeof WorkingStepState>;

export const WorkingStep = z.object({
  title: z.string().min(1).max(160),
  detail: z.string().max(300).optional(),
  state: WorkingStepState,
});
export type WorkingStep = z.infer<typeof WorkingStep>;

/** Whombat's current task (its active plan in a task chat) as steps with a progress bar. */
export const WorkingTask = z.object({
  conversationId: ConversationId,
  title: z.string().min(1).max(160),
  startedAt: Timestamp,
  progress: z.object({ done: Count, total: Count }),
  steps: z.array(WorkingStep).max(50),
});
export type WorkingTask = z.infer<typeof WorkingTask>;

/* Chats with the assistant (0.91, CT-403; Whombat home-redesign.md HR-21) ----------------------------- */

/**
 * Where a chat with the assistant stands for the viewer: `working` (the assistant works in it now), `waiting` (an
 * approval or a question there waits for the viewer), `recent` (the newest others).
 */
export const HOME_CHAT_STATES = ['working', 'waiting', 'recent'] as const;
export const HomeChatState = z.enum(HOME_CHAT_STATES);
export type HomeChatState = z.infer<typeof HomeChatState>;

/** The most chats `HomeOverview.chats` carries; the web shows 4, the phone 3. */
export const HOME_CHATS_MAX = 8;

/**
 * A chat on Home's “Chats with the assistant” card: working first, then waiting, then the newest others (the server's
 * order). `progress` and `step` come from its active plan (“Working · step 3 of 4”).
 */
export const HomeChat = z.object({
  conversationId: ConversationId,
  title: z.string().min(1).max(160),
  state: HomeChatState,
  /** The last thing that happened in it (the newest message, or when the work started). */
  at: Timestamp,
  progress: z.object({ done: Count, total: Count }).optional(),
  /** The step it is on now, in plain words. */
  step: z.string().max(160).optional(),
  /**
   * The person's default chat with the assistant (their DM, as `ChatSummary.default`): drawn as “Your chat with Neo”
   * rather than a row titled with the assistant's name. Absent: a task chat.
   */
  default: z.boolean().optional(),
});
export type HomeChat = z.infer<typeof HomeChat>;

/* Your things ------------------------------------------------------------------------------------- */

export const THING_KINDS = ['server', 'connection', 'device'] as const;
export const ThingKind = z.enum(THING_KINDS);
export type ThingKind = z.infer<typeof ThingKind>;

/** `learning`: a device Whombat is still learning (a proposed skill nobody switched on yet). */
export const ThingStatus = z.enum(['ok', 'warn', 'bad', 'learning', 'offline', 'unknown']);
export type ThingStatus = z.infer<typeof ThingStatus>;

export const ThingFact = z.object({
  /** “Living room”, “CPU”, “Clients”. */
  label: z.string().min(1).max(60),
  /** Already formatted: “21.5”, “3 of 4”, “on”. */
  value: z.string().max(60),
  unit: z.string().max(16).optional(),
  /** “of 24 °C”, “since 08:12”. */
  note: z.string().max(80).optional(),
});
export type ThingFact = z.infer<typeof ThingFact>;

/**
 * A server, connection or device on Home and in the sidebar's “Your things” (ONE-04, ONE-05). `id` is
 * `thingId(kind, id)`: `server:pve-02`, `connection:con_…`, `device:con_…`.
 */
export const ThingSummary = z.object({
  id: z.string().min(3).max(220),
  kind: ThingKind,
  /** A connection's or device's catalog entry (`homeassistant`, `device`). */
  catalogId: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,30}$/)
    .optional(),
  name: z.string().min(1).max(120),
  /**
   * An icon name the clients know (`server`, `home`, `wifi`, `mail`, `thermometer`), a catalog id, or a server's mark
   * (0.90, CT-399: `hostOsMark`, `proxmox`, `debian`); a client draws an icon it doesn't know by the thing's kind.
   */
  icon: z.string().min(1).max(40),
  /**
   * A connection’s own logo, drawn instead of `icon`: a Custom connection the
   * assistant gave one. Absent: the icon.
   */
  logo: ThingLogo.optional(),
  status: ThingStatus,
  /** One line under the name: “3 lights on · 21.5 °C”, “Last checked 08:12”. */
  line: z.string().max(160).optional(),
  /**
   * Why it isn't fine, in a few plain words (0.95, CT-453; Whombat sidebar.md SB-03): “3 integrations not loading”,
   * “1 access point offline”, “Filling up”. Only with a status other than `ok`; absent when the server doesn't know
   * why (clients then say the status alone).
   */
  reason: z.string().min(1).max(160).optional(),
  facts: z.array(ThingFact).max(8),
  href: HomeHref,
  /**
   * The server it is part of (0.88, CT-391; Whombat connection-pages.md CP-10): a Proxmox or Unraid connection to a
   * server Whombat already watches. The sidebar and Home's tiles leave it out; the server's page links to it.
   */
  partOf: z.string().min(3).max(220).optional(),
  /**
   * When an agent's or a person's call to it last worked (0.91, CT-404; HR-23): a connection without live figures shows
   * “Connected · used today”. Absent: never, or a server.
   */
  usedAt: Timestamp.optional(),
});
export type ThingSummary = z.infer<typeof ThingSummary>;

/** `server:pve-02`: a thing's id from its kind and the id within it. */
export function thingId(kind: ThingKind, id: string): string {
  return `${kind}:${id}`;
}

/** The kind and inner id of `thingId`'s output, or null. */
export function parseThingId(value: string): { kind: ThingKind; id: string } | null {
  const i = value.indexOf(':');
  if (i < 1) return null;
  const kind = ThingKind.safeParse(value.slice(0, i));
  const id = value.slice(i + 1);
  return kind.success && id ? { kind: kind.data, id } : null;
}

/** The thing's page: `/things/<thingId>` (the id URL-encoded). */
export function thingHref(kind: ThingKind, id: string): string {
  return `/things/${encodeURIComponent(thingId(kind, id))}`;
}

/** A task chat's page: `/chats/<conversationId>`. */
export function chatHref(conversationId: string): string {
  return `/chats/${conversationId}`;
}

/* Chat, Feedback and Connections (0.93, CT-445, 0.94 CT-450; Whombat chat-channel.md CHT-08, CHT-11, CHT-21) --- */

/**
 * Overview's old address (the Dashboard): a link or bookmark to it opens Overview. Its code names stay
 * `home.*`.
 */
export const DASHBOARD_HREF = '/dashboard';

/** Overview, at `/connections` (0.94, CT-450; the Dashboard before; sidebar-tabs.md): the servers and services, Needs you, what is pinned. */
export const CONNECTIONS_HREF = '/connections';

/** The one Needs you list (3.11; Whombat needs-you-list.md NYL-05): Watch's `/watch` opens it too. */
export const NEEDS_YOU_HREF = '/needs-you';

/** One item of the Needs you list, by its `id`: `/needs-you?item=hosts.alert%3A12`. A push about it opens it. */
export function needsYouItemHref(itemId: string): string {
  return `${NEEDS_YOU_HREF}?item=${encodeURIComponent(itemId)}`;
}

const ROOM_HREF = { chat: '/chat', feedback: '/feedback' } as const satisfies Record<ChatRoom, string>;

/** A room's page: `/chat` or `/feedback`. */
export function chatRoomHref(room: ChatRoom): (typeof ROOM_HREF)[ChatRoom] {
  return ROOM_HREF[room];
}

/** A thread in a room, open beside it: `/chat?thread=<rootId>` (the thread's first message). */
export function chatThreadHref(room: ChatRoom, rootId: string): string {
  return `${ROOM_HREF[room]}?thread=${encodeURIComponent(rootId)}`;
}

/**
 * The room and thread of a Chat or Feedback link (`chatRoomHref`, `chatThreadHref`), or null for any other path. Takes
 * `/chat` and `/feedback` (a trailing `/`, other query parameters and a `#…` are ignored); `thread` is null without a
 * `?thread=` that is a message id. Hand-parsed: no `URL` or `URLSearchParams`, so it runs the same on Hermes.
 */
export function parseChatHref(href: string): { room: ChatRoom; thread: string | null } | null {
  const hash = href.indexOf('#');
  const noHash = hash < 0 ? href : href.slice(0, hash);
  const q = noHash.indexOf('?');
  const path = (q < 0 ? noHash : noHash.slice(0, q)).replace(/(.)\/$/, '$1');
  const room = CHAT_ROOMS.find((r) => ROOM_HREF[r] === path);
  if (!room) return null;
  const pair =
    q < 0
      ? undefined
      : noHash
          .slice(q + 1)
          .split('&')
          .find((p) => p.startsWith('thread='));
  return { room, thread: pair === undefined ? null : threadId(pair.slice('thread='.length)) };
}

function threadId(encoded: string): string | null {
  try {
    const value = decodeURIComponent(encoded);
    return MessageId.safeParse(value).success ? value : null;
  } catch {
    return null;
  }
}

/* Automations today, Done recently ---------------------------------------------------------------- */

export const AutomationToday = z.object({
  id: AutomationId,
  name: z.string().min(1).max(80),
  state: z.enum(['ran', 'failed', 'scheduled']),
  /** When it ran, failed or will run. */
  at: Timestamp,
});
export type AutomationToday = z.infer<typeof AutomationToday>;

/** Whether a change can be undone (ONE-08): `available` until `until`, `undone` once it was, `none` without an inverse. */
export const ChangeUndo = z.object({
  state: z.enum(['available', 'undone', 'none']),
  until: Timestamp.optional(),
});
export type ChangeUndo = z.infer<typeof ChangeUndo>;

export const ChangeActor = z.object({
  kind: z.enum(['whombat', 'person']),
  id: PrincipalId,
  name: z.string().min(1).max(80),
});
export type ChangeActor = z.infer<typeof ChangeActor>;

/** Something Whombat (or a person through it) changed through a tool, with a plain title (ONE-08). */
export const ChangeEntry = z.object({
  id: ChangeId,
  /** “Turned off the hallway lights”, “Gave web-01 4 GB more memory”. */
  title: z.string().min(1).max(200),
  detail: z.string().max(500).optional(),
  at: Timestamp,
  actor: ChangeActor,
  undo: ChangeUndo,
  /** What it changed: the thing's page or the chat it came from. */
  link: HomeHref.optional(),
  /** The thing it changed (`thingId`), when there is one. */
  thingId: z.string().max(220).optional(),
});
export type ChangeEntry = z.infer<typeof ChangeEntry>;

/** How long Undo stays offered after a change (ONE-08, decided CT-338): 24 hours. */
export const CHANGE_UNDO_WINDOW_S = 24 * 3600;
/** Done recently on Home: the newest this many. */
export const DONE_RECENTLY_MAX = 8;

/**
 * A task the assistant finished today, in its own few words (`report_done`, Whombat done-today.md; status-line.md).
 * `href` is the thread or chat it was done in; `fixed` marks a problem it fixed (a look whose research ended fixed),
 * which the status sentence counts (“I fixed 1 thing overnight.”);
 * `undo` is the one change made there that can still be undone, when there is exactly one.
 */
export const DoneTodayItem = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(60),
  at: Timestamp,
  href: HomeHref.optional(),
  fixed: z.literal(true).optional(),
  undo: z.object({ changeId: ChangeId, until: Timestamp.optional() }).optional(),
});
export type DoneTodayItem = z.infer<typeof DoneTodayItem>;

/** `HomeOverview.doneToday`: the newest this many of the person's day. */
export const DONE_TODAY_MAX = 20;

/* Widgets ----------------------------------------------------------------------------------------- */

/** A series' colour: `--chart-1`, `--chart-2`, `--chart-3`. */
export const WidgetColor = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type WidgetColor = z.infer<typeof WidgetColor>;

const SeriesKey = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);

export const WidgetSeries = z.object({
  key: SeriesKey,
  label: z.string().min(1).max(40),
  unit: z.string().max(16).optional(),
  color: WidgetColor,
});
export type WidgetSeries = z.infer<typeof WidgetSeries>;

export const WidgetPoint = z.object({
  t: Timestamp,
  values: z.record(z.string(), z.number().nullable()),
});
export type WidgetPoint = z.infer<typeof WidgetPoint>;

/** A pinned panel on Home (ONE-09). `kind` `line` only for now. Points: oldest first, at most 24 hours. */
export const Widget = z.object({
  id: WidgetId,
  title: z.string().min(1).max(80),
  subtitle: z.string().max(120).optional(),
  kind: z.literal('line'),
  series: z.array(WidgetSeries).min(1).max(3),
  latest: z.array(
    z.object({ key: SeriesKey, value: z.number().nullable(), unit: z.string().max(16).optional() }),
  ),
  points: z.array(WidgetPoint).max(2880),
  refreshSec: z.number().int().positive(),
  updatedAt: Timestamp.nullable(),
  /** The chat it was pinned from. */
  fromConversationId: ConversationId.optional(),
  /** Why the last refresh failed, in plain words; absent when it worked. */
  problem: z.string().max(200).optional(),
  /**
   * Kept on a thing's page instead of Home (0.88, CT-392; CP-14): its `thingId` (`connection:con_…`, `device:…`,
   * `server:pve-02`). Absent: on Home.
   */
  thingId: z.string().min(3).max(220).optional(),
});
export type Widget = z.infer<typeof Widget>;

/** The fewest, default and most seconds between refreshes, and how much history a widget keeps. */
export const WIDGET_REFRESH_MIN_S = 60;
export const WIDGET_REFRESH_DEFAULT_S = 300;
export const WIDGET_REFRESH_MAX_S = 86_400;
export const WIDGET_HISTORY_S = 24 * 3600;
/** The most widgets one person pins in a burrow. */
export const WIDGETS_MAX = 12;

/** A JSON pointer (RFC 6901): `''` for the whole document, `/data/0/temp`. */
export const JsonPointer = z
  .string()
  .max(300)
  .regex(/^(\/([^~/]|~[01])*)*$/);
export type JsonPointer = z.infer<typeof JsonPointer>;

/** The value at a JSON pointer, or undefined. */
export function jsonPointerGet(doc: unknown, pointer: string): unknown {
  if (pointer === '') return doc;
  if (!pointer.startsWith('/')) return undefined;
  let cur: unknown = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
      cur = cur[Number(key)];
    } else if (cur && typeof cur === 'object') {
      if (!Object.hasOwn(cur, key)) return undefined;
      cur = (cur as Record<string, unknown>)[key];
    } else return undefined;
  }
  return cur;
}

/**
 * What a widget reads (stored, shown to its owner; ONE-09): one read-only tool call with fixed arguments and which
 * numbers of its answer form the series (`path`, a JSON pointer into the tool's result), or a server's metric from the
 * hosts service. The server refreshes it without the AI.
 */
export const WidgetSource = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('connection_tool'),
    connectionId: z.string().regex(/^con_[A-Za-z0-9_-]{1,64}$/),
    tool: z.string().min(1).max(200),
    args: JsonObject,
    values: z
      .array(
        z.object({
          key: SeriesKey,
          label: z.string().min(1).max(40),
          unit: z.string().max(16).optional(),
          path: JsonPointer,
        }),
      )
      .min(1)
      .max(3),
  }),
  z.object({
    kind: z.literal('server_metric'),
    serverId: z.string().min(1).max(100),
    /** Series of `hosts.serverMetrics` (`cpu_pct`, `mem_pct`, `temp_max_c`, `net_rx_mbps`, `net_tx_mbps`, …). */
    series: z
      .array(z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/))
      .min(1)
      .max(3),
  }),
]);
export type WidgetSource = z.infer<typeof WidgetSource>;

/* Watch ------------------------------------------------------------------------------------------- */

/**
 * Something that needs attention but isn't a decision (ONE-07): an open alert or hint from a server, a connection that
 * stopped working, a failed automation.
 */
export const WatchItem = z.object({
  id: z.string().min(1).max(200),
  ref: HomeRef,
  source: z.enum(['server', 'connection', 'automation', 'device']),
  severity: HomeSeverity,
  title: z.string().min(1).max(200),
  body: z.string().max(600),
  at: Timestamp,
  serverId: z.string().max(100).optional(),
  state: z.enum(['open', 'acknowledged', 'snoozed']),
  snoozedUntil: Timestamp.optional(),
  /** Where to look: the server's section, the connection, the run. */
  href: HomeHref.optional(),
  /**
   * Problem or Only you (0.122, CT-1064; QN-01, QN-22). Watch leaves out heads-ups and what is ignored, snoozed or not
   * watched. Absent: as before.
   */
  nature: NoticeNature.optional(),
  /**
   * An only-you item the assistant can carry out once asked (a server's backup job, snapshot schedule or restart):
   * Watch offers Ask {assistant} to fix it. Absent: the person does it.
   */
  fixable: z.literal(true).optional(),
  /** The check behind it, for *Stop watching this* (`NeedsYouWatch`). */
  watch: NeedsYouWatch.optional(),
});
export type WatchItem = z.infer<typeof WatchItem>;

/* The overview ------------------------------------------------------------------------------------ */

export const HomeSummary = z.object({
  /**
   * What needs the person: since 3.11 (Whombat needs-you-list.md NYL-04) the `you` group of `needsYouList`, the one count
   * every place shows.
   */
  needsYou: Count,
  working: Count,
  problems: Count,
  /**
   * The most serious open Watch item's severity (0.95, CT-454; Whombat sidebar.md SB-02): the Watch badge's colour.
   * Absent with nothing open.
   */
  worst: HomeSeverity.optional(),
});
export type HomeSummary = z.infer<typeof HomeSummary>;

/** `home.overview`: every section of Home (mock 1), for the viewer. */
export const HomeOverview = z.object({
  summary: HomeSummary,
  needsYou: z.array(NeedsYouItem).max(50),
  /**
   * The one Needs you list (3.11; Whombat needs-you-list.md NYL-01): every item with its `group` — what needs the person,
   * what the assistant is on, heads-ups and what is quiet — what Watch and `needsYou` had together, each once, worst
   * first then newest. An older Whombat sends none.
   */
  needsYouList: z.array(NeedsYouItem).max(300).optional(),
  /** Chats with the assistant (0.91, CT-403; HR-21), in the order to show them. */
  chats: z.array(HomeChat).max(HOME_CHATS_MAX),
  things: z.array(ThingSummary).max(200),
  automationsToday: z.array(AutomationToday).max(50),
  widgets: z.array(Widget).max(24),
  doneRecently: z.array(ChangeEntry).max(50),
  /**
   * What the assistant finished for the viewer since the start of their day, newest first (status-line.md): Chat's
   * *Done today*. Absent from an older server: Chat shows none.
   */
  doneToday: z.array(DoneTodayItem).max(DONE_TODAY_MAX).optional(),
  generatedAt: Timestamp,
});
export type HomeOverview = z.infer<typeof HomeOverview>;

/**
 * The Home parts a `home.changed` event names: the client refetches `home.overview` (or only the widgets). `working`
 * stands for `chats` (0.91): apps refetch the whole overview for any part.
 */
export const HOME_PARTS = [
  'needsYou',
  'working',
  'things',
  'automationsToday',
  'widgets',
  'doneRecently',
  'watch',
] as const;
export const HomePart = z.enum(HOME_PARTS);
export type HomePart = z.infer<typeof HomePart>;
