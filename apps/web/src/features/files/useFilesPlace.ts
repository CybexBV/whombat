/**
 * Which conversation a Files address names and how to call it (docs/decisions/files-space.md AP-774): the sidebar's
 * conversations (the bootstrap: the person's rooms and the branch rooms), else the conversation itself (a task chat).
 * Named as `/files` names it (`filesConversationRows`).
 */
import {
  type FilesConversationRow,
  type FilesPlace,
  filesConversationId,
  filesConversationRows,
} from '@whombat/client';
import { useBootstrap, useConversation } from '@whombat/client/react';
import { conversationLink } from '@whombat/core';
import { useMemo } from 'react';

export interface ResolvedPlace {
  /** Null while it is being looked up, or when the viewer can't see it (`missing`). */
  conversationId: string | null;
  row: FilesConversationRow | null;
  missing: boolean;
}

const EPOCH = '1970-01-01T00:00:00.000Z';

/** Names one conversation the way `/files` does. */
export function useConversationNaming(
  burrow: string,
  conversationId: string | null,
): FilesConversationRow | null {
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  const named = useMemo(
    () =>
      conversationId
        ? (filesConversationRows(
            { conversations: [{ conversationId, count: 1, bytes: 0, lastAddedAt: EPOCH }] },
            bootstrap,
          )[0] ?? null)
        : null,
    [conversationId, bootstrap],
  );
  // Not in the sidebar (a task chat): the conversation itself says what it is.
  const unknown = named?.kind === 'unknown';
  const { data: detail } = useConversation(
    unknown && conversationId ? { params: { burrow, conversationId } } : null,
    { retry: false },
  );
  return useMemo(() => {
    if (named?.kind !== 'unknown' || !detail) return named;
    const c = detail.conversation;
    return {
      ...named,
      kind: c.kind,
      label: c.title,
      link: conversationLink(c),
    };
  }, [named, detail]);
}

export function useFilesPlace(burrow: string, place: FilesPlace | null): ResolvedPlace {
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  const conversationId = place ? filesConversationId(place, bootstrap) : null;
  const row = useConversationNaming(burrow, conversationId);
  return { conversationId, row, missing: !conversationId && !!bootstrap };
}
