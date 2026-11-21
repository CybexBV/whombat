/**
 * The screen's voice (Whombat desk-display.md DK-50…DK-52; app desk-display-web.md AP-3400…): the Voice row under Talk,
 * Listen's sample read through an export stream, `no_voice` in words, and the fake screen's voices.
 */
import { describe, expect, it } from 'vitest';
import { createFakeAppliance } from '../session/fake';
import { OperationError } from '../session/managed-ops';
import { createSecureSession } from '../session/secure';
import { base64 } from '../svg';
import { deskApi } from './api';
import { DEFAULT_DESK_SETTINGS, DESK_VOICES, DESK_WORDS, DeskScreen } from './contract';
import { createFakeDesk, deskToneWav, type FakeDeskPerson, fakeDeskApi } from './fake';
import {
  DESK_TEXT,
  deskErrorText,
  deskListenErrorText,
  deskSampleWav,
  deskSectionView,
  deskVoiceView,
} from './model';

const NOW = Date.parse('2026-10-20T12:34:00Z');
const CTX = { assistant: 'Neo', timeZone: 'Europe/Amsterdam', now: NOW };
const JOHN: FakeDeskPerson = { personId: 'prn_john', name: 'John' };
const SIX = [...DESK_VOICES];

function screen(over: Partial<DeskScreen> = {}): DeskScreen {
  return {
    paired: {
      personId: JOHN.personId,
      name: 'John',
      pairedAt: '2026-10-18T09:00:00Z',
      hasPin: true,
      self: false,
    },
    settings: DEFAULT_DESK_SETTINGS,
    pairing: null,
    unlockRequest: null,
    hasDisplay: true,
    hasMicrophone: true,
    hasSpeaker: true,
    hasBattery: true,
    voiceAvailable: true,
    voices: SIX,
    display: { connected: true, real: true, builtIn: true, name: null },
    on: true,
    onChosen: false,
    presenceAvailable: false,
    lockAgain: ['idle', 'never'],
    cameraWakeAvailable: false,
    ...over,
  };
}

/** A fake screen paired with John, its box listing `voices`. */
function pairedDesk(voices: string[] | null = SIX) {
  const desk = createFakeDesk({ hardware: voices ? { voices } : {} });
  desk.call('desk.startPairing', {}, JOHN);
  desk.call('desk.pair', { code: desk.letters(), pin: '246810' }, JOHN);
  return desk;
}

const codeOf = (r: { body: unknown }) =>
  (r.body as { error?: { code: string; details?: { code: string } } }).error;

describe('the Voice row (AP-3400…)', () => {
  it('lists the six voices in their order, each with its name and kind, the chosen one marked', () => {
    const v = deskVoiceView(
      screen({ voices: ['george', 'heart', 'emma', 'bella', 'fenrir', 'michael'] }),
      'Neo',
    );
    expect(v?.title).toBe(DESK_WORDS.settings.voice);
    expect(v?.meta).toContain('Neo');
    expect(v?.options.map((o) => o.value)).toEqual(SIX);
    expect(v?.options[0]).toEqual({
      value: 'heart',
      label: 'Heart',
      kind: DESK_WORDS.settings.voiceKinds.heart,
    });
    expect(v?.options.find((o) => o.value === 'george')?.kind).toContain('British');
    expect(v?.value).toBe('heart');
    const emma = deskVoiceView(
      screen({ settings: { ...DEFAULT_DESK_SETTINGS, speechVoice: 'emma' } }),
      'Neo',
    );
    expect(emma?.value).toBe('emma');
  });

  it('keeps only the voices this app knows; a voice it doesn’t know shows none chosen', () => {
    const v = deskVoiceView(
      screen({
        voices: ['heart', 'nova', 'george'],
        settings: { ...DEFAULT_DESK_SETTINGS, speechVoice: 'nova' },
      }),
      'Neo',
    );
    expect(v?.options.map((o) => o.value)).toEqual(['heart', 'george']);
    expect(v?.value).toBeNull();
  });

  it('none from a runtime before 0.105, with fewer than two known voices, or while Talk is off', () => {
    const { voices: _, ...older } = screen();
    expect(deskVoiceView(older, 'Neo')).toBeNull();
    expect(deskVoiceView(screen({ voices: ['heart', 'nova'] }), 'Neo')).toBeNull();
    expect(deskVoiceView(screen({ settings: { ...DEFAULT_DESK_SETTINGS, voice: false } }), 'Neo')).toBeNull();
    expect(deskVoiceView(screen({ hasMicrophone: false }), 'Neo')).toBeNull();
    expect(deskVoiceView(screen({ voiceAvailable: false }), 'Neo')).toBeNull();
  });

  it('is among the paired screen’s rows', () => {
    expect(deskSectionView(screen(), CTX).mine?.voice?.options).toHaveLength(6);
  });
});

