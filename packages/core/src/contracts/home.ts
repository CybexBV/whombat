/**
 * The one-Whombat shell's REST contract (Whombat one-whombat.md ONE-04…ONE-10, ONE-06, ONE-18; contracts 0.80.0,
 * CT-336…CT-341; 0.80.1, CT-349; 0.80.3, CT-352): Home, Watch and its acknowledgements, Needs you snoozes and ignores, Done
 * recently and Undo, pinned widgets, task chats, what answers in Chat (0.96, CT-461) and the device
 * skill decision. Every route is the caller's own view in a burrow; writes go through the commit pipeline. Session ops
 * too (`home.*`, `watch.*`, `needsYou.*`, `changes.*`, `widgets.*`, `chats.*`, `deviceSkills.*`).
 */
import { z } from 'zod';
import { SettingsCopyFile, SettingsCopyQuery } from '../domain/changes.js';
import { ChatRuntime, ChatRuntimeView } from '../domain/chat-runtime.js';
import { Count, Cursor, Timestamp } from '../domain/common.js';
import {
  CHAT_THREADS_LIMIT_DEFAULT,
  CHAT_THREADS_LIMIT_MAX,
  ChatRoom,
  ChatSubject,
  ChatSummary,
  ChatThread,
  Conversation,
  ThreadPlace,
} from '../domain/conversation.js';
import { DESK_SCREEN_VIEWS_MAX, DeskCatalog, DeskWidgetRef, DeskWidgetView } from '../domain/desk-screens.js';
import { DeviceActionChoice, DeviceSkillCard } from '../domain/devices.js';
import { ExposureView } from '../domain/exposure.js';
import { ChangeEntry, HomeOverview, HomeRef, WatchItem, Widget } from '../domain/home.js';
import { ThingHistory, ThingHistoryQuery } from '../domain/incidents.js';
import { LookResearch } from '../domain/look-research.js';
import { Message, MessageTextInput } from '../domain/message.js';
import { ArrangeOverviewBody, OverviewLayout, OverviewViewsQuery } from '../domain/overview-layout.js';
import {
  KEEP_QUIET_MAX_MINUTES,
  KEEP_QUIET_MIN_MINUTES,
  KeptQuiet,
  NoticeCheck,
  NoticeQuiet,
  NoticeRef,
  NoticeSubject,
  ThingWatch,
  WatchLimitValue,
} from '../domain/quiet.js';
import {
  ThingButtonValue,
  ThingImageRef,
  ThingPage,
  ThingPageKey,
  ThingPageQuery,
} from '../domain/thing-page.js';
import { ThingWatchView } from '../domain/thing-watch.js';
import {
  ChangeId,
  ConnectionId,
  ConversationId,
  DeviceSkillProposalId,
  MessageId,
  ThingWatchId,
  WidgetId,
} from '../ids.js';
import { API_PREFIX, BurrowParam, endpoint, limitQuery, QueryBool } from './endpoint.js';

const B = z.object({ burrow: BurrowParam });

/* Home and Watch ---------------------------------------------------------------------------------- */

export const WatchListResponse = z.object({ items: z.array(WatchItem) });
export type WatchListResponse = z.infer<typeof WatchListResponse>;

export const SnoozeNeedsYouBody = z.object({ ref: HomeRef, until: Timestamp });
export type SnoozeNeedsYouBody = z.infer<typeof SnoozeNeedsYouBody>;
export const SnoozeNeedsYouResponse = z.object({ ref: HomeRef, snoozedUntil: Timestamp });

/**
 * Ignore a Needs you item for good (0.80.3, CT-352): it leaves the caller's Needs you, and their Watch shows it as seen.
 * Nothing else changes: an approval stays undecided, a server alert stays open for everyone else. `ignored: false` takes
 * it back (the toast's Undo).
 *
 * Since 0.122 (CT-1064; Whombat quiet-notices.md QN-21) on `alert` and `connection` items, and on Watch's `hint` and
 * `device` items (QN-25), it is the shared Ignore of `things.quiet` instead: ignored for the whole Whombat until it
 * changes (a server alert: the hosts service's acknowledgement until it resolves), with the toast
 * `QUIET_WORDS.toastIgnored`; `ignored: false` takes that back. On approvals, questions and failed runs it stays the
 * caller's own, as before (ONE-24).
 */
export const IgnoreNeedsYouBody = z.object({ ref: HomeRef, ignored: z.boolean().default(true) });
export type IgnoreNeedsYouBody = z.input<typeof IgnoreNeedsYouBody>;
export const IgnoreNeedsYouResponse = z.object({ ref: HomeRef, ignored: z.boolean() });
export type IgnoreNeedsYouResponse = z.infer<typeof IgnoreNeedsYouResponse>;

/**
 * *Talk to {assistant} about it* (Whombat inbox.md IBX-07): a new thread in the caller's Chat that the assistant
 * starts with the Inbox item's words (about its server, connection or device when it has one), so the person can talk
 * it over with the assistant knowing what it is about. No turn runs until the person writes. 404 when the item isn't in
 * the caller's Inbox any more.
 */
export const DiscussNeedsYouBody = z.object({ ref: HomeRef });
export type DiscussNeedsYouBody = z.infer<typeof DiscussNeedsYouBody>;
/** The Chat and the new thread's first message (the assistant's). */
export const DiscussNeedsYouResponse = z.object({ conversation: Conversation, message: Message });
export type DiscussNeedsYouResponse = z.infer<typeof DiscussNeedsYouResponse>;

