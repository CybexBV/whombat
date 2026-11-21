import { describe, expect, it } from 'vitest';
import { connectionStatus, QUIET_MS } from './connection';

describe('connectionStatus', () => {
  it('is ok while polls succeed', () => {
    expect(connectionStatus(null, 1_000_000)).toBe('ok');
  });

  it('stays quiet for the first 10 s of failures, then says so', () => {
    expect(connectionStatus(1000, 1000)).toBe('hiccup');
    expect(connectionStatus(1000, 1000 + QUIET_MS - 1)).toBe('hiccup');
    expect(connectionStatus(1000, 1000 + QUIET_MS)).toBe('lost');
  });
});
