/**
 * The one-Whombat shell's reads and writes (contracts 0.80, CT-336…CT-340; app one-whombat-shell.md): Home, Watch, Done
 * recently and Undo, pinned widgets, task chats and the device skill decision. Every write is a `CommitResult`; the
 * hooks put the server's answer (or, for a snooze, the expected one) in the cache at once, so Home, the sidebar and the
 * chat agree without waiting for `home.changed`.
 */
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ChangeEntry,
  ChatRuntime,
  ChatSubject,
  ChatSummary,
  Conversation,
  DeviceActionChoice,
  DeviceSkillCard,
  HomeOverview,
  HomeRef,
  Message,
  NeedsYouWatch,
  Widget,
} from '@whombat/core';
import {
  api,
  type ConnectionsListResponse,
  type SetRunsOnBody,
  type ThingActionBody,
} from '@whombat/core/contracts';
import { useMemo } from 'react';
import { type UndoRequests, withChange } from '../home/changes';
import { withNeedsYouListItem } from '../home/needsYouList';
import { type ThingHeadPreview, thingHeadFromConnections, thingHeadFromThings } from '../home/thingPage';
import type { CommitResult } from '../http/types';
import { patchMessages, upsertMessageEverywhere } from '../query/apply';
import { patchEndpoint } from '../query/cache';
import { queryKeys } from '../query/keys';
import { useWhombat } from './context';
import { queryHook } from './queries';

/** Home for the viewer (`home.overview`): the sidebar's things and Watch count read it too. */
export const useHomeOverview = queryHook(api.home.overview);
/** Everything Whombat changed, newest first (`changes.list`, paged by `before`). */
export const useChanges = queryHook(api.changes.list);
/** The viewer's pinned widgets (`widgets.list`). */
export const useWidgets = queryHook(api.widgets.list);
/** The viewer's chats with their Whombat (`chats.list`). */
export const useChats = queryHook(api.chats.list);
/** A connection's or device's own page (`things.page`, contracts 0.88; connection-pages.md CP-01). */
export const useThingPage = queryHook(api.things.page);

/* Thing pages ------------------------------------------------------------------------------------- */

/**
 * A thing page's head before `things.page` answers (app page-speed.md AP-2650, AP-2651), from what the app already
 * holds and without asking: Home's things (the web's sidebar and Connections, the phone's Connections tab read them),
 * else `connections.list` (Settings → Connections, an agent's LOOKS AFTER). Null when neither has it (a link opened
 * from elsewhere first): the page draws as before.
 */
export function cachedThingHead(qc: QueryClient, burrow: string, thingId: string): ThingHeadPreview | null {
  for (const [, home] of qc.getQueriesData<HomeOverview>({
    queryKey: queryKeys.scope('home.overview', { burrow }),
  })) {
    const head = home ? thingHeadFromThings(home.things, thingId) : null;
    if (head) return head;
  }
  for (const [, list] of qc.getQueriesData<ConnectionsListResponse>({
    queryKey: queryKeys.scope('connections.list', { burrow }),
  })) {
    const head = list ? thingHeadFromConnections(list.connections, thingId) : null;
    if (head) return head;
  }
  return null;
}

/** `cachedThingHead` as a thing page opens: read once per thing, the page's own answer takes over. */
export function useCachedThingHead(burrow: string, thingId: string): ThingHeadPreview | null {
  const qc = useQueryClient();
  return useMemo(() => cachedThingHead(qc, burrow, thingId), [qc, burrow, thingId]);
}

/**
 * Run one of a thing page's actions (Restart) after the person confirmed it (`things.action`): its id, or the whole body
 * a button sends (contracts 0.121, CT-1006: `{action, target, value}`; `useThingButtons` presses those). The page is
 * read again once it answers, and so are Home and Done recently, where the change shows.
 */
export function useThingAction(burrow: string, thing: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: string | ThingActionBody) =>
      client.request(api.things.action, {
        params: { burrow, thing },
        body: typeof action === 'string' ? { action } : action,
      }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.scope('things.page') });
      void qc.invalidateQueries({ queryKey: queryKeys.scope('changes.list') });
      void qc.invalidateQueries({ queryKey: queryKeys.scope('home.overview') });
    },
  });
}

/** Say what a connection runs on, or let Whombat find it (`connections.setRunsOn`); its page is read again. */
export function useSetRunsOn(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ connectionId, body }: { connectionId: string; body: SetRunsOnBody }) =>
      client.request(api.connections.setRunsOn, {
        params: { burrow, connectionId: connectionId as never },
        body,
      }),
    onSuccess: (result) => {
      if (result.status === 'ok') void qc.invalidateQueries({ queryKey: queryKeys.scope('things.page') });
    },
  });
}

