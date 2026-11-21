/**
 * The frame's one storage key (AP-429): `localStorage` `whombat-feedback:<site>` with the session and the reports sent
 * while signed in; malformed or expired entries are dropped; storage that throws is not an error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSession,
  loadSession,
  parseStoredSession,
  type ReporterSession,
  reporterKey,
  SENT_MAX,
  saveSession,
} from './reporter-store';

const SITE = 'fbs_abcdefghijklmnopqrstuvwx';
const NOW = Date.parse('2026-09-30T10:00:00.000Z');
const SESSION: ReporterSession = {
  token: `fbrs_${'b'.repeat(43)}`,
  email: 'ann@example.com',
  name: 'Ann',
  expiresAt: '2026-10-30T10:00:00.000Z',
  sent: [{ reference: 'FB-7K3Q-9M2X', type: 'bug', summary: 'Wrong total', at: '2026-09-29T10:00:00.000Z' }],
};

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('the reporter session store', () => {
  it('keeps exactly one key per site', () => {
    expect(reporterKey(SITE)).toBe(`whombat-feedback:${SITE}`);
    expect(saveSession(SITE, SESSION)).toBe(true);
    expect(Object.keys(localStorage)).toEqual([`whombat-feedback:${SITE}`]);
    expect(JSON.parse(localStorage.getItem(reporterKey(SITE)) ?? '')).toEqual(SESSION);
    expect(loadSession(SITE, NOW)).toEqual(SESSION);
    expect(loadSession('fbs_zzzzzzzzzzzzzzzzzzzzzzzz', NOW)).toBeNull();
    clearSession(SITE);
    expect(localStorage.length).toBe(0);
  });

  it('drops an expired or malformed session, and bad sent entries', () => {
    saveSession(SITE, SESSION);
    expect(loadSession(SITE, Date.parse(SESSION.expiresAt))).toBeNull();
    expect(localStorage.length).toBe(0);
    localStorage.setItem(reporterKey(SITE), '{not json');
    expect(loadSession(SITE, NOW)).toBeNull();
    for (const bad of [
      null,
      { ...SESSION, token: 'fbrs_x' },
      { ...SESSION, email: '' },
      { ...SESSION, name: 'x'.repeat(121) },
      { ...SESSION, expiresAt: 'later' },
    ])
      expect(parseStoredSession(bad, NOW)).toBeNull();
    const sent = [
      ...SESSION.sent,
      { reference: 'FB-bad', type: 'bug', summary: '', at: SESSION.sent[0]?.at },
      { ...SESSION.sent[0], type: 'question' },
      { ...SESSION.sent[0], summary: 'x'.repeat(141) },
      ...Array.from({ length: 60 }, () => SESSION.sent[0]),
    ];
    expect(parseStoredSession({ ...SESSION, sent }, NOW)?.sent).toHaveLength(SENT_MAX);
    expect(parseStoredSession({ ...SESSION, sent: 'x' }, NOW)?.sent).toEqual([]);
  });

  it('storage that throws is not an error', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(loadSession(SITE, NOW)).toBeNull();
    expect(saveSession(SITE, SESSION)).toBe(false);
    expect(() => clearSession(SITE)).not.toThrow();
  });

  it('a window whose localStorage getter throws is not an error either', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    try {
      expect(loadSession(SITE, NOW)).toBeNull();
      expect(saveSession(SITE, SESSION)).toBe(false);
      expect(() => clearSession(SITE)).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});
