/**
 * The essentials on the phone (Whombat essentials items 4, 5, 8, 11, 12, 14; AP-500…AP-519): failed turns and Try
 * again, branch rooms by repository, the message menu, tombstones and edits, notification levels, Do not disturb and
 * quiet hours, reactions and link previews — the pure parts. Conversations between people are gone (AP-4981).
 */

import { ApiError } from '@whombat/client';
import { MESSAGE_DELETED_TEXT, type Message, type TurnFailedCard } from '@whombat/core';
import { bootstrap, DM_DUSTY_MESSAGES, dusty, mara, SEED_NOW } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { appUrlForPath, branchRoomFor, routeForLink } from '../navigation/routes';
import { worldContext } from '../test/world';
import { branchRoomMeta } from './lists';
import { canSaveEdit, deleteConfirm, editProblem, messageMenu, messageViewer } from './messageActions';
import { chatItems } from './messages';
import { dndStateText, dndUntilClock, nextWholeHour, notifyBody, notifyOptions, parseClock } from './notify';
import {
  emojiLines,
  emojiPerRow,
  emojiSections,
  parseRecentEmoji,
  quickReactions,
  reactionPills,
  recentAfter,
} from './reactions';
import { isFinalRetryRefusal, retryFailureText, turnFailedView } from './turns';

const ctx = worldContext();
const TZ = ctx.timeZone;
const base = DM_DUSTY_MESSAGES[1] as Message;
const msg = (over: Partial<Message>): Message => ({ ...base, card: null, ...over });

const failedCard = (over: Partial<TurnFailedCard> = {}): TurnFailedCard => ({
  kind: 'turn_failed',
  dispatchId: 'dsp_1',
  agentId: dusty.id,
  code: 'signin',
  reason:
    'I couldn’t start because Claude isn’t set up or signed in for this. Sign in under Settings → AI sign-in, then press Try again.',
  retriedAt: null,
  retryDispatchId: null,
  ...over,
});

describe('failed turns (item 4, AP-500, AP-501)', () => {
  const viewer = { id: mara.id, kind: 'person' as const };

  it('says why, and offers Try again to a person', () => {
    const card = failedCard();
    const view = turnFailedView(card, {
      text: 'Something else',
      agent: dusty,
      viewer,
      retryFeature: true,
      timeZone: TZ,
    });
    expect(view).toMatchObject({
      label: 'NOT SIGNED IN',
      tone: 'bad',
      reason: card.reason,
      canRetry: true,
      retried: null,
    });
    expect(view.accessibilityLabel).toBe(`Dusty couldn’t finish. Not signed in. ${card.reason}`);
    // The message's own text is the sentence: the card doesn't say it twice.
    expect(
      turnFailedView(card, { text: card.reason, agent: dusty, viewer, retryFeature: true, timeZone: TZ })
        .reason,
    ).toBeNull();
  });

  it('keeps Try again from a runtime without it and from anyone but a person (the server decides who)', () => {
    const card = failedCard();
    const ctxOf = (retryFeature: boolean, who: { id: string; kind: 'person' | 'agent' } = viewer) => ({
      text: '',
      agent: dusty,
      viewer: who,
      retryFeature,
      timeZone: TZ,
    });
    expect(turnFailedView(card, ctxOf(false)).canRetry).toBe(false);
    expect(turnFailedView(card, ctxOf(true)).canRetry).toBe(true);
    expect(turnFailedView(card, ctxOf(true, { id: dusty.id, kind: 'agent' })).canRetry).toBe(false);
  });

  it('says “Tried again · 11:30” for everyone once pressed, quietly', () => {
    const card = failedCard({ retriedAt: '2026-09-23T09:30:00.000Z', retryDispatchId: 'dsp_2' });
    const view = turnFailedView(card, { text: '', agent: dusty, viewer, retryFeature: true, timeZone: TZ });
    expect(view).toMatchObject({ canRetry: false, retried: 'Tried again · 11:30', tone: 'neutral' });
  });

  it('shows the card in the chat and keeps it out of the card summaries', () => {
    const [item] = chatItems(
      [msg({ authorId: dusty.id, text: failedCard().reason, card: failedCard() })],
      ctx,
      {
        authors: true,
      },
    );
    expect(item?.card).toBeNull();
    expect(item?.turnFailed).toMatchObject({ label: 'NOT SIGNED IN', reason: null, canRetry: true });
    const [older] = chatItems([msg({ card: failedCard() })], ctx, { authors: true, retry: false });
    expect(older?.turnFailed?.canRetry).toBe(false);
  });

  it('what a refused retry says', () => {
    expect(retryFailureText(new Error('offline'))).toBe(
      'Couldn’t reach Whombat. Nothing changed, try again.',
    );
    expect(
      retryFailureText({
        status: 'pending_approval',
        approvalId: 'apv_1',
        approvalNumber: 3,
        eventId: 'evt_1',
      }),
    ).toBe('That needs a person to approve it first.');
    const refused = new ApiError(
      409,
      'conflict',
      'Mara left, so it can’t try again.',
      null,
      'dispatches.retry',
    );
    expect(retryFailureText(refused)).toBe(refused.message);
    expect(isFinalRetryRefusal(refused)).toBe(true);
    expect(isFinalRetryRefusal(new Error('offline'))).toBe(false);
  });
});