/* Needs you --------------------------------------------------------------------------------------- */

/**
 * Snooze an Inbox item (“Remind me tomorrow”): it moves to Later at once (and leaves an older Whombat's
 * Needs you), back on a refusal.
 */
export function useSnoozeNeedsYou(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<CommitResult<unknown>, Error, { ref: HomeRef; until: string }, { snapshot: Snapshot }>({
    onMutate: ({ ref, until }) => {
      const snapshot = takeSnapshot(qc, 'home.overview');
      patchEndpoint<HomeOverview>(qc, 'home.overview', (d) => withNeedsYouListItem(d, ref, 'snoozed', until));
      return { snapshot };
    },
    mutationFn: ({ ref, until }) =>
      client.request(api.needsYou.snooze, { params: { burrow }, body: { ref, until } }),
    onSuccess: (result, _v, ctx) => {
      if (result.status !== 'ok' && ctx) restoreSnapshot(qc, ctx.snapshot);
    },
    onError: (_e, _v, ctx) => {
      if (ctx) restoreSnapshot(qc, ctx.snapshot);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.scope('watch.list') });
      void qc.invalidateQueries({ queryKey: queryKeys.scope('home.overview') });
    },
  });
}

/**
 * Settle an Inbox item (`needsYou.ignore`, contracts 0.80.3: a line until it happens again, anything else for good), or
 * take that back (`ignored: false`, the toast's Undo). It moves to Settled at once, back on a refusal; taking it back
 * asks Home again.
 */
export function useIgnoreNeedsYou(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<
    CommitResult<unknown>,
    Error,
    { ref: HomeRef; ignored: boolean },
    { snapshot: Snapshot | null }
  >({
    onMutate: ({ ref, ignored }) => {
      if (!ignored) return { snapshot: null };
      const snapshot = takeSnapshot(qc, 'home.overview');
      patchEndpoint<HomeOverview>(qc, 'home.overview', (d) => withNeedsYouListItem(d, ref, 'quiet'));
      return { snapshot };
    },
    mutationFn: ({ ref, ignored }) =>
      client.request(api.needsYou.ignore, { params: { burrow }, body: { ref, ignored } }),
    onSuccess: (result, _v, ctx) => {
      if (result.status !== 'ok' && ctx?.snapshot) restoreSnapshot(qc, ctx.snapshot);
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.snapshot) restoreSnapshot(qc, ctx.snapshot);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.scope('watch.list') });
      void qc.invalidateQueries({ queryKey: queryKeys.scope('home.overview') });
    },
  });
}

/**
 * Bring a snoozed or ignored Watch item back (`watch.acknowledge` with `acknowledged: false`): the person's own snooze
 * and the shared Ignore of the line behind it; Watch and Home are read again.
 */
/**
 * Needs you's *Stop watching this* (on-purpose.md): the check behind the row switched off (`things.setWatch`), the row
 * gone at once; `watched: true` is its Undo. A refusal puts the row back.
 */
export function useStopWatchingNeedsYou(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<
    CommitResult<unknown>,
    Error,
    { ref: HomeRef; watch: NeedsYouWatch; watched: boolean },
    { snapshot: Snapshot | null }
  >({
    onMutate: ({ ref, watched }) => {
      if (watched) return { snapshot: null };
      const snapshot = takeSnapshot(qc, 'home.overview');
      patchEndpoint<HomeOverview>(qc, 'home.overview', (d) => withNeedsYouListItem(d, ref, 'gone'));
      return { snapshot };
    },
    mutationFn: ({ watch, watched }) =>
      client.request(api.things.setWatch, {
        params: { burrow, thing: watch.thing },
        body: { check: watch.check, ...(watch.subject ? { subject: watch.subject } : {}), watched },
      }),
    onSuccess: (result, _v, ctx) => {
      if (result.status !== 'ok' && ctx?.snapshot) restoreSnapshot(qc, ctx.snapshot);
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.snapshot) restoreSnapshot(qc, ctx.snapshot);
    },
    onSettled: (_r, _e, { watch }) => {
      void qc.invalidateQueries({ queryKey: queryKeys.scope('home.overview') });
      void qc.invalidateQueries({ queryKey: queryKeys.scope('watch.list') });
      void qc.invalidateQueries({
        queryKey: queryKeys.scope('things.watch', { burrow, thing: watch.thing }),
      });
      void qc.invalidateQueries({ queryKey: queryKeys.scope('things.page', { burrow, thing: watch.thing }) });
    },
  });
}

export function useBringBackWatch(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<CommitResult<unknown>, Error, { ref: HomeRef }>({
    mutationFn: ({ ref }) =>
      client.request(api.watch.acknowledge, { params: { burrow }, body: { ref, acknowledged: false } }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.scope('watch.list') });
      void qc.invalidateQueries({ queryKey: queryKeys.scope('home.overview') });
    },
  });
}

