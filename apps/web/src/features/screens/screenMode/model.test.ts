import { OperationError } from '@whombat/client/session';
import { describe, expect, it } from 'vitest';
import {
  deviceKind,
  lettersShown,
  modalItems,
  POLL_MS,
  POLL_TOUCHED_MS,
  pageAt,
  pillText,
  pollDelay,
  relockDue,
  screenDeviceLabel,
  screenRemoved,
} from './model';

const IPAD =
  'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

describe('a device as a screen', () => {
  it('calls itself what it is, and shows in Settings as “iPad · Safari”', () => {
    expect(deviceKind(IPAD, true)).toBe('tablet');
    expect(deviceKind(MAC, false)).toBe('computer');
    expect(screenDeviceLabel(IPAD, true)).toBe('Safari on iPad');
    expect(screenDeviceLabel(MAC)).toBe('Chrome on Mac');
    expect(lettersShown('KTRMWP')).toBe('KTR·MWP');
  });

  it('asks every 10 s, every 3 s for two minutes after a touch', () => {
    expect(pollDelay(1_000_000, null)).toBe(POLL_MS);
    expect(pollDelay(1_000_000, 1_000_000 - 60_000)).toBe(POLL_TOUCHED_MS);
    expect(pollDelay(1_000_000, 1_000_000 - 121_000)).toBe(POLL_MS);
  });

  it('turns pages by itself, waiting while touched; a touched one goes back to the first after two minutes', () => {
    const at = { page: 0, pages: 3, since: 0, touchedAt: null };
    expect(pageAt({ ...at, turn: '30s', now: 29_000 })).toBe(0);
    expect(pageAt({ ...at, turn: '30s', now: 30_000 })).toBe(1);
    expect(pageAt({ ...at, page: 2, turn: '30s', now: 30_000 })).toBe(0);
    expect(pageAt({ ...at, turn: '30s', touchedAt: 20_000, now: 40_000 })).toBe(0);
    expect(pageAt({ ...at, page: 2, turn: 'touch', now: 119_000 })).toBe(2);
    expect(pageAt({ ...at, page: 2, turn: 'touch', now: 120_000 })).toBe(0);
    expect(pageAt({ ...at, page: 2, turn: 'touch', touchedAt: 100_000, now: 130_000 })).toBe(2);
  });

  it('opens the modal for what pops and isn’t put away; the pill shows everything', () => {
    const items = [
      { key: 'down', kind: 'look', tone: 'bad', pops: true, title: 'pve-02 isn’t answering' },
      { key: 'ask:3', kind: 'ask', tone: 'bad', pops: false, title: 'Neo has a question' },
    ] as const;
    expect(modalItems(items, new Set(), false).map((i) => i.key)).toEqual(['down']);
    expect(modalItems(items, new Set(['down']), false)).toEqual([]);
    expect(modalItems(items, new Set(['down']), true)).toHaveLength(2);
    expect(pillText(1, { one: '1 thing needs you', many: '{n} things need you' })).toBe('1 thing needs you');
    expect(pillText(3, { one: '1 thing needs you', many: '{n} things need you' })).toBe('3 things need you');
  });

  it('locks itself two minutes after the last touch while unlocked', () => {
    expect(relockDue(200_000, null, null)).toBe(false);
    expect(relockDue(200_000, 150_000, 100_000)).toBe(false);
    expect(relockDue(270_000, 150_000, 100_000)).toBe(true);
  });

  it('knows when it isn’t a screen any more', () => {
    expect(screenRemoved(new OperationError('screen.state', 403, 'revoked', 'Revoked.'))).toBe(true);
    expect(screenRemoved(new OperationError('screen.state', 404, 'unknown_op', 'No.'))).toBe(true);
    expect(screenRemoved(new OperationError('screen.state', 503, 'unavailable', 'Later.'))).toBe(false);
    expect(screenRemoved(new Error('lost'))).toBe(false);
  });
});
