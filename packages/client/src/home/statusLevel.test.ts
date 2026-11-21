import { describe, expect, it } from 'vitest';
import {
  needsYouStatusLevel,
  STATUS_REASON_MAX,
  serverStatusLevel,
  sortByStatusLevel,
  statusMarkLabel,
  statusReason,
  statusSummary,
  thingStatusLevel,
  thingStatusView,
} from './statusLevel';

describe('status level', () => {
  it('maps a thing’s status onto the four levels', () => {
    expect(thingStatusLevel('bad')).toBe('notWorking');
    expect(thingStatusLevel('offline')).toBe('notWorking');
    expect(thingStatusLevel('warn')).toBe('needsLook');
    expect(thingStatusLevel('learning')).toBe('learning');
    expect(thingStatusLevel('ok')).toBe('connected');
    expect(thingStatusLevel('unknown')).toBe('connected');
  });

  it('maps a server’s status, waiting for its first report as learning', () => {
    expect(serverStatusLevel('offline')).toBe('notWorking');
    expect(serverStatusLevel('pending')).toBe('learning');
    expect(serverStatusLevel('ok')).toBe('connected');
  });

  it('calls only a bad problem in the Inbox not working, never an ask', () => {
    expect(needsYouStatusLevel({ kind: 'alert', severity: 'bad', nature: 'problem' })).toBe('notWorking');
    expect(needsYouStatusLevel({ kind: 'alert', severity: 'warn' })).toBe('needsLook');
    expect(needsYouStatusLevel({ kind: 'approval', severity: 'bad' })).toBe('needsLook');
    expect(needsYouStatusLevel({ kind: 'hint', severity: 'bad', nature: 'you' })).toBe('needsLook');
  });

  it('says the thing’s own word when offline, the level’s word otherwise, and a reason only when not connected', () => {
    expect(thingStatusView({ status: 'offline' })).toEqual({
      level: 'notWorking',
      word: 'Offline',
      reason: null,
    });
    expect(thingStatusView({ status: 'bad', reason: 'Disk array failed' })).toMatchObject({
      word: 'Not working',
      reason: 'Disk array failed',
    });
    expect(thingStatusView({ status: 'ok', reason: 'stale' }).reason).toBeNull();
  });

  it('keeps a reason within the limit, cut at a word', () => {
    const long = 'The pool pump and the garage door integrations have stopped loading since this morning';
    const cut = statusReason(long);
    expect(cut?.length).toBeLessThanOrEqual(STATUS_REASON_MAX);
    expect(cut?.endsWith('…')).toBe(true);
    expect(long.startsWith(cut?.slice(0, -1) ?? '')).toBe(true);
    expect(statusReason('  ')).toBeNull();
  });

  it('names a mark by the thing and why', () => {
    const view = thingStatusView({ status: 'bad', reason: 'Disk array failed' });
    expect(statusMarkLabel('blackbox', view)).toBe('blackbox: disk array failed');
    expect(statusMarkLabel('pve-02', thingStatusView({ status: 'warn' }))).toBe('pve-02: needs a look');
    expect(statusMarkLabel('Google', thingStatusView({ status: 'ok' }))).toBeNull();
  });

  it('sorts worst first and keeps the order within a level', () => {
    const rows = [
      { id: 'a', level: 'connected' },
      { id: 'b', level: 'needsLook' },
      { id: 'c', level: 'learning' },
      { id: 'd', level: 'needsLook' },
      { id: 'e', level: 'notWorking' },
    ] as const;
    expect(sortByStatusLevel(rows, (r) => r.level).map((r) => r.id)).toEqual(['e', 'b', 'd', 'c', 'a']);
  });

  it('counts the levels in words', () => {
    expect(statusSummary(['connected', 'needsLook', 'connected', 'needsLook', 'learning'])).toBe(
      '2 connected · 2 need a look · 1 learning',
    );
    expect(statusSummary(['needsLook', 'notWorking'])).toBe('1 not working · 1 needs a look');
    expect(statusSummary([])).toBe('');
  });
});
