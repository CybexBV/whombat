/**
 * Edits, tombstones, pins and link previews in the cache (contracts 0.26: CT-173, CT-174; AP-440…): `message.updated`
 * and `message.deleted` reach the conversation's lists, its thread, the pins pane and search results, and the pins
 * list keeps its order (newest pin first) and its cap.
 */
import { QueryClient } from '@tanstack/query-core';
import {
  api,
  type Message,
  type MessagePage,
  PINS_MAX,
  type SearchResponse,
  type SearchResult,
  type ThreadView,
} from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { BURROW, message, t } from '../test/fixtures';
import { applyRealtimeEvent, createCacheSyncState, removeMessageEverywhere } from './apply';
import { endpointKey } from './keys';
import { applyOptimisticPin, restore } from './optimistic';
import { reducePins, reduceSearchResults, removeFromPins, removeSearchResult } from './reducers';

const CONV = 'cnv_chat';
const B = { burrow: BURROW };
const keys = {
  list: endpointKey(api.messages.list, { params: { ...B, conversationId: CONV } }),
  thread: endpointKey(api.messages.thread, { params: { ...B, messageId: 'msg_root' } }),
  pins: endpointKey(api.conversations.pins, { params: { ...B, conversationId: CONV } }),
  otherPins: endpointKey(api.conversations.pins, { params: { ...B, conversationId: 'cnv_general' } }),
  search: endpointKey(api.search.query, { params: B, query: { q: 'pdf' } }),
};

const page = (messages: Message[]): MessagePage => ({ messages, hasMore: false, before: null });

function result(id: string, o: Partial<SearchResult> = {}): SearchResult {
  return {
    id,
    type: 'MESSAGE',
    where: 'Chat · today 10:02',
    authorId: 'prn_mara',
    snippet: 'Hello',
    citedAs: null,
    link: { type: 'message', in: { type: 'dm', room: 'chat' }, messageId: id },
    createdAt: t(0),
    status: null,
    ...o,
  };
}

function search(results: SearchResult[]): SearchResponse {
  return {
    query: 'pdf',
    results,
    counts: {
      all: results.length,
      threads: results.length,
      patches: 0,
      runs: 0,
      canvases: 0,
      plans: 0,
      decisions: 0,
      automations: 0,
    },
    answer: null,
  };
}

const pinned = (id: string, minute: number, o: Partial<Message> = {}) =>
  message(id, { pinnedAt: t(minute), pinnedById: 'prn_mara', ...o });

describe('reducePins', () => {
  it('adds a pinned message newest pin first and replaces it in place after an edit', () => {
    const start = { messages: [pinned('msg_b', 5), pinned('msg_a', 1)] };
    const added = reducePins(start, pinned('msg_c', 3), CONV);
    expect(added.messages.map((m) => m.id)).toEqual(['msg_b', 'msg_c', 'msg_a']);
    const edited = reducePins(added, pinned('msg_c', 3, { text: 'Edited', editedAt: t(9) }), CONV);
    expect(edited.messages.map((m) => m.id)).toEqual(['msg_b', 'msg_c', 'msg_a']);
    expect(edited.messages[1]?.text).toBe('Edited');
  });

  it('drops an unpinned message or a tombstone, and leaves other conversations alone', () => {
    const start = { messages: [pinned('msg_b', 5), pinned('msg_a', 1)] };
    expect(reducePins(start, message('msg_b'), CONV).messages.map((m) => m.id)).toEqual(['msg_a']);
    expect(
      reducePins(start, pinned('msg_a', 1, { deletedAt: t(6), text: '' }), CONV).messages.map((m) => m.id),
    ).toEqual(['msg_b']);
    expect(reducePins(start, pinned('msg_z', 9), 'cnv_general')).toBe(start);
    expect(reducePins(start, message('msg_unknown'), CONV)).toBe(start);
  });

  it('keeps at most PINS_MAX', () => {
    const full = { messages: Array.from({ length: PINS_MAX }, (_, i) => pinned(`msg_${i}`, 100 - i)) };
    const next = reducePins(full, pinned('msg_new', 200), CONV);
    expect(next.messages).toHaveLength(PINS_MAX);
    expect(next.messages[0]?.id).toBe('msg_new');
    expect(next.messages.some((m) => m.id === `msg_${PINS_MAX - 1}`)).toBe(false);
  });

  it('removeFromPins returns the same object when the message isn’t there', () => {
    const start = { messages: [pinned('msg_a', 1)] };
    expect(removeFromPins(start, 'msg_x')).toBe(start);
    expect(removeFromPins(start, 'msg_a').messages).toEqual([]);
  });
});

describe('search results', () => {
  it('show an edit’s plain words and drop a tombstone with its count', () => {
    const data = search([result('msg_1'), result('msg_2', { type: 'THREAD' })]);
    const edited = reduceSearchResults(data, message('msg_1', { text: 'Use **Typeset**\n\nfor PDFs' }));
    expect(edited.results[0]?.snippet).toBe('Use Typeset for PDFs');
    const gone = reduceSearchResults(edited, message('msg_2', { deletedAt: t(3), text: '' }));
    expect(gone.results.map((r) => r.id)).toEqual(['msg_1']);
    expect(gone.counts.all).toBe(1);
    expect(gone.counts.threads).toBe(1);
    expect(reduceSearchResults(gone, message('msg_other'))).toBe(gone);
    expect(removeSearchResult(gone, 'msg_1').results).toEqual([]);
  });
});

