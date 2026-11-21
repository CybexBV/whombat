/**
 * The web's quiet actions (Whombat quiet-notices.md QN-10…QN-15, QN-23; app quiet-notices.md AP-4821, AP-4828): the
 * shared `useQuietActions` with the app's toast — Undo in it for 6 s where the action can be taken back, a refusal's
 * words up long enough to read — and, for a server, whether its viewer may quiet its lines: the Whombat has
 * `things.quiet` and `things.watch` says `mayChange`. Without the feature there are no actions: an older
 * Whombat shows no ⋯ menu and no Undo.
 */
import { QUIET_TOASTS } from '@whombat/client';
import { type QuietActions, useQuietActions, useThingWatch } from '@whombat/client/react';
import { thingId } from '@whombat/core';
import { useToast } from '../../../components/Toast';
import { useBurrowContext } from '../../messaging/useRoom';

/** A refusal's or failure's words stay up long enough to read. */
const FAILED_TOAST_MS = 6000;

/** The quiet actions of one thing, saying how each went in a toast. */
export function useThingQuiet(burrow: string, thing: string): QuietActions {
  const { timeZone } = useBurrowContext(burrow);
  const toast = useToast();
  const actions = useQuietActions(burrow, thing, {
    timeZone,
    note: (message, o) => {
      if (!message) return;
      if (o?.undo) toast.show(message, { action: { label: QUIET_TOASTS.undo, onAction: o.undo } });
      else toast.show(message, o?.failed ? { duration: FAILED_TOAST_MS } : undefined);
    },
  });
  return actions;
}

/** What the server's pages need to quiet its lines: whether the viewer may (`mayQuiet`), and the actions. */
export interface ServerQuiet {
  mayQuiet: boolean;
  actions: QuietActions;
}

/** A server's quiet (QN-10, QN-23): `things.watch`'s `mayChange`, read once and kept a minute. */
export function useServerQuiet(burrow: string, serverId: string): ServerQuiet {
  const thing = thingId('server', serverId);
  const watch = useThingWatch(
    { params: { burrow, thing } },
    {
      retry: false,
      staleTime: 60_000,
    },
  );
  const actions = useThingQuiet(burrow, thing);
  return { mayQuiet: !!watch.data?.mayChange, actions };
}
