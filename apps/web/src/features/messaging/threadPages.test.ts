/** Merging a thread's pages (docs/decisions/web-messages.md WX-11). */
import type { Message } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { mergeThreadPages } from './useThreadPages';

const reply = (id: string, at: string, text = id) => ({ id, createdAt: at, text }) as Message;
const page = (...replies: Message[]) => ({ replies }) as never;

describe('mergeThreadPages', () => {
  it('puts earlier pages first and keeps each reply once, the newest page’s copy', () => {
    const older = page(reply('r1', '09:00'), reply('r2', '09:01'), reply('r9', '09:09', 'stale'));
    const newer = page(reply('r3', '09:03'), reply('r9', '09:09', 'fresh'));
    const merged = mergeThreadPages([older, newer]);
    expect(merged.map((m) => m.id)).toEqual(['r1', 'r2', 'r3', 'r9']);
    expect(merged.at(-1)?.text).toBe('fresh');
  });

  it('waits for pages still loading', () => {
    expect(mergeThreadPages([undefined, page(reply('r1', '09:00'))]).map((m) => m.id)).toEqual(['r1']);
  });
});
