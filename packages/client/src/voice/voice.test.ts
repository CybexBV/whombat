/**
 * Voice typing over the session (dictation.md DT-03, DT-05…DT-07, DT-12): the `voice.*` ops and a recording sent as a
 * `dictation` upload against the fake box, its refusals with their reason, an older box without it; and what
 * Settings → This Whombat → VOICE TYPING and the mic show.
 */
import { DUTCH_VOICE_LICENCE_URL, DUTCH_VOICE_LICENCE_VERSION, type VoiceTyping } from '@whombat/core/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeSession } from '../session/fake-session';
import { OperationError } from '../session/managed-ops';
import { StreamError } from '../session/types';
import { voiceApi } from './api';
import { createFakeVoice, FAKE_TRANSCRIPT, type FakeVoice, fakeVoiceSeed, withFakeVoice } from './fake';
import {
  formatRecordingTime,
  pushVoiceLevel,
  recordingLabel,
  VOICE_TEXT,
  voiceMicOf,
  voiceProblemText,
  voiceSectionShown,
  voiceSectionView,
  voiceSettingErrorText,
  voiceTypingProblemOf,
} from './model';
import { encodeWav } from './wav';

const seconds = (n: number) => encodeWav(new Int16Array(Math.round(n * 16_000)).fill(1200));

/** A fake box with voice typing; timers run at once so downloads and answers don't wait. */
function box(voice: FakeVoice) {
  const { session } = createFakeSession(
    withFakeVoice(
      { handle: async () => ({ status: 404, body: { error: { code: 'not_found', message: '' } } }) },
      voice,
    ),
  );
  return { session, api: voiceApi(session) };
}

const instant = { setTimer: (fn: () => void) => queueMicrotask(fn), clearTimer: () => {} };
const sessions: { close(): void }[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.close();
});

function open(voice: FakeVoice) {
  const b = box(voice);
  sessions.push(b.session);
  return b;
}

