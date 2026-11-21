import { type MessagePage, parseMessage } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { RICH_MESSAGES, RICH_ROOM, withRichMessages } from './rich';

describe('rich messages in the demo world (AP-329)', () => {
  it('holds an HTML page, a table with task items, a diagram and code', () => {
    const blocks = RICH_MESSAGES.flatMap((m) => parseMessage(m.text));
    expect(blocks.some((b) => b.type === 'code' && b.preview === 'html')).toBe(true);
    expect(blocks.some((b) => b.type === 'table')).toBe(true);
    expect(blocks.some((b) => b.type === 'list' && b.checked?.includes(true))).toBe(true);
    expect(blocks.some((b) => b.type === 'code' && b.preview === 'mermaid')).toBe(true);
    expect(blocks.some((b) => b.type === 'heading' && b.level === 2)).toBe(true);
  });

  it('adds them to PR #482’s room only, once, in time order, by the agent', () => {
    const page = { messages: [], before: null, hasMore: false } as unknown as MessagePage;
    const room = withRichMessages(RICH_ROOM, page);
    expect(room.messages.map((m) => m.id)).toEqual(RICH_MESSAGES.map((m) => m.id));
    expect(new Set(room.messages.map((m) => m.authorId))).toEqual(new Set(['prn_dusty']));
    expect(withRichMessages(RICH_ROOM, room).messages).toHaveLength(RICH_MESSAGES.length);
    expect(withRichMessages('cnv_dm-dusty', page)).toBe(page);
  });
});