describe('branch rooms by repository (item 5, AP-514)', () => {
  const room = (id: string, prNumber: number, repo?: string) =>
    ({ id, prNumber, ...(repo ? { repo } : {}) }) as { id: string; prNumber: number; repo?: string };
  const rooms = [
    room('cnv_w1', 1, 'acme/Whombat'),
    room('cnv_c1', 1, 'acme/LumioOS'),
    room('cnv_w2', 2, 'acme/Whombat'),
  ];

  it('picks the room by number and repository, never the first of several', () => {
    expect(branchRoomFor(rooms, 1, 'acme/LumioOS')?.id).toBe('cnv_c1');
    expect(branchRoomFor(rooms, 1, undefined)).toBeNull();
    expect(branchRoomFor(rooms, 2, undefined)?.id).toBe('cnv_w2');
    expect(branchRoomFor(rooms, 1, 'Other/Repo')).toBeNull();
    // An older server's rooms carry no repo: the only room with that number is the one.
    expect(branchRoomFor([room('cnv_old', 7)], 7, 'acme/Whombat')?.id).toBe('cnv_old');
  });

  it('routes a link with a repo to its room, and an unknown or ambiguous one to the screen that asks', () => {
    const sidebar = {
      ...bootstrap().sidebar,
      branchRooms: bootstrap().sidebar.branchRooms.map((b) => ({ ...b, repo: 'burrowhq/billing' })),
    };
    expect(routeForLink({ type: 'pr', number: 482, repo: 'burrowhq/billing' }, sidebar)).toEqual({
      name: 'Conversation',
      params: { conversationId: 'cnv_pr482' },
    });
    expect(routeForLink({ type: 'pr', number: 482, repo: 'acme/Whombat' }, sidebar)).toEqual({
      name: 'Conversation',
      params: { prNumber: 482, repo: 'acme/Whombat' },
    });
    expect(routeForLink({ type: 'pr', number: 999 }, sidebar)).toEqual({
      name: 'Conversation',
      params: { prNumber: 999 },
    });
  });

  it('opens pushed paths of branch rooms', () => {
    expect(appUrlForPath('/burrow-hq/pr/1?repo=acme/LumioOS')).toBe('whombat://pr/1?repo=acme%2FLumioOS');
    // The Files changed tab opens the pull request's screen (MX-06).
    expect(appUrlForPath('/pr/482?repo=burrowhq%2Fbilling&tab=files')).toBe(
      'whombat://pr/482/files?repo=burrowhq%2Fbilling',
    );
    expect(appUrlForPath('/pr/482')).toBe('whombat://pr/482');
    expect(appUrlForPath('/pr/482?repo=not a repo')).toBe('whombat://pr/482');
  });

  it('names the repository beside the number only when the rooms come from several', () => {
    expect(
      branchRoomMeta({ prNumber: 1, repo: 'acme/LumioOS' }, new Set(['acme/LumioOS', 'acme/Whombat'])),
    ).toBe('LumioOS #1');
    expect(branchRoomMeta({ prNumber: 482, repo: 'burrowhq/billing' }, new Set(['burrowhq/billing']))).toBe(
      '#482',
    );
    expect(branchRoomMeta({ prNumber: 482, repo: null }, new Set())).toBe('#482');
  });
});

