/**
 * Contracts 0.103.0, a four-digit PIN and staying unlocked while you're there (Whombat desk-display.md DK-26…DK-35;
 * CT-590…CT-593): PINs of 4 to 6 digits, the ones too easy to guess, the presence setting, its timing and its words.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DESK_SETTINGS,
  DESK_PIN_MAX,
  DESK_PIN_MIN,
  DESK_PIN_RE,
  DESK_PRESENCE_CHECK_S,
  DESK_PRESENCE_GONE_S,
  DESK_PRESENCE_MAX_S,
  DESK_UNLOCKED_IDLE_S,
  DESK_WORDS,
  DeskPin,
  DeskPinDigits,
  DeskScreen,
  DeskSettings,
  DeskSettingsPatch,
  deskPinTooEasy,
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
    voice: true,
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

describe('a PIN of 4 to 6 digits (CT-590)', () => {
  it('takes 4, 5 and 6 ASCII digits, not 3 or 7', () => {
    expect([DESK_PIN_MIN, DESK_PIN_MAX]).toEqual([4, 6]);
    for (const pin of ['2580', '13970', '860417']) expect(DeskPin.safeParse(pin).success, pin).toBe(true);
    for (const pin of ['258', '8604170', '', '25 80', '2580\n', '25a0', 2580])
      expect(DeskPin.safeParse(pin).success, String(pin)).toBe(false);
    // ASCII only: other scripts' digits and full-width ones are not a PIN, whatever `\d` would say.
    for (const pin of ['٢٥٨٠', '२५८०', '２５８０', '𝟐𝟓𝟖𝟎'])
      expect(DeskPin.safeParse(pin).success, pin).toBe(false);
    expect(DESK_PIN_RE.source).toBe('^[0-9]{4,6}$');
  });

  it('says its length as a whole number of 4 to 6', () => {
    for (const n of [4, 5, 6]) expect(DeskPinDigits.safeParse(n).success, String(n)).toBe(true);
    for (const n of [3, 7, 4.5, '4']) expect(DeskPinDigits.safeParse(n).success, String(n)).toBe(false);
  });
});

describe('PINs too easy to guess (CT-591)', () => {
  it('refuses one digit repeated, runs up and down, a pair or three digits repeated', () => {
    for (const pin of ['0000', '1234', '7890', '0987', '4321', '1212', '6969', '123123', '123456', '654321'])
      expect(deskPinTooEasy(pin), pin).toBe(true);
  });

  it('accepts the rest', () => {
    for (const pin of ['2580', '1397', '5203', '860417']) expect(deskPinTooEasy(pin), pin).toBe(false);
  });

  it('reads 9 and 0 as next to each other, at every length', () => {
    for (const pin of ['8901', '9012', '1098', '56789', '34567', '98765', '11111', '999999', '890123'])
      expect(deskPinTooEasy(pin), pin).toBe(true);
    // A run that turns back, a step of two, a near-repeat: not too easy.
    for (const pin of ['1232', '2468', '1213', '12312', '123124', '135790'])
      expect(deskPinTooEasy(pin), pin).toBe(false);
  });

  it('repeats a pair in five digits too, a triple only when it fits twice', () => {
    expect(deskPinTooEasy('12121')).toBe(true);
    expect(deskPinTooEasy('121212')).toBe(true);
    expect(deskPinTooEasy('1231')).toBe(false);
    expect(deskPinTooEasy('12312')).toBe(false);
  });

  it('judges only a PIN; the schema refuses the rest', () => {
    for (const notPin of ['', '123', '1111111', 'abcd', '٠٠٠٠'])
      expect(deskPinTooEasy(notPin), notPin).toBe(false);
  });
});

describe('stay unlocked while you’re here (CT-592, CT-593)', () => {
  it('is off until the person turns it on, and off on an older runtime', () => {
    expect(DEFAULT_DESK_SETTINGS.presence).toBe(false);
    expect(DeskSettings.parse({}).presence).toBe(false);
    expect(DeskSettings.parse(screen.settings).presence).toBe(false);
    expect(DeskSettings.parse({ ...screen.settings, presence: true }).presence).toBe(true);
  });

  it('is one of the settings desk.update takes, a boolean', () => {
    expect(DeskSettingsPatch.safeParse({ presence: true }).success).toBe(true);
    expect(DeskSettingsPatch.safeParse({ presence: 'on' }).success).toBe(false);
  });

  it('shows the switch where the runtime says the camera works', () => {
    expect(DeskScreen.parse({ ...screen, presenceAvailable: true }).presenceAvailable).toBe(true);
    expect(DeskScreen.parse({ ...screen, presenceAvailable: false }).presenceAvailable).toBe(false);
  });

  it('locks sooner after you leave than after the last touch, at most four hours in a row', () => {
    expect(DESK_PRESENCE_GONE_S).toBe(30);
    expect(DESK_PRESENCE_GONE_S).toBeLessThan(DESK_UNLOCKED_IDLE_S);
    expect(DESK_PRESENCE_MAX_S).toBe(4 * 3_600);
    expect(DESK_PRESENCE_CHECK_S).toBe(2);
    expect(DESK_PRESENCE_CHECK_S * 3).toBeLessThan(DESK_PRESENCE_GONE_S);
  });
});

describe('the words (CT-593)', () => {
  it('say the PIN’s length, the camera and staying unlocked, with the person’s name filled in', () => {
    expect(DESK_WORDS.settings.choosePin).toContain('4 to 6 digits');
    expect(fillDeskWords(DESK_WORDS.unlockedHere, { name: 'John' })).toMatch(
      /^Unlocked as John · .*while you’re here$/,
    );
    expect(DESK_WORDS.cameraOn).toContain('camera');
    expect(DESK_WORDS.settings.presence).toContain('while you’re here');
    expect(DESK_WORDS.settings.presenceHint).toContain('30 seconds');
    expect(DESK_WORDS.settings.presenceHint).toContain('doesn’t recognize faces');
    expect(DESK_WORDS.errors.easy_pin).toContain('too easy');
  });
});
