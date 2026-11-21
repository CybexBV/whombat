/**
 * “Ask about pve-02” on a server's or a thing's page (one-whombat-mobile.md AP-1358; chat-channel.md AP-2455): the
 * newest thread about it in Chat (`chats.threads` with the subject); with none, `ask` (the page's sheet, which starts
 * one with the subject).
 */
import { useChatThreads } from '@whombat/client/react';
import type { ChatSubject } from '@whombat/core';
import { useBurrowBase } from '../data/BurrowProvider';
import { useAppNavigation } from '../navigation/hooks';

export function useAskAbout(subject: ChatSubject | null, back: string, ask: () => void): () => void {
  const { slug } = useBurrowBase();
  const navigation = useAppNavigation();
  const threads = useChatThreads(slug, 'chat', { subject, enabled: !!subject });
  return () => {
    const newest = threads.threads[0];
    if (newest) navigation.navigate('Thread', { messageId: newest.rootId, back });
    else ask();
  };
}
