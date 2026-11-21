import { QueryClient } from '@tanstack/query-core';
import { GuideCard, type Message, type MessagePage } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { describe, expect, it } from 'vitest';
import {
  answeredGuideCard,
  GUIDE_NETWORK_TEXT,
  guideFailureText,
  guideRefusalOf,
  optimisticGuideLabel,
} from './guides';
import { ApiError, InvalidRequestError, NetworkError } from './http/errors';
import { infiniteEndpointKey } from './query/keys';
import { applyOptimisticGuideAnswer, findCachedMessage, restore } from './query/optimistic';

const card = GuideCard.parse({
  kind: 'guide',
  guide: 'email',
  node: 'provider',
  title: 'Which email do you use?',
  state: 'open',
  blocks: [
    {
      type: 'choices',
      id: 'provider',
      options: [
        { id: 'google', title: 'Google', icon: { brand: 'google' } },
        { id: 'microsoft', title: 'Microsoft 365', disabled: true },
      ],
    },
    { type: 'actions', actions: [{ id: 'later', label: 'Maybe later', style: 'quiet' }] },
    {
      type: 'form',
      id: 'client',
      fields: [{ id: 'clientId', label: 'Client ID', kind: 'text' }],
      submitLabel: 'Save',
    },
  ],
});

const refusal = (status: number, generic: string, code: string, message: string, fields = {}) =>
  new ApiError(
    status,
    generic as never,
    message,
    { error: { code: generic, message, details: { code }, fields } },
    'guides.act',
    fields,
  );

describe('guide answers (AG-03)', () => {
  it('labels the lock with what was picked', () => {
    expect(optimisticGuideLabel(card, { actionId: 'provider', optionIds: ['google'] })).toBe('Google');
    expect(optimisticGuideLabel(card, { actionId: 'later' })).toBe('Maybe later');
    expect(optimisticGuideLabel(card, { actionId: 'client', values: { clientId: 'x' } })).toBe('Sending…');
  });

  it('locks the card with the answer, never the values', () => {
    const done = answeredGuideCard(card, { actionId: 'client', values: { clientId: 'secret' } }, NOW);
    expect(done.state).toBe('done');
    expect(done.answer).toEqual({ actionId: 'client', optionIds: null, label: 'Sending…', at: NOW });
    expect(JSON.stringify(done)).not.toContain('secret');
  });

  it('locks the cached message and rolls back', () => {
    const qc = new QueryClient();
    const message = { ...baseMessage, clientId: null, card } as Message;
    const key = infiniteEndpointKey(api.messages.list, {
      params: { burrow: 'hq', conversationId: 'cnv_dm' },
    });
    qc.setQueryData(key, { pages: [page(message)], pageParams: [undefined] });
    const snap = applyOptimisticGuideAnswer(
      qc,
      message.id,
      { actionId: 'provider', optionIds: ['google'] },
      NOW,
    );
    expect(snap).not.toBeNull();
    const locked = findCachedMessage(qc, message.id)?.card;
    expect(locked?.kind === 'guide' && locked.state).toBe('done');
    // A second tap on a locked card does nothing here.
    expect(applyOptimisticGuideAnswer(qc, message.id, { actionId: 'later' }, NOW)).toBeNull();
    restore(qc, snap ?? []);
    const back = findCachedMessage(qc, message.id)?.card;
    expect(back?.kind === 'guide' && back.state).toBe('open');
  });
});

describe('guide refusals (CT-81)', () => {
  it('shows nothing for a card another tab answered', () => {
    const e = refusal(409, 'conflict', 'guide_closed', 'This step is done.');
    expect(guideRefusalOf(e)?.code).toBe('guide_closed');
    expect(guideFailureText(e)).toBeNull();
  });

  it('keys field errors by the form’s field ids', () => {
    const e = refusal(422, 'validation_failed', 'invalid_values', 'Check the Client ID.', {
      'values.clientId': ['That isn’t a Google Client ID.'],
    });
    expect(guideRefusalOf(e)).toEqual({
      code: 'invalid_values',
      message: 'Check the Client ID.',
      fields: { clientId: 'That isn’t a Google Client ID.' },
    });
    const local = new InvalidRequestError('guides.act', 'body', { 'values.clientSecret': ['Too long'] });
    expect(guideRefusalOf(local)?.fields).toEqual({ clientSecret: 'Too long' });
  });

  it('says Whombat wasn’t reached for transport failures', () => {
    expect(guideFailureText(new NetworkError('guides.act', new Error('offline')))).toBe(GUIDE_NETWORK_TEXT);
  });
});

const NOW = '2026-09-26T10:00:00.000Z';
const baseMessage = {
  id: 'msg_guide1',
  conversationId: 'cnv_dm',
  authorId: 'agt_tulip',
  createdAt: NOW,
  editedAt: null,
  text: '',
  mentions: [],
  suggestions: [],
  more: null,
  attachments: [],
  reactions: [],
  threadRootId: null,
  replyCount: 0,
  lastReplyAt: null,
  threadParticipantIds: [],
};
function page(m: Message): MessagePage {
  return { messages: [m], hasMore: false } as unknown as MessagePage;
}
