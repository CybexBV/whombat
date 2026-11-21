/**
 * Contracts 0.115.0, server cards three to a row and a server's own screen (Whombat desk-display.md DK-80…DK-89;
 * CT-860…CT-867): the server id, the ranges and guest states, the words, and the server the runner hears about.
 */
import { describe, expect, it } from 'vitest';
import { DeskDispatchContext } from '../contracts/runner.js';
import {
  DESK_GUEST_STATES,
  DESK_SERVER_ID_RE,
  DESK_SERVER_RANGES,
  DESK_WORDS,
  DeskServerId,
  fillDeskWords,
} from './desk.js';
import { HostGuestState } from './hosts.js';

describe('a server’s own screen (CT-862…CT-867)', () => {
  it('takes the hosts service’s ids, short ones and an older hub’s with dots', () => {
    for (const id of ['pve-01', 'nas', 'pve01.home.lan', 'node:2', `p${'x'.repeat(127)}`])
      expect(DeskServerId.safeParse(id).success, id).toBe(true);
    for (const id of ['', '.', '..', '.nas', 'pve/01', 'pve 01', `p${'x'.repeat(128)}`])
      expect(DESK_SERVER_ID_RE.test(id), id).toBe(false);
  });

  it('looks back an hour, 24 hours or 7 days, and knows the hosts service’s guest states', () => {
    expect(DESK_SERVER_RANGES).toEqual(['1h', '24h', '7d']);
    expect([...DESK_GUEST_STATES]).toEqual(HostGuestState.options);
  });

  it('tells the runner which server the person was looking at; absent from the glance and older servers', () => {
    expect(DeskDispatchContext.parse({ spoken: true })).toEqual({ spoken: true });
    const ctx = { spoken: false, server: { id: 'nas', name: 'nas' } };
    expect(DeskDispatchContext.parse(ctx)).toEqual(ctx);
    expect(
      DeskDispatchContext.safeParse({ spoken: false, server: { id: 'pve/01', name: 'pve-01' } }).success,
    ).toBe(false);
    expect(DeskDispatchContext.safeParse({ spoken: false, server: { id: 'nas', name: '' } }).success).toBe(
      false,
    );
    expect(DeskDispatchContext.safeParse({ spoken: false, server: { id: 'nas' } }).success).toBe(false);
  });
});

describe('the words (CT-868)', () => {
  const s = DESK_WORDS.server;

  it('labels a card’s three lines and opens it by name', () => {
    expect([DESK_WORDS.card.cpu, DESK_WORDS.card.memory, DESK_WORDS.card.disk]).toEqual([
      'CPU',
      'MEM',
      'DISK',
    ]);
    expect(fillDeskWords(DESK_WORDS.card.open, { name: 'pve-01' })).toContain('pve-01');
    expect(fillDeskWords(DESK_WORDS.hot, { n: 84 })).toContain('84°');
  });

  it('fills every hole of a server’s screen', () => {
    const filled = fillDeskWords(s.ask, { assistant: 'Neo', server: 'pve-01' });
    expect(filled).toContain('Neo');
    expect(filled).toContain('pve-01');
    expect(fillDeskWords(s.cpuPeak, { n: 61, time: '03:10' })).toMatch(/61 %.*03:10/);
    expect(fillDeskWords(s.guestsCount, { running: 4, off: 1 })).toMatch(/4.*1/);
    expect(fillDeskWords(s.diskOf, { used: '1.2', total: '3.6 TB' })).toMatch(/1\.2.*3\.6 TB/);
    expect(fillDeskWords(s.tempNote, { tone: DESK_WORDS.box.tones.ok, n: 85 })).toMatch(/cool.*85°/);
    for (const w of [s.ask, s.cpuPeak, s.guestsCount, s.diskOf, s.tempNote, s.off, s.yesterday])
      expect(w, w).toMatch(/\{[a-z]+\}/);
  });

  it('names every range and guest state', () => {
    for (const r of DESK_SERVER_RANGES) {
      expect(s.ranges[r]).toBeTruthy();
      expect(s.rangeChips[r]).toBeTruthy();
    }
    for (const g of DESK_GUEST_STATES) expect(s.guestStates[g]).toBeTruthy();
    expect(s.guestStates.stopped).toBe('off');
  });
});
