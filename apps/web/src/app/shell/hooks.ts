import { useNavigate } from '@tanstack/react-router';
import { queryKeys } from '@whombat/client/query';
import { useRealtimeEvent, useSubscription } from '@whombat/client/react';
import type { Bootstrap, ThemePreference } from '@whombat/core';
import { needsYouToast } from '@whombat/core/text';
import { useCallback, useEffect, useRef } from 'react';
import { useToast } from '../../components/Toast';
import { clearDrafts } from '../../features/messaging/drafts';
import { isPushSupported, registerServiceWorker } from '../../push/webPush';
import { useAppServices, useManaged } from '../providers';
import { useNavigateHref, useSearchUpdate } from '../routing/navigation';
import { useThemePreferenceSync } from '../theme';
import { type KeyAction, resolveKeyAction, stepConversation } from './keyboard';
import type { ShellLocation } from './location';
import type { ModalState, PaneState } from './shellState';
import type { ThreadOrigin } from './threadOrigin';

/** Holds the burrow's realtime while the shell is mounted and subscribes to its bootstrap topics. */
export function useBurrowRealtime(burrow: string, topics: readonly string[] | undefined) {
  const services = useAppServices();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new burrow is a new hold, as before.
  useEffect(() => {
    const realtime = services.realtime;
    if (!realtime) return;
    realtime.connect();
    return () => realtime.disconnect();
  }, [services, burrow]);
  useSubscription(topics);
}

/**
 * Per-user theme (TODO 1.1): the preference from the bootstrap wins once loaded (`system` follows the device); the
 * person's choice — Light, Dark or Auto — is saved through `PATCH /me/preferences` and patches the cached bootstrap.
 */
export function useShellThemeSync(burrow: string, preference: ThemePreference | undefined) {
  const { client, queryClient } = useAppServices();
  const save = useCallback(
    (theme: ThemePreference) => {
      client.me
        .updatePreferences({ body: { theme } })
        .then((result) => {
          if (result.status !== 'ok') return;
          queryClient.setQueryData(
            queryKeys.conversations.bootstrap({ params: { burrow } }),
            (old: Bootstrap | undefined) => old && { ...old, preferences: result.data },
          );
        })
        .catch(() => {
          // Offline or signed out: the choice is still stored locally.
        });
    },
    [client, queryClient, burrow],
  );
  useThemePreferenceSync(preference ?? null, save);
}

/**
 * Signs out of this browser: the session's root ends the box's session and clears what it cached (`managed.signOut`).
 * Drafts are kept in this browser (WX-05): they go too. Fixture mode has nothing to leave.
 */
export function useSignOut() {
  const services = useAppServices();
  return useCallback(async () => {
    services.realtime?.disconnect();
    clearDrafts();
    services.managed?.signOut();
  }, [services]);
}

export interface ShellKeyboardOptions {
  burrow: string;
  location: ShellLocation;
  href: string;
  pathname: string;
  pane: PaneState;
  modal: ModalState;
  conversationPaths: readonly string[];
  /** Where the open room thread was opened from: Escape goes back there. */
  origin?: ThreadOrigin | null;
}

/** Focusable element on the search screen that ⌘K focuses when search is already open. */
export const SEARCH_INPUT_SELECTOR = '[data-search-input]';

/** Global shortcuts: ⌘K / Ctrl K, ⌘, / Ctrl , (Settings), Esc (modal → pane → search), Alt+↑/↓. */
export function useShellKeyboard(options: ShellKeyboardOptions) {
  const navigate = useNavigate();
  const navigateHref = useNavigateHref();
  const updateSearch = useSearchUpdate();
  const lastOutsideSearch = useRef<string | null>(null);
  const state = useRef(options);
  state.current = options;

  useEffect(() => {
    if (options.location.kind !== 'search') lastOutsideSearch.current = options.href;
  }, [options.location.kind, options.href]);

  useEffect(() => {
    const perform = (action: KeyAction) => {
      const s = state.current;
      switch (action) {
        case 'openSearch': {
          if (s.location.kind === 'search') {
            document.querySelector<HTMLElement>(SEARCH_INPUT_SELECTOR)?.focus();
            return;
          }
          void navigate({ to: '/search' });
          return;
        }
        case 'openSettings':
          void navigate({ to: '/settings' });
          return;
        case 'closeModal':
          void updateSearch((prev) => ({ ...prev, approval: undefined }));
          return;
        case 'collapseThread':
          void updateSearch((prev) => ({ ...prev, focus: undefined }));
          return;
        case 'closePane':
          if (s.pane?.kind === 'thread' && s.pane.room && s.origin) navigateHref(s.origin.href);
          else if (s.pane?.kind === 'thread')
            void updateSearch((prev) => ({ ...prev, thread: undefined, focus: undefined }));
          else if (s.pane?.kind === 'plan' || s.pane?.kind === 'plans')
            void updateSearch((prev) => ({ ...prev, plan: undefined, step: undefined, plans: undefined }));
          else if (s.pane?.kind === 'pins') void updateSearch((prev) => ({ ...prev, pins: undefined }));
          else if (s.pane?.kind === 'settled') void updateSearch((prev) => ({ ...prev, settled: undefined }));
          return;
        case 'closeSearch': {
          const back = lastOutsideSearch.current;
          if (back) navigateHref(back);
          else void navigate({ to: '/' });
          return;
        }
        case 'previousConversation':
        case 'nextConversation': {
          const next = stepConversation(
            s.conversationPaths,
            s.pathname,
            action === 'nextConversation' ? 1 : -1,
          );
          if (next) navigateHref(next);
          return;
        }
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const s = state.current;
      const action = resolveKeyAction(event, {
        modalOpen: s.modal !== null,
        dialogInDom: document.querySelector('[role="dialog"], [role="alertdialog"]') !== null,
        paneOpen: s.pane !== null,
        // A room's thread has no split view to go back to: Esc closes it (AP-2415).
        threadFocus: s.pane?.kind === 'thread' && s.pane.focus && !s.pane.room,
        searchOpen: s.location.kind === 'search',
      });
      if (!action) return;
      event.preventDefault();
      perform(action);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate, navigateHref, updateSearch]);
}

/**
 * Registers `apps/web/public/sw.js` once the shell mounts (`docs/decisions/web-push-connect.md`): no
 * permission prompt, just gets `notificationclick` deep-linking and future push delivery ready.
 * Subscribing is `apps/web/src/push/useWebPush.ts`'s: by itself where the browser already allows it, else from a click.
 */
export function useServiceWorkerRegistration() {
  const managed = useManaged();
  useEffect(() => {
    // Managed Whombats: no service worker until browser push goes through Whombat's service (AP-24).
    if (managed || !isPushSupported()) return;
    registerServiceWorker().catch(() => {
      // Offline, blocked by an extension, etc.: pushes simply won't arrive until it retries.
    });
  }, [managed]);
}

/** A toast for each live "needs you" item addressed to the viewer, once per notification id. */
export function useNeedsYouToast(meId: string | undefined) {
  const toast = useToast();
  const seen = useRef(new Set<string>());
  useRealtimeEvent('notification.created', (event) => {
    const { item } = event;
    if (item.kind !== 'needs_you' || item.readAt) return;
    if (meId && item.principalId !== meId) return;
    if (seen.current.has(item.id)) return;
    seen.current.add(item.id);
    toast.show(needsYouToast(item.where, item.text));
  });
}
