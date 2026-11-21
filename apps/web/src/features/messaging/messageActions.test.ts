/** Which actions a message offers, and the delete dialog's words (docs/decisions/essentials-messages.md AP-440, AP-442). */
import type { Message } from '@whombat/core';
import { dusty, mara } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import {
  deleteMessageText,
  lastEditable,
  type MessageActionContext,
  messageActions,
  messageExcerpt,
  messageViewer,
} from './messageActions';

function message(id: string, o: Partial<Message> = {}): Message {
  return {
    id,
    conversationId: 'cnv_billing-v2',
    authorId: mara.id,
    createdAt: '2026-09-23T09:20:00.000Z',
    editedAt: null,
    text: 'Hello',
    mentions: [],
    card: null,
    suggestions: [],
    more: null,
    attachments: [],
    reactions: [],
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    threadParticipantIds: [],
    clientId: null,
    ...o,
  };
}

const ownerMara: MessageActionContext = { viewer: messageViewer(mara), place: 'room' };

describe('messageActions', () => {
  it('offers everything on your own message', () => {
    expect(messageActions(message('msg_1'), ownerMara)).toEqual(['reply', 'react', 'edit', 'pin', 'delete']);
    expect(messageActions(message('msg_1', { pinnedAt: '2026-09-23T09:21:00.000Z' }), ownerMara)).toEqual([
      'reply',
      'react',
      'edit',
      'unpin',
      'delete',
    ]);
  });

  it('lets the person delete the agent’s message but not edit it', () => {
    const dustys = message('msg_2', { authorId: dusty.id });
    expect(messageActions(dustys, ownerMara)).toEqual(['reply', 'react', 'pin', 'delete']);
  });

  it('never edits a card, and a thread reply has no “Reply in thread”', () => {
    const card = message('msg_4', { card: { kind: 'pill', text: '38 of 41 passed', tone: 'warn' } });
    expect(messageActions(card, ownerMara)).not.toContain('edit');
    expect(messageActions(message('msg_5', { threadRootId: 'msg_1' }), ownerMara)).not.toContain('reply');
    expect(messageActions(message('msg_6'), { ...ownerMara, place: 'thread' })).not.toContain('reply');
  });

  it('offers nothing on a tombstone or a message still being sent', () => {
    expect(
      messageActions(message('msg_7', { deletedAt: '2026-09-23T09:30:00.000Z', text: '' }), ownerMara),
    ).toEqual([]);
    expect(messageActions(message('msg_local-abc'), ownerMara)).toEqual([]);
  });

  it('agents only react', () => {
    const agent = { ...ownerMara, viewer: messageViewer(dusty) };
    expect(messageActions(message('msg_1', { authorId: dusty.id }), agent)).toEqual(['reply', 'react']);
  });
});

describe('lastEditable', () => {
  it('is the viewer’s newest message they may edit', () => {
    const list = [
      message('msg_a'),
      message('msg_b', { authorId: dusty.id }),
      message('msg_c', { card: { kind: 'pill', text: 'x', tone: 'ok' } }),
      message('msg_local-d'),
    ];
    expect(lastEditable(list, ownerMara)?.id).toBe('msg_a');
    expect(lastEditable(list.slice(1), ownerMara)).toBeUndefined();
  });
});

describe('the delete dialog', () => {
  it('says where it goes from, and that its replies go with it', () => {
    expect(deleteMessageText(message('msg_1'), mara.id, 'Mara Okafor', '#billing-v2')).toContain(
      '#billing-v2',
    );
    expect(
      deleteMessageText(message('msg_1', { replyCount: 2 }), mara.id, 'Mara Okafor', '#billing-v2'),
    ).toContain('2 replies');
    const agents = deleteMessageText(
      message('msg_1', { authorId: dusty.id, replyCount: 1 }),
      mara.id,
      'Dusty',
      '',
    );
    expect(agents).toContain('Dusty’s message');
    expect(agents).not.toMatch(/owner|everyone/);
  });

  it('quotes the message’s first words on one line', () => {
    expect(messageExcerpt('Use **Typeset**\n\nfor PDFs')).toBe('Use Typeset for PDFs');
    expect(messageExcerpt('x'.repeat(200), 20)).toBe(`${'x'.repeat(19)}…`);
  });
});
