/** What a widget's sheet offers from *Add a widget*'s items: *Limits* only for a panel the runtime says shows limits. */
import { describe, expect, it } from 'vitest';
import { widgetLimits } from './catalog';

const groups = [
  {
    items: [
      {
        type: 'panel' as const,
        ref: 'connection:con_f',
        opts: { panel: 'subscriptions' },
        name: 'Subscriptions',
        line: 'Every subscription',
        limits: true,
      },
      {
        type: 'panel' as const,
        ref: 'connection:con_f',
        opts: { panel: 'people' },
        name: 'People',
        line: 'Who used it most',
      },
    ],
  },
];

describe('widgetLimits', () => {
  it('offers Limits for a panel of limits, whatever it shows now', () => {
    const subs = {
      type: 'panel' as const,
      ref: 'connection:con_f',
      opts: { panel: 'subscriptions', limits: 'left' },
    };
    expect(widgetLimits(subs, groups)).toBe(true);
    expect(widgetLimits({ ...subs, opts: { panel: 'people' } }, groups)).toBe(false);
    expect(widgetLimits({ type: 'figures', ref: 'connection:con_f', opts: {} }, groups)).toBe(false);
  });
});
