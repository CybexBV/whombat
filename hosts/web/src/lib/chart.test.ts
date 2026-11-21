import { describe, expect, it } from 'vitest';
import { restIndex, marksFor } from './chart';

describe('restIndex', () => {
  it('rests at about 72% of the range', () => {
    expect(restIndex(96)).toBe(68);
    expect(restIndex(96, () => true)).toBe(68);
  });

  it('falls back to the newest sample when there is no data at 72%', () => {
    const values = Array.from({ length: 96 }, (_, i) => (i >= 90 && i <= 93 ? 5 : null));
    expect(restIndex(96, (i) => values[i] != null)).toBe(93);
  });

  it('keeps 72% when the chart has no data at all', () => {
    expect(restIndex(96, () => false)).toBe(68);
  });
});

describe('marksFor', () => {
  const ts = ['2026-10-13T10:00:00Z', '2026-10-13T10:15:00Z', '2026-10-13T10:30:00Z', '2026-10-13T10:45:00Z'];
  it('puts each annotation in the bucket that ends at or after it', () => {
    const marks = marksFor(
      [
        { at: '2026-10-13T10:05:00Z', kind: 'alert', severity: 'critical', text: 'Disk failing' },
        { at: '2026-10-13T10:30:00Z', kind: 'reboot', text: 'Host booted' },
        { at: '2026-10-13T09:00:00Z', kind: 'action', text: 'too early' },
      ],
      ts,
    );
    expect(marks).toEqual([
      { i: 1, color: 'var(--critical)', text: 'Disk failing' },
      { i: 2, color: 'var(--ink-3)', text: 'Host booted' },
    ]);
  });
  it('is empty without data', () => {
    expect(marksFor(undefined, ts)).toEqual([]);
    expect(marksFor([{ at: '2026-10-13T10:05:00Z', kind: 'agent', text: 'x' }], [])).toEqual([]);
  });
});
