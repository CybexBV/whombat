/** Android verification fixes (fix/mobile): back labels, switch colors, a conversation one is not in. */
import { ApiError } from '@whombat/client';
import { describe, expect, it } from 'vitest';
import { backButtonLabel } from '../navigation/routes';
import { conversationLoadError } from './messages';

describe('back buttons', () => {
  it('name the place they go back to, and never say “Back to Back”', () => {
    expect(backButtonLabel('Inbox')).toBe('Back to Inbox');
    expect(backButtonLabel('#incidents')).toBe('Back to #incidents');
    expect(backButtonLabel('Back')).toBe('Back');
    expect(backButtonLabel(' back ')).toBe('Back');
    expect(backButtonLabel('')).toBe('Back');
  });
});

describe('a conversation that does not open', () => {
  const api = (status: number) => new ApiError(status, 'not_found', 'Not found', null, 'conversations.get');

  it('says you are not in it, without a pointless Try again', () => {
    expect(conversationLoadError(api(404))).toEqual({
      text: 'You’re not in this conversation.',
      retry: false,
    });
    expect(conversationLoadError(api(403))).toEqual({
      text: 'You’re not in this conversation.',
      retry: false,
    });
  });
});
