import { describe, expect, it } from 'vitest';
import { type KeyInput, resolveKeyAction, stepConversation } from './keyboard';
import { parseShellLocation } from './location';
import { paneFor } from './shellState';

const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});
const closed = { modalOpen: false, dialogInDom: false, paneOpen: false, searchOpen: false };

describe('parseShellLocation', () => {
  it.each([
    ['/pr/abc', { kind: 'other' }],
    ['/chat/a', { kind: 'other' }],
    ['/chat', { kind: 'room', room: 'chat' }],
    ['/agents/banjo', { kind: 'other' }],
  ])('%s', (path, expected) => {
    expect(parseShellLocation(path)).toEqual(expected);
  });
});

describe('panes and modals from the URL', () => {
  it('opens the thread pane on conversations only', () => {
    expect(paneFor(parseShellLocation('/pr/12'), { thread: 'm1' })).toEqual({
      kind: 'thread',
      threadId: 'm1',
      focus: false,
    });
    // Focus mode (ui-improvements.md AP-304).
    expect(paneFor(parseShellLocation('/pr/12'), { thread: 'm1', focus: 1 })).toEqual({
      kind: 'thread',
      threadId: 'm1',
      focus: true,
    });
    expect(paneFor(parseShellLocation('/log'), { thread: 'm1' })).toBeNull();
    // A feedback chat's report threads open beside the chat (feedback-chat.md AP-1833).
    expect(paneFor(parseShellLocation('/chats/cnv_chat-feedback'), { thread: 'm1' })).toEqual({
      kind: 'thread',
      threadId: 'm1',
      focus: false,
    });
    expect(paneFor(parseShellLocation('/settings'), { thread: 'm1' })).toBeNull();
  });
});

describe('keyboard', () => {
  it('steps through conversations with Alt+↑/↓', () => {
    expect(resolveKeyAction(key('ArrowDown', { altKey: true }), closed)).toBe('nextConversation');
    expect(resolveKeyAction(key('ArrowUp', { altKey: true }), closed)).toBe('previousConversation');
    expect(resolveKeyAction(key('ArrowUp'), closed)).toBeNull();
    const paths = ['/c/a', '/c/b', '/dm/x'];
    expect(stepConversation(paths, '/c/a', 1)).toBe('/c/b');
    expect(stepConversation(paths, '/dm/x', 1)).toBe('/c/a');
    expect(stepConversation(paths, '/c/a', -1)).toBe('/dm/x');
    expect(stepConversation(paths, '/log', 1)).toBe('/c/a');
    expect(stepConversation(paths, '/log', -1)).toBe('/dm/x');
    expect(stepConversation([], '/log', 1)).toBeNull();
  });
});
