/** Whether a page with the claim link is open, as the box's screen hears it: at once when it opens, after a grace when it goes. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Services } from '../../services';
import type { SessionConnection } from './connection';
import { CLAIM_PAGE_GRACE_MS, SessionRegistry } from './registry';

const services = { bus: { onControl: () => () => {} } } as unknown as Services;
const session = () => ({}) as SessionConnection;
const withLink = { via: 'door', peer: '198.51.100.7', claimLink: true } as const;
const without = { via: 'door', peer: '203.0.113.9', claimLink: false } as const;

let registry: SessionRegistry;
let told: number;
beforeEach(() => {
  vi.useFakeTimers();
  registry = new SessionRegistry(services);
  told = 0;
  registry.onClaimPage = () => {
    told++;
  };
});
afterEach(() => {
  registry.close();
  vi.useRealTimers();
});

describe('a page with the claim link', () => {
  it('is open at once, and gone only a while after its last session', () => {
    const first = session();
    expect(registry.attach(first, false, withLink)).toBe(true);
    expect(registry.claimPageOpen).toBe(true);
    expect(told).toBe(1);
    // Its first look at the box ends before the claim's own session starts: no change on the screen.
    registry.detach(first);
    expect(registry.claimPageOpen).toBe(true);
    const second = session();
    registry.attach(second, false, withLink);
    vi.advanceTimersByTime(CLAIM_PAGE_GRACE_MS * 2);
    expect(registry.claimPageOpen).toBe(true);
    expect(told).toBe(1);
    // The tab closed: gone after the grace.
    registry.detach(second);
    vi.advanceTimersByTime(CLAIM_PAGE_GRACE_MS - 1);
    expect(registry.claimPageOpen).toBe(true);
    vi.advanceTimersByTime(1);
    expect(registry.claimPageOpen).toBe(false);
    expect(told).toBe(2);
  });

  it('is never a visitor without the link', () => {
    registry.attach(session(), false, without);
    registry.attach(session(), false, { via: 'local' });
    expect(registry.claimPageOpen).toBe(false);
    expect(told).toBe(0);
  });
});
