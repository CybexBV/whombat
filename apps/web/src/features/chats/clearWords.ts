import { CHAT_WORDS } from '@whombat/client';
import type { ChatRoom } from '@whombat/core';

/**
 * What clearing a room says, before and after (chat-clear.md AP-4502, AP-4503). The cleared threads are found with
 * search; the room's head lists only settled ones (chat-settle.md AP-6253).
 */
export function clearChatWords(room: ChatRoom, assistantName?: string) {
  const name = CHAT_WORDS[room];
  return room === 'chat'
    ? {
        menu: 'Clear chats',
        kicker: 'CLEAR CHAT',
        title: `Clear ${name}?`,
        body: `The messages leave ${name}, and ${assistantName ?? 'your agent'} starts fresh on your next question. Search still finds every thread.`,
        done: `Cleared ${name}. Search still finds every thread.`,
        empty: `${name} is already clear.`,
      }
    : {
        menu: 'Clear feedback',
        kicker: 'CLEAR FEEDBACK',
        title: `Clear ${name}?`,
        body: `The reports leave ${name}. Search still finds every report.`,
        done: `Cleared ${name}. Search still finds every report.`,
        empty: `${name} is already clear.`,
      };
}
