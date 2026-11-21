/** Contracts 0.119.0: `chats.clear` and the `chat.cleared` frame (CT-990, CT-991). */
import { describe, expect, it } from 'vitest';
import { ClearChatBody, ClearChatResponse } from './home.js';
import { api } from './index.js';
import { REALTIME_EVENT_TOPICS, RealtimeEvent } from './realtime.js';

describe('chats.clear (CT-990)', () => {
  it('clears Chat unless another room is named', () => {
    expect(ClearChatBody.parse({})).toEqual({ room: 'chat' });
    expect(ClearChatBody.parse({ room: 'feedback' })).toEqual({ room: 'feedback' });
    expect(() => ClearChatBody.parse({ room: 'task' })).toThrow();
  });

  it('is a POST on the burrow’s chats', () => {
    expect(api.chats.clear.method).toBe('POST');
    expect(api.chats.clear.path).toBe('/burrows/:burrow/chats/clear');
  });

  it('answers the room, when and how many left its view', () => {
    const answer = {
      room: 'chat',
      conversationId: 'cnv_abcdefghijkl',
      clearedAt: '2026-10-21T20:00:00.000Z',
      cleared: 3,
    };
    expect(ClearChatResponse.parse(answer)).toEqual(answer);
    expect(() => ClearChatResponse.parse({ ...answer, cleared: -1 })).toThrow();
  });
});

describe('chat.cleared (CT-991)', () => {
  it('reaches only the room’s person', () => {
    const frame = {
      type: 'chat.cleared',
      conversationId: 'cnv_abcdefghijkl',
      room: 'feedback',
      clearedAt: '2026-10-21T20:00:00.000Z',
    };
    expect(RealtimeEvent.parse(frame)).toEqual(frame);
    expect(REALTIME_EVENT_TOPICS['chat.cleared']).toEqual(['me']);
  });
});
