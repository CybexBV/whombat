import { Outlet, useRouterState } from '@tanstack/react-router';
import { chatRoomsOf, needsYouBadge, needsYouStatusLevel, needsYouWorst } from '@whombat/client';
import { useHostsStatus } from '@whombat/client/hosts/status';
import { whombatPart } from '@whombat/client/managed';
import { useBootstrap, useChats, useHomeOverview, useTheAgent } from '@whombat/client/react';
import { topics } from '@whombat/core/contracts';
import { lazy, Suspense, useCallback, useMemo } from 'react';
import { useInboxSplit } from '../../features/chats/inboxNav';
import { DeskUnlockNotice } from '../../features/desk/DeskUnlock';
import { MessageFilesProvider } from '../../features/messaging/messageFiles';
import { LinkBanner } from '../../managed/LinkBanner';
import { MovedBanner } from '../../managed/MovedBanner';
import { PasskeyNotices } from '../../managed/PasskeyNotices';
import { useOpenBurrow } from '../routing/openBurrow';
import { AgentsBlockedNotice } from './AgentsBlockedNotice';
import { AssistantSidebar } from './AssistantSidebar';
import { assistantConversationPaths, buildAssistantSidebarModel } from './assistantSidebarModel';
import { DemoNotice } from './DemoNotice';
import {
  useBurrowRealtime,
  useNeedsYouToast,
  useServiceWorkerRegistration,
  useShellKeyboard,
  useShellThemeSync,
  useSignOut,
} from './hooks';
import { ModalHost, PaneHost } from './hosts';
import { parseShellLocation } from './location';
import { NeedsYouBarLink } from './NeedsYouBarLink';
import { ShellError, ShellLayout, ShellPending } from './ShellLayout';
import { modalFor, paneFor } from './shellState';
import { useThreadOrigin } from './threadOrigin';
import { useUnreadIndicator } from './useUnreadIndicator';

/** The servers' task tracker (PX-05): outcome toasts and the task dialog, wherever the person goes meanwhile. */
const HostTasks = lazy(() =>
  import('../../features/things/tasks/HostTasks').then((m) => ({ default: m.HostTasks })),
);

/**
 * Layout of every burrow route: sidebar (live from the bootstrap + realtime), the screen, the
 * right pane and the modals, plus the burrow's socket, the per-user theme and global shortcuts.
 */
