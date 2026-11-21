/** A thread opens on its root as the room has it while its replies load. */
import type { Message, MessagePage } from '@whombat/core';
import { PR482_MESSAGES } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { threadPlaceholder } from './threadPages';

const page = (messages: Message[]): MessagePage => ({ messages, before: null, hasMore: false });
const root = PR482_MESSAGES[2] as Message;

describe('threadPlaceholder', () => {
  it('is the root from whichever room page has it, with no replies and nothing more offered', () => {
    const lists = [
      undefined,
      { pages: [page(PR482_MESSAGES.slice(0, 1))] },
      { pages: [page(PR482_MESSAGES)] },
    ];
    const view = threadPlaceholder(lists, root.id);
    expect(view?.root).toBe(root);
    expect(view?.conversationId).toBe(root.conversationId);
    expect(view?.replies).toEqual([]);
    expect(view?.more).toBeNull();
  });

  it('is nothing when no page has it', () => {
    expect(
      threadPlaceholder([{ pages: [page(PR482_MESSAGES.slice(0, 1))] }], 'msg_elsewhere'),
    ).toBeUndefined();
  });
});
