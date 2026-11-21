import { describe, expect, it } from 'vitest';
import { badgeText, tabBadgeLabel } from './inbox';

describe('badges (AP-708)', () => {
  it('says what is new to TalkBack and caps the number', () => {
    expect(tabBadgeLabel('Watch', 3)).toBe('Watch, 3 new');
    expect(tabBadgeLabel('Settings', 0, true)).toBe('Settings, unread messages');
    expect(tabBadgeLabel('Chat', 0)).toBe('Chat');
    expect(badgeText(7)).toBe('7');
    expect(badgeText(120)).toBe('99+');
  });
});
