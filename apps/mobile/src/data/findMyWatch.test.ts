/**
 * A one-time Find My watch on the phone (findmy-watch.md): while it watches, the card with core's words and Cancel;
 * once ended, one line with nothing to open; a watch nobody can read any more leaves only the message's words.
 */
import type { FindMyWatchView, MessageCard } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { worldContext } from '../test/world';
import { cardSummary, settledLine } from './messages';

function watch(o: Partial<FindMyWatchView> = {}): FindMyWatchView {
  return {
    id: 'fmw_noor',
    name: 'Noor Visser',
    change: 'leaves',
    place: 'Keizersgracht',
    status: 'watching',
    startedAt: '2026-09-23T09:05:00.000Z',
    endsAt: '2026-09-24T09:05:00.000Z',
    endedAt: null,
    to: null,
    ...o,
  };
}

const card = (w: FindMyWatchView | null): MessageCard => ({
  kind: 'findmy_watch',
  watchId: 'fmw_noor',
  watch: w,
});

describe('the Find My watch card on the phone (findmy-watch.md)', () => {
  it('is the card with Cancel while it watches', () => {
    const ctx = worldContext();
    const summary = cardSummary(card(watch()), ctx);
    expect(summary?.title).toContain('Noor Visser');
    expect(summary?.title).toContain('Keizersgracht');
    expect(summary?.detail).toMatch(/^Until /);
    expect(summary?.findMyWatch).toEqual({ watchId: 'fmw_noor' });
    expect(settledLine(card(watch()), ctx, 'prn_any')).toBeNull();
  });

  it('is one line once it ended, without Cancel', () => {
    const ctx = worldContext();
    const ended = card(watch({ status: 'happened', endedAt: '2026-09-23T12:05:00.000Z', to: 'Amstelveen' }));
    expect(cardSummary(ended, ctx)?.findMyWatch).toBeNull();
    const line = settledLine(ended, ctx, 'prn_any');
    expect(line?.lead).toContain('Noor Visser');
    expect(line?.detail).toMatch(/^\d\d:\d\d$/);
    expect(line?.tone).toBe('ok');
  });

  it('leaves only the message’s words when the watch can’t be read', () => {
    const ctx = worldContext();
    expect(cardSummary(card(null), ctx)).toBeNull();
    expect(settledLine(card(null), ctx, 'prn_any')).toBeNull();
  });
});
