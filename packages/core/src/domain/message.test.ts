import { describe, expect, it } from 'vitest';
import {
  canAskForMore,
  MESSAGE_MAX_JSON_BYTES,
  MESSAGE_MAX_LENGTH,
  MESSAGE_TOO_LONG,
  Message,
  MessageTextInput,
  messageTextFits,
  messageTextJsonBytes,
  replySuggestions,
  SUGGESTIONS_MAX,
  suggestionMessage,
} from './message.js';

const agents = new Set(['prn_clove']);
const isAgent = (id: string) => agents.has(id);
const msg = (id: string, authorId: string, suggestions: string[] = [], replyCount = 0) => ({
  id,
  authorId,
  suggestions,
  replyCount,
});

describe('replySuggestions', () => {
  it('offers nothing on people’s messages, the viewer’s own or an empty list', () => {
    expect(replySuggestions([msg('m1', 'prn_mara', ['Yes'])], 'prn_john', isAgent)).toBeNull();
    expect(replySuggestions([msg('m1', 'prn_clove', ['Yes'])], 'prn_clove', isAgent)).toBeNull();
    expect(replySuggestions([], 'prn_john', isAgent)).toBeNull();
    expect(replySuggestions([msg('m1', 'prn_clove')], 'prn_john', isAgent)).toBeNull();
  });
});

describe('canAskForMore', () => {
  const more = { hint: 'the two other options', requestedById: null, requestedAt: null };
  const offer = { authorId: 'prn_clove', more };
  const clove = { kind: 'agent' as const };
  const john = { id: 'prn_john', kind: 'person' as const };

  it('offers nothing to agents, to the author or without a viewer', () => {
    expect(canAskForMore(offer, clove, { id: 'prn_dusty', kind: 'agent' })).toBe(false);
    expect(canAskForMore(offer, clove, { id: 'prn_clove', kind: 'person' })).toBe(false);
    expect(canAskForMore(offer, clove, undefined)).toBe(false);
    expect(canAskForMore(offer, { kind: 'person' }, john)).toBe(false);
  });

  it('offers the agent’s to any other person, until someone asked', () => {
    expect(canAskForMore(offer, clove, john)).toBe(true);
    expect(canAskForMore(offer, clove, { id: 'prn_mara', kind: 'person' })).toBe(true);
    const asked = {
      ...offer,
      more: { ...more, requestedById: 'prn_mara', requestedAt: '2026-09-24T16:50:00.000Z' },
    };
    expect(canAskForMore(asked, clove, john)).toBe(false);
  });
});

describe('suggestionMessage', () => {
  it('mentions the agent elsewhere, unless the words already do', () => {
    expect(suggestionMessage('Dig into the CI failure', 'Dusty', false)).toBe(
      '@Dusty Dig into the CI failure',
    );
    expect(suggestionMessage('Ask @Dusty to retry', 'Dusty', false)).toBe('Ask @Dusty to retry');
    expect(suggestionMessage('Ask @Dustys', 'Dusty', false)).toBe('@Dusty Ask @Dustys');
  });
});

describe('Message.suggestions', () => {
  it('defaults to none and holds at most three', () => {
    const base = {
      id: 'msg_1',
      conversationId: 'cnv_1',
      authorId: 'prn_clove',
      createdAt: '2026-09-24T16:46:00.000Z',
      editedAt: null,
      text: 'Hi',
      mentions: [],
      card: null,
      attachments: [],
      reactions: [],
      threadRootId: null,
      replyCount: 0,
      lastReplyAt: null,
      threadParticipantIds: [],
      clientId: null,
    };
    expect(Message.parse(base).suggestions).toEqual([]);
    const four = Array.from({ length: SUGGESTIONS_MAX + 1 }, (_, i) => `Option ${i}`);
    expect(Message.safeParse({ ...base, suggestions: four }).success).toBe(false);
  });
});

describe('message text limits (CT-151)', () => {
  it('counts a text’s JSON bytes like JSON.stringify and UTF-8', () => {
    const { TextEncoder: Encoder } = globalThis as unknown as {
      TextEncoder: new () => { encode(s: string): Uint8Array };
    };
    const utf8 = (s: string) => new Encoder().encode(JSON.stringify(s)).length;
    for (const s of [
      '',
      'plain',
      'a "quoted"\n\\ line\t',
      '€ · ’ “x”',
      '😀 emoji',
      '\u0001\u001f',
      'lone \ud800 x',
    ])
      expect(messageTextJsonBytes(s), s).toBe(utf8(s));
  });

  it('takes a 37 KB page, refuses one past either limit', () => {
    const page = `<!DOCTYPE html><html><body>${'<p class="x">Toffee’s logo</p>\n'.repeat(1200)}</body></html>`;
    expect(page.length).toBeGreaterThan(37_000);
    expect(messageTextFits(page)).toBe(true);
    expect(MessageTextInput.safeParse(page).success).toBe(true);
    expect(messageTextFits('x'.repeat(MESSAGE_MAX_LENGTH + 1))).toBe(false);
    const quotes = '"'.repeat(30_000); // 60 002 bytes as JSON
    expect(messageTextFits(quotes)).toBe(false);
    expect(MessageTextInput.safeParse(quotes).error?.issues[0]?.message).toBe(MESSAGE_TOO_LONG);
    expect(MESSAGE_MAX_JSON_BYTES).toBeLessThan(64 * 1024);
  });
});
