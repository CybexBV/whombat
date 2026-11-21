/**
 * Contracts 0.107.0, only the clock when nobody's there and staying unlocked (Whombat desk-display.md DK-70…DK-76;
 * CT-640…CT-645): the two settings with their defaults, *Lock again* as one choice over `presence` and
 * `stayUnlocked`, a runtime before 0.107 read by a newer client, the idle times and the words.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DESK_SETTINGS,
  DESK_AWAY_S,
  DESK_IDLE_S,
  DESK_LOCK_AGAIN,
  DESK_WORDS,
  DeskScreen,
  DeskSettings,
  DeskSettingsPatch,
  deskLockAgainOf,
  deskLockAgainPatch,
  fillDeskWords,
} from './desk.js';

const screen = {
  paired: {
    personId: 'prn_john0001',
    name: 'John Doe',
    pairedAt: '2026-10-20T12:00:00Z',
    you: true,
    hasPin: true,
    self: false,
  },
  settings: {
    lockedView: 'summary',
    quietHours: { enabled: true, start: '23:00', end: '07:00' },
    night: 'dim',
  },
  pairing: null,
  unlockRequest: null,
  hasDisplay: true,
  hasMicrophone: true,
  hasSpeaker: true,
  hasBattery: true,
  voiceAvailable: true,
  display: { connected: true, real: true, builtIn: false, name: 'DELL U2720Q' },
  on: true,
  onChosen: false,
  presenceAvailable: false,
  lockAgain: ['idle', 'never'],
  cameraWakeAvailable: false,
};

describe('Lock again and the camera to see when you’re here (CT-640…CT-645)', () => {
  it('starts with both off', () => {
    expect(DEFAULT_DESK_SETTINGS.stayUnlocked).toBe(false);
    expect(DEFAULT_DESK_SETTINGS.cameraWake).toBe(false);
    const parsed = DeskScreen.parse(screen);
    expect(parsed.settings.stayUnlocked).toBe(false);
    expect(parsed.settings.cameraWake).toBe(false);
  });

  it('reads the choices a runtime offers, in order, nothing else', () => {
    const s = DeskScreen.parse({ ...screen, lockAgain: ['idle', 'never'], cameraWakeAvailable: false });
    expect(s.lockAgain).toEqual(['idle', 'never']);
    expect(DESK_LOCK_AGAIN).toEqual(['idle', 'away', 'never']);
    expect(DeskScreen.safeParse({ ...screen, lockAgain: ['always'] }).success).toBe(false);
  });

  it('is one choice: stayUnlocked wins over presence', () => {
    expect(deskLockAgainOf({ presence: false, stayUnlocked: false })).toBe('idle');
    expect(deskLockAgainOf({ presence: true, stayUnlocked: false })).toBe('away');
    expect(deskLockAgainOf({ presence: false, stayUnlocked: true })).toBe('never');
    expect(deskLockAgainOf({ presence: true, stayUnlocked: true })).toBe('never');
    for (const choice of DESK_LOCK_AGAIN) {
      const patch = deskLockAgainPatch(choice);
      expect(deskLockAgainOf(patch), choice).toBe(choice);
      expect(DeskSettingsPatch.safeParse(patch).success, choice).toBe(true);
    }
  });

  it('takes the camera switch in a patch', () => {
    expect(DeskSettingsPatch.safeParse({ cameraWake: true }).success).toBe(true);
    expect(DeskSettingsPatch.safeParse({ cameraWake: 'on' }).success).toBe(false);
    expect(DeskSettings.parse({ cameraWake: true }).cameraWake).toBe(true);
  });

  it('goes idle after 10 minutes untouched, a minute after the camera last saw someone', () => {
    expect(DESK_IDLE_S).toBe(600);
    expect(DESK_AWAY_S).toBe(60);
  });

  it('has the words for every choice, the camera and the chip', () => {
    const w = DESK_WORDS.settings;
    for (const c of DESK_LOCK_AGAIN) {
      expect(w.lockAgainChoices[c], c).toBeTruthy();
      expect(w.lockAgainHints[c], c).toBeTruthy();
    }
    expect(fillDeskWords(w.lockAgainHints.never, { assistant: 'Neo' })).toContain('Neo');
    expect(w.cameraWake).toContain('camera');
    expect(fillDeskWords(DESK_WORDS.unlockedStays, { name: 'John' })).toBe('Unlocked as John');
    expect(DESK_WORDS.cameraLooking).toContain('camera');
  });
});
