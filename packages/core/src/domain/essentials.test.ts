/** Contracts 0.26, the essentials (CT-167…CT-181): the pure rules and the new shapes. */
import { describe, expect, it } from 'vitest';
import { dusty, mara, NOW, TZ } from '../__fixtures__/world.js';
import { api, Bootstrap, ConversationDetail, DispatchContext, SearchQuery } from '../contracts/index.js';
import { canRetryTurn, MessageCard, StoredCard, TurnFailedCard } from './cards.js';
import {
  ConversationSummary,
  conversationLabel,
  conversationLink,
  defaultNotifyLevel,
  notifyLevelOf,
} from './conversation.js';
import { TurnFailureCode, turnFailureDetail } from './dispatch.js';
import { LinkRef, linkPath } from './links.js';
import { addedMentions, canDeleteMessage, canEditMessage, canPinMessage, Message } from './message.js';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  dndUntilFor,
  inQuietHours,
  isDndActive,
  isQuietNow,
  NotificationPreferences,
  notifyReason,
  zonedInstant,
} from './notify.js';
import { Agent, Person } from './principal.js';
import { DispatchSummary, WorkItem } from './work.js';

const T = '2026-09-30T10:00:00.000Z';
const personViewer = (id: string) => ({ id, kind: 'person' as const });

describe('links (CT-170, CT-171)', () => {
  it('a branch room link carries its repo, readable in the path', () => {
    const link = LinkRef.parse({ type: 'pr', number: 1, repo: 'acme/Whombat' });
    expect(linkPath('burrow-hq', link)).toBe('/burrow-hq/pr/1?repo=acme/Whombat');
    expect(linkPath('burrow-hq', { type: 'pr', number: 1, repo: 'a/b', tab: 'files' })).toBe(
      '/burrow-hq/pr/1?repo=a/b&tab=files',
    );
    expect(linkPath('burrow-hq', { type: 'pr', number: 482 })).toBe('/burrow-hq/pr/482');
    expect(LinkRef.safeParse({ type: 'pr', number: 1, repo: 'no-slash' }).success).toBe(false);
  });

  it('message, approval and plan links inside a repo room keep one query string', () => {
    const inRoom = { type: 'pr' as const, number: 7, repo: 'acme/LumioOS' };
    expect(linkPath('b', { type: 'message', in: inRoom, messageId: 'msg_1', threadRootId: 'msg_0' })).toBe(
      '/b/pr/7?repo=acme/LumioOS&thread=msg_0',
    );
    expect(linkPath('b', { type: 'message', in: inRoom, messageId: 'msg_1' })).toBe(
      '/b/pr/7?repo=acme/LumioOS#msg_1',
    );
    expect(linkPath('b', { type: 'approval', number: 3, in: inRoom })).toBe(
      '/b/pr/7?repo=acme/LumioOS&approval=3',
    );
    expect(linkPath('b', { type: 'plan', planId: 'pln_1', in: inRoom, stepId: 'stp_2' })).toBe(
      '/b/pr/7?repo=acme/LumioOS&plan=pln_1&step=stp_2',
    );
    expect(
      linkPath('b', { type: 'message', in: { type: 'dm' }, messageId: 'msg_1', threadRootId: 'msg_0' }),
    ).toBe('/b/chat?thread=msg_0');
  });

  it('a person’s rooms link to their room, branch rooms to their PR', () => {
    expect(conversationLink({ id: 'cnv_d1', kind: 'dm', slug: 'dm-mara', prNumber: null })).toEqual({
      type: 'dm',
    });
    expect(conversationLink({ kind: 'dm', slug: 'feedback-mara', prNumber: null, room: 'feedback' })).toEqual(
      {
        type: 'dm',
        room: 'feedback',
      },
    );
    expect(conversationLink({ kind: 'branch', slug: 'x', prNumber: 1, repo: 'acme/Whombat' })).toEqual({
      type: 'pr',
      number: 1,
      repo: 'acme/Whombat',
    });
    expect(conversationLink({ kind: 'branch', slug: 'x', prNumber: 1 })).toEqual({ type: 'pr', number: 1 });
  });
});

