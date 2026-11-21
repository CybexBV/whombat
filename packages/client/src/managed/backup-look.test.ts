import { describe, expect, it } from 'vitest';
import {
  BACKUP_LOOK_TEXT,
  lookCategoryRows,
  lookDoneLine,
  lookItemMeta,
  lookProblemText,
  lookStage,
  togglePick,
} from './backup-look';

const bring = (over: Record<string, unknown>) =>
  ({
    state: 'done',
    picked: 0,
    back: 0,
    already: 0,
    notBack: 0,
    titles: [],
    signIn: [],
    error: null,
    finishedAt: null,
    ...over,
  }) as never;

describe('bringing things back from a backup: the shared view', () => {
  it('names the categories with their counts', () => {
    expect(
      lookCategoryRows([
        { id: 'messages', count: 12 },
        { id: 'vault', count: 1 },
      ]),
    ).toEqual([
      { id: 'messages', name: 'Chats', count: '12' },
      { id: 'vault', name: 'Vault', count: '1' },
    ]);
  });

  it('follows the look from opening to ready, or says why it stopped', () => {
    expect(lookStage(null)).toBe('opening');
    expect(lookStage({ state: 'opening' })).toBe('opening');
    expect(lookStage({ state: 'ready' })).toBe('ready');
    expect(lookStage({ state: 'failed' })).toBe('stopped');
    expect(
      lookProblemText({ state: 'failed', problem: { code: 'no_room', message: 'There isn’t room…' } }),
    ).toBe('There isn’t room…');
    expect(lookProblemText({ state: 'closed', problem: null })).toBe(BACKUP_LOOK_TEXT.closed);
    expect(lookProblemText({ state: 'ready', problem: null })).toBeNull();
  });

  it('says when and where a thing was', () => {
    const now = new Date('2026-11-04T10:00:00');
    expect(lookItemMeta({ at: '2026-11-03T09:00:00', detail: 'In Chat · 4 replies' }, now)).toBe(
      'Yesterday · In Chat · 4 replies',
    );
    expect(lookItemMeta({ at: null, detail: null }, now)).toBe('');
  });

  it('says how the bring-back went', () => {
    expect(lookDoneLine(bring({ back: 3, already: 1 }))).toBe('3 things are back. 1 was already here.');
    expect(lookDoneLine(bring({ state: 'bringing' }))).toBe(BACKUP_LOOK_TEXT.bringing);
    expect(lookDoneLine(bring({ state: 'failed', error: 'It stopped.' }))).toBe('It stopped.');
    expect(lookDoneLine(null)).toBeNull();
    expect(BACKUP_LOOK_TEXT.bring(1)).toBe('Bring back 1 thing');
    expect(BACKUP_LOOK_TEXT.bring(3)).toBe('Bring back 3 things');
  });

  it('picks and unpicks', () => {
    const one = togglePick(new Set(), 'thread:msg_1');
    expect([...one]).toEqual(['thread:msg_1']);
    expect([...togglePick(one, 'thread:msg_1')]).toEqual([]);
  });
});