describe('the message menu, edits and tombstones (items 8, 11, AP-502…AP-505)', () => {
  const me = messageViewer({ id: mara.id });
  const features = { edit: true, pins: true };
  const kinds = (m: Message, viewer = me, options = { inThread: false, features }) =>
    messageMenu(m, viewer, options)?.actions.map((a) => a.kind);

  it('offers Reply in thread, Copy text, Edit, Pin and Delete on your own message', () => {
    expect(kinds(msg({ authorId: mara.id }))).toEqual(['reply_thread', 'copy_text', 'edit', 'pin', 'delete']);
    expect(kinds(msg({ authorId: mara.id, pinnedAt: SEED_NOW.toISOString() }))).toContain('unpin');
  });

  it('offers Save as prompt on your own message in your Chat only (prompts-phone.md)', () => {
    const chat = { inThread: false, features, savePrompt: true };
    expect(messageMenu(msg({ authorId: mara.id }), me, chat)?.actions.map((a) => a.kind)).toContain(
      'save_prompt',
    );
    expect(messageMenu(msg({ authorId: dusty.id }), me, chat)?.actions.map((a) => a.kind)).not.toContain(
      'save_prompt',
    );
    expect(kinds(msg({ authorId: mara.id }))).not.toContain('save_prompt');
  });

  it('lets you delete the agent’s message too, never edit it (AP-5732)', () => {
    expect(kinds(msg({ authorId: dusty.id }))).toEqual(['reply_thread', 'copy_text', 'pin', 'delete']);
    // A card isn't edited.
    expect(kinds(msg({ authorId: mara.id, card: failedCard() }))).not.toContain('edit');
  });

  it('leaves out what the runtime can’t do, Reply in thread inside a thread, and a message still sending', () => {
    expect(
      kinds(msg({ authorId: mara.id }), me, { inThread: false, features: { edit: false, pins: false } }),
    ).toEqual(['reply_thread', 'copy_text']);
    expect(kinds(msg({ authorId: mara.id }), me, { inThread: true, features })).toEqual([
      'copy_text',
      'edit',
      'pin',
      'delete',
    ]);
    expect(kinds(msg({ authorId: mara.id, threadRootId: 'msg_root' }))).not.toContain('reply_thread');
    expect(messageMenu(msg({ id: 'msg_local-1' }), me, { inThread: false, features })).toBeNull();
    const tombstone = messageMenu(msg({ authorId: mara.id, deletedAt: SEED_NOW.toISOString() }), me, {
      inThread: false,
      features,
    });
    expect(tombstone).toEqual({ react: false, actions: [expect.objectContaining({ kind: 'reply_thread' })] });
  });

  it('asks before deleting, and says what happens to the replies', () => {
    expect(deleteConfirm(msg({ authorId: mara.id, replyCount: 0 }), mara.id, 'Mara Okafor')).toEqual({
      title: 'Delete this message?',
      body: 'It’s removed from this conversation.',
      cta: 'Delete',
    });
    expect(deleteConfirm(msg({ authorId: dusty.id, replyCount: 3 }), mara.id, 'Dusty')).toEqual({
      title: 'Delete Dusty’s message?',
      body: 'It’s removed from this conversation, with its replies.',
      cta: 'Delete',
    });
  });

  it('saves an edit only when the text changed and isn’t empty (unless files carry it)', () => {
    expect(canSaveEdit('Hello', 'Hello ', false)).toBe(false);
    expect(canSaveEdit('Hello', 'Hello there', false)).toBe(true);
    expect(canSaveEdit('Hello', '  ', false)).toBe(false);
    expect(canSaveEdit('', 'A caption', true)).toBe(true);
    expect(canSaveEdit('Caption', '', true)).toBe(true);
    expect(editProblem('Hello', '', false)).toBe('A message needs some text.');
    expect(editProblem('Hello', 'x'.repeat(50_000), false)).toBe('That message is too long.');
    expect(editProblem('Hello', 'Hi', false)).toBeNull();
  });

  it('shows a deleted thread root as a quiet tombstone with its replies, and marks edits and pins', () => {
    const [tomb, edited] = chatItems(
      [
        msg({
          id: 'msg_t',
          authorId: dusty.id,
          deletedAt: SEED_NOW.toISOString(),
          text: '',
          replyCount: 2,
          threadRootId: null,
        }),
        msg({
          id: 'msg_e',
          authorId: mara.id,
          editedAt: SEED_NOW.toISOString(),
          pinnedAt: SEED_NOW.toISOString(),
        }),
      ],
      ctx,
      { authors: true },
    );
    expect(tomb).toMatchObject({
      deleted: true,
      text: MESSAGE_DELETED_TEXT,
      replies: '2 replies',
      card: null,
      attachments: [],
    });
    expect(edited).toMatchObject({ deleted: false, edited: true, pinned: true });
  });
});

