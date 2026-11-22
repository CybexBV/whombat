/**
 * Voice typing as Settings sees it: which model a recording goes to, what the
 * settings want downloaded, and the view from the settings, the desk's Talk, the speech service and the downloads.
 */
import type { VoiceModelState } from '@whombat/control-contracts/local';
import {
  DUTCH_VOICE_LICENCE_VERSION,
  VOICE_MODEL_SIZES,
  type VoiceDownloadModel,
  VoiceTyping,
} from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import type { VoiceAbility } from './speech';
import {
  DEFAULT_VOICE_TYPING,
  modelFor,
  type VoiceFacts,
  voiceTypingForMinor,
  voiceTypingView,
  wantedModels,
  wantsDutchVoice,
} from './view';

const ready = (...ids: ('parakeet' | 'whisper')[]) => new Set(ids);

const HEALTH: VoiceAbility = { stt: true, tts: true, microphone: true, speaker: true, models: [] };

function model(id: VoiceDownloadModel, state: VoiceModelState['state'], extra = {}): VoiceModelState {
  return { id, state, size: 1000, received: state === 'ready' ? 1000 : 0, ...extra };
}

function facts(f: Partial<VoiceFacts> = {}): VoiceFacts {
  return {
    settings: DEFAULT_VOICE_TYPING,
    deskTalk: false,
    health: HEALTH,
    fetched: [model('parakeet', 'absent'), model('whisper', 'absent')],
    hasFetcher: true,
    ...f,
  };
}

describe('the model a recording goes to', () => {
  it('is Whisper on a graphics chip in Automatic, else Parakeet, else Whisper on the processor', () => {
    expect(modelFor('auto', ready('parakeet', 'whisper'), true)).toBe('whisper');
    expect(modelFor('auto', ready('parakeet', 'whisper'), false)).toBe('parakeet');
    expect(modelFor('auto', ready('parakeet'), true)).toBe('parakeet');
    expect(modelFor('auto', ready('whisper'), false)).toBe('whisper');
    expect(modelFor('auto', ready(), true)).toBeNull();
  });

  it('is the chosen one only when it is there', () => {
    expect(modelFor('whisper', ready('parakeet'), true)).toBeNull();
    expect(modelFor('whisper', ready('whisper'), false)).toBe('whisper');
    expect(modelFor('parakeet', ready('parakeet', 'whisper'), true)).toBe('parakeet');
  });
});

describe('what the settings want downloaded', () => {
  const settings = (s: Partial<typeof DEFAULT_VOICE_TYPING>) => ({ ...DEFAULT_VOICE_TYPING, ...s });

  it('is Parakeet while voice typing or the desk’s Talk is on', () => {
    expect([...wantedModels(settings({}), false, false)]).toEqual(['parakeet']);
    expect([...wantedModels(settings({ on: false }), true, false)]).toEqual(['parakeet']);
    expect([...wantedModels(settings({ model: 'parakeet' }), false, true)]).toEqual(['parakeet']);
  });

  it('is Whisper too when chosen, or in Automatic with a graphics chip', () => {
    expect([...wantedModels(settings({ model: 'whisper' }), false, false)]).toEqual(['parakeet', 'whisper']);
    expect([...wantedModels(settings({}), false, true)]).toEqual(['parakeet', 'whisper']);
  });

  it('is nothing while neither hears anything', () => {
    expect([...wantedModels(settings({ on: false, model: 'whisper' }), false, true)]).toEqual([]);
  });
});

