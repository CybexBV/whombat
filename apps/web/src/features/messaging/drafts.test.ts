/** Drafts kept in the browser (docs/decisions/web-messages.md WX-05). */
import { describe, expect, it } from 'vitest';
import { clearDrafts, DRAFT_MAX_AGE_MS, draftKey, readDraft, writeDraft } from './drafts';

describe('drafts', () => {
  it('keeps one per burrow, conversation and thread, in localStorage', () => {
    const room = draftKey('burrow-hq', 'cnv_billing-v2');
    const thread = draftKey('burrow-hq', 'thread', 'msg_1');
    writeDraft(room, 'In the room');
    writeDraft(thread, 'In the thread');
    expect(readDraft(room)).toBe('In the room');
    expect(readDraft(thread)).toBe('In the thread');
    expect(localStorage.getItem('whombat:draft:burrow-hq:cnv_billing-v2')).toContain('In the room');
    writeDraft(room, '');
    expect(readDraft(room)).toBe('');
    expect(localStorage.getItem('whombat:draft:burrow-hq:cnv_billing-v2')).toBeNull();
  });

  it('drops a draft left alone for 30 days, and anything that isn’t one', () => {
    const key = draftKey('burrow-hq', 'cnv_general');
    writeDraft(key, 'Old', 1_000);
    expect(readDraft(key, 1_000 + DRAFT_MAX_AGE_MS)).toBe('Old');
    expect(readDraft(key, 1_001 + DRAFT_MAX_AGE_MS)).toBe('');
    localStorage.setItem('whombat:draft:burrow-hq:cnv_x', '{"text":3}');
    expect(readDraft('burrow-hq:cnv_x')).toBe('');
  });

  it('forgets them all on clearDrafts, and nothing else', () => {
    writeDraft(draftKey('a', 'cnv_1'), 'One');
    localStorage.setItem('whombat:theme', 'dark');
    clearDrafts();
    expect(readDraft(draftKey('a', 'cnv_1'))).toBe('');
    expect(localStorage.getItem('whombat:theme')).toBe('dark');
  });
});