/**
 * Acknowledge a Watch item (0.80.1, CT-349; one-whombat.md ONE-07): “I've seen it”, until it changes. A server alert's
 * acknowledgement is the hosts service's (until it resolves, everyone sees it); anything else is the caller's own view.
 * `acknowledged: false` takes it back (Watch's “Bring it back”), and with it the shared Ignore of the line behind a
 * server hint, a connection or a device (Whombat quiet-notices.md QN-25).
 */
export const AcknowledgeWatchBody = z.object({ ref: HomeRef, acknowledged: z.boolean().default(true) });
export type AcknowledgeWatchBody = z.input<typeof AcknowledgeWatchBody>;
export const AcknowledgeWatchResponse = z.object({ ref: HomeRef, state: z.enum(['acknowledged', 'open']) });
export type AcknowledgeWatchResponse = z.infer<typeof AcknowledgeWatchResponse>;

export const ChangesListResponse = z.object({ changes: z.array(ChangeEntry), before: Cursor.nullable() });
export type ChangesListResponse = z.infer<typeof ChangesListResponse>;

/**
 * Undo's answer: `undone` (the inverse ran), `asked` (it waits for a person's approval, `approvalNumber`; the change
 * shows Undo once that decides), or `requested` (0.91, CT-406; Whombat home-redesign.md HR-03: a change an agent reported
 * with `report_change`: the agent was asked to put it back in `conversationId`, the chat it was reported in, and the
 * change shows undone once it says so). A refusal is an error with a plain message (`conflict`: “It was changed again
 * since.”, “I’m already undoing this.”).
 */
export const UNDO_STATES = ['undone', 'asked', 'requested'] as const;
export const UndoChangeResponse = z.object({
  change: ChangeEntry,
  state: z.enum(UNDO_STATES),
  approvalNumber: z.number().int().positive().optional(),
  /** With `requested`: the chat where the agent puts it back. */
  conversationId: ConversationId.optional(),
});
export type UndoChangeResponse = z.infer<typeof UndoChangeResponse>;

export const WidgetsResponse = z.object({ widgets: z.array(Widget) });
export type WidgetsResponse = z.infer<typeof WidgetsResponse>;
export const MoveWidgetBody = z.object({ position: z.number().int().min(0).max(100) });

export const homeEndpoints = {
  overview: endpoint({
    id: 'home.overview',
    method: 'GET',
    path: '/burrows/:burrow/home',
    summary:
      'The caller’s Overview page: the status line’s counts, Needs you, Working on, their servers and services, Automations today and pinned widgets.',
    params: B,
    response: HomeOverview,
  }),
};

export const watchEndpoints = {
  list: endpoint({
    id: 'watch.list',
    method: 'GET',
    path: '/burrows/:burrow/watch',
    summary:
      'What needs attention but isn’t a decision: server alerts and hints, connections that stopped, failed automations.',
    params: B,
    query: z.object({ state: z.enum(['open', 'all']).optional() }),
    response: WatchListResponse,
  }),
  acknowledge: endpoint({
    id: 'watch.acknowledge',
    method: 'POST',
    path: '/burrows/:burrow/watch/acknowledge',
    summary:
      'Acknowledge a Watch item until it changes, or take that back. A server alert’s acknowledgement is shared (the hosts service’s); anything else is the caller’s own view.',
    params: B,
    body: AcknowledgeWatchBody,
    response: AcknowledgeWatchResponse,
  }),
};

export const needsYouEndpoints = {
  snooze: endpoint({
    id: 'needsYou.snooze',
    method: 'POST',
    path: '/burrows/:burrow/needs-you/snooze',
    summary: 'Hide an Inbox item until a time (“Remind me tomorrow”); the caller’s own view only.',
    params: B,
    body: SnoozeNeedsYouBody,
    response: SnoozeNeedsYouResponse,
  }),
  ignore: endpoint({
    id: 'needsYou.ignore',
    method: 'POST',
    path: '/burrows/:burrow/needs-you/ignore',
    summary:
      'Settle an Inbox item (a watched line until it happens again, anything else for good), or take that back.',
    params: B,
    body: IgnoreNeedsYouBody,
    response: IgnoreNeedsYouResponse,
  }),
  discuss: endpoint({
    id: 'needsYou.discuss',
    method: 'POST',
    path: '/burrows/:burrow/needs-you/discuss',
    summary:
      'Start a thread with the assistant about an Inbox item: it opens with the item’s words, and the person talks it over from there.',
    params: B,
    body: DiscussNeedsYouBody,
    response: DiscussNeedsYouResponse,
  }),
};

/* What the assistant found out about a look (3.5; Whombat look-research.md) ------------------------------------------ */

/** `key` the look's, as `LookResearch.key` (`server:pve-02`, `connection:con_…`). */
export const FixLookBody = z.object({ key: z.string().min(1).max(120) });
export type FixLookBody = z.infer<typeof FixLookBody>;
/** The research as it is now: `fixing` while the assistant takes the step. */
export const FixLookResponse = z.object({ research: LookResearch });
export type FixLookResponse = z.infer<typeof FixLookResponse>;

/** `key` the thing's (`server:pve-02`, `connection:con_…`), as `LookResearch.key`. */
export const HandleLookBody = z.object({ key: z.string().min(1).max(120) });
export type HandleLookBody = z.infer<typeof HandleLookBody>;
/** The research as it is now: `looking` while the assistant looks into everything there. */
export const HandleLookResponse = z.object({ research: LookResearch });
export type HandleLookResponse = z.infer<typeof HandleLookResponse>;
export const GetLookQuery = z.object({ key: z.string().min(1).max(120) });
export type GetLookQuery = z.infer<typeof GetLookQuery>;
/** The thing's live research, or null when the assistant isn't looking into anything there. */
export const GetLookResponse = z.object({ research: LookResearch.nullable() });
export type GetLookResponse = z.infer<typeof GetLookResponse>;

