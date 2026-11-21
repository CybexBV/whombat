/** Contracts 0.95.0, the sidebar: why a thing isn't fine, the worst open Watch item (CT-453…CT-455). */
import { describe, expect, it } from 'vitest';
import { HomeSummary, ThingSummary } from './home.js';

const thing = {
  id: 'connection:con_1',
  kind: 'connection',
  name: 'Home Assistant',
  icon: 'homeassistant',
  status: 'warn',
  facts: [],
  href: '/things/connection%3Acon_1',
} as const;

describe('why a thing isn’t fine (CT-453)', () => {
  it('carries a short reason', () => {
    expect(ThingSummary.parse({ ...thing, reason: '3 integrations not loading' }).reason).toBe(
      '3 integrations not loading',
    );
    expect(ThingSummary.safeParse({ ...thing, reason: '' }).success).toBe(false);
    expect(ThingSummary.safeParse({ ...thing, reason: 'x'.repeat(161) }).success).toBe(false);
  });

  it('is optional, as from older servers', () => {
    expect(ThingSummary.parse(thing).reason).toBeUndefined();
  });
});

describe('the worst open Watch item (CT-454)', () => {
  it('takes a severity, or nothing', () => {
    const summary = { needsYou: 0, working: 0, problems: 18 };
    expect(HomeSummary.parse({ ...summary, worst: 'warn' }).worst).toBe('warn');
    expect(HomeSummary.parse(summary).worst).toBeUndefined();
    expect(HomeSummary.safeParse({ ...summary, worst: 'critical' }).success).toBe(false);
  });
});
