import { describe, expect, it } from 'vitest';
import { remoteHelpSource } from './contractsSource';
import { parseDesk } from './desk';
import {
  parseRemoteHelp,
  REMOTE_HELP_DESK_WORDS,
  REMOTE_HELP_LEVEL_WORDS,
  REMOTE_HELP_TITLE,
  remoteHelpChipLabel,
  remoteHelpConnected,
  remoteHelpLevel,
  remoteHelpLine,
  untilText,
} from './remoteHelp';

const at = (iso: string) => Date.parse(iso);

describe('remote help on the desk (CG-290, CG-295)', () => {
  it('copies the contracts’ desk words under the same keys', () => {
    // `REMOTE_HELP_WORDS.desk`: from its key to the end of its block (its words hold `{holes}`).
    const from = remoteHelpSource.indexOf('\n  desk: {');
    const desk = from < 0 ? '' : remoteHelpSource.slice(from, remoteHelpSource.indexOf('\n  },', from));
    for (const [key, word] of Object.entries(REMOTE_HELP_DESK_WORDS))
      expect(desk).toContain(`${key}: '${word}'`);
  });

  it('copies the contracts’ title and level words (CG-296)', () => {
    expect(remoteHelpSource).toContain(`title: '${REMOTE_HELP_TITLE}'`);
    // `REMOTE_HELP_WORDS.levels`: from its key to the end of its block.
    const from = remoteHelpSource.indexOf('\n  levels: {');
    const levels = from < 0 ? '' : remoteHelpSource.slice(from, remoteHelpSource.indexOf('\n  },', from));
    for (const [level, { label, hint }] of Object.entries(REMOTE_HELP_LEVEL_WORDS)) {
      expect(levels).toContain(`${level}: {`);
      expect(levels).toContain(`label: '${label}'`);
      expect(levels).toContain(`hint: '${hint}'`);
    }
  });

  it('reads the desk state’s member, and nothing it doesn’t understand', () => {
    expect(parseRemoteHelp({ level: 'fix', until: null, connected: 'Claude' })).toEqual({
      level: 'fix',
      until: null,
      connected: 'Claude',
    });
    expect(
      parseRemoteHelp({ level: 'look', until: '2026-10-21T14:00:00Z', connected: '  ' })?.connected,
    ).toBeNull();
    for (const bad of [null, 'on', { level: 'root', until: null }, { level: 'look', until: 'tomorrow' }, []])
      expect(parseRemoteHelp(bad)).toBeNull();
    const desk = {
      v: 1,
      now: '2026-10-21T12:00:00Z',
      paired: null,
      pairing: null,
      lock: { state: 'locked' },
      glance: null,
      power: null,
      talk: null,
    };
    expect(
      parseDesk({ ...desk, remoteHelp: { level: 'look', until: null, connected: null } })?.remoteHelp,
    ).toEqual({
      level: 'look',
      until: null,
      connected: null,
    });
    expect(parseDesk(desk)).not.toHaveProperty('remoteHelp');
    expect(parseDesk({ ...desk, remoteHelp: { level: 'root' } })).not.toHaveProperty('remoteHelp');
  });

  it('says until when on the person’s clock: today, tomorrow, another day, another year', () => {
    const now = at('2026-10-21T10:00:00Z'); // 12:00 in Amsterdam
    const tz = 'Europe/Amsterdam';
    expect(untilText(at('2026-10-21T12:00:00Z'), now, tz)).toBe('14:00');
    expect(untilText(at('2026-10-21T22:30:00Z'), now, tz)).toBe('tomorrow 00:30');
    expect(untilText(at('2026-10-23T12:00:00Z'), now, tz)).toBe('Fri 23 Oct, 14:00');
    expect(untilText(at('2027-01-02T12:00:00Z'), at('2026-12-30T12:00:00Z'), tz)).toBe(
      'Sat 2 Jan 2027, 13:00',
    );
    expect(untilText(at('2026-10-21T23:30:00Z'), now, 'America/New_York')).toBe('19:30');
  });

  it('makes the line and who is connected', () => {
    const now = at('2026-10-21T10:00:00Z');
    expect(remoteHelpLine({ level: 'fix', until: null, connected: null }, now, 'UTC')).toBe(
      REMOTE_HELP_DESK_WORDS.onForever,
    );
    expect(
      remoteHelpLine({ level: 'look', until: '2026-10-21T14:00:00Z', connected: null }, now, 'UTC'),
    ).toContain('· until 14:00');
    expect(remoteHelpConnected({ level: 'fix', until: null, connected: 'Support' })).toMatch(/^Support is/);
    expect(remoteHelpConnected({ level: 'fix', until: null, connected: null })).toBeNull();
  });

  it('names the chip with the whole line, and the sheet with the level (CG-295, CG-296)', () => {
    const now = at('2026-10-21T10:00:00Z');
    const on = { level: 'fix', until: null, connected: 'Support' } as const;
    expect(remoteHelpChipLabel(on, now, 'UTC')).toContain(REMOTE_HELP_DESK_WORDS.onForever);
    expect(remoteHelpChipLabel(on, now, 'UTC')).toContain('Support is connected');
    expect(remoteHelpChipLabel({ ...on, connected: null }, now, 'UTC')).toBe(
      REMOTE_HELP_DESK_WORDS.onForever,
    );
    expect(remoteHelpLevel(on).label).toBe(REMOTE_HELP_LEVEL_WORDS.fix.label);
    expect(remoteHelpLevel({ ...on, level: 'look' }).label).toBe(REMOTE_HELP_LEVEL_WORDS.look.label);
  });
});