export const lookEndpoints = {
  /**
   * *Ask {assistant} to handle these* on a thing's Worth a look (3.11, Whombat handle-it.md): the assistant looks into
   * everything that needs a look there now and comes back with one plan to say go ahead to. Already looking: the same
   * research. A Whombat without it answers `unknown_op`; the apps then ask in the Ask pane as before.
   */
  handle: endpoint({
    id: 'looks.handle',
    method: 'POST',
    path: '/burrows/:burrow/looks/handle',
    summary:
      'Hand everything that needs a look on a thing to the assistant: it looks into all of it in the thing’s thread and comes back with one plan. 404 when nothing needs a look there; 403 when the caller may not.',
    params: B,
    body: HandleLookBody,
    response: HandleLookResponse,
  }),
  /** A thing's research for a page that doesn't carry it (a server's, built in the apps; 3.11). */
  get: endpoint({
    id: 'looks.get',
    method: 'GET',
    path: '/burrows/:burrow/looks/research',
    summary:
      'What the assistant found out about a thing that needs a look, with its plan; null when nothing.',
    params: B,
    query: GetLookQuery,
    response: GetLookResponse,
  }),
  fix: endpoint({
    id: 'looks.fix',
    method: 'POST',
    path: '/burrows/:burrow/looks/fix',
    summary:
      'Take the step the assistant offers on a look (its button, “Restart Zigbee”), or its plan (Go ahead): the press is the go-ahead for exactly those steps, which the assistant takes in the look’s thread. 404 when the look went or offers no step; 403 when the caller may not manage the thing.',
    params: B,
    body: FixLookBody,
    response: FixLookResponse,
  }),
};

export const changeEndpoints = {
  list: endpoint({
    id: 'changes.list',
    method: 'GET',
    path: '/burrows/:burrow/changes',
    summary:
      'What Whombat changed through its tools, newest first, with Undo where possible; with `thing`, a thing page’s “Changes here”.',
    params: B,
    query: z.object({
      before: Cursor.optional(),
      limit: limitQuery(20, 100),
      thing: z.string().max(220).optional(),
    }),
    response: ChangesListResponse,
  }),
  undo: endpoint({
    id: 'changes.undo',
    method: 'POST',
    path: '/burrows/:burrow/changes/:changeId/undo',
    summary:
      'Undo a change: its inverse runs as a new call through the pipeline, so keys and approvals apply again. People only.',
    params: B.extend({ changeId: ChangeId }),
    response: UndoChangeResponse,
  }),
};

export const widgetEndpoints = {
  list: endpoint({
    id: 'widgets.list',
    method: 'GET',
    path: '/burrows/:burrow/widgets',
    summary:
      'The caller’s pinned widgets in their order, with up to 24 hours of points: the Overview page’s, or with `thing` those kept on that thing’s page (0.88).',
    params: B,
    query: z.object({ thing: z.string().min(3).max(220).optional() }),
    response: WidgetsResponse,
  }),
  remove: endpoint({
    id: 'widgets.remove',
    method: 'DELETE',
    path: '/burrows/:burrow/widgets/:widgetId',
    summary: 'Unpin a widget.',
    params: B.extend({ widgetId: WidgetId }),
    response: WidgetsResponse,
  }),
  move: endpoint({
    id: 'widgets.move',
    method: 'POST',
    path: '/burrows/:burrow/widgets/:widgetId/move',
    summary: 'Move a widget to a position (0 = first).',
    params: B.extend({ widgetId: WidgetId }),
    body: MoveWidgetBody,
    response: WidgetsResponse,
  }),
};

/* Arranging the Overview (Whombat overview-arranged.md) --------------------------------------------------------- */

export const ArrangeOverviewResponse = z.object({ arranged: OverviewLayout });
export const OverviewViewsResponse = z.object({ views: z.array(DeskWidgetView).max(DESK_SCREEN_VIEWS_MAX) });

export const overviewEndpoints = {
  arrange: endpoint({
    id: 'overview.arrange',
    method: 'PUT',
    path: '/burrows/:burrow/overview/layout',
    summary:
      'Arrange the Overview: the whole layout — what each tile shows, its size and place, the four figures at the top, the pinned charts’ widths. One for the whole Whombat; the person only.',
    params: B,
    body: ArrangeOverviewBody,
    response: ArrangeOverviewResponse,
  }),
  views: endpoint({
    id: 'overview.views',
    method: 'GET',
    path: '/burrows/:burrow/overview/views',
    summary:
      'What the Overview’s tiles and figures show now (`show`: `thing~panel~range`, comma separated): the views of desk-screen widgets of type `figures` or `panel` of a connection, a device or an account, as a screen would draw them; each view’s id is `overviewShowId`.',
    params: B,
    query: OverviewViewsQuery,
    response: OverviewViewsResponse,
  }),
  figures: endpoint({
    id: 'overview.figures',
    method: 'GET',
    path: '/burrows/:burrow/overview/figures',
    summary:
      'What a tile or a figure can show: each connection’s, device’s and account’s figures and the panels of its page; with `thing`, only that one’s (its page read now).',
    params: B,
    query: z.object({ thing: DeskWidgetRef.optional() }),
    response: DeskCatalog,
  }),
};

/* Thing pages (0.88, CT-390…CT-393) --------------------------------------------------------------- */

/** A thing in a path: its thingId, URL-encoded (`connection%3Acon_x`). */
export const ThingParam = z.string().min(3).max(220);

