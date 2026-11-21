import type { SharedLink } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { shareContents, shareLinkLine, shareWarningText } from './shares';

const link = (over: Partial<SharedLink>): SharedLink => ({
  id: 'shr_AAAAAAAAAAAAAAAAAAAAAA',
  title: 'Holiday',
  url: 'https://app.example/s/shr_AAAAAAAAAAAAAAAAAAAAAA#k',
  rootId: 'msg_1',
  messages: 3,
  pictures: true,
  createdAt: '2026-11-05T09:00:00Z',
  expiresAt: '2026-11-12T09:00:00Z',
  stoppedAt: null,
  state: 'live',
  stopping: false,
  views: 0,
  ...over,
});

describe('the words of shared links', () => {
  it('says how long a link works and how often it was opened', () => {
    expect(shareLinkLine(link({ views: 3 }), 'UTC')).toContain('12 Nov');
    expect(shareLinkLine(link({ views: 3 }), 'UTC')).toContain('3 times');
    expect(shareLinkLine(link({ expiresAt: null, views: null }), 'UTC')).not.toContain('Opened');
    expect(shareLinkLine(link({ state: 'stopped', stopping: true }))).toContain('Stopped');
    expect(shareLinkLine(link({ state: 'expired' }), 'UTC')).toContain('12 Nov');
  });

  it('counts messages and pictures, and names what to look at', () => {
    expect(shareContents({ messages: 1, pictures: 2 }, true)).toBe('1 message and 2 pictures');
    expect(shareContents({ messages: 4, pictures: 2 }, false)).toBe('4 messages');
    expect(shareWarningText({ kind: 'address', messages: 2, example: '10.0.0.1' })).toContain('10.0.0.1');
  });
});
