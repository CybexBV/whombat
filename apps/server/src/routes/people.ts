/** A person's notification level for a conversation (docs/decisions/essentials-people.md EP-10, contracts CT-175). */
import { api } from '@whombat/core';
import { setConversationNotify } from '../commands/people';
import { commitAs } from './burrows';
import { route } from './define';

export const peopleRoutes = [
  route(api.conversations.setNotify, async (ctx) =>
    commitAs(ctx, setConversationNotify, {
      conversationId: ctx.params.conversationId,
      notify: ctx.body.notify,
    }),
  ),
];