describe('realtime', () => {
  function seeded() {
    const qc = new QueryClient();
    const root = message('msg_root', { replyCount: 2, pinnedAt: t(2), pinnedById: 'prn_mara' });
    qc.setQueryData(keys.list, page([root, message('msg_2', { createdAt: t(1) })]));
    qc.setQueryData(keys.thread, {
      root,
      replies: [message('msg_r1', { threadRootId: 'msg_root', createdAt: t(3) })],
      where: 'Chat',
      topic: null,
      conversationId: CONV,
    } as unknown as ThreadView);
    qc.setQueryData(keys.pins, { messages: [root] });
    qc.setQueryData(keys.otherPins, { messages: [] });
    qc.setQueryData(keys.search, search([result('msg_root', { type: 'THREAD' }), result('msg_2')]));
    return qc;
  }

  it('an edit, a pin and a preview reach the list, the thread, the pins and search', () => {
    const qc = seeded();
    const state = createCacheSyncState(() => Date.parse(t(30)));
    const edited = message('msg_2', {
      createdAt: t(1),
      text: 'PDFs ship Friday',
      editedAt: t(10),
      pinnedAt: t(10),
      pinnedById: 'prn_joris',
      previews: [{ url: 'https://typeset.dev', title: 'Typeset', description: null, siteName: 'Typeset' }],
    });
    applyRealtimeEvent(qc, { type: 'message.updated', message: edited }, { at: t(10) }, state);
    const list = qc.getQueryData<MessagePage>(keys.list);
    expect(list?.messages[1]?.text).toBe('PDFs ship Friday');
    expect(list?.messages[1]?.previews?.[0]?.title).toBe('Typeset');
    expect(qc.getQueryData<{ messages: Message[] }>(keys.pins)?.messages.map((m) => m.id)).toEqual([
      'msg_2',
      'msg_root',
    ]);
    expect(qc.getQueryData<{ messages: Message[] }>(keys.otherPins)?.messages).toEqual([]);
    expect(qc.getQueryData<SearchResponse>(keys.search)?.results[1]?.snippet).toBe('PDFs ship Friday');
  });

  it('a tombstone replaces the root in the list and the thread, and leaves the pins and search', () => {
    const qc = seeded();
    const state = createCacheSyncState(() => Date.parse(t(30)));
    const tombstone = message('msg_root', { text: '', replyCount: 2, deletedAt: t(12), pinnedAt: null });
    applyRealtimeEvent(qc, { type: 'message.updated', message: tombstone }, { at: t(12) }, state);
    expect(qc.getQueryData<MessagePage>(keys.list)?.messages[0]?.deletedAt).toBe(t(12));
    expect(qc.getQueryData<ThreadView>(keys.thread)?.root.deletedAt).toBe(t(12));
    expect(qc.getQueryData<ThreadView>(keys.thread)?.replies).toHaveLength(1);
    expect(qc.getQueryData<{ messages: Message[] }>(keys.pins)?.messages).toEqual([]);
    expect(qc.getQueryData<SearchResponse>(keys.search)?.results.map((r) => r.id)).toEqual(['msg_2']);
  });

  it('a deleted message leaves the pins and search too, and stays gone', () => {
    const qc = seeded();
    const state = createCacheSyncState(() => Date.parse(t(30)));
    applyRealtimeEvent(
      qc,
      { type: 'message.deleted', conversationId: CONV, messageId: 'msg_root' },
      { at: t(12) },
      state,
    );
    expect(qc.getQueryData<MessagePage>(keys.list)?.messages.map((m) => m.id)).toEqual(['msg_2']);
    expect(qc.getQueryData<{ messages: Message[] }>(keys.pins)?.messages).toEqual([]);
    expect(qc.getQueryData(keys.thread)).toBeUndefined();
    expect(qc.getQueryData<SearchResponse>(keys.search)?.results.map((r) => r.id)).toEqual(['msg_2']);
    // A late update can't bring it back.
    expect(
      applyRealtimeEvent(qc, { type: 'message.updated', message: message('msg_root') }, { at: t(13) }, state),
    ).toBe(false);
  });

  it('removeMessageEverywhere takes a reply out of its thread', () => {
    const qc = seeded();
    removeMessageEverywhere(qc, CONV, 'msg_r1');
    expect(qc.getQueryData<ThreadView>(keys.thread)?.replies).toEqual([]);
  });
});

describe('applyOptimisticPin', () => {
  it('pins at once and restores on rollback', () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.list, page([message('msg_1')]));
    qc.setQueryData(keys.pins, { messages: [] });
    const snap = applyOptimisticPin(qc, 'msg_1', true, 'prn_mara', t(4));
    expect(snap).not.toBeNull();
    expect(qc.getQueryData<MessagePage>(keys.list)?.messages[0]?.pinnedAt).toBe(t(4));
    expect(qc.getQueryData<{ messages: Message[] }>(keys.pins)?.messages.map((m) => m.id)).toEqual(['msg_1']);
    restore(qc, snap ?? []);
    expect(qc.getQueryData<MessagePage>(keys.list)?.messages[0]?.pinnedAt).toBeUndefined();
    expect(qc.getQueryData<{ messages: Message[] }>(keys.pins)?.messages).toEqual([]);
    expect(applyOptimisticPin(qc, 'msg_unknown', true, 'prn_mara')).toBeNull();
  });
});