describe('conversations (CT-171, CT-172, CT-175)', () => {
  it('notification levels default by kind', () => {
    expect(defaultNotifyLevel('dm')).toBe('all');
    expect(defaultNotifyLevel('branch')).toBe('mentions');
    expect(notifyLevelOf({ kind: 'branch' })).toBe('mentions');
    expect(notifyLevelOf({ kind: 'branch', notify: 'none' })).toBe('none');
    expect(notifyLevelOf({ kind: 'dm', notify: null })).toBe('all');
  });

  it('a conversation is named by its title', () => {
    expect(conversationLabel({ kind: 'dm', title: 'Chat' })).toBe('Chat');
    expect(conversationLabel({ kind: 'branch', title: 'feat/invoice-pdf' })).toBe('feat/invoice-pdf');
  });

  it('summaries and details take the new optional fields and still parse without them', () => {
    const base = {
      id: 'cnv_d1',
      kind: 'dm',
      slug: 'dm-mara',
      title: 'Chat',
      link: { type: 'dm' },
      unread: 0,
      mentions: 0,
      prNumber: null,
      lastMessageAt: null,
    };
    expect(ConversationSummary.parse(base).notify).toBeUndefined();
    expect(ConversationSummary.parse({ ...base, notify: 'none' }).notify).toBe('none');
    expect(ConversationSummary.safeParse({ ...base, notify: 'loud' }).success).toBe(false);
    expect(ConversationDetail.shape.notify.safeParse(undefined).success).toBe(true);
  });
});

describe('messages (CT-173, CT-174, CT-176)', () => {
  const own = { authorId: mara.id, card: null, deletedAt: null };
  it('people edit their own text messages; not cards, not tombstones; agents never', () => {
    expect(canEditMessage(own, personViewer(mara.id))).toBe(true);
    expect(canEditMessage({ ...own, authorId: dusty.id }, personViewer(mara.id))).toBe(false);
    expect(
      canEditMessage({ ...own, card: { kind: 'pill', text: 'x', tone: 'ok' } }, personViewer(mara.id)),
    ).toBe(false);
    expect(canEditMessage({ ...own, deletedAt: T }, personViewer(mara.id))).toBe(false);
    expect(canEditMessage({ ...own, authorId: dusty.id }, { id: dusty.id, kind: 'agent' })).toBe(false);
    expect(canEditMessage(own, undefined)).toBe(false);
  });

  it('the person deletes any message; tombstones stay; agents never (CT-1517)', () => {
    expect(canDeleteMessage(own, personViewer(mara.id))).toBe(true);
    expect(canDeleteMessage({ ...own, authorId: dusty.id }, personViewer(mara.id))).toBe(true);
    expect(canDeleteMessage({ ...own, deletedAt: T }, personViewer(mara.id))).toBe(false);
    expect(canDeleteMessage({ authorId: dusty.id }, { id: dusty.id, kind: 'agent' })).toBe(false);
    expect(canPinMessage({}, personViewer(mara.id))).toBe(true);
    expect(canPinMessage({ deletedAt: T }, personViewer(mara.id))).toBe(false);
    expect(canPinMessage({}, { id: dusty.id, kind: 'agent' })).toBe(false);
  });

  it('an edit wakes or notifies only the mentions it adds', () => {
    expect(addedMentions(['a', 'b'], ['b', 'c', 'a', 'c'])).toEqual(['c']);
    expect(addedMentions([], ['a'])).toEqual(['a']);
    expect(addedMentions(['a'], [])).toEqual([]);
  });

  it('a message takes the new fields and a tombstone parses', () => {
    const m = {
      id: 'msg_1',
      conversationId: 'cnv_dm-mara',
      authorId: mara.id,
      createdAt: T,
      editedAt: null,
      text: '',
      mentions: [],
      card: null,
      attachments: [],
      reactions: [],
      threadRootId: null,
      replyCount: 2,
      lastReplyAt: T,
      threadParticipantIds: [],
      clientId: null,
    };
    expect(Message.parse(m).deletedAt).toBeUndefined();
    const full = Message.parse({
      ...m,
      deletedAt: T,
      pinnedAt: T,
      pinnedById: mara.id,
    });
    expect(full).toMatchObject({ deletedAt: T, pinnedById: mara.id });
  });
});

describe('people and agents (CT-177; since 3.0 one person, CT-1507)', () => {
  it('the person has no role and is never removed; the agent is never gone', () => {
    expect(Person.parse({ ...mara, role: 'owner', removedAt: T })).not.toHaveProperty('role');
    expect(Person.parse({ ...mara, removedAt: T })).not.toHaveProperty('removedAt');
    expect(Agent.parse({ ...dusty, retiredAt: T })).not.toHaveProperty('retiredAt');
  });
});

