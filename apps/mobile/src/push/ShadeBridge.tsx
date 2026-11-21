/**
 * Read in the app, gone from the shade (MN-04), self-hosted and managed alike. Every way of reading — opening an inbox
 * row, reading a conversation or a thread, opening a notification, reading on another device (`notification.read`,
 * MN-03), deciding an approval — ends in the cached inbox, so this watches the cache (and the event, for rows the
 * cache doesn't hold) rather than each path: a moment after a change it asks Android what is in the shade, resolves a
 * managed push's ref once through the session, and cancels what `readInShade` says was read. Also on coming back to
 * the foreground and when a push reaches the running app. Android's shade comes from the native module (without it,
 * in tests, it does nothing), iOS's from its notification center (`phoneNotifications`).
 */
import { useQueryClient } from '@tanstack/react-query';
import { resolvePushRef } from '@whombat/client/managed';
import { cachedData, parseKey } from '@whombat/client/query';
import { useRealtimeEvent } from '@whombat/client/react';
import type { InboxResponse } from '@whombat/core';
import { useEffect, useMemo, useRef } from 'react';
import { AppState } from 'react-native';
import { WhombatLive } from '../../modules/whombat-live';
import { useBurrowBase } from '../data/BurrowProvider';
import { useManaged } from '../managed/context';
import { knownPushRefs } from './knownRefs';
import { phoneNotifications } from './phoneNotifications';
import { inboxRows, noteRead, readInShade, refsToResolve } from './shade';

/** Changes closer together than this are looked at once. */
const SETTLE_MS = 400;

export function NotificationShadeBridge() {
  const { slug } = useBurrowBase();
  const qc = useQueryClient();
  const managed = useManaged();
  const latest = useRef({ slug, qc, managed });
  latest.current = { slug, qc, managed };
  const reads = useRef({ ids: new Set<string>(), allBefore: null as number | null });

  const check = useMemo(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false;
    let again = false;
    const run = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        const shade = await phoneNotifications.shade();
        if (!shade.length) return;
        const { slug: burrow, qc: cache, managed: m } = latest.current;
        const session = m && m.connection.status === 'open' ? m.session : null;
        if (session) {
          for (const ref of refsToResolve(shade, knownPushRefs)) {
            const open = await resolvePushRef(session, ref);
            if (open.to === 'link') knownPushRefs.set(ref, { burrow: open.burrow, link: open.link });
            else if (open.to === 'inbox' && open.missing) knownPushRefs.set(ref, 'gone');
          }
        }
        const inboxes = cachedData<InboxResponse>(cache, 'notifications.inbox')
          .filter(({ key }) => parseKey(key)?.params.burrow === burrow)
          .map(({ data }) => data);
        const tags = readInShade({
          shade,
          burrow,
          rows: inboxRows(inboxes),
          reads: reads.current,
          targets: knownPushRefs,
        });
        await phoneNotifications.cancel(tags);
      } catch {
        // The shade stays as it is; the next change looks again.
      } finally {
        running = false;
        if (again) {
          again = false;
          schedule();
        }
      }
    };
    const schedule = () => {
      if (!phoneNotifications.available() || timer) return;
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, SETTLE_MS);
    };
    return schedule;
  }, []);

  useRealtimeEvent('notification.read', (e) => {
    noteRead(reads.current, e, Date.now());
    check();
  });

  useEffect(() => {
    check();
    const offCache = qc.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return;
      if (parseKey(event.query.queryKey)?.endpointId === 'notifications.inbox') check();
    });
    const appState = AppState.addEventListener('change', (next) => next === 'active' && check());
    const offs = [WhombatLive.onPush(check), phoneNotifications.onPush(check)];
    return () => {
      offCache();
      appState.remove();
      for (const off of offs) off();
    };
  }, [qc, check]);

  return null;
}
