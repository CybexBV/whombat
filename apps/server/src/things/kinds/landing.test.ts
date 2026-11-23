/**
 * Every connection opens on a dashboard: each catalog entry either has a kind (its page in slots), is one of the
 * person's accounts with a page of its own (`things/accounts/`), or is named here with where a click takes the person
 * instead. A new entry without any of them fails this test, so it can't ship with only the answer-time page by accident.
 */
import { ACCOUNT_PAGE_IDS, CATALOG } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_LANDINGS } from '../accounts/index';
import { KIND_MODULES } from './index';

/** Entries without a kind or an account page, and where they open instead. */
const ELSEWHERE: Record<string, string> = {
  custom_api: 'the page the assistant writes for it, from what it can read',
  custom_mcp: 'the page the assistant writes for it, from what it can read',
  device: 'its own page of readings',
  whombat_servers: 'each server’s own page',
};

describe('where a connection opens', () => {
  it('is a dashboard for every catalog entry, or named with where it opens', () => {
    const missing = CATALOG.map((e) => e.id).filter(
      (id) => !KIND_MODULES[id] && !ACCOUNT_LANDINGS[id as keyof typeof ACCOUNT_LANDINGS] && !ELSEWHERE[id],
    );
    expect(missing).toEqual([]);
  });

  it('opens Google, Microsoft 365, Email, GitHub and Website feedback on their account page', () => {
    expect(Object.keys(ACCOUNT_LANDINGS).sort()).toEqual([...ACCOUNT_PAGE_IDS].sort());
    for (const id of ACCOUNT_PAGE_IDS) expect(KIND_MODULES[id]).toBeUndefined();
  });

  it('names no entry that has a kind or an account page after all, or that is gone', () => {
    const ids = new Set(CATALOG.map((e) => e.id));
    expect(
      Object.keys(ELSEWHERE).filter(
        (id) => KIND_MODULES[id] || ACCOUNT_LANDINGS[id as keyof typeof ACCOUNT_LANDINGS] || !ids.has(id),
      ),
    ).toEqual([]);
    expect(ACCOUNT_PAGE_IDS.filter((id) => !ids.has(id))).toEqual([]);
  });
});
