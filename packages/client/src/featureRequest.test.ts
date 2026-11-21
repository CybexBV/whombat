import { FEATURE_REQUEST_WORDS } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { cardDisplay, featureRequestLine, textFoldsIntoCard } from './cardDisplay';
import {
  canSendNote,
  customerReads,
  FEATURE_NOTE_MAX,
  featureDecideBody,
  featureDecidedToast,
  featureRequestLabel,
  featureValueLabel,
} from './featureRequest';

describe('a feature request’s card', () => {
  it('sends approving without words, a reason or question trimmed', () => {
    expect(featureDecideBody('approve', 'ignored')).toEqual({ choice: 'approve' });
    expect(featureDecideBody('build')).toEqual({ choice: 'build' });
    expect(featureDecideBody('decline', '  Only one school asked.  ')).toEqual({
      choice: 'decline',
      note: 'Only one school asked.',
    });
    expect(featureDecideBody('ask', ' Which file format? ')).toEqual({
      choice: 'ask',
      note: 'Which file format?',
    });
    // An emptied reason leaves the note out: the server then uses the agent's own.
    expect(featureDecideBody('decline', '   ')).toEqual({ choice: 'decline' });
  });

  it('sends a form only with words, within the limit', () => {
    expect(canSendNote('')).toBe(false);
    expect(canSendNote('  \n ')).toBe(false);
    expect(canSendNote('Which file format?')).toBe(true);
    expect(canSendNote('x'.repeat(FEATURE_NOTE_MAX))).toBe(true);
    expect(canSendNote('x'.repeat(FEATURE_NOTE_MAX + 1))).toBe(false);
  });

  it('folds both drafts under their labels, leaving an empty one out', () => {
    const both = customerReads({ approvedMessage: 'Yes.\n\nNeo - AI Assistant', declinedMessage: 'No.' });
    expect(both.map((r) => r.id)).toEqual(['approved', 'declined']);
    expect(both.map((r) => r.label)).toEqual([
      FEATURE_REQUEST_WORDS.ifApproved,
      FEATURE_REQUEST_WORDS.ifDeclined,
    ]);
    // Line breaks stay: the customer reads it as it is.
    expect(both[0]?.text).toContain('\n\n');
    expect(customerReads({ approvedMessage: '', declinedMessage: 'No.' }).map((r) => r.id)).toEqual([
      'declined',
    ]);
    expect(customerReads({ approvedMessage: ' ', declinedMessage: '' })).toEqual([]);
  });

  it('names the value chip and the card for screen readers', () => {
    expect(featureValueLabel(7)).toBe('Value 7 of 10');
    expect(featureValueLabel(null)).toBe('Not scored');
    expect(featureRequestLabel({ title: 'Schedule rollouts' })).toBe('Feature request: Schedule rollouts');
  });

  it('says who tells the customer once the answer is kept', () => {
    for (const choice of ['approve', 'build', 'decline', 'ask'] as const)
      expect(featureDecidedToast(choice, 'Neo')).toContain('Neo');
    expect(featureDecidedToast('build', 'Neo')).not.toBe(featureDecidedToast('approve', 'Neo'));
  });

  it('is a card while it waits and a line after, its own text folded in once resolved', () => {
    const request = {
      state: 'waiting',
      choice: null,
      note: null,
      declineReason: 'Few need it.',
      title: 'Export to CSV',
    } as const;
    const card = { kind: 'feature_request', requestId: 'tfr_a', request } as never;
    expect(cardDisplay(card)).toBe('full');
    expect(
      cardDisplay({
        kind: 'feature_request',
        requestId: 'tfr_a',
        request: { ...request, state: 'decided' },
      } as never),
    ).toBe('line');
    expect(textFoldsIntoCard('Feature request: …', card)).toBe(true);
    expect(
      textFoldsIntoCard('Feature request: …', {
        kind: 'feature_request',
        requestId: 'tfr_a',
        request: null,
      } as never),
    ).toBe(false);
    expect(featureRequestLine({ ...request, state: 'decided', choice: 'approve' }, 'John')).toMatchObject({
      lead: 'Approved by John · Planned',
      detail: 'Export to CSV',
    });
  });
});
