import { describe, expect, it } from 'vitest';
import { keptSiteUntil } from './keptSites';

describe('keptSiteUntil', () => {
  const now = new Date('2026-11-13T13:00:00Z');
  it('says the clock today, and tomorrow when it goes after midnight', () => {
    expect(keptSiteUntil('2026-11-13T16:40:00Z', now, 'Europe/Amsterdam')).toBe('until 17:40');
    expect(keptSiteUntil('2026-11-14T08:10:00Z', now, 'Europe/Amsterdam')).toBe('until tomorrow 09:10');
    expect(keptSiteUntil('2026-11-13T23:30:00Z', now, 'UTC')).toBe('until 23:30');
    expect(keptSiteUntil('2026-11-13T23:30:00Z', now, 'Europe/Amsterdam')).toBe('until tomorrow 00:30');
  });
});