describe('failed turns (CT-167)', () => {
  const card = {
    kind: 'turn_failed',
    dispatchId: 'dsp_1',
    agentId: dusty.id,
    code: 'sandbox',
    reason: 'I couldn’t start my workspace.',
  };

  it('the card parses as a message card and as stored, defaults the retry to null', () => {
    const parsed = TurnFailedCard.parse(card);
    expect(parsed).toMatchObject({ retriedAt: null, retryDispatchId: null });
    expect(MessageCard.parse(card).kind).toBe('turn_failed');
    expect(StoredCard.parse(card).kind).toBe('turn_failed');
    expect(TurnFailedCard.safeParse({ ...card, reason: 'x'.repeat(201) }).success).toBe(false);
    expect(TurnFailedCard.safeParse({ ...card, code: 'weird' }).success).toBe(false);
  });

  it('Try again: any person, until someone pressed it', () => {
    const c = TurnFailedCard.parse(card);
    expect(canRetryTurn(c, personViewer(mara.id))).toBe(true);
    expect(canRetryTurn({ retriedAt: T }, personViewer(mara.id))).toBe(false);
    expect(canRetryTurn(c, { id: dusty.id, kind: 'agent' })).toBe(false);
    expect(canRetryTurn(c, undefined)).toBe(false);
  });

  it('the technical detail is redacted and bounded', () => {
    expect(turnFailureDetail('')).toBeNull();
    expect(turnFailureDetail(null)).toBeNull();
    const d = turnFailureDetail('auth failed: Authorization: Bearer abcdefghijklmnopqrstuvwx\u0007 end');
    expect(d).toContain('[redacted]');
    expect(d).not.toContain('abcdefghijklmnop');
    expect(d).not.toContain('\u0007');
    const long = turnFailureDetail(`start ${'x '.repeat(3000)}Read-only file system`) as string;
    expect(long.length).toBe(2000);
    expect(long.startsWith('…')).toBe(true);
    expect(long.endsWith('Read-only file system')).toBe(true);
  });

  it('dispatch summaries and work items carry the failure; older answers parse', () => {
    const summary = {
      id: 'dsp_1',
      agentId: dusty.id,
      conversationId: 'cnv_dm-mara',
      threadRootId: null,
      trigger: 'retry',
      state: 'failed',
      runId: null,
      createdAt: T,
      claimedAt: null,
      heartbeatAt: null,
      finishedAt: T,
      reason: null,
    };
    expect(DispatchSummary.parse(summary).failure).toBeUndefined();
    expect(
      DispatchSummary.parse({ ...summary, failure: { code: 'timeout', reason: 'Out of time.' } }).failure
        ?.code,
    ).toBe('timeout');
    const item = {
      id: 'dispatch:dsp_1',
      kind: 'dispatch',
      section: 'failed',
      title: 'Turn',
      where: 'Chat',
      agentId: dusty.id,
      ownerId: null,
      status: { text: 'FAILED', tone: 'bad' },
      detail: null,
      since: T,
      health: null,
      activity: null,
      link: { type: 'work' },
      actions: ['retry_turn'],
      refs: { conversationId: null, dispatchId: 'dsp_1' },
      failure: { code: 'sandbox', reason: 'The sandbox didn’t start.', detail: 'x'.repeat(2000) },
    };
    const w = WorkItem.parse(item);
    expect(w.failure).toMatchObject({ code: 'sandbox', retriedAt: null, retryDispatchId: null });
    expect(
      WorkItem.safeParse({ ...item, failure: { ...item.failure, detail: 'x'.repeat(2001) } }).success,
    ).toBe(false);
    expect(TurnFailureCode.options).toEqual([
      'signin',
      'usage_limit',
      'provider',
      'refused',
      'sandbox',
      'timeout',
      'runner',
      'workspace',
      'internal',
    ]);
  });

  it('the runner reports the classification and the retry context reaches the turn', () => {
    expect(api.dispatches.retry.path).toBe('/burrows/:burrow/dispatches/:dispatchId/retry');
    expect(api.dispatches.retry.method).toBe('POST');
    expect(
      DispatchContext.shape.retry.safeParse({ dispatchId: 'dsp_1', code: 'runner', reason: 'x' }).success,
    ).toBe(true);
    expect(DispatchContext.shape.grantedApproval.safeParse(undefined).success).toBe(true);
  });
});