/**
 * Run one of a page's actions (`ThingPage.actions`) after the person confirmed it, or press one of its buttons (0.121,
 * CT-1006; `ThingPageButton`): its `action`, and its `target` and `value` as the button carries them (a switch sends
 * `value: !on`, a stepper its new figure). The server checks all three against what the page offers.
 */
export const ThingActionBody = z.object({
  action: ThingPageKey,
  target: z.string().min(1).max(200).optional(),
  value: ThingButtonValue.optional(),
});
export type ThingActionBody = z.infer<typeof ThingActionBody>;
/**
 * The toast's words (“Restarting Home Assistant. It’s back in about a minute.”, “Approved Dune: Part Two”) and the
 * change it made; an everyday switch (SD-08) has none in Done recently. `refresh` (0.121, CT-1006): read the page again
 * at once (a client may do so anyway).
 */
export const ThingActionResponse = z.object({
  message: z.string().min(1).max(200),
  changeId: ChangeId.optional(),
  refresh: z.boolean().optional(),
  /**
   * The change can be put back (Whombat service-settings.md SST-03): the toast offers “Put it back”, which is
   * `changes.undo` of `changeId`.
   */
  undoable: z.boolean().optional(),
});
export type ThingActionResponse = z.infer<typeof ThingActionResponse>;

/**
 * A picture on a thing's page (0.121, CT-1000; Whombat service-dashboards.md SD-06, SD-S03): a raw route beside the
 * JSON API (like `ATTACHMENT_TRANSFER`), not an `api` endpoint. `GET` (and HEAD) answers the picture's bytes —
 * `Content-Type` `image/jpeg`, `image/png` or `image/webp` (`THING_IMAGE_TYPES`), at most `THING_IMAGE_MAX_SIDE` pixels
 * on its long side, `Cache-Control: private, max-age=300` (a camera's snapshot `no-store`) — for a signed-in person who
 * may see the thing. Anything wrong (a ref that isn't this thing's, has expired or doesn't verify, a thing they can't
 * see, a picture that can't be fetched) is a 404 that never says why. Over the session: a download of resource
 * `thing-image {burrow, thing, ref}`.
 */
export const THING_IMAGE_TRANSFER = {
  image: {
    id: 'things.image',
    method: 'GET',
    base: API_PREFIX,
    path: '/burrows/:burrow/things/:thing/images/:ref',
    params: B.extend({ thing: ThingParam, ref: ThingImageRef }),
  },
} as const;

/** `/api/v1/burrows/{slug}/things/{thingId, encoded}/images/{ref}`: where a page's `ThingImage` is loaded from. */
export function thingImagePath(burrow: string, thing: string, ref: string): string {
  const t = THING_IMAGE_TRANSFER.image;
  const params: Record<string, string> = { burrow, thing, ref };
  return `${t.base}${t.path.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => encodeURIComponent(params[name] ?? ''))}`;
}

/* Quiet notices (0.122, CT-1063; Whombat quiet-notices.md QN-10…QN-15) ------------------------------------------- */

/** Ignore (until it changes), Remind me tomorrow, or take either back (Undo). */
export const QUIET_HOWS = ['ignore', 'snooze', 'undo'] as const;
export const QuietHow = z.enum(QUIET_HOWS);
export type QuietHow = z.infer<typeof QuietHow>;

/**
 * Quiet a Worth a look line of a thing (`things.quiet`), or take that back. `notice` as the line names it (`check`,
 * `subject.id`). `snooze` lasts until `until`, or without one until `QUIET_SNOOZE_HOUR` (09:00) tomorrow in the
 * Whombat's time zone; `until` is only for a snooze. `undo` takes back an ignore or a snooze. Shared for the whole
 * Whombat (QN-14) and recorded in the thing's Activity (QN-17).
 */
export const QuietNoticeBody = z
  .object({ notice: NoticeRef, how: QuietHow, until: Timestamp.optional() })
  .refine((b) => b.until === undefined || b.how === 'snooze', {
    message: 'Only a snooze takes a time',
    path: ['until'],
  });
export type QuietNoticeBody = z.infer<typeof QuietNoticeBody>;
/** The line and how it is quiet now; `quiet` null after `undo`. */
export const QuietNoticeResponse = z.object({ notice: NoticeRef, quiet: NoticeQuiet.nullable() });
export type QuietNoticeResponse = z.infer<typeof QuietNoticeResponse>;

/**
 * Switch a check off or on again (`things.setWatch`, QN-13): for one item (`subject`, with its name, so the exception
 * still reads “Attic AP” once the item has gone) or for the whole thing. Kept until undone; recorded in the thing's
 * Activity.
 */
export const SetThingWatchBody = z.object({
  check: NoticeCheck,
  subject: NoticeSubject.optional(),
  watched: z.boolean(),
});
export type SetThingWatchBody = z.infer<typeof SetThingWatchBody>;

export const SetThingWatchLimitBody = z.object({
  check: NoticeCheck,
  subject: NoticeSubject.optional(),
  /** Null restores the server's limit for one item, or the check's default for a whole server. */
  limit: WatchLimitValue.nullable(),
});
export type SetThingWatchLimitBody = z.infer<typeof SetThingWatchLimitBody>;

export const SetThingWatchLimitResponse = z.object({
  watch: ThingWatch,
  changeId: ChangeId.optional(),
});
export type SetThingWatchLimitResponse = z.infer<typeof SetThingWatchLimitResponse>;
/**
 * Keep a server, connection or device quiet (`things.keepQuiet`): until `until`, or for
 * `minutes`, with an optional `note` (“Moving the NAS”). A thing kept quiet already gets the new end and note. Session
 * minor 9.
 */