describe('voice typing over the session', () => {
  it('turns a recording into text through the dictation upload', async () => {
    const voice = createFakeVoice({ ...instant });
    const { api } = open(voice);
    const out = await api.transcribe({ burrow: 'home', wav: seconds(2) });
    expect(out).toEqual({ text: FAKE_TRANSCRIPT, seconds: 2, model: 'parakeet' });
    expect(voice.heard()).toEqual([2]);
    // Larger than one chunk: the upload pages it.
    const long = await api.transcribe({ burrow: 'home', wav: seconds(40) });
    expect(long.seconds).toBe(40);
  });

  it('answers a refusal with the box’s reason', async () => {
    const voice = createFakeVoice({ ...instant });
    const { api } = open(voice);
    voice.refuseNext('busy');
    const busy = await api.transcribe({ burrow: 'home', wav: seconds(1) }).catch((e: unknown) => e);
    expect(busy).toBeInstanceOf(StreamError);
    expect(voiceTypingProblemOf(busy)).toBe('busy');
    await api.update({ on: false });
    const off = await api.transcribe({ burrow: 'home', wav: seconds(1) }).catch((e: unknown) => e);
    expect(voiceTypingProblemOf(off)).toBe('dictation_off');
  });

  it('refuses a recording over five minutes before its bytes go', async () => {
    const { api } = open(createFakeVoice({ ...instant }));
    const tooLong = await api.transcribe({ burrow: 'home', wav: seconds(301) }).catch((e: unknown) => e);
    expect(voiceTypingProblemOf(tooLong)).toBe('too_long');
  });

  it('changes the settings and downloads what they need', async () => {
    const voice = createFakeVoice({ ...instant, initial: { gpu: { name: 'AMD Radeon 8050S' } } });
    const { api } = open(voice);
    const before = await api.get();
    expect(before.models.find((m) => m.id === 'whisper')).toMatchObject({ state: 'absent', inUse: true });
    const fetching = await api.fetchModel('whisper');
    expect(fetching.models.find((m) => m.id === 'whisper')?.state).toBe('downloading');
    await new Promise((r) => setTimeout(r, 10));
    const after = await api.get();
    expect(after).toMatchObject({ uses: 'whisper', ready: true });
    const nl = await api.update({ language: 'nl', model: 'parakeet' });
    expect(nl).toMatchObject({ language: 'nl', model: 'parakeet', uses: 'parakeet' });
    expect((await api.removeModel('whisper')).models.find((m) => m.id === 'whisper')?.state).toBe('absent');
    const inUse = await api.removeModel('parakeet').catch((e: unknown) => e);
    expect(inUse).toBeInstanceOf(OperationError);
    expect(voiceSettingErrorText(inUse)).toBe(VOICE_TEXT.errors.inUse);
  });

  it('a box without voice typing answers unknown_op', async () => {
    const { api } = open(createFakeVoice({ initial: { available: false } }));
    await expect(api.get()).rejects.toMatchObject({ code: 'unknown_op' });
  });

  it('agrees to the Dutch voice licence, downloads it, and removes it when turned off', async () => {
    const voice = createFakeVoice({ ...instant });
    const { api } = open(voice);
    expect((await api.get()).dutchVoice).toMatchObject({ on: false, state: 'absent', agreedAt: null });
    await expect(api.fetchModel('supertonic')).rejects.toMatchObject({ code: 'forbidden' });
    const on = await api.setDutchVoice({ on: true, licenceVersion: DUTCH_VOICE_LICENCE_VERSION });
    expect(on.dutchVoice).toMatchObject({
      on: true,
      state: 'downloading',
      licenceVersion: DUTCH_VOICE_LICENCE_VERSION,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect((await api.get()).dutchVoice?.state).toBe('ready');
    const off = await api.setDutchVoice({ on: false });
    expect(off.dutchVoice).toMatchObject({
      on: false,
      state: 'absent',
      agreedAt: null,
      licenceVersion: null,
    });
  });
});

function typing(over: Partial<VoiceTyping> = {}): VoiceTyping {
  return { ...createFakeVoice().state(), ...over };
}

describe('the mic', () => {
  it('shows only where voice typing is available and on, and says when its model is still coming', () => {
    expect(voiceMicOf(undefined)).toBe('hidden');
    expect(voiceMicOf(typing({ available: false }))).toBe('hidden');
    expect(voiceMicOf(typing({ on: false }))).toBe('hidden');
    expect(voiceMicOf(typing())).toBe('ready');
    expect(voiceMicOf(createFakeVoice({ initial: fakeVoiceSeed('downloading') }).state())).toBe('not_ready');
  });

  it('counts the recording and keeps the waveform’s last levels', () => {
    expect(formatRecordingTime(12)).toBe('0:12');
    expect(formatRecordingTime(299.9)).toBe('4:59');
    expect(recordingLabel(72)).toContain('1:12');
    let levels: number[] = [];
    for (let i = 0; i < 80; i++) levels = pushVoiceLevel(levels, i / 80);
    expect(levels).toHaveLength(64);
    expect(levels.at(-1)).toBeCloseTo(79 / 80);
    expect(voiceProblemText('microphone')).toBe(VOICE_TEXT.errors.microphone);
  });
});

describe('Settings → VOICE TYPING', () => {
  it('is shown only where the box has the speech service', () => {
    expect(voiceSectionShown(typing())).toBe(true);
    expect(voiceSectionShown(typing({ available: false }))).toBe(false);
    expect(voiceSectionShown(null)).toBe(false);
  });

  it('lists the choices, what Automatic uses now and the models with their size and action', () => {
    const v = voiceSectionView(typing());
    expect(v.on.on).toBe(true);
    expect(v.model.options.map((o) => o.value)).toEqual(['auto', 'parakeet', 'whisper']);
    expect(v.model.uses).toBe(VOICE_TEXT.model.uses.parakeet);
    expect(v.model.warning).toBeNull();
    expect(v.language.options.map((o) => o.label)).toContain('Nederlands');
    const [fast, accurate] = v.models.rows;
    expect(fast).toMatchObject({ id: 'parakeet', size: '669 MB', state: 'ready', tone: 'ok', action: null });
    expect(accurate).toMatchObject({ id: 'whisper', size: '574 MB', action: { kind: 'download' } });
    expect(v.gpu).toBe(VOICE_TEXT.gpu.none);
  });

  it('shows a download’s progress, a failure with Try again and the slow warning', () => {
    const coming = voiceSectionView(createFakeVoice({ initial: fakeVoiceSeed('downloading') }).state());
    expect(coming.models.rows[0]).toMatchObject({ state: 'downloading', progress: 0.4, action: null });
    expect(coming.models.rows[0]?.status).toContain('40%');
    const failed = voiceSectionView(createFakeVoice({ initial: fakeVoiceSeed('failed') }).state());
    expect(failed.models.rows[1]).toMatchObject({
      tone: 'bad',
      action: { kind: 'retry' },
      problem: VOICE_TEXT.problems.no_room,
    });
    expect(failed.model.warning).toBe(VOICE_TEXT.model.slow);
    expect(failed.model.uses).toBeNull();
    const gpu = voiceSectionView(createFakeVoice({ initial: fakeVoiceSeed('gpu') }).state());
    expect(gpu.gpu).toContain('AMD Radeon 8050S');
    expect(gpu.model.uses).toBe(VOICE_TEXT.model.uses.whisper);
    // Both ready: Fast is free to go only while voice typing is off.
    expect(gpu.models.rows.map((r) => r.action?.kind ?? null)).toEqual([null, null]);
    expect(gpu.dutchVoice).toMatchObject({
      title: VOICE_TEXT.dutchVoice.label,
      on: false,
      size: '145 MB',
      licenceVersion: DUTCH_VOICE_LICENCE_VERSION,
      licenceUrl: DUTCH_VOICE_LICENCE_URL,
    });
  });
});
