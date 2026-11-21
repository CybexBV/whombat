import { describe, expect, it } from 'vitest';
import { demoCommunity, demoCommunityStart } from './communityLink';

describe('the community demo’s link (AP-5478)', () => {
  it('opens the community journey, at a link when it names one', () => {
    expect(demoCommunity('whombat://demo/community')).toBe(true);
    expect(demoCommunity('whombat://demo/version?who=client')).toBe(false);
    expect(demoCommunity(null)).toBe(false);
    expect(demoCommunityStart('whombat://demo/community')).toBe('join');
    expect(demoCommunityStart('whombat://demo/community/device')).toBe('device');
    expect(demoCommunityStart('whombat://demo/community/invite')).toBe('join');
  });
});
