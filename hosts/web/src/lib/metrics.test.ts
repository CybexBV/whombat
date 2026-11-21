import { describe, expect, it } from 'vitest';
import type { Metrics } from '../api/types';
import { seriesStats } from './metrics';

const base: Metrics = {
  server: 'basalt',
  range: '24h',
  step_seconds: 900,
  points: 4,
  as_of: '2026-10-11T14:00:00Z',
  timestamps: ['2026-10-11T13:15:00Z', '2026-10-11T13:30:00Z', '2026-10-11T13:45:00Z', '2026-10-11T14:00:00Z'],
  series: { cpu_pct: [30, 40, null, 35] },
};

describe('peak and average (S4, ACCEPTANCE 3 and 6)', () => {
  it('uses the stored maximum, not the plotted averages (spike shorter than one bucket)', () => {
    const m: Metrics = { ...base, summary: { cpu_pct: { avg: 36.2, max: 92.5, max_at: '2026-10-11T13:41:20Z' } } };
    expect(seriesStats(m, 'cpu_pct')).toEqual({ avg: 36.2, max: 92.5, at: '2026-10-11T13:41:20Z' });
  });
  it('a null summary means no data', () => {
    const m: Metrics = { ...base, summary: { cpu_pct: null } };
    expect(seriesStats(m, 'cpu_pct')).toEqual({ avg: null, max: null, at: null });
  });
  it('falls back to the plotted values when the API sends no summary, skipping gaps', () => {
    expect(seriesStats(base, 'cpu_pct')).toEqual({ avg: 35, max: 40, at: '2026-10-11T13:30:00Z' });
  });
});
