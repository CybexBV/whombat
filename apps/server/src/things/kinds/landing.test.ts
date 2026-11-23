/**
 * Every connection opens on a dashboard: each catalog entry either has a kind (its page in slots) or is named here with
 * where a click takes the person instead. A new entry without either fails this test, so it can't ship with only the
 * answer-time page by accident.
 */
import { CATALOG } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { KIND_MODULES } from './index';

/** Entries without a kind, and where they open instead. */
const ELSEWHERE: Record<string, string> = {
  custom_api: 'the page the assistant writes for it, from what it can read',
  custom_mcp: 'the page the assistant writes for it, from what it can read',
  device: 'its own page of readings',
  whombat_servers: 'each server’s own page',
  google: 'its account page in Settings',
  microsoft: 'its account page in Settings',
  imap: 'its account page in Settings',
  github: 'its account page in Settings',
  feedback: 'its page in Settings',
};

describe('where a connection opens', () => {
  it('is a dashboard for every catalog entry, or named with where it opens', () => {
    const missing = CATALOG.map((e) => e.id).filter((id) => !KIND_MODULES[id] && !ELSEWHERE[id]);
    expect(missing).toEqual([]);
  });

  it('names no entry that has a kind after all, or that is gone', () => {
    const ids = new Set(CATALOG.map((e) => e.id));
    expect(Object.keys(ELSEWHERE).filter((id) => KIND_MODULES[id] || !ids.has(id))).toEqual([]);
  });
});