export const KeepQuietBody = z
  .object({
    until: Timestamp.optional(),
    minutes: z.number().int().min(KEEP_QUIET_MIN_MINUTES).max(KEEP_QUIET_MAX_MINUTES).optional(),
    note: z.string().trim().min(1).max(120).optional(),
  })
  .refine((b) => (b.until === undefined) !== (b.minutes === undefined), {
    message: 'Say until when, or for how long',
    path: ['until'],
  });
export type KeepQuietBody = z.infer<typeof KeepQuietBody>;
/**
 * The thing as it is kept quiet now; null after `things.endQuiet`. `changeId` (from `things.keepQuiet`): the change it
 * made, whose `changes.undo` puts the person's window back as it was, or ends the one it made; it never ends Whombat's
 * own window for its work.
 */
export const KeepQuietResponse = z.object({
  keptQuiet: KeptQuiet.nullable(),
  changeId: ChangeId.optional(),
});
export type KeepQuietResponse = z.infer<typeof KeepQuietResponse>;

export const thingEndpoints = {
  cancelWatch: endpoint({
    id: 'things.cancelWatch',
    method: 'POST',
    path: '/burrows/:burrow/thing-watches/:watchId/cancel',
    summary: 'Stop a one-time watch started in Chat.',
    params: z.object({ burrow: BurrowParam, watchId: ThingWatchId }),
    body: z.object({}),
    response: ThingWatchView,
  }),
  page: endpoint({
    id: 'things.page',
    method: 'GET',
    path: '/burrows/:burrow/things/:thing',
    summary:
      'A connection’s or device’s own page: how it runs (figures, charts over `range`, what needs a look, tables), what it runs on, and its actions. Read live, cached briefly. Servers have `hosts.getServer`; clients build their Summary from it with the same panels.',
    params: B.extend({ thing: ThingParam }),
    query: ThingPageQuery,
    response: ThingPage,
  }),
  action: endpoint({
    id: 'things.action',
    method: 'POST',
    path: '/burrows/:burrow/things/:thing/actions',
    summary:
      'Run one of the page’s actions (Restart) or press one of its buttons (0.121: `target`, `value`) for a person who may manage the thing; recorded as a change (everyday switches in the thing’s Activity only). Refused on Look only.',
    params: B.extend({ thing: ThingParam }),
    body: ThingActionBody,
    response: ThingActionResponse,
    status: 202,
  }),
  quiet: endpoint({
    id: 'things.quiet',
    method: 'POST',
    path: '/burrows/:burrow/things/:thing/quiet',
    summary:
      'Ignore a Worth a look line until it changes, snooze it until tomorrow 09:00 (or `until`), or take either back, for the whole Whombat (0.122). `not_allowed` where the thing is look-only, `not_found` for a line it doesn’t have now (`undo`: nothing to take back).',
    params: B.extend({ thing: ThingParam }),
    body: QuietNoticeBody,
    response: QuietNoticeResponse,
  }),
  watch: endpoint({
    id: 'things.watch',
    method: 'GET',
    path: '/burrows/:burrow/things/:thing/watch',
    summary:
      'What Whombat watches on a thing (0.122): every check it can raise in plain words, whether it is on, and what is excepted (switched off, ignored or snoozed for an item), with who and when.',
    params: B.extend({ thing: ThingParam }),
    response: ThingWatch,
  }),
  history: endpoint({
    id: 'things.history',
    method: 'GET',
    path: '/burrows/:burrow/things/:thing/history',
    summary:
      'What happened to a server, connection or device over the last 30 or 90 days (session minor 9): its incidents (down or a problem, when, how long, what and their cause), its uptime over the period, for a server the alerts the hosts service had, and (minor 22) what changed on it.',
    params: B.extend({ thing: ThingParam }),
    query: ThingHistoryQuery,
    response: ThingHistory,
  }),
  exposure: endpoint({
    id: 'things.exposure',
    method: 'GET',
    path: '/burrows/:burrow/exposure',
    summary:
      'Open to the internet (session minor 22): every opening Whombat finds in the settings of what it is connected to (proxy hosts, Cloudflare tunnels, port forwards, Tailscale Funnel), what each leads to, what guards it, what is new and what is worth a look, and which places Whombat read or can’t see. Read from those settings only; nothing is checked from outside the house.',
    params: B,
    response: ExposureView,
  }),
  settingsCopy: endpoint({
    id: 'things.settingsCopy',
    method: 'GET',
    path: '/burrows/:burrow/things/:thing/settings-copy',
    summary:
      'A service’s settings copy for Download (session minor 22): the newest, or the one named by `copy`, as base64 with its file name and type. Larger than a message: clients read it through an export stream. Only the person; `not_found` when there is none.',
    params: B.extend({ thing: ThingParam }),
    query: SettingsCopyQuery,
    response: SettingsCopyFile,
  }),
  setWatch: endpoint({
    id: 'things.setWatch',
    method: 'POST',
    path: '/burrows/:burrow/things/:thing/watch',
    summary:
      'Stop watching a check for one item or the whole thing, or watch it again (0.122). `not_allowed` where the thing is look-only, `not_found` for a check the thing doesn’t have.',
    params: B.extend({ thing: ThingParam }),
    body: SetThingWatchBody,
    response: ThingWatch,
  }),
  setWatchLimit: endpoint({
    id: 'things.setWatchLimit',
    method: 'PUT',
    path: '/burrows/:burrow/things/:thing/watch/limit',
    summary: 'Set or clear a custom alert limit for a server or one item.',
    params: B.extend({ thing: ThingParam }),
    body: SetThingWatchLimitBody,
    response: SetThingWatchLimitResponse,
  }),
  keepQuiet: endpoint({
    id: 'things.keepQuiet',
    method: 'POST',
    path: '/burrows/:burrow/things/:thing/keep-quiet',
    summary:
      'Keep a server, connection or device quiet until a time or for some minutes, with an optional note (session minor 9): its lines colour nothing and make no look, Inbox item, incident or push until then; a server’s alerts are muted in the hosts service too. Signed as the person with Undo. `not_allowed` where the person may not manage the thing.',
    params: B.extend({ thing: ThingParam }),
    body: KeepQuietBody,
    response: KeepQuietResponse,
  }),
  endQuiet: endpoint({
    id: 'things.endQuiet',
    method: 'POST',
    path: '/burrows/:burrow/things/:thing/keep-quiet/end',
    summary:
      'End now: a thing kept quiet is watched again at once, and what is still wrong counts from the start (session minor 9). `not_found` when it isn’t kept quiet.',
    params: B.extend({ thing: ThingParam }),
    response: KeepQuietResponse,
  }),
};