describe('notifications (CT-175, CT-176)', () => {
  const at = (hhmm: string, day = '2026-09-30') =>
    zonedInstant(
      { year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)), day: Number(day.slice(8, 10)) },
      hhmm,
      TZ,
    );

  it('zoned instants follow the zone and its DST', () => {
    expect(at('08:00').toISOString()).toBe('2026-09-30T06:00:00.000Z');
    expect(at('08:00', '2026-12-01').toISOString()).toBe('2026-12-01T07:00:00.000Z');
  });

  it('DND lasts until its time', () => {
    expect(isDndActive({ dndUntil: null }, NOW)).toBe(false);
    expect(isDndActive({ dndUntil: '2026-09-23T10:00:00.000Z' }, NOW)).toBe(true);
    expect(isDndActive({ dndUntil: '2026-09-23T09:22:00.000Z' }, NOW)).toBe(false);
    expect(dndUntilFor('30m', NOW, TZ)).toBe('2026-09-23T09:52:00.000Z');
    expect(dndUntilFor('1h', NOW, TZ)).toBe('2026-09-23T10:22:00.000Z');
    // Wednesday 11:22 in Amsterdam → Thursday 08:00 local.
    expect(dndUntilFor('tomorrow', NOW, TZ)).toBe('2026-09-24T06:00:00.000Z');
  });

  it('quiet hours: same-day and overnight, on the listed days', () => {
    const night = { enabled: true, start: '22:00', end: '08:00', days: ['wed' as const] };
    // 2026-09-30 is a Wednesday.
    expect(inQuietHours(night, at('23:00'), TZ)).toBe(true);
    expect(inQuietHours(night, at('07:59', '2026-10-01'), TZ)).toBe(true);
    expect(inQuietHours(night, at('08:00', '2026-10-01'), TZ)).toBe(false);
    expect(inQuietHours(night, at('07:00'), TZ)).toBe(false);
    expect(inQuietHours({ ...night, enabled: false }, at('23:00'), TZ)).toBe(false);
    const lunch = { enabled: true, start: '12:00', end: '13:00', days: ['wed' as const] };
    expect(inQuietHours(lunch, at('12:30'), TZ)).toBe(true);
    expect(inQuietHours(lunch, at('13:00'), TZ)).toBe(false);
    expect(inQuietHours({ ...lunch, start: '09:00', end: '09:00' }, at('03:00'), TZ)).toBe(true);
  });

  it('preferences default and parse; quiet = DND or quiet hours', () => {
    expect(NotificationPreferences.parse({})).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    expect(DEFAULT_NOTIFICATION_PREFERENCES).toMatchObject({
      email: 'hourly',
      threadReplies: true,
      dndUntil: null,
    });
    expect(
      NotificationPreferences.safeParse({
        schedule: { enabled: true, start: '24:00', end: '08:00', days: [] },
      }).success,
    ).toBe(false);
    expect(
      isQuietNow({ ...DEFAULT_NOTIFICATION_PREFERENCES, dndUntil: '2026-09-23T10:00:00.000Z' }, NOW, TZ),
    ).toBe(true);
    expect(isQuietNow(DEFAULT_NOTIFICATION_PREFERENCES, NOW, TZ)).toBe(false);
  });

  it('who a message notifies, and why', () => {
    const base = { recipientId: 'p', authorId: 'a', mentionIds: [] as string[] };
    expect(notifyReason({ ...base, kind: 'branch' })).toBeNull();
    expect(notifyReason({ ...base, kind: 'branch', mentionIds: ['p'] })).toBe('mention');
    expect(notifyReason({ ...base, kind: 'branch', notify: 'none', mentionIds: ['p'] })).toBeNull();
    expect(notifyReason({ ...base, kind: 'branch', inThread: true })).toBe('reply');
    expect(notifyReason({ ...base, kind: 'branch', inThread: true, threadReplies: false })).toBeNull();
    expect(notifyReason({ ...base, kind: 'branch', notify: 'all' })).toBe('all');
    expect(notifyReason({ ...base, kind: 'dm' })).toBe('all');
    expect(notifyReason({ ...base, kind: 'dm', notify: 'mentions' })).toBeNull();
    expect(notifyReason({ ...base, kind: 'dm', authorId: 'p' })).toBeNull();
  });
});

describe('the shell and search (CT-175, CT-179, CT-180)', () => {
  it('bootstrap takes capabilities, and no presence since 3.0 (CT-1515)', () => {
    const shape = Bootstrap.shape;
    expect(shape.capabilities.safeParse({ emailNotifications: false, webPush: true }).success).toBe(true);
    expect(shape).not.toHaveProperty('presence');
    expect(Object.keys(shape.sidebar.shape).sort()).toEqual(['branchRooms', 'counts', 'dms']);
  });

  it('search takes from, in, after, before and a cursor', () => {
    const q = SearchQuery.parse({
      q: '',
      from: 'dusty',
      in: 'cnv_dm-mara',
      after: '2026-09-01',
      before: '2026-09-30',
      cursor: 'abc',
      limit: '50',
    });
    expect(q).toMatchObject({ type: 'all', limit: 50, from: 'dusty', after: '2026-09-01' });
    expect(SearchQuery.safeParse({ q: 'x', after: '2026-9-1' }).success).toBe(false);
    expect(SearchQuery.safeParse({ q: 'x', limit: 101 }).success).toBe(false);
  });
});
