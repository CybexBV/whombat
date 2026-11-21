/**
 * Contracts 0.105.0, the screen's voice (Whombat desk-display.md DK-50…DK-53; CT-610, CT-611): the voices, the
 * setting with its default, a newer runtime's voice read by an older client, and the words.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DESK_SETTINGS,
  DEFAULT_DESK_VOICE,
  DESK_VOICES,
  DESK_WORDS,
  DeskScreen,
  DeskSettings,
  DeskSettingsPatch,
  DeskVoiceName,
  fillDeskWords,
  knownDeskVoices,
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

describe('the screen’s voice (CT-610, CT-611)', () => {
  it('offers six voices, heart first and by default', () => {
    expect(DESK_VOICES).toEqual(['heart', 'bella', 'michael', 'fenrir', 'emma', 'george']);
    expect(DEFAULT_DESK_VOICE).toBe('heart');
    expect(DEFAULT_DESK_SETTINGS.speechVoice).toBe('heart');
    expect(DeskSettings.parse({}).speechVoice).toBe('heart');
    for (const v of DESK_VOICES) expect(DeskVoiceName.safeParse(v).success, v).toBe(true);
  });

  it('reads a screen without voices, and a voice this client doesn’t know', () => {
    const plain = DeskScreen.parse(screen);
    expect(plain.settings.speechVoice).toBe('heart');
    expect(plain.voices).toBeUndefined();
    const newer = DeskScreen.parse({
      ...screen,
      settings: { ...screen.settings, speechVoice: 'nova' },
      voices: ['heart', 'nova', 'emma'],
    });
    expect(newer.settings.speechVoice).toBe('nova');
    expect(knownDeskVoices(newer.voices ?? [])).toEqual(['heart', 'emma']);
    expect(DeskScreen.safeParse({ ...screen, voices: ['Heart'] }).success).toBe(false);
    expect(DeskScreen.safeParse({ ...screen, voices: Array(33).fill('heart') }).success).toBe(false);
  });

  it('changes the voice to one of its own, nothing else', () => {
    expect(DeskSettingsPatch.safeParse({ speechVoice: 'emma' }).success).toBe(true);
    expect(DeskSettingsPatch.safeParse({ speechVoice: 'nova' }).success).toBe(false);
    expect(DeskSettingsPatch.safeParse({ speechVoice: '' }).success).toBe(false);
  });

  it('keeps knownDeskVoices in DESK_VOICES order', () => {
    expect(knownDeskVoices(['george', 'heart', 'x', 'bella'])).toEqual(['heart', 'bella', 'george']);
    expect(knownDeskVoices([])).toEqual([]);
  });

  it('has a name and a kind for every voice, and a sample with the assistant’s name', () => {
    const w = DESK_WORDS.settings;
    for (const v of DESK_VOICES) {
      expect(w.voices[v], v).toBeTruthy();
      expect(w.voiceKinds[v], v).toMatch(/^(American|British) · (woman|man)$/);
    }
    expect(fillDeskWords(w.sample, { assistant: 'Neo' })).toContain('Neo');
    expect(fillDeskWords(w.voiceHint, { assistant: 'Neo' })).toContain('Neo');
    expect(DESK_WORDS.errors.no_voice).toBeTruthy();
  });
});
