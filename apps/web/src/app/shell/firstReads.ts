/**
 * A burrow's first reads, sent together instead of one after another (open-speed.md AP-4404). Opening a Whombat asked
 * the account, then the bootstrap, then mounted the shell, whose sidebar asked its reads, then Chat its rooms, then the
 * room its conversation, then its messages: on a new session each step waited a round trip for the one before. Here
 * the bootstrap goes out with the session's first requests; once the session has said what its runtime is, the
 * sidebar's reads and Chat's rooms; once the rooms are in, the open room's conversation and newest messages.
 * The screens ask the same queries (`BurrowShell`, `ChatRoomScreen`, `useRoomMessages`), so they find these answers in
 * the cache, or join the request still on its way. Once per burrow and app: later navigations read what is cached.
 */
import { chatRoomsOf } from '@whombat/client';
import type { ApplianceSession } from '@whombat/client/session';
import { type ChatRoom, topics } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import type { OpenPhase } from '../openTiming';
import type { AppServices } from '../services';

/** How long the warm-up holds the room's live updates: by then the room holds them itself, or isn't open. */
const HOLD_MS = 30_000;

const warmed = new WeakMap<AppServices, Set<string>>();

/** The Chat shell's room a path opens: `/` and `/chat` Chat, `/feedback` the Feedback room; null for the others. */
export function firstRoom(pathname: string): ChatRoom | null {
  if (pathname === '/' || pathname === '/chat') return 'chat';
  if (pathname === '/feedback') return 'feedback';
  return null;
}

export function warmBurrow(services: AppServices, burrow: string, pathname: string): void {
  const done = warmed.get(services) ?? new Set<string>();
  warmed.set(services, done);
  if (done.has(burrow)) return;
  done.add(burrow);
  const { queryClient, queries, realtime, session } = services;
  const ensure = (options: Parameters<typeof queryClient.ensureQueryData>[0], phase?: OpenPhase) =>
    queryClient
      .ensureQueryData(options)
      .then((data) => {
        if (phase) services.openTiming?.mark(phase);
        return data;
      })
      .catch(() => undefined);
  const params = { burrow };
  void ensure(queries.conversations.bootstrap({ params }), 'bootstrap');
  whenOpen(session, () => {
    // Without retries, as the shell asks these: the shell joins this request, and a retry would hold its error back.
    void ensure({ ...queries.endpoint(api.home.overview, { params }), retry: false });
    void ensure({ ...queries.endpoint(api.hosts.status, { params }), retry: false });
    const room = firstRoom(pathname);
    void queryClient
      .ensureQueryData({ ...queries.endpoint(api.chats.list, { params, query: {} }), retry: false })
      .then((list) => {
        services.openTiming?.mark('rooms');
        const ref = room ? chatRoomsOf(list.chats)[room] : undefined;
        if (!ref || !room) return;
        const input = { params: { burrow, conversationId: ref.id } };
        // Live updates before the history, as the room asks them, so nothing posted meanwhile is missed. A subscription
        // reaches the box only while the realtime is connected, which the shell does once it mounts: connect it here
        // (again is a no-op), or the history would be asked first.
        realtime?.connect();
        const release = realtime?.subscribe(topics.conversation(ref.id));
        if (release) setTimeout(release, HOLD_MS);
        void ensure(queries.endpoint(api.conversations.get, input));
        // The room needs working/settling metadata too; share the screen's exact query and keep history separate.
        void queryClient.prefetchInfiniteQuery(
          queries.chats.threadsInfinite({ params, query: { room, state: 'open' } }),
        );
        void queryClient
          .fetchInfiniteQuery(queries.messages.listInfinite(input))
          .then(() => services.openTiming?.mark('history'))
          .catch(() => undefined);
      })
      .catch(() => undefined);
  });
}

/** `run` once the session is open (now, when it is); never once it has closed. */
function whenOpen(session: ApplianceSession, run: () => void): void {
  const status = session.state().status;
  if (status === 'open') {
    run();
    return;
  }
  if (status === 'closed') return;
  const off = session.onState((s) => {
    if (s.status !== 'open' && s.status !== 'closed') return;
    off();
    if (s.status === 'open') run();
  });
}
