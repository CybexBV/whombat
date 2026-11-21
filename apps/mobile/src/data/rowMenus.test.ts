/** A chat row's menu and swipe are kept per message while nothing that decides them changes. */
import type { Message } from '@whombat/core';
import { PR482_MESSAGES } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { messageMenu, messageSwipe, messageViewer } from './messageActions';
import { createRowMenus, type RowMenuInput } from './rowMenus';

const message = PR482_MESSAGES.find((m) => m.threadRootId === null && m.text.trim()) as Message;
const input: RowMenuInput = {
  viewer: messageViewer({ id: message.authorId }),
  options: { inThread: false, features: { edit: true, pins: true } },
  offer: 'settle',
  ranOn: null,
  roomTop: true,
};

describe('createRowMenus', () => {
  it('builds what the shared rules say, with the settle offer given', () => {
    const rows = createRowMenus(true);
    const row = rows(message, input);
    const expected = messageMenu(message, input.viewer, { ...input.options, settle: () => 'settle' });
    expect(row.menu).toEqual(expected);
    expect(row.swipe).toBe(messageSwipe(expected, true));
    expect(row.menu?.actions.map((a) => a.kind)).toContain('settle');
    expect(JSON.parse(row.spec ?? 'null')).toHaveProperty('sections');
  });

  it('answers with the same object while the message and its inputs are the same', () => {
    const rows = createRowMenus(true);
    const first = rows(message, input);
    expect(rows(message, { ...input })).toBe(first);
  });

  it('builds it again when the thread’s offer, the message or what answered it changes', () => {
    const rows = createRowMenus(true);
    const first = rows(message, input);
    const working = rows(message, { ...input, offer: null });
    expect(working).not.toBe(first);
    expect(working.menu?.actions.map((a) => a.kind)).not.toContain('settle');
    expect(working.swipe).toBe('more');
    expect(rows({ ...message, pinnedAt: message.createdAt }, { ...input, offer: null })).not.toBe(working);
    expect(rows(message, { ...input, offer: null, ranOn: 'Claude' })).not.toBe(working);
  });

  it('leaves out iOS’s menu where the app’s sheet opens instead', () => {
    expect(createRowMenus(false)(message, input).spec).toBeNull();
  });
});
