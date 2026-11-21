import { describe, expect, it } from 'vitest';
import {
  approvalAnswerChoices,
  approvalPermissionText,
  approvalTonight,
  approvalUnmet,
  exactMomentText,
} from './card.js';

describe('approval card facts', () => {
  it('spells out the exact moment Yes, tonight means, with its zone', () => {
    const at = '2026-09-24T01:00:00.000Z';
    expect(exactMomentText(at, 'Europe/Amsterdam')).toBe(
      'Thursday, 24 September 2026 at 03:00 · Europe/Amsterdam',
    );
    expect(approvalTonight(at, 'Europe/Amsterdam')?.label).toBe('Yes, tonight');
    expect(approvalTonight(null, 'Europe/Amsterdam')).toBeNull();
  });

  it('names the key it uses, or says the request did not supply one', () => {
    expect(approvalPermissionText('connections.write')).toContain('Change things in connected services');
    expect(approvalPermissionText(undefined)).toBe('Not supplied in this request');
  });

  it('keeps one order of answers, with and without a later time', () => {
    expect(approvalAnswerChoices(true).map((a) => a.label)).toEqual(['Yes, now', 'Yes, tonight', 'No']);
    expect(approvalAnswerChoices(false).map((a) => a.label)).toEqual(['Yes, do it', 'No']);
  });

  it('lists what it still waits for without the person’s own yes', () => {
    const unmet = approvalUnmet({
      conditions: [
        {
          id: 'p',
          kind: 'person_approves',
          met: false,
          label: 'A person says yes',
          mobileLabel: '',
          note: 'you',
          mobileNote: '',
          mark: '',
        },
        {
          id: 'c',
          kind: 'checks_pass',
          met: false,
          label: 'Checks pass',
          mobileLabel: '',
          note: '38 of 41',
          mobileNote: '',
          mark: '',
        },
        {
          id: 'r',
          kind: 'review_approved',
          met: true,
          label: 'Review',
          mobileLabel: '',
          note: 'approved',
          mobileNote: '',
          mark: '✓',
        },
      ],
    });
    expect(unmet.map((u) => u.id)).toEqual(['c']);
  });
});