describe('the view', () => {
  it('starts on, Automatic, with nothing downloaded and the mic not ready', () => {
    const view = voiceTypingView(facts());
    expect(VoiceTyping.parse(view)).toEqual(view);
    expect(view).toMatchObject({
      available: true,
      on: true,
      ready: false,
      uses: null,
      gpu: null,
      maxSeconds: 300,
    });
    expect(view.models.map((m) => [m.id, m.state, m.inUse])).toEqual([
      ['parakeet', 'absent', true],
      ['whisper', 'absent', false],
    ]);
  });

  it('uses what the speech service runs, and shows its graphics chip', () => {
    const view = voiceTypingView(
      facts({
        health: { ...HEALTH, models: ['parakeet', 'whisper'], gpu: { name: 'AMD Radeon 8060S' } },
        fetched: [model('whisper', 'ready'), model('parakeet', 'ready')],
      }),
    );
    expect(view).toMatchObject({ ready: true, uses: 'whisper', gpu: { name: 'AMD Radeon 8060S' } });
    // In the order Settings shows them, both needed: Parakeet while voice typing is on, Whisper in use.
    expect(view.models.map((m) => [m.id, m.inUse])).toEqual([
      ['parakeet', true],
      ['whisper', true],
    ]);
  });

  it('keeps the model recordings go to from being removed, even when the settings wouldn’t download it', () => {
    const view = voiceTypingView(
      facts({
        health: { ...HEALTH, models: ['whisper'] },
        fetched: [model('parakeet', 'failed', { problem: 'no_room' }), model('whisper', 'ready')],
      }),
    );
    expect(view.uses).toBe('whisper');
    expect(view.models.find((m) => m.id === 'whisper')?.inUse).toBe(true);
    expect(view.models.find((m) => m.id === 'parakeet')).toMatchObject({
      state: 'failed',
      problem: 'no_room',
    });
  });

  it('lets everything go while voice typing and the desk’s Talk are off', () => {
    const off = { ...DEFAULT_VOICE_TYPING, on: false };
    const view = voiceTypingView(facts({ settings: off, health: { ...HEALTH, models: ['parakeet'] } }));
    expect(view).toMatchObject({ on: false, ready: false, uses: 'parakeet' });
    expect(view.models.every((m) => !m.inUse)).toBe(true);
    // The desk's Talk hears with the same models: it keeps them.
    const desk = voiceTypingView(
      facts({ settings: off, deskTalk: true, health: { ...HEALTH, models: ['whisper'] } }),
    );
    expect(desk.models.map((m) => [m.id, m.inUse])).toEqual([
      ['parakeet', true],
      ['whisper', true],
    ]);
  });

  it('is not available without a speech service that can turn recordings into text', () => {
    const older = { stt: true, tts: true, microphone: true, speaker: true };
    for (const f of [{ health: null }, { health: older, hasFetcher: false, fetched: null }]) {
      const view = voiceTypingView(facts({ fetched: [model('parakeet', 'ready')], ...f }));
      expect(view).toMatchObject({ available: false, ready: false, uses: null, gpu: null });
    }
  });

  it('is available on a new box before its first model is there, to show the download', () => {
    const none = { stt: false, tts: true, microphone: true, speaker: true };
    const view = voiceTypingView(
      facts({ health: none, fetched: [model('parakeet', 'downloading', { received: 400 })] }),
    );
    expect(view).toMatchObject({ available: true, ready: false, uses: null });
    expect(view.models.map((m) => [m.id, m.state, m.inUse])).toEqual([['parakeet', 'downloading', true]]);
  });

  it('shows the models the service runs with catalog or last-known sizes when there is no fetcher answer', () => {
    const view = voiceTypingView(
      facts({ health: { ...HEALTH, models: ['parakeet'] }, fetched: null, hasFetcher: false }),
    );
    expect(view.models).toEqual([
      {
        id: 'parakeet',
        state: 'ready',
        size: VOICE_MODEL_SIZES.parakeet,
        received: VOICE_MODEL_SIZES.parakeet,
        inUse: true,
      },
    ]);
    expect(view.ready).toBe(true);

    const observed = voiceTypingView(
      facts({
        health: { ...HEALTH, models: ['parakeet', 'whisper'] },
        fetched: null,
        knownModelSizes: { whisper: 32_000_000 },
      }),
    );
    expect(observed.models).toEqual([
      {
        id: 'parakeet',
        state: 'ready',
        size: VOICE_MODEL_SIZES.parakeet,
        received: VOICE_MODEL_SIZES.parakeet,
        inUse: true,
      },
      {
        id: 'whisper',
        state: 'ready',
        size: 32_000_000,
        received: 32_000_000,
        inUse: false,
      },
    ]);
  });

  it('shows a download’s progress and why one waits', () => {
    const view = voiceTypingView(
      facts({
        fetched: [
          model('parakeet', 'downloading', { received: 400 }),
          model('whisper', 'waiting', { problem: 'no_network' }),
        ],
      }),
    );
    expect(view.models).toMatchObject([
      { id: 'parakeet', state: 'downloading', received: 400, size: 1000 },
      { id: 'whisper', state: 'waiting', problem: 'no_network' },
    ]);
  });

  it('tracks the opt-in Dutch voice separately from dictation models and requires the current licence version', () => {
    const agreedAt = new Date('2026-11-21T20:00:00.000Z');
    const fetchedClean = [
      model('parakeet', 'ready'),
      model('whisper', 'absent'),
      model('supertonic', 'absent', { size: 145_310_775, received: 0 }),
    ];
    // Off and no files on disk: state stays absent and supertonic isn't listed in dictation models.
    const cleanOff = voiceTypingView(facts({ fetched: fetchedClean }));
    expect(cleanOff.models.map((m) => m.id)).toEqual(['parakeet', 'whisper']);
    expect(cleanOff.dutchVoice).toEqual({
      on: false,
      state: 'absent',
      size: 145_310_775,
      received: 0,
      agreedAt: null,
      licenceVersion: null,
    });
    expect(wantsDutchVoice(DEFAULT_VOICE_TYPING)).toBe(false);

    // Off while leftover files remain (removing, downloading, or partial bytes): reports removing with bytes left.
    const fetched = [
      model('parakeet', 'ready'),
      model('whisper', 'absent'),
      model('supertonic', 'downloading', { size: 145_310_775, received: 50_000_000 }),
    ];
    const offWithFiles = voiceTypingView(facts({ fetched }));
    expect(VoiceTyping.parse(offWithFiles)).toEqual(offWithFiles);
    expect(offWithFiles.dutchVoice).toEqual({
      on: false,
      state: 'removing',
      size: 145_310_775,
      received: 50_000_000,
      agreedAt: null,
      licenceVersion: null,
    });
    const offRemoving = voiceTypingView(
      facts({
        fetched: [
          model('parakeet', 'ready'),
          model('whisper', 'removing', { size: 1000, received: 400 }),
          model('supertonic', 'removing', { size: 145_310_775, received: 65_536 }),
        ],
      }),
    );
    expect(offRemoving.dutchVoice).toMatchObject({ on: false, state: 'removing', received: 65_536 });
    expect(offRemoving.models.find((m) => m.id === 'whisper')).toMatchObject({
      state: 'removing',
      received: 400,
    });
    // Older phone apps (protocol minor < 3) get 'absent'/0 instead of 'removing' so their parser accepts the response.
    const forOlder = voiceTypingForMinor(offRemoving, 2);
    expect(forOlder.models.find((m) => m.id === 'whisper')).toMatchObject({ state: 'absent', received: 0 });
    expect(forOlder.dutchVoice).toMatchObject({ on: false, state: 'absent', received: 0 });
    expect(voiceTypingForMinor(offRemoving, 3)).toEqual(offRemoving);

    // Agreed under an outdated licence version: still treated as off.
    const stale = {
      ...DEFAULT_VOICE_TYPING,
      dutchVoice: true,
      dutchVoiceAgreedBy: 'prn_mara',
      dutchVoiceAgreedAt: agreedAt,
      dutchVoiceLicenceVersion: 'old-version',
    };
    expect(wantsDutchVoice(stale)).toBe(false);
    expect(voiceTypingView(facts({ settings: stale, fetched })).dutchVoice).toMatchObject({
      on: false,
      state: 'removing',
      received: 50_000_000,
    });

    // Agreed under the current licence version: exposes progress and agreement metadata.
    const on = {
      ...DEFAULT_VOICE_TYPING,
      dutchVoice: true,
      dutchVoiceAgreedBy: 'prn_mara',
      dutchVoiceAgreedAt: agreedAt,
      dutchVoiceLicenceVersion: DUTCH_VOICE_LICENCE_VERSION,
    };
    expect(wantsDutchVoice(on)).toBe(true);
    const active = voiceTypingView(facts({ settings: on, fetched }));
    expect(VoiceTyping.parse(active)).toEqual(active);
    expect(active.dutchVoice).toEqual({
      on: true,
      state: 'downloading',
      size: 145_310_775,
      received: 50_000_000,
      agreedAt: agreedAt.toISOString(),
      licenceVersion: DUTCH_VOICE_LICENCE_VERSION,
    });

    // Agreed while the fetcher hasn't accepted the download yet ('absent') or is restarting (fetched: null):
    // reports 'waiting' with the saved agreement instead of 'absent' or null.
    const onBeforeAccepted = voiceTypingView(facts({ settings: on, fetched: fetchedClean }));
    expect(onBeforeAccepted.dutchVoice).toEqual({
      on: true,
      state: 'waiting',
      size: 145_310_775,
      received: 0,
      agreedAt: agreedAt.toISOString(),
      licenceVersion: DUTCH_VOICE_LICENCE_VERSION,
    });
    const onWhileFetcherDown = voiceTypingView(
      facts({ settings: on, fetched: null, knownDutchSize: 145_310_775 }),
    );
    expect(onWhileFetcherDown.dutchVoice).toEqual({
      on: true,
      state: 'waiting',
      size: 145_310_775,
      received: 0,
      agreedAt: agreedAt.toISOString(),
      licenceVersion: DUTCH_VOICE_LICENCE_VERSION,
    });
    const onReadyWhileFetcherDown = voiceTypingView(
      facts({
        settings: on,
        health: { ...HEALTH, languages: ['en', 'nl'] },
        fetched: null,
        knownDutchSize: 145_310_775,
      }),
    );
    expect(onReadyWhileFetcherDown.dutchVoice).toMatchObject({
      on: true,
      state: 'ready',
      size: 145_310_775,
      received: 145_310_775,
    });
    // Right after a server restart before the fetcher has ever answered (knownDutchSize is null/unknown),
    // fall back to the catalog's total size so ready/waiting/removing rows never report 0 bytes.
    const onReadyAfterRestart = voiceTypingView(
      facts({
        settings: on,
        health: { ...HEALTH, languages: ['en', 'nl'] },
        fetched: null,
        knownDutchSize: null,
      }),
    );
    expect(onReadyAfterRestart.dutchVoice).toEqual({
      on: true,
      state: 'ready',
      size: VOICE_MODEL_SIZES.supertonic,
      received: VOICE_MODEL_SIZES.supertonic,
      agreedAt: agreedAt.toISOString(),
      licenceVersion: DUTCH_VOICE_LICENCE_VERSION,
    });
    const onWaitingAfterRestart = voiceTypingView(
      facts({
        settings: on,
        health: { ...HEALTH, languages: ['en'] },
        fetched: null,
      }),
    );
    expect(onWaitingAfterRestart.dutchVoice).toMatchObject({
      on: true,
      state: 'waiting',
      size: VOICE_MODEL_SIZES.supertonic,
      received: 0,
    });
    const offRemovingAfterRestart = voiceTypingView(
      facts({
        settings: DEFAULT_VOICE_TYPING,
        health: { ...HEALTH, languages: ['en', 'nl'] },
        fetched: null,
        knownDutchSize: null,
      }),
    );
    expect(offRemovingAfterRestart.dutchVoice).toMatchObject({
      on: false,
      state: 'removing',
      size: VOICE_MODEL_SIZES.supertonic,
      received: VOICE_MODEL_SIZES.supertonic,
    });
    // Agreed while old removal trash is still on disk: keeps reporting 'removing' and bytes left.
    const onWhileRemoving = voiceTypingView(
      facts({
        settings: on,
        fetched: [
          model('parakeet', 'ready'),
          model('whisper', 'absent'),
          model('supertonic', 'removing', { size: 145_310_775, received: 150_000_000 }),
        ],
      }),
    );
    expect(onWhileRemoving.dutchVoice).toMatchObject({
      on: true,
      state: 'removing',
      received: 150_000_000,
    });
    // Turned off while fetcher is restarting with pending removal: reports off + removing rather than null.
    const offWhileFetcherDown = voiceTypingView(
      facts({
        settings: DEFAULT_VOICE_TYPING,
        fetched: null,
        knownDutchSize: 145_310_775,
        dutchRemovePending: true,
      }),
    );
    expect(offWhileFetcherDown.dutchVoice).toMatchObject({
      on: false,
      state: 'removing',
      size: 145_310_775,
      agreedAt: null,
      licenceVersion: null,
    });
  });
});