/* Done recently ----------------------------------------------------------------------------------- */

/** Put a change's new state wherever it shows (Home's Done recently, the changes list). */
export function applyChange(qc: QueryClient, change: ChangeEntry): void {
  patchEndpoint<HomeOverview>(qc, 'home.overview', (d) =>
    d.doneRecently.some((c) => c.id === change.id)
      ? { ...d, doneRecently: withChange(d.doneRecently, change) }
      : d,
  );
  patchEndpoint<{ changes: ChangeEntry[] }>(qc, 'changes.list', (d) =>
    d.changes.some((c) => c.id === change.id) ? { ...d, changes: withChange(d.changes, change) } : d,
  );
}

/** Undo a change: its inverse runs as a new call through the pipeline (ONE-08); `asked` waits for an approval. */
export function useUndoChange(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (changeId: string) =>
      client.request(api.changes.undo, { params: { burrow, changeId: changeId as never } }),
    onSuccess: (result, changeId) => {
      if (result.status !== 'ok') return;
      applyChange(qc, result.data.change);
      // A change an agent reported (contracts 0.91 `requested`, CT-406): the agent was asked; its row says so.
      if (result.data.state === 'requested')
        qc.setQueryData<UndoRequests>(undoRequestsKey(burrow), (old) => ({
          ...old,
          [changeId]: { conversationId: result.data.conversationId ?? null, at: Date.now() },
        }));
    },
  });
}

/** Where the viewer's Undo requests are kept: in the query cache (one per session), outside the API's keys. */
const undoRequestsKey = (burrow: string) => ['whombat-local', 'undoRequests', burrow] as const;

/**
 * The Undo requests this session made in `burrow` (app home-redesign.md AP-2217), for `doneRows`: the server's change
 * doesn't say it was asked for, so the row's “Asked Neo to undo this” comes from here until it is undone or the
 * request's 10 minutes are over.
 */
export function useUndoRequests(burrow: string): UndoRequests {
  const qc = useQueryClient();
  const key = undoRequestsKey(burrow);
  const { data } = useQuery({
    queryKey: key,
    // Never read from anywhere: a refetch (an invalidation of everything) keeps what is there.
    queryFn: () => qc.getQueryData<UndoRequests>(key) ?? {},
    initialData: {},
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
  return data;
}

/* Widgets ----------------------------------------------------------------------------------------- */

/**
 * The viewer's widgets of one place everywhere they show (contracts 0.88, CT-392; connection-pages.md CP-14): Home's
 * (`thing` null) in Home's widgets list and on Home, a thing page's (`thing` its thingId) in that page's list only.
 * `widgets.remove` and `widgets.move` answer the list of the place the widget is kept.
 */
export function applyWidgets(qc: QueryClient, widgets: Widget[], thing: string | null = null): void {
  patchEndpoint<{ widgets: Widget[] }>(qc, 'widgets.list', (d, key) =>
    ((key.query?.thing as string | undefined) ?? null) === thing ? { ...d, widgets } : d,
  );
  if (thing === null) patchEndpoint<HomeOverview>(qc, 'home.overview', (d) => ({ ...d, widgets }));
}

/** Unpin a widget; `thing` is the page it is kept on (null: Home). */
export function useRemoveWidget(burrow: string, thing: string | null = null) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (widgetId: string) =>
      client.request(api.widgets.remove, { params: { burrow, widgetId: widgetId as never } }),
    onSuccess: (result) => {
      if (result.status === 'ok') applyWidgets(qc, result.data.widgets, thing);
    },
  });
}

/** Move a widget among those of its place; `thing` is the page it is kept on (null: Home). */
export function useMoveWidget(burrow: string, thing: string | null = null) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ widgetId, position }: { widgetId: string; position: number }) =>
      client.request(api.widgets.move, {
        params: { burrow, widgetId: widgetId as never },
        body: { position },
      }),
    onSuccess: (result) => {
      if (result.status === 'ok') applyWidgets(qc, result.data.widgets, thing);
    },
  });
}

/* Task chats -------------------------------------------------------------------------------------- */

/** A chat's row from its conversation and first message (what `chats.list` would answer). */
export function chatSummaryOf(
  conversation: Conversation,
  message: Pick<Message, 'text' | 'createdAt'> | null,
): ChatSummary {
  return {
    id: conversation.id,
    title: conversation.chat?.title ?? conversation.title,
    subject: conversation.chat?.subject ?? null,
    lastAt: message?.createdAt ?? conversation.lastMessageAt,
    ...(message ? { lastText: message.text.slice(0, 200) } : {}),
    unread: 0,
    default: !conversation.chat,
    archivedAt: conversation.chat?.archivedAt ?? null,
  };
}

