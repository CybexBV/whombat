/** Contracts 0.100.0: the desk screen over the session (CT-522…CT-526). */

import { DESK_WORDS } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  DESK_ERROR_CODES,
  DESK_ERROR_STATUS,
  DeskErrorDetails,
  DeskVoiceSample,
  DeskVoiceSampleInput,
} from './desk.js';
import { APP_ERROR_CODES } from './errors.js';
import { HostMetricsOutput, HostNow } from './host.js';
import { operationSafety, resendAfterNotFound } from './operation-safety.js';
import { createOperationAllowlist, SESSION_OPERATIONS } from './operations.js';
import { decodeTolerant } from './tolerant.js';

const DESK_OPS = [
  'desk.get',
  'desk.startPairing',
  'desk.pair',
  'desk.setPin',
  'desk.update',
  'desk.unpair',
  'desk.answerUnlock',
];
const screen = {
  paired: {
    personId: 'prn_john0001',
    name: 'John Doe',
    pairedAt: '2026-10-20T12:00:00Z',
    hasPin: true,
    self: false,
  },
  settings: {
    lockedView: 'summary',
    quietHours: { enabled: true, start: '23:00', end: '07:00' },
    night: 'dim',
    voice: true,
    presence: false,
    speechVoice: 'heart',
    stayUnlocked: false,
    cameraWake: false,
    show: {
      bar: { network: 'always', internet: 'always', battery: 'always', updates: 'matters' },
      items: {},
      order: [],
      clock: 'big',
      welcomeBack: true,
      doneToday: true,
    },
  },
  pairing: null,
  unlockRequest: { id: 'unl_q3Vx9LpA0dZk', expiresAt: '2026-10-20T12:36:00Z' },
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

describe('the desk screen over the session (CT-523, CT-526)', () => {
  it('has seven session-native app ops; pairing and the PIN are secret', () => {
    const allow = createOperationAllowlist();
    for (const op of DESK_OPS) {
      const spec = SESSION_OPERATIONS.get(op);
      expect(spec?.source, op).toBe('session');
      expect(spec?.channel, op).toBe('app');
      expect(allow.resolve(op, { enrolled: false }), op).toEqual({ ok: false, code: 'enrollment_required' });
      expect(spec?.secret, op).toBe(op === 'desk.pair' || op === 'desk.setPin');
      expect(spec?.mutating, op).toBe(op !== 'desk.get');
      expect(spec?.ephemeral, op).toBe(false);
    }
    expect(SESSION_OPERATIONS.get('desk.get')?.output.parse(screen)).toEqual(screen);
  });

  it('never resends what acts outside a receipt; unpairing is for a person to decide', () => {
    expect(operationSafety('desk.get')).toEqual({ destructive: false, retry: 'safe' });
    expect(operationSafety('desk.update')).toEqual({ destructive: false, retry: 'receipt' });
    expect(operationSafety('desk.unpair')).toEqual({ destructive: true, retry: 'receipt' });
    for (const op of ['desk.startPairing', 'desk.pair', 'desk.setPin', 'desk.answerUnlock'])
      expect(operationSafety(op), op).toEqual({ destructive: false, retry: 'never' });
    expect(resendAfterNotFound('desk.update')).toBe(true);
    expect(resendAfterNotFound('desk.unpair')).toBe(false);
  });

  it('takes the letters and a six-digit PIN, strictly', () => {
    const pair = SESSION_OPERATIONS.get('desk.pair')?.input;
    expect(pair?.safeParse({ code: 'KXQM', pin: '048213' }).success).toBe(true);
    expect(pair?.safeParse({ code: 'KXQO', pin: '048213' }).success).toBe(false);
    // 4 to 6 digits since 0.103 (CT-590).
    expect(pair?.safeParse({ code: 'KXQM', pin: '482' }).success).toBe(false);
    expect(pair?.safeParse({ code: 'KXQM', pin: '048213', name: 'John' }).success).toBe(false);
    const update = SESSION_OPERATIONS.get('desk.update')?.input;
    expect(update?.safeParse({ night: 'black' }).success).toBe(true);
    expect(update?.safeParse({ night: 'off' }).success).toBe(false);
    const answer = SESSION_OPERATIONS.get('desk.answerUnlock')?.input;
    expect(answer?.safeParse({ id: 'unl_q3Vx9LpA0dZk', unlock: true }).success).toBe(true);
    expect(answer?.safeParse({ id: 'unl_q3Vx9LpA0dZk' }).success).toBe(false);
    expect(SESSION_OPERATIONS.get('desk.answerUnlock')?.output.parse({ ok: true })).toEqual({ ok: true });
  });

  it('refuses with codes that have words and a status', () => {
    for (const code of DESK_ERROR_CODES) {
      expect(APP_ERROR_CODES, code).toHaveProperty(code);
      expect(DESK_WORDS.errors, code).toHaveProperty(code);
      expect(DESK_ERROR_STATUS[code], code).toBeTruthy();
    }
    expect(DeskErrorDetails.parse({ code: 'wrong_code', triesLeft: 3 })).toEqual({
      code: 'wrong_code',
      triesLeft: 3,
    });
    expect(DESK_ERROR_STATUS.pairing_expired).toBe('expired');
  });
});

describe('the battery in the box’s measurements (CT-522)', () => {
  const now = {
    at: '2026-10-20T00:20:00Z',
    cpuPermille: 40,
    cores: 16,
    memoryTotalBytes: 128_000_000_000,
    memoryUsedBytes: 9_000_000_000,
    containersMemoryBytes: null,
    uplink: ['enx00e04c680001'],
  };
  const power = {
    source: 'battery',
    percent: 72,
    charging: false,
    minutesLeft: 190,
    chargeLimit: 80,
    since: '2026-10-20T00:14:00Z',
  };

  it('is there on a machine with a battery, absent elsewhere', () => {
    expect(HostNow.parse({ ...now, power }).power).toEqual(power);
    expect(HostNow.parse(now).power).toBeUndefined();
    expect(HostNow.safeParse({ ...now, power: { ...power, percent: 100.5 } }).success).toBe(false);
  });

  it('lets an older app read a newer source without failing the measurements', () => {
    const r = decodeTolerant(HostMetricsOutput, {
      metrics: null,
      reason: 'unavailable',
    });
    expect(r.ok).toBe(true);
    const n = decodeTolerant(HostNow, { ...now, power: { ...power, source: 'solar' } });
    expect(n.ok).toBe(true);
    if (n.ok) expect(n.data.power).toBeUndefined();
  });
});

describe('a screen that works at once (0.101, CT-540…CT-542)', () => {
  it('turns the screen on or off for an owner, a person deciding, at the same level', () => {
    const spec = SESSION_OPERATIONS.get('desk.setScreen');
    expect(spec?.source).toBe('session');
    expect(spec?.channel).toBe('app');
    expect(spec?.mutating).toBe(true);
    expect(spec?.secret).toBe(false);
    expect(spec?.input.safeParse({ on: true }).success).toBe(true);
    expect(spec?.input.safeParse({ on: 'yes' }).success).toBe(false);
    expect(spec?.input.safeParse({ on: false, pin: '048213' }).success).toBe(false);
    const on = {
      ...screen,
      paired: { ...screen.paired, hasPin: false, self: true },
      display: { connected: true, real: true, builtIn: true, name: null },
      on: true,
      onChosen: true,
    };
    expect(spec?.output.parse(on)).toEqual(on);
    expect(operationSafety('desk.setScreen')).toEqual({ destructive: true, retry: 'receipt' });
    expect(operationSafety('desk.setScreen')).toEqual(operationSafety('desk.unpair'));
    // No feature of its own: the next one is 0.102's.
  });

  it('refuses without a screen, and a PIN where there is none', () => {
    expect(DESK_ERROR_CODES).toEqual(expect.arrayContaining(['no_screen', 'no_pin']));
    expect(DESK_ERROR_STATUS.no_screen).toBe('conflict');
    expect(DESK_ERROR_STATUS.no_pin).toBe('conflict');
    expect(DeskErrorDetails.parse({ code: 'no_pin' })).toEqual({ code: 'no_pin' });
  });

  it('measures the processor’s temperature and the uptime where it can', () => {
    const now = {
      at: '2026-10-20T00:20:00Z',
      cpuPermille: 70,
      cores: 16,
      memoryTotalBytes: 64_000_000_000,
      memoryUsedBytes: 11_200_000_000,
      containersMemoryBytes: null,
      uplink: ['enx00e04c680001'],
    };
    expect(HostNow.parse({ ...now, cpuTempC: 46, uptimeS: 8_040 })).toMatchObject({
      cpuTempC: 46,
      uptimeS: 8_040,
    });
    expect(HostNow.parse(now).cpuTempC).toBeUndefined();
    expect(HostNow.safeParse({ ...now, cpuTempC: 46.5 }).success).toBe(false);
    expect(HostNow.safeParse({ ...now, cpuTempC: -51 }).success).toBe(false);
    expect(HostNow.safeParse({ ...now, uptimeS: 10 ** 10 + 1 }).success).toBe(false);
  });
});

describe('a four-digit PIN and staying unlocked while you’re there (0.103, CT-590…CT-594)', () => {
  it('pairs and sets a PIN of 4 to 6 digits, an easy one too: the runtime refuses it, not the schema', () => {
    for (const op of ['desk.pair', 'desk.setPin']) {
      const input = SESSION_OPERATIONS.get(op)?.input;
      const base = op === 'desk.pair' ? { code: 'KXQM' } : {};
      for (const pin of ['2580', '13970', '860417', '1234'])
        expect(input?.safeParse({ ...base, pin }).success, `${op} ${pin}`).toBe(true);
      for (const pin of ['258', '8604170', '٢٥٨٠'])
        expect(input?.safeParse({ ...base, pin }).success, `${op} ${pin}`).toBe(false);
    }
  });

  it('refuses an easy PIN as a value it won’t take, with words', () => {
    expect(DESK_ERROR_CODES).toContain('easy_pin');
    expect(DESK_ERROR_STATUS.easy_pin).toBe('validation_failed');
    expect(APP_ERROR_CODES).toHaveProperty('easy_pin');
    expect(DESK_WORDS.errors.easy_pin).toBeTruthy();
    expect(DeskErrorDetails.parse({ code: 'easy_pin' })).toEqual({ code: 'easy_pin' });
  });

  it('turns presence on and off with desk.update, and says where the camera works', () => {
    const update = SESSION_OPERATIONS.get('desk.update')?.input;
    expect(update?.safeParse({ presence: true }).success).toBe(true);
    expect(update?.safeParse({ presence: 'yes' }).success).toBe(false);
    const here = { ...screen, settings: { ...screen.settings, presence: true }, presenceAvailable: true };
    expect(SESSION_OPERATIONS.get('desk.get')?.output.parse(here)).toEqual(here);
    // A setting left out reads off.
    const { presence: _presence, ...rest } = screen.settings;
    const parsed = SESSION_OPERATIONS.get('desk.get')?.output.parse({ ...screen, settings: rest });
    expect(parsed).toMatchObject({ settings: { presence: false } });
  });

  it('needs no feature and no new level: optional fields, a widened input, an error code', () => {
    // `DeskScreen.presenceAvailable` says a runtime has it (DK-34).
    // (`presence` is people's online presence, CT-179.)
  });
});

describe('Listen (0.105, CT-612, CT-613)', () => {
  it('reads desk.voiceSample as a non-mutating app op, through an export stream', () => {
    const spec = SESSION_OPERATIONS.get('desk.voiceSample');
    expect(spec?.source).toBe('session');
    expect(spec?.channel).toBe('app');
    expect(spec?.mutating).toBe(false);
    expect(spec?.exportable).toBe(true);
    expect(spec?.secret).toBe(false);
    expect(DeskVoiceSampleInput.safeParse({ voice: 'emma' }).success).toBe(true);
    expect(DeskVoiceSampleInput.safeParse({ voice: 'nova' }).success).toBe(false);
    expect(DeskVoiceSampleInput.safeParse({ voice: 'emma', text: 'Say this' }).success).toBe(false);
    expect(DeskVoiceSample.safeParse({ audioWav: 'UklGR'.padEnd(64, 'A') }).success).toBe(true);
    expect(DeskVoiceSample.safeParse({ audioWav: '%'.repeat(64) }).success).toBe(false);
  });

  it('refuses a voice the screen hasn’t with no_voice, on conflict, in words', () => {
    expect(DESK_ERROR_CODES).toContain('no_voice');
    expect(DESK_ERROR_STATUS.no_voice).toBe('conflict');
    expect(DESK_WORDS.errors.no_voice).toBeTruthy();
  });
});

describe('Settings → Screen (3.2, CT-1621…CT-1628)', () => {
  it('reads an older answer without the choices as the defaults', () => {
    const { show: _show, ...older } = screen.settings;
    const parsed = SESSION_OPERATIONS.get('desk.get')?.output.parse({ ...screen, settings: older });
    expect(parsed).toMatchObject({
      settings: { show: { clock: 'big', items: {}, bar: { updates: 'matters' } } },
    });
  });

  it('takes a part of the choices in desk.update, a null putting a key back', () => {
    const update = SESSION_OPERATIONS.get('desk.update')?.input;
    expect(
      update?.safeParse({ show: { items: { 'server:pve-01': 'off', 'connection:con_1': null } } }).success,
    ).toBe(true);
    expect(update?.safeParse({ show: { items: { 'nope:1': 'off' } } }).success).toBe(false);
    expect(update?.safeParse({ show: { clock: 'huge' } }).success).toBe(false);
    expect(update?.safeParse({ show: { extra: true } }).success).toBe(false);
  });

  it('previews and tries on the screen without keeping anything; the name is a receipt', () => {
    expect(SESSION_OPERATIONS.get('desk.preview')?.mutating).toBe(false);
    expect(operationSafety('desk.preview')).toEqual({ destructive: false, retry: 'safe' });
    expect(operationSafety('desk.tryOnScreen')).toEqual({ destructive: false, retry: 'never' });
    expect(operationSafety('desk.setName')).toEqual({ destructive: false, retry: 'receipt' });
    const preview = SESSION_OPERATIONS.get('desk.preview')?.input;
    expect(preview?.safeParse({ scenario: 'wrong' }).success).toBe(true);
    expect(preview?.safeParse({ scenario: 'later' }).success).toBe(false);
    const name = SESSION_OPERATIONS.get('desk.setName')?.input;
    expect(name?.safeParse({ name: 'Home' }).success).toBe(true);
    expect(name?.safeParse({ name: 'Two\nlines' }).success).toBe(false);
    expect(name?.safeParse({ name: '' }).success).toBe(false);
  });
});
