import { describe, expect, it } from 'vitest';
import { PushPreview, PushRequest } from './device/push.js';

const base = { kind: 'message', ref: 'a'.repeat(22), handles: ['b'.repeat(30)], ttlS: 60 };

describe('push previews (CT-286)', () => {
  it('takes any script, curly quotes and emoji on one line', () => {
    expect(
      PushPreview.safeParse({ title: 'Banjo · #général', body: '“Klaar” — PR #42 🎉 日本語' }).success,
    ).toBe(true);
    expect(PushPreview.safeParse({ title: 'Banjo', body: '' }).success).toBe(true);
  });

  it('refuses newlines, tabs, invisible characters and over-long lines', () => {
    expect(PushPreview.safeParse({ title: 'Banjo', body: 'a\nb' }).success).toBe(false);
    expect(PushPreview.safeParse({ title: 'Banjo', body: 'a\tb' }).success).toBe(false);
    expect(PushPreview.safeParse({ title: 'Banjo', body: 'a​b' }).success).toBe(false);
    expect(PushPreview.safeParse({ title: 'Banjo', body: 'a b' }).success).toBe(false);
    expect(PushPreview.safeParse({ title: '', body: 'x' }).success).toBe(false);
    expect(PushPreview.safeParse({ title: 'x'.repeat(81), body: '' }).success).toBe(false);
    // Length in code points: 160 emoji (320 UTF-16 units) fit.
    expect(PushPreview.safeParse({ title: 'x', body: '🎉'.repeat(160) }).success).toBe(true);
    expect(PushPreview.safeParse({ title: 'x', body: '🎉'.repeat(161) }).success).toBe(false);
  });

  it('is optional on a request, like clear', () => {
    expect(PushRequest.safeParse(base).success).toBe(true);
    expect(
      PushRequest.safeParse({ ...base, preview: { title: 'Banjo', body: 'Done' }, clear: false }).success,
    ).toBe(true);
    expect(PushRequest.safeParse({ ...base, preview: { title: 'Banjo', body: 'x', extra: 1 } }).success).toBe(
      false,
    );
  });
});
