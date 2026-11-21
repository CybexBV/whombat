import { useQueryClient } from '@tanstack/react-query';
import { CHAT_WORDS } from '@whombat/client';
import { queryKeys } from '@whombat/client/query';
import { useApiMutation, useTheAgent } from '@whombat/client/react';
import { api, type ChatRoom } from '@whombat/core';
import { useState } from 'react';
import { useToast } from '../../components/Toast';
import { ConfirmDialog } from '../conversations/ConfirmDialog';
import { outcomeText, refusalText } from '../conversations/refusal';
import { clearChatWords } from './clearWords';

/**
 * Clearing Chat or Feedback from the sidebar (Whombat chat-clear.md CHC-01…CHC-06; app chat-clear.md AP-4502…AP-4504):
 * always asks first, then `chats.clear`, reads the room's timeline again (the `chat.cleared` frame does the same on the
 * person's other tabs) and says it in a toast. `element` renders the question.
 */
export function useClearChat(burrow: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const { agent: assistant } = useTheAgent(burrow);
  const clear = useApiMutation(api.chats.clear);
  const [room, setRoom] = useState<ChatRoom | null>(null);
  const [error, setError] = useState<string | null>(null);
  const words = clearChatWords(room ?? 'chat', assistant?.name);

  const confirm = async () => {
    if (!room) return;
    try {
      const r = await clear.mutateAsync({ params: { burrow }, body: { room } });
      if (r.status !== 'ok') return setError(outcomeText(r));
      void qc.resetQueries({
        queryKey: queryKeys.scope('messages.list', { conversationId: r.data.conversationId }),
      });
      void qc.invalidateQueries({ queryKey: queryKeys.scope('chats.list') });
      // What could settle did (Whombat chat-inbox.md CIB-13): the inbox and what is new read again.
      void qc.invalidateQueries({ queryKey: queryKeys.scope('chats.threads') });
      void qc.invalidateQueries({ queryKey: queryKeys.scope('chats.unread') });
      setRoom(null);
      toast.show(r.data.cleared > 0 ? words.done : words.empty);
    } catch (err) {
      setError(refusalText(err, `Couldn’t clear ${CHAT_WORDS[room]}. Try again.`));
    }
  };

  return {
    ask: (next: ChatRoom) => {
      setError(null);
      setRoom(next);
    },
    element: (
      <ConfirmDialog
        open={room !== null}
        onOpenChange={(open) => !open && setRoom(null)}
        kicker={words.kicker}
        title={words.title}
        confirmLabel={words.menu}
        busy={clear.isPending}
        error={error}
        onConfirm={() => void confirm()}
      >
        {words.body}
      </ConfirmDialog>
    ),
  };
}