describe('Listen (AP-3400…)', () => {
  it('a sample is a WAV, at most 1 MiB', () => {
    const wav = deskToneWav(440, 0.1);
    expect(deskSampleWav({ audioWav: base64(wav) })).toEqual(wav);
    expect(() => deskSampleWav({ audioWav: 'not base64!' })).toThrow();
    expect(() => deskSampleWav({ audioWav: base64(new TextEncoder().encode('RIFF....NOPE')) })).toThrow();
  });

  it('says why it didn’t play: the box’s refusal, else that the voice couldn’t play', () => {
    const noVoice = new OperationError('desk.voiceSample', 409, 'stream_refused', 'No.', {
      code: 'no_voice',
    });
    expect(deskErrorText(noVoice)).toBe(DESK_WORDS.errors.no_voice);
    expect(deskListenErrorText(noVoice)).toBe(DESK_WORDS.errors.no_voice);
    expect(deskListenErrorText(new Error('NotAllowedError'))).toBe(DESK_TEXT.sampleFailed);
  });

  it('reads the sample through an export stream, larger than a session message', async () => {
    const desk = pairedDesk();
    const appliance = createFakeAppliance({ handle: async (op, input) => desk.call(op, input, JOHN) });
    const session = createSecureSession({ connector: appliance.connector });
    try {
      const api = deskApi(session);
      const wav = await api?.voiceSample('bella');
      expect(wav?.byteLength).toBeGreaterThan(64 * 1024);
      expect(String.fromCharCode(...(wav?.subarray(8, 12) ?? []))).toBe('WAVE');
      // A refusal comes back as the op's: `no_voice` in words (a box that can't speak now).
      const lost = createFakeDesk({ hardware: { voices: ['heart', 'bella'], voiceAvailable: false } });
      lost.call('desk.startPairing', {}, JOHN);
      lost.call('desk.pair', { code: lost.letters(), pin: '246810' }, JOHN);
      const quiet = createFakeAppliance({ handle: async (op, input) => lost.call(op, input, JOHN) });
      const other = createSecureSession({ connector: quiet.connector });
      try {
        const error = await deskApi(other)
          ?.voiceSample('heart')
          .then(
            () => null,
            (e: unknown) => e,
          );
        expect(error).toBeInstanceOf(OperationError);
        expect(deskListenErrorText(error)).toBe(DESK_WORDS.errors.no_voice);
      } finally {
        other.close();
      }
    } finally {
      session.close();
    }
  });
});

describe('the fake screen’s voices', () => {
  it('lists them only where the box says so, and keeps the choice', async () => {
    const john = fakeDeskApi(pairedDesk(), JOHN);
    const before = await john.get();
    expect(before.voices).toEqual(SIX);
    expect(before.settings.speechVoice).toBe('heart');
    expect(DeskScreen.safeParse(before).success).toBe(true);
    expect((await john.update({ speechVoice: 'george' })).settings.speechVoice).toBe('george');
    expect('voices' in (await fakeDeskApi(pairedDesk(null), JOHN).get())).toBe(false);
  });

  it('refuses a voice the box doesn’t list, and the member on a runtime from before', () => {
    const two = pairedDesk(['heart', 'bella']);
    expect(codeOf(two.call('desk.update', { speechVoice: 'emma' }, JOHN))?.details?.code).toBe('no_voice');
    expect(codeOf(two.call('desk.voiceSample', { voice: 'emma' }, JOHN))?.details?.code).toBe('no_voice');
    const older = pairedDesk(null);
    expect(codeOf(older.call('desk.update', { speechVoice: 'bella' }, JOHN))?.code).toBe('validation_failed');
    expect(codeOf(older.call('desk.voiceSample', { voice: 'bella' }, JOHN))?.code).toBe('unknown_op');
  });

  it('plays a sample once paired, a different tone per voice', async () => {
    const desk = pairedDesk();
    const john = fakeDeskApi(desk, JOHN);
    const heart = await john.voiceSample('heart');
    const george = await john.voiceSample('george');
    expect(heart.byteLength).toBe(george.byteLength);
    expect(heart).not.toEqual(george);
    const unpaired = createFakeDesk({ hardware: { voices: SIX } });
    await expect(fakeDeskApi(unpaired, JOHN).voiceSample('heart')).rejects.toMatchObject({
      details: { code: 'not_paired' },
    });
  });
});
