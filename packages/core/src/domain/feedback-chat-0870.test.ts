import { describe, expect, it } from 'vitest';
import { feedbackEndpoints } from '../contracts/feedback.js';
import { CHAT_TITLE_MAX, conversationLink } from './conversation.js';
import { FeedbackIntegration, FeedbackIntegrationSettings, feedbackChatTitle } from './feedback.js';

/* Contracts 0.87.0 (CT-383): website feedback in a person's Feedback room (Whombat less-is-more.md LM-01, OA-16). */

const SETTINGS = {
  name: 'Billing portal',
  productLabel: 'Burrow Billing',
  allowedOrigins: ['https://billing.example.com'],
  repoId: null,
  reportTypes: ['bug', 'feature'],
};

const CHAT = { id: 'cnv_feedback-mara' };

const SAVED = {
  ...SETTINGS,
  conversationId: CHAT.id,
  chat: CHAT,
  id: 'fbi_billing-portal',
  siteId: 'fbs_Q7m2Xc9LpR4tVb8NwK3zHd6J',
  intake: 'enabled',
  assessment: 'active',
  revision: 2,
  configHash: 'c'.repeat(64),
  createdById: 'prn_mara',
  createdAt: '2026-10-18T09:00:00.000Z',
  updatedById: 'prn_mara',
  updatedAt: '2026-10-18T09:00:00.000Z',
};

describe('feedback in a chat (CT-383)', () => {
  it('takes settings without a room or an agent; the handoff is off unless switched on', () => {
    const parsed = FeedbackIntegrationSettings.parse(SETTINGS);
    expect(parsed.handoff).toBe('off');
    expect(parsed).not.toHaveProperty('channelId');
    expect(FeedbackIntegrationSettings.parse({ ...SETTINGS, handoff: 'on' }).handoff).toBe('on');
    expect(FeedbackIntegrationSettings.safeParse({ ...SETTINGS, handoff: 'prn_dusty' }).success).toBe(false);
    expect(feedbackEndpoints.createIntegration.body?.safeParse(SETTINGS).success).toBe(true);
  });

  it('always names the room of a saved integration (the person’s Feedback room)', () => {
    const saved = FeedbackIntegration.parse(SAVED);
    expect(saved.chat).toEqual(CHAT);
    expect(saved.conversationId).toBe(CHAT.id);
    const { chat: _chat, ...withoutChat } = SAVED;
    expect(FeedbackIntegration.safeParse(withoutChat).success).toBe(false);
    const { conversationId: _room, ...withoutRoom } = SAVED;
    expect(FeedbackIntegration.safeParse(withoutRoom).success).toBe(false);
    expect(conversationLink({ kind: 'dm', slug: 'x', prNumber: null, room: 'feedback' })).toEqual({
      type: 'dm',
      room: 'feedback',
    });
    expect(
      conversationLink({ kind: 'dm', slug: 'x', prNumber: null, id: CHAT.id, chat: { title: 't' } }),
    ).toEqual({ type: 'chat', id: CHAT.id });
  });

  it('titles the chat after the integration, within a chat title’s 60 characters', () => {
    expect(feedbackChatTitle('Billing portal')).toBe('Website feedback · Billing portal');
    expect(feedbackChatTitle('  Lumio \n site ')).toBe('Website feedback · Lumio site');
    expect(feedbackChatTitle('')).toBe('Website feedback');
    const long = feedbackChatTitle('A very long name for the customer billing portal of Burrow');
    expect([...long].length).toBe(CHAT_TITLE_MAX);
    expect(long.endsWith('…')).toBe(true);
  });
});