describe('reactions, previews (item 14, AP-507, AP-508)', () => {
  it('turns reactions into pills TalkBack can read', () => {
    const pills = reactionPills([
      { value: '👍', count: 2, mine: true, principalIds: [mara.id, dusty.id] },
      { value: 'finally', count: 1, mine: false, principalIds: [dusty.id] },
    ]);
    expect(pills).toEqual([
      { value: '👍', count: 2, mine: true, accessibilityLabel: 'thumbs up, you and 1 more' },
      { value: 'finally', count: 1, mine: false, accessibilityLabel: 'finally, 1 reaction' },
    ]);
    expect(quickReactions([{ value: '👍', count: 1, mine: true, principalIds: [mara.id] }])[0]).toEqual({
      value: '👍',
      mine: true,
    });
  });

  it('lists recent emoji and the groups, or only what a search finds', () => {
    const sections = emojiSections('', ['🎉', 'not-an-emoji']);
    expect(sections[0]).toMatchObject({ key: 'recent', title: 'RECENT' });
    expect(sections[0]?.emoji.map((e) => e.char)).toEqual(['🎉']);
    expect(sections.map((s) => s.key).slice(1, 3)).toEqual(['smileys', 'people']);
    const found = emojiSections('thumbs', []);
    expect(found).toHaveLength(1);
    expect(found[0]?.emoji[0]?.char).toBe('👍');
    expect(emojiSections('zzzzqqq', [])).toEqual([]);
    expect(recentAfter(['👍', '🎉'], '🎉')).toEqual(['🎉', '👍']);
    expect(parseRecentEmoji('["👍",3,"🎉"]')).toEqual(['👍', '🎉']);
    expect(parseRecentEmoji('not json')).toEqual([]);
  });

  it('lays the sections out as a virtualised list of labels and rows, as the wrapped grid had them (AP-905)', () => {
    // The 368dp phone: (368 − 2 × 14) / 44 → 7 a row.
    expect(emojiPerRow(368)).toBe(7);
    expect(emojiPerRow(30)).toBe(1);
    const sections = emojiSections('', ['🎉']);
    const lines = emojiLines(sections, 7);
    expect(lines[0]).toEqual({ kind: 'title', key: 'recent:title', title: 'RECENT' });
    expect(lines[1]).toMatchObject({ kind: 'row', section: 'recent' });
    // Every emoji once, in order, at most seven a row; keys unique.
    const rows = lines.filter((l) => l.kind === 'row');
    expect(rows.flatMap((r) => r.emoji)).toEqual(sections.flatMap((s) => s.emoji));
    expect(rows.every((r) => r.emoji.length >= 1 && r.emoji.length <= 7)).toBe(true);
    expect(new Set(lines.map((l) => l.key)).size).toBe(lines.length);
    expect(lines.filter((l) => l.kind === 'title').map((l) => l.title)).toEqual(sections.map((s) => s.title));
    expect(emojiLines([], 7)).toEqual([]);
  });
});

describe('notification levels, Do not disturb and quiet hours (item 12, AP-511…AP-513)', () => {
  it('offers All / Mentions / Nothing with the kind’s default marked and the level in effect selected', () => {
    const branch = notifyOptions({ kind: 'branch' });
    expect(branch.map((o) => o.level)).toEqual(['all', 'mentions', 'none']);
    const fallback = branch.find((o) => o.selected)?.level;
    expect(branch.find((o) => o.selected)?.detail).toMatch(/· default$/);
    expect(notifyOptions({ kind: 'dm', notify: 'none' }).find((o) => o.selected)?.level).toBe('none');
    // Picking the default follows the default again (null); anything else is stored.
    expect(notifyBody('branch', fallback ?? 'mentions')).toBeNull();
    expect(notifyBody('branch', 'none')).toBe('none');
  });

  it('says when Do not disturb ends, and reads a typed “until” as the next time the clock shows it', () => {
    const now = SEED_NOW; // 11:22 in Amsterdam
    expect(dndStateText({ dndUntil: null }, now, TZ)).toBe('Off');
    expect(dndStateText({ dndUntil: '2026-09-23T10:00:00.000Z' }, now, TZ)).toBe('On until 12:00');
    expect(dndStateText({ dndUntil: '2026-09-23T09:00:00.000Z' }, now, TZ)).toBe('Off');
    expect(dndUntilClock('18:30', now, TZ)).toEqual({ ok: true, until: '2026-09-23T16:30:00.000Z' });
    expect(dndUntilClock('9:00', now, TZ)).toEqual({ ok: true, until: '2026-09-24T07:00:00.000Z' });
    expect(dndUntilClock('25:00', now, TZ)).toEqual({ ok: false, error: 'Type a time such as 18:30.' });
    expect(parseClock('0730')).toBe('07:30');
    expect(parseClock('7.30')).toBe('07:30');
    expect(parseClock('7')).toBeNull();
    expect(nextWholeHour(now, TZ)).toBe('12:00');
    expect(nextWholeHour('2026-09-23T21:59:00.000Z', TZ)).toBe('00:00');
  });
});
