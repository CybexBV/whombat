import type { ClientStatus } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { shownClient } from './ClientRow';

const base = (state: ClientStatus['state'], extra: Partial<ClientStatus> = {}): ClientStatus => ({
  provider: 'claude',
  installed: null,
  latest: { version: '2.1.302', publishedAt: '2026-09-26T00:00:00Z' },
  state,
  progress: null,
  error: null,
  ...extra,
});
const refused = base('failed', {
  latest: null,
  error: {
    code: 'client.unavailable',
    message: 'No tested Claude Code version is published for this appliance yet.',
  },
});

describe('shownClient (AP-194)', () => {
  it('is the list without an install of its own', () => {
    expect(shownClient(base('not_installed'), null, 10)).toEqual(base('not_installed'));
    expect(shownClient(null, null, 10)).toBeNull();
  });

  it('shows installing, without a made-up percentage, while the request is on its way', () => {
    const shown = shownClient(base('not_installed'), { pending: true, answer: null, at: 5 }, 10);
    expect(shown).toMatchObject({ provider: 'claude', state: 'installing', progress: null, error: null });
    // A list that already moves on is shown as it is.
    const moving = base('installing', { progress: 30 });
    expect(shownClient(moving, { pending: true, answer: null, at: 5 }, 10)).toBe(moving);
  });

  it('shows the answer until a newer read, then the list', () => {
    const answer = base('installing', { progress: 0 });
    const attempt = { pending: false, answer, at: 20 };
    expect(shownClient(base('not_installed'), attempt, 10)).toBe(answer);
    expect(shownClient(base('installing', { progress: 44 }), attempt, 30)?.progress).toBe(44);
    expect(shownClient(base('not_installed'), attempt, 30)?.state).toBe('not_installed');
  });

  it('keeps a refusal the list doesn’t keep, until the list shows something else', () => {
    const attempt = { pending: false, answer: refused, at: 20 };
    expect(shownClient(base('not_installed'), attempt, 30)).toBe(refused);
    expect(shownClient(base('installing', { progress: 3 }), attempt, 30)?.state).toBe('installing');
  });
});
