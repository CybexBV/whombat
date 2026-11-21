import { describe, expect, it } from 'vitest';
import { metricValues, newestValue } from './widget-reader';

describe('server-metric widget values', () => {
  it('takes each series’ newest measured value', () => {
    expect(newestValue([1, 2, null])).toBe(2);
    expect(newestValue([null, null])).toBeNull();
    expect(newestValue(undefined)).toBeNull();
  });

  it('keys values by series, sums the old network name from its parts, null where nothing was measured', () => {
    expect(
      metricValues(['cpu_pct', 'net_mbps', 'temp.max'], {
        cpu_pct: [10, 12],
        net_rx_mbps: [1, 3],
        net_tx_mbps: [2, null, 4],
      }),
    ).toEqual({ cpu_pct: 12, net_mbps: 7, temp_max: null });
    expect(metricValues(['net_mbps'], { net_rx_mbps: [1] })).toEqual({ net_mbps: null });
  });
});