/* Chat, Feedback and task chats ------------------------------------------------------------------- */

export const ChatsListResponse = z.object({ chats: z.array(ChatSummary) });
export type ChatsListResponse = z.infer<typeof ChatsListResponse>;

/**
 * A new thread in the caller's Chat (0.93, CT-444; Whombat chat-channel.md CHT-06; a new task chat before): its first
 * message, and optionally what it is about (stored on that message, `Message.subject`) and what answers in it (0.96,
 * CT-461; chat-runtime.md CR-02: stored as the thread's choice, null when it equals the assistant's own). A runtime
 * without feature `chat.runtime` ignores `runtime`.
 */
export const StartChatBody = z.object({
  text: MessageTextInput,
  subject: ChatSubject.optional(),
  runtime: ChatRuntime.optional(),
  /**
   * With `subject` (3.11; Whombat needs-you-list.md NYL-06): the text goes into the newest thread about that thing, as
   * the caller's reply (which opens it again if it settled), and a new thread starts only when there is none. The
   * answer's `message` is then the reply. An older Whombat ignores it and starts a thread.
   */
  reuseThread: z.boolean().optional(),
});
export type StartChatBody = z.input<typeof StartChatBody>;
/** The Chat and the thread's first message. */
export const StartChatResponse = z.object({ conversation: Conversation, message: Message });
export type StartChatResponse = z.infer<typeof StartChatResponse>;

export const RenameChatBody = z.object({ title: z.string().trim().min(1).max(60) });
export const ChatResponse = z.object({ conversation: Conversation });
export type ChatResponse = z.infer<typeof ChatResponse>;

const ChatParams = B.extend({ conversationId: ConversationId });

/**
 * `chats.threads`' query (0.93, CT-443): the room (Chat unless asked), optionally only threads about one subject, and
 * a page of threads whose `lastAt` is before `before` (the previous page's `next`).
 */
export const ChatThreadsQuery = z.object({
  room: ChatRoom.default('chat'),
  /**
   * 3.8 (chat-settle.md): `open` lists the threads that aren't settled, newest activity first; `settled` the settled
   * ones, the latest settled first, paged by their `settled.at` (`before`, `next`). Absent: every thread, as before.
   */
  state: z.enum(['open', 'settled']).optional(),
  /**
   * 3.20, for apps from before one Chat (Whombat one-chat.md): `chat` lists every thread, `code` none. Absent: every
   * thread.
   */
  place: ThreadPlace.optional(),
  subjectKind: ChatSubject.shape.kind.optional(),
  subjectId: z.string().max(200).optional(),
  before: Timestamp.optional(),
  limit: limitQuery(CHAT_THREADS_LIMIT_DEFAULT, CHAT_THREADS_LIMIT_MAX),
});
export type ChatThreadsQuery = z.input<typeof ChatThreadsQuery>;

/** Newest `lastAt` first; `next` is the `before` of the next page, null on the last. */
export const ChatThreadsResponse = z.object({
  threads: z.array(ChatThread).max(CHAT_THREADS_LIMIT_MAX),
  next: Timestamp.nullable(),
  /** 3.8: how many of the room's threads are settled (“Settled · 14”), on a first page (no `before`) only. */
  settledCount: z.number().int().nonnegative().optional(),
});
export type ChatThreadsResponse = z.infer<typeof ChatThreadsResponse>;

/**
 * `chats.clear` (0.119, CT-990; Whombat chat-clear.md CHC-01…): which of the caller's rooms to clear, Chat unless asked.
 * Its messages leave the room's view; every thread stays in Threads and opens as before.
 */
export const ClearChatBody = z.object({ room: ChatRoom.default('chat') });
export type ClearChatBody = z.input<typeof ClearChatBody>;
/** The room cleared, from when, and how many top-level messages left its view (0 when it was empty already). */
export const ClearChatResponse = z.object({
  room: ChatRoom,
  conversationId: ConversationId,
  clearedAt: Timestamp,
  cleared: z.number().int().nonnegative(),
});
export type ClearChatResponse = z.infer<typeof ClearChatResponse>;

/** `chats.settle` (3.8; Whombat chat-settle.md): settle the thread, or open a settled one again. */
export const SettleThreadBody = z.object({ settled: z.boolean() });
export type SettleThreadBody = z.infer<typeof SettleThreadBody>;
/** The thread as it is now. */
export const SettleThreadResponse = z.object({ thread: ChatThread });
export type SettleThreadResponse = z.infer<typeof SettleThreadResponse>;