export function BurrowShell() {
  const burrow = useOpenBurrow();
  const {
    data: bootstrap,
    error: bootstrapError,
    refetch: refetchBootstrap,
  } = useBootstrap({
    params: { burrow },
  });
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const href = useRouterState({ select: (s) => s.location.href });
  const search = useRouterState({ select: (s) => s.location.search });

  const location = useMemo(
    () => parseShellLocation(pathname, search as Record<string, unknown>),
    [pathname, search],
  );
  const pane = paneFor(location, search as Record<string, unknown>);
  // This Whombat's Overview shows the desk's unlock request as a NEEDS YOU row; the notice steps aside there (AP-3008).
  const onWhombatOverview =
    location.kind === 'settings' &&
    (search as Record<string, unknown>).tab === 'appliance' &&
    whombatPart((search as Record<string, unknown>).section) === 'overview';
  const modal = modalFor(search as Record<string, unknown>);
  // The sidebar's reads (AP-1256): your things and the one Needs you count from Home, the chats.
  const { data: home } = useHomeOverview({ params: { burrow } }, { retry: false });
  const things = home?.things;
  const needs = needsYouBadge(home);
  // The badge's colour (Whombat sidebar.md SB-02): the worst item's that needs the person.
  const worst = home ? needsYouWorst(home) : null;
  // The top bar's count turns red only when something that needs the person isn't working.
  const broken = useMemo(
    () =>
      (home?.needsYou ?? []).some(
        (i) => (i.group ?? 'you') === 'you' && needsYouStatusLevel(i) === 'notWorking',
      ),
    [home?.needsYou],
  );
  const { data: chats } = useChats({ params: { burrow }, query: {} }, { retry: false });
  // Chat (chat-channel.md AP-2401): Chat and Feedback lead the sidebar, with their unread counts.
  const rooms = useMemo(() => chatRoomsOf(chats?.chats), [chats?.chats]);
  // SERVERS' heading and its `+` (sidebar-servers.md AP-1748): whether the hosts service runs here.
  const { data: hostsStatus } = useHostsStatus({ params: { burrow } }, { retry: false });
  const hosts = useMemo(() => (hostsStatus ? { present: hostsStatus.present } : undefined), [hostsStatus]);
  // The model follows the parts of the bootstrap it reads, so the sidebar isn't drawn again on every bootstrap change
  // (an unread count elsewhere, presence).
  const burrowInfo = bootstrap?.burrow;
  const me = bootstrap?.me;
  const principals = bootstrap?.principals;
  const model = useMemo(
    () =>
      burrowInfo && me
        ? buildAssistantSidebarModel(
            { burrow: burrowInfo, me, principals },
            {
              location,
              things,
              chats: chats?.chats,
              // What needs the person: the one count (needs-you-list.md NYL-04).
              needsYou: needs,
              needsYouWorst: worst,
              needsYouBroken: broken,
              hosts,
              rooms,
            },
          )
        : null,
    [burrowInfo, me, principals, location, things, needs, worst, broken, chats?.chats, hosts, rooms],
  );
  const paths = useMemo(() => (model ? assistantConversationPaths(model) : []), [model]);

  // The shell also listens to the burrow's servers (Whombat ONE-DW30, AP-1275): `hosts.alert`, `hosts.enrollment` and
  // `hosts.resync` refetch Home's Needs you and Watch (the Servers card and pages follow `hosts.server` themselves).
  const realtimeTopics = useMemo(
    () => (bootstrap ? [...bootstrap.realtime.topics, topics.hosts(bootstrap.burrow.id)] : undefined),
    [bootstrap],
  );
  useBurrowRealtime(burrow, realtimeTopics);
  useShellThemeSync(burrow, bootstrap?.preferences.theme);
  // Where a room's thread was opened from: its back link and Escape go back there.
  const { words } = useTheAgent(burrow);
  const thingName = useCallback((id: string) => things?.find((t) => t.id === id)?.name ?? null, [things]);
  const origin = useThreadOrigin(
    href,
    pathname,
    pane?.kind === 'thread' && pane.room ? pane.threadId : null,
    useMemo(() => ({ thing: thingName, assistant: words.name }), [thingName, words.name]),
  );
  useShellKeyboard({ burrow, location, href, pathname, pane, modal, conversationPaths: paths, origin });
  // On a wide screen Chat's and Feedback's thread sits beside their list instead of over it.
  const split = useInboxSplit();
  const beside = split && pane?.kind === 'thread' && !!pane.room;
  useServiceWorkerRegistration();
  useNeedsYouToast(bootstrap?.me.id);
  useUnreadIndicator(bootstrap?.sidebar);
  const signOut = useSignOut();
  const onSignOut = useCallback(() => void signOut(), [signOut]);

  if (!model)
    return bootstrapError ? <ShellError onRetry={() => void refetchBootstrap()} /> : <ShellPending />;

  return (
    // Save to Files on messages' files, in the conversation and its thread pane alike (AP-834).
    <MessageFilesProvider burrow={burrow}>
      <ShellLayout
        sidebar={<AssistantSidebar model={model} onSignOut={onSignOut} />}
        pane={
          <Suspense fallback={null}>
            <PaneHost burrow={burrow} pane={pane} origin={origin} beside={beside} />
          </Suspense>
        }
        paneFocus={pane?.kind === 'thread' && pane.focus && !beside}
        paneBeside={beside}
        navKey={href}
        // On the Inbox the page itself is the list.
        barEnd={location.kind === 'needsYou' ? null : <NeedsYouBarLink count={needs} broken={broken} />}
        modals={
          <>
            <Suspense fallback={null}>
              <ModalHost burrow={burrow} modal={modal} />
            </Suspense>
            <Suspense fallback={null}>
              <HostTasks />
            </Suspense>
          </>
        }
        notice={
          // Stacked above the screen in this order, each a full-width line (AP-794, AP-795, AP-3008).
          <>
            {/* The hosted app's demo: says so on every screen, with the way back. */}
            <DemoNotice />
            <AgentsBlockedNotice burrow={burrow} onSettings={location.kind === 'settings'} />
            {/* Whombat Link ending or ended: what still works, and Turn on Tailscale. */}
            <LinkBanner />
            {/* At the box's old address after a change: where it moved, and the way there. */}
            <MovedBanner />
            <PasskeyNotices onSettings={location.kind === 'settings'} />
            <DeskUnlockNotice burrow={burrow} hidden={onWhombatOverview} />
          </>
        }
      >
        {/* Another burrow is another world: its screens start afresh (AP-361). */}
        <Outlet key={burrow} />
      </ShellLayout>
    </MessageFilesProvider>
  );
}
