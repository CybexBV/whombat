/**
 * A message's permalink (docs/decisions/web-messages.md WX-06): the conversation's path with `#msg_…` (the room opens
 * there, AP-445), a reply's with `?thread=<root>#msg_…` (the thread pane opens there). Copied links are burrow-less
 * with `?burrow=` (AP-365) and, on a managed Whombat, name the Whombat too (MR-45), as the canvas's Share does.
 */
import { appPath, withBurrow } from '@whombat/client';
import { applianceLink } from '@whombat/client/managed';
import { type ConversationDetail, conversationLink, type Message } from '@whombat/core';
import { useCallback } from 'react';
import { useAppServices } from '../../app/providers';
import type { PrincipalLookup } from './model';

/** The in-app path of a message in `detail`'s conversation. */
export function messagePath(
  detail: Pick<ConversationDetail, 'conversation' | 'summary'>,
  m: Pick<Message, 'id' | 'threadRootId'>,
  _lookup?: PrincipalLookup,
): string {
  // The server's own link for the conversation (a branch room's carries its repository); built here when it isn't one.
  const own = detail.summary.link;
  const where =
    own.type === 'dm' || own.type === 'pr' || own.type === 'chat'
      ? own
      : conversationLink(detail.conversation);
  const path = appPath({
    type: 'message',
    in: where,
    messageId: m.id,
    ...(m.threadRootId ? { threadRootId: m.threadRootId } : {}),
  });
  // The thread's address with the reply as its fragment: the pane scrolls to it.
  return m.threadRootId ? `${path}#${m.id}` : path;
}

/** The whole URL to copy for a message, or null while its conversation isn't known. */
export function useMessageUrl(
  burrow: string,
  detail: Pick<ConversationDetail, 'conversation' | 'summary'> | null | undefined,
  lookup: PrincipalLookup,
): (m: Message) => string | null {
  const { managed } = useAppServices();
  return useCallback(
    (m: Message) => {
      if (!detail) return null;
      const path = withBurrow(messagePath(detail, m, lookup), burrow);
      return managed
        ? applianceLink(window.location.origin, managed.applianceId, path)
        : `${window.location.origin}${path}`;
    },
    [burrow, detail, lookup, managed],
  );
}