/**
 * `chats.settleFinished` (3.8): which of the caller's rooms, Chat unless asked. `onlyRead` (Whombat chat-inbox.md CIB-07):
 * leave open the threads with something the caller hasn't read (“Settle everything read”); absent: every thread.
 */
export const SettleFinishedBody = z.object({
  room: ChatRoom.default('chat'),
  onlyRead: z.boolean().optional(),
});
export type SettleFinishedBody = z.input<typeof SettleFinishedBody>;
/** How many threads settled: every open one the assistant isn't working on and that waits for nobody. */
export const SettleFinishedResponse = z.object({
  room: ChatRoom,
  conversationId: ConversationId,
  settled: z.number().int().nonnegative(),
});
export type SettleFinishedResponse = z.infer<typeof SettleFinishedResponse>;

/**
 * `chats.unread`'s query (Whombat thread-unread.md): which of the caller's rooms, Chat unless asked.
 */
export const ChatUnreadQuery = z.object({
  room: ChatRoom.default('chat'),
  /** 3.20, for apps from before one Chat: `code` has none. Absent: every thread. */
  place: ThreadPlace.optional(),
});
export type ChatUnreadQuery = z.input<typeof ChatUnreadQuery>;

/** Most threads `chats.unread` lists: open threads with something new are few, the newest first. */
export const CHAT_UNREAD_THREADS_MAX = 200;

/**
 * The room's open threads with something the caller hasn't read: a new first message from someone else not yet
 * seen in the room, or replies from someone else since the caller last read the thread. Threads with nothing new and
 * settled threads aren't listed. `conversationId` null: the room doesn't exist yet.
 */
export const ChatUnreadResponse = z.object({
  conversationId: ConversationId.nullable(),
  threads: z.array(z.object({ rootId: MessageId, unread: Count.min(1) })).max(CHAT_UNREAD_THREADS_MAX),
});
export type ChatUnreadResponse = z.infer<typeof ChatUnreadResponse>;

/** `chats.readThread`: the thread is read up to this message (a reply in it, or its first message). */
export const ReadThreadBody = z.object({ messageId: MessageId });
export type ReadThreadBody = z.infer<typeof ReadThreadBody>;
/** What is left unread in the thread, and the room's badge after it: its threads with something new. */
export const ReadThreadResponse = z.object({
  conversationId: ConversationId,
  rootId: MessageId,
  unread: Count,
  roomUnread: Count,
});
export type ReadThreadResponse = z.infer<typeof ReadThreadResponse>;

/**
 * `chats.place` (3.20), for apps from before one Chat (Whombat one-chat.md): moved nowhere, the thread is answered as it
 * is. Goes with the next major.
 */
export const PlaceThreadBody = z.object({ place: ThreadPlace, seen: z.boolean().optional() });
export type PlaceThreadBody = z.infer<typeof PlaceThreadBody>;
/** The thread as it is now. */
export const PlaceThreadResponse = z.object({ thread: ChatThread });
export type PlaceThreadResponse = z.infer<typeof PlaceThreadResponse>;

/** `chats.runtime`'s query (0.96, CT-461): a thread of the caller's Chat (its first message) whose choice to add. */
export const ChatRuntimeQuery = z.object({ thread: MessageId.optional() });
export type ChatRuntimeQuery = z.infer<typeof ChatRuntimeQuery>;

/** A Chat thread's choice (0.96, CT-461; CR-02); null: the thread follows the agent's own runtime again. */
export const SetChatThreadRuntimeBody = z.object({ runtime: ChatRuntime.nullable() });
export type SetChatThreadRuntimeBody = z.infer<typeof SetChatThreadRuntimeBody>;
/** The thread's choice as stored: null when it follows the agent's own (a choice equal to it is stored as null). */
export const ChatThreadRuntimeResponse = z.object({ thread: ChatRuntime.nullable() });
export type ChatThreadRuntimeResponse = z.infer<typeof ChatThreadRuntimeResponse>;