/**
 * Start a chat with the viewer's Whombat (“Look into it”, a thing page's Ask, the Ask box): its row shows at once. With the
 * Chat shell (contracts 0.93, CT-444; app chat-channel.md AP-2406) the answer is the Chat and the new thread's first
 * message, which joins the cached Threads lists at once (`upsertMessageEverywhere`); open it with `startedChatPath`.
 */
export function useStartChat(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      text,
      subject,
      runtime,
      reuseThread,
    }: {
      text: string;
      subject?: ChatSubject | null;
      /** What answers in the new thread (contracts 0.96, CT-461; chat-runtime.md CR-02): `chatStartRuntime`. */
      runtime?: ChatRuntime | null;
      /** Into the newest thread about `subject` when there is one (Whombat needs-you-list.md NYL-06). */
      reuseThread?: boolean;
    }) =>
      client.request(api.chats.start, {
        params: { burrow },
        body: {
          text,
          ...(subject ? { subject } : {}),
          ...(runtime ? { runtime } : {}),
          ...(subject && reuseThread ? { reuseThread: true } : {}),
        },
      }),
    onSuccess: (result) => {
      if (result.status !== 'ok') return;
      const { conversation, message } = result.data;
      patchEndpoint<{ chats: ChatSummary[] }>(qc, 'chats.list', (d, key) =>
        key.query.archived || d.chats.some((c) => c.id === conversation.id)
          ? d
          : { ...d, chats: [chatSummaryOf(conversation, message), ...d.chats] },
      );
      upsertMessageEverywhere(qc, message);
      void qc.invalidateQueries({ queryKey: queryKeys.scope('chats.list') });
    },
  });
}

/**
 * *Talk to {assistant} about it* (`needsYou.discuss`, Whombat inbox.md IBX-07): a new thread the assistant opens with
 * the Inbox item's words; it joins the cached Threads lists at once. Open it with `startedChatPath`.
 */
export function useDiscussNeedsYou(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ref }: { ref: HomeRef }) =>
      client.request(api.needsYou.discuss, { params: { burrow }, body: { ref } }),
    onSuccess: (result) => {
      if (result.status !== 'ok') return;
      const { conversation, message } = result.data;
      patchEndpoint<{ chats: ChatSummary[] }>(qc, 'chats.list', (d, key) =>
        key.query.archived || d.chats.some((c) => c.id === conversation.id)
          ? d
          : { ...d, chats: [chatSummaryOf(conversation, message), ...d.chats] },
      );
      upsertMessageEverywhere(qc, message);
      void qc.invalidateQueries({ queryKey: queryKeys.scope('chats.list') });
    },
  });
}

/* Device skills ----------------------------------------------------------------------------------- */

/** Put a device skill card's new state on the message that carries it (every cached list, thread and message). */
export function applyDeviceSkillCard(qc: QueryClient, card: DeviceSkillCard): void {
  patchMessages({ qc }, (m) =>
    m.card?.kind === 'device_skill' && m.card.proposalId === card.proposalId ? { ...m, card } : m,
  );
  void qc.invalidateQueries({ queryKey: queryKeys.scope('home.overview') });
}

/** Switch a device skill on (or keep the choices without switching on), as the person chose on the card. */
export function useDecideDeviceSkill(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      proposalId,
      actions,
      switchOn,
    }: {
      proposalId: string;
      actions: Record<string, DeviceActionChoice>;
      switchOn: boolean;
    }) =>
      client.request(api.deviceSkills.decide, {
        params: { burrow, proposalId: proposalId as never },
        body: { actions, switchOn },
      }),
    onSuccess: (result) => {
      if (result.status === 'ok') applyDeviceSkillCard(qc, result.data.card);
    },
  });
}

/** “Not now” on a device skill card: declined, nothing is made. */
export function useDeclineDeviceSkill(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (proposalId: string) =>
      client.request(api.deviceSkills.decline, { params: { burrow, proposalId: proposalId as never } }),
    onSuccess: (result) => {
      if (result.status === 'ok') applyDeviceSkillCard(qc, result.data.card);
    },
  });
}

/* Snapshots --------------------------------------------------------------------------------------- */

type Snapshot = [readonly unknown[], unknown][];

function takeSnapshot(qc: QueryClient, endpointId: string): Snapshot {
  return qc.getQueriesData({ queryKey: queryKeys.scope(endpointId) });
}

function restoreSnapshot(qc: QueryClient, snapshot: Snapshot): void {
  for (const [key, data] of snapshot) qc.setQueryData(key, data);
}
