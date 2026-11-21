import { describe, expect, it } from 'vitest';
import { CONTINUE_MS, continuesMessage } from './continues';

const T = Date.parse('2026-11-02T10:00:00.000Z');
const m = (authorId: string, offsetMs: number, deletedAt: string | null = null) => ({
  authorId,
  createdAt: new Date(T + offsetMs).toISOString(),
  deletedAt,
});

describe('continuesMessage', () => {
  it('runs the same author’s next message on only moments later', () => {
    expect(continuesMessage(m('dusty', 0), m('dusty', 60_000))).toBe(true);
    expect(continuesMessage(m('dusty', 0), m('dusty', CONTINUE_MS))).toBe(true);
    expect(continuesMessage(m('dusty', 0), m('dusty', CONTINUE_MS + 1))).toBe(false);
  });

  it('starts again for another author, a deleted message or nothing before', () => {
    expect(continuesMessage(m('dusty', 0), m('mara', 1000))).toBe(false);
    expect(continuesMessage(m('dusty', 0, '2026-11-02T10:01:00.000Z'), m('dusty', 1000))).toBe(false);
    expect(continuesMessage(null, m('dusty', 0))).toBe(false);
    expect(continuesMessage(m('dusty', 1000), m('dusty', 0))).toBe(false);
  });
});
