/**
 * The chat's rows re-render only for what changed (AP-901): time labels kept by message (the same words as core's), and
 * items kept as the same objects where nothing changed.
 */
import { lastReplyLabel } from '@whombat/client';
import { dayKey, formatDayDivider, formatRecent, type Message } from '@whombat/core';
import { ALL_MESSAGES, PR482_MESSAGES, SEED_NOW, SEED_TIME_ZONE } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { worldContext } from '../test/world';
import {
  chatItems,
  keepSameItems,
  lastReplyFollowsClock,
  lastReplyText,
  sentFollowsClock,
  sentLabel,
  timeLabels,
} from './messages';

const at = (iso: string) => new Date(iso);

describe('timeLabels (AP-901)', () => {
  const moments = [
    ...ALL_MESSAGES.map((m) => m.createdAt),
    '2026-09-23T09:21:30.000Z',
    '2026-09-23T09:22:00.000Z',
    '2026-09-23T09:23:00.000Z',
    '2026-09-22T21:59:59.000Z',
    '2026-09-22T22:00:00.000Z',
    '2026-09-16T10:00:00.000Z',
    '2025-12-31T23:30:00.000Z',
  ];
  const nows = [
    SEED_NOW,
    at('2026-09-23T09:22:15.000Z'),
    at('2026-09-23T09:23:00.000Z'),
    at('2026-09-23T21:59:45.000Z'),
    at('2026-09-23T22:00:15.000Z'),
    at('2026-09-30T08:00:00.000Z'),
    at('2027-01-02T08:00:00.000Z'),
  ];

  it('says what core says, at every now and in more than one zone', () => {
    for (const zone of [SEED_TIME_ZONE, 'UTC', 'America/New_York'])
      for (const now of nows) {
        const labels = timeLabels(now, zone);
        for (const moment of moments) {
          expect(labels.recent(moment)).toBe(formatRecent(moment, now, zone));
          expect(labels.divider(moment)).toBe(formatDayDivider(moment, now, zone));
          expect(labels.dayKey(moment)).toBe(dayKey(moment, zone));
          // Asked again (from the cache): the same.
          expect(labels.recent(moment)).toBe(formatRecent(moment, now, zone));
        }
      }
  });

  it('keeps `just now` moving with the clock, not with the day', () => {
    const sent = '2026-09-23T09:22:10.000Z';
    expect(timeLabels(at('2026-09-23T09:22:15.000Z'), 'UTC').recent(sent)).toBe('just now');
    expect(timeLabels(at('2026-09-23T09:23:15.000Z'), 'UTC').recent(sent)).toBe('09:22');
    expect(timeLabels(at('2026-09-23T09:22:30.000Z'), 'UTC').recent(sent)).toBe('just now');
  });
});

describe('labels that follow the clock in the row, not in the items', () => {
  const sent = '2026-09-23T09:22:10.000Z';

  it('keeps a message’s settled time in its item, and the row says just now for its first minute', () => {
    const labels = timeLabels(at('2026-09-23T09:22:15.000Z'), 'UTC');
    expect(labels.settled(sent)).toBe('09:22');
    expect(labels.settled('2026-09-22T09:00:00.000Z')).toBe(labels.recent('2026-09-22T09:00:00.000Z'));
    expect(sentLabel(sent, '09:22', at('2026-09-23T09:22:15.000Z'), 'UTC')).toBe('just now');
    expect(sentLabel(sent, '09:22', at('2026-09-23T09:23:15.000Z'), 'UTC')).toBe('09:22');
    expect(sentFollowsClock(sent, at('2026-09-23T09:22:30.000Z'))).toBe(true);
    expect(sentFollowsClock(sent, at('2026-09-23T09:23:15.000Z'))).toBe(false);
  });

  it('words the last reply as the shared rule does, and stops following the clock after a week', () => {
    for (const now of [at('2026-09-23T09:30:00.000Z'), at('2026-10-20T09:30:00.000Z')])
      expect(lastReplyText(sent, now, 'UTC')).toBe(lastReplyLabel(sent, now, 'UTC'));
    expect(lastReplyFollowsClock(sent, at('2026-09-25T09:30:00.000Z'))).toBe(true);
    expect(lastReplyFollowsClock(sent, at('2026-10-20T09:30:00.000Z'))).toBe(false);
  });

  it('builds the same items at any time of the same day', () => {
    const ctx = worldContext();
    const later = new Date(SEED_NOW.getTime() + 20 * 60_000);
    const first = chatItems(PR482_MESSAGES, { ...ctx, now: SEED_NOW }, { authors: true, threads: true });
    const again = chatItems(PR482_MESSAGES, { ...ctx, now: later }, { authors: true, threads: true });
    expect(keepSameItems(first, again)).toBe(first);
  });
});

describe('keepSameItems (AP-901)', () => {
  const ctx = worldContext();
  const items = (messages: readonly Message[], now = SEED_NOW) =>
    chatItems(messages, { ...ctx, now }, { authors: true, threads: true });

  it('keeps the list when nothing changed, even at a later now', () => {
    const first = items(PR482_MESSAGES);
    const again = items(PR482_MESSAGES, new Date(SEED_NOW.getTime() + 15_000));
    expect(again).not.toBe(first);
    expect(keepSameItems(first, again)).toBe(first);
  });

  it('keeps every unchanged item when a message arrives or an older page loads', () => {
    const first = items(PR482_MESSAGES.slice(3, -1));
    const more = items(PR482_MESSAGES);
    const kept = keepSameItems(first, more);
    expect(kept).not.toBe(first);
    const before = new Map(first.map((i) => [i.id, i]));
    // Each item that says the same is the same object; the new ones (and any whose author line changed) are new.
    for (const item of kept) {
      const old = before.get(item.id);
      if (old && JSON.stringify(old) === JSON.stringify(item)) expect(item).toBe(old);
      else expect(item).not.toBe(old);
    }
    expect(kept.filter((i) => before.get(i.id) === i).length).toBeGreaterThan(first.length - 2);
  });

  it('gives a changed item a new object', () => {
    const first = items(PR482_MESSAGES);
    const last = PR482_MESSAGES.at(-1) as Message;
    const edited = [...PR482_MESSAGES.slice(0, -1), { ...last, text: `${last.text} (fixed)` }];
    const kept = keepSameItems(first, items(edited));
    expect(kept.at(-1)).not.toBe(first.at(-1));
    expect(kept.at(-1)?.text).toBe(`${last.text} (fixed)`);
    expect(kept.slice(0, -1).every((item, i) => item === first[i])).toBe(true);
  });
});