export const chatEndpoints = {
  list: endpoint({
    id: 'chats.list',
    method: 'GET',
    path: '/burrows/:burrow/chats',
    summary:
      'The caller’s rooms with their Whombat: the Chat and, once it exists, the Feedback room; archived task chats with `archived` (0.93; task chats before).',
    params: B,
    query: z.object({
      archived: QueryBool.optional(),
      subjectKind: z.enum(['server', 'connection', 'device']).optional(),
      subjectId: z.string().max(200).optional(),
    }),
    response: ChatsListResponse,
  }),
  threads: endpoint({
    id: 'chats.threads',
    method: 'GET',
    path: '/burrows/:burrow/chats/threads',
    summary:
      'The threads of the caller’s Chat or Feedback room, newest activity first, optionally only those about one server, connection or device; paged by `before`.',
    params: B,
    query: ChatThreadsQuery,
    response: ChatThreadsResponse,
  }),
  start: endpoint({
    id: 'chats.start',
    method: 'POST',
    path: '/burrows/:burrow/chats',
    summary:
      'Start a thread in the caller’s Chat: the text is sent as a top-level message, with the subject on it, and wakes the agent (0.93; a task chat before).',
    params: B,
    body: StartChatBody,
    response: StartChatResponse,
    status: 201,
  }),
  clear: endpoint({
    id: 'chats.clear',
    method: 'POST',
    path: '/burrows/:burrow/chats/clear',
    summary:
      'Clear the caller’s Chat or Feedback room: its messages leave the room and the agent starts the next thread fresh, while every thread stays in Threads (0.119; feature `chat.clear`).',
    params: B,
    body: ClearChatBody,
    response: ClearChatResponse,
  }),
  settle: endpoint({
    id: 'chats.settle',
    method: 'PUT',
    path: '/burrows/:burrow/chats/threads/:rootId/settled',
    summary:
      'Settle a thread of the caller’s Chat or Feedback room, or open a settled one again (3.8). Refused while the agent works on it or something in it waits for the caller.',
    params: B.extend({ rootId: MessageId }),
    body: SettleThreadBody,
    response: SettleThreadResponse,
  }),
  settleFinished: endpoint({
    id: 'chats.settleFinished',
    method: 'POST',
    path: '/burrows/:burrow/chats/settle',
    summary:
      'Settle every open thread of the caller’s Chat or Feedback room that the agent isn’t working on and that waits for nobody (3.8).',
    params: B,
    body: SettleFinishedBody,
    response: SettleFinishedResponse,
  }),
  unread: endpoint({
    id: 'chats.unread',
    method: 'GET',
    path: '/burrows/:burrow/chats/unread',
    summary:
      'Which open threads of the caller’s Chat or Feedback room have something they haven’t read, and how much.',
    params: B,
    query: ChatUnreadQuery,
    response: ChatUnreadResponse,
  }),
  readThread: endpoint({
    id: 'chats.readThread',
    method: 'POST',
    path: '/burrows/:burrow/chats/threads/:rootId/read',
    summary: 'Mark a thread of the caller’s Chat or Feedback room read up to a message; never moves back.',
    params: B.extend({ rootId: MessageId }),
    body: ReadThreadBody,
    response: ReadThreadResponse,
  }),
  markUnread: endpoint({
    id: 'chats.markUnread',
    method: 'POST',
    path: '/burrows/:burrow/chats/threads/:rootId/unread',
    summary:
      'Mark a thread of the caller’s Chat or Feedback room as unread: its newest message from someone else counts as new again (Whombat chat-inbox.md).',
    params: B.extend({ rootId: MessageId }),
    response: ReadThreadResponse,
  }),
  place: endpoint({
    id: 'chats.place',
    method: 'PUT',
    path: '/burrows/:burrow/chats/threads/:rootId/place',
    summary:
      'For apps from before one Chat: answers the thread as it is, every thread being Chat’s (3.20; Whombat one-chat.md).',
    params: B.extend({ rootId: MessageId }),
    body: PlaceThreadBody,
    response: PlaceThreadResponse,
  }),
  runtime: endpoint({
    id: 'chats.runtime',
    method: 'GET',
    path: '/burrows/:burrow/chats/runtime',
    summary:
      'What answers in the caller’s Chat: the agent’s own provider, model, effort and fast replies, a thread’s choice with `thread`, and each provider’s models, readiness and usage (0.96).',
    params: B,
    query: ChatRuntimeQuery,
    response: ChatRuntimeView,
  }),
  setThreadRuntime: endpoint({
    id: 'chats.setThreadRuntime',
    method: 'PUT',
    path: '/burrows/:burrow/chats/threads/:rootId/runtime',
    summary:
      'Choose what answers in a thread of the caller’s Chat, from its next turn; null follows the agent’s own again (0.96).',
    params: B.extend({ rootId: MessageId }),
    body: SetChatThreadRuntimeBody,
    response: ChatThreadRuntimeResponse,
  }),
  rename: endpoint({
    id: 'chats.rename',
    method: 'PATCH',
    path: '/burrows/:burrow/chats/:conversationId',
    summary: 'Rename a task chat (its person).',
    params: ChatParams,
    body: RenameChatBody,
    response: ChatResponse,
  }),
  archive: endpoint({
    id: 'chats.archive',
    method: 'POST',
    path: '/burrows/:burrow/chats/:conversationId/archive',
    summary: 'Archive a task chat (never the default chat); it leaves the list and stays readable.',
    params: ChatParams,
    response: ChatResponse,
  }),
  unarchive: endpoint({
    id: 'chats.unarchive',
    method: 'POST',
    path: '/burrows/:burrow/chats/:conversationId/unarchive',
    summary: 'Bring an archived task chat back to the list (0.80.1, CT-349).',
    params: ChatParams,
    response: ChatResponse,
  }),
};

/* Device skills ----------------------------------------------------------------------------------- */

/** The owner's choice on a `device_skill` card: each action's tier and limits, and whether to switch it on now. */
export const DecideDeviceSkillBody = z.object({
  actions: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), DeviceActionChoice),
  switchOn: z.boolean(),
});
export type DecideDeviceSkillBody = z.infer<typeof DecideDeviceSkillBody>;

export const DeviceSkillResponse = z.object({ card: DeviceSkillCard, connectionId: ConnectionId.nullable() });
export type DeviceSkillResponse = z.infer<typeof DeviceSkillResponse>;

const DeviceSkillParams = B.extend({ proposalId: DeviceSkillProposalId });

export const deviceSkillEndpoints = {
  decide: endpoint({
    id: 'deviceSkills.decide',
    method: 'POST',
    path: '/burrows/:burrow/device-skills/:proposalId/decide',
    summary:
      'Choose each action’s tier and limits and, with switchOn, make the device connection live.nothing changes on the device before.',
    params: DeviceSkillParams,
    body: DecideDeviceSkillBody,
    response: DeviceSkillResponse,
  }),
  decline: endpoint({
    id: 'deviceSkills.decline',
    method: 'POST',
    path: '/burrows/:burrow/device-skills/:proposalId/decline',
    summary: 'Not now: the proposal is declined and nothing is made.',
    params: DeviceSkillParams,
    response: DeviceSkillResponse,
  }),
};
