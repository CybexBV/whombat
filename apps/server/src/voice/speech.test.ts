/**
 * The voice service as the runtime sees it (desk-display-talk.md DK-T02, DK-T03; dictation.md): the
 * screen's and the composers' WAV checked before it goes anywhere, the socket client against the fake on a unix socket
 * (both ways validated, the service's errors as codes, a voice named only when the service lists it: DK-S52; a voice
 * typing recording's parts joined, the settings sent), and the health a minute at a time.
 */
import { DESK_VOICES } from '@whombat/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../config';
import { setVoiceModelsFor, voiceModelsFor } from './models';
import {
  answeringVoiceHealth,
  checkDeskWav,
  checkDictationWav,
  encodeWav,
  forgetVoiceHealth,
  NO_VOICE,
  parseWav,
  setVoiceFor,
  speakingVoices,
  transcribeTimeoutMs,
  type VoiceAbility,
  VoiceCallError,
  type VoicePort,
  VoiceSocketClient,
  voiceFor,
  voiceHealth,
  WavError,
  wavPeak,
} from './speech';
import { FakeVoiceModels } from './testing/fake-models';
import {
  FAKE_TRANSCRIPT,
  FakeVoice,
  type FakeVoiceServer,
  fakeRecording,
  startFakeVoice,
} from './testing/fake-voice';

/** A WAV with these header fields and `bytes` of samples. */
function wavWith(fields: {
  rate?: number;
  channels?: number;
  bits?: number;
  format?: number;
  bytes?: number;
}) {
  const rate = fields.rate ?? 16_000;
  const channels = fields.channels ?? 1;
  const bits = fields.bits ?? 16;
  const wav = encodeWav(new Int16Array((fields.bytes ?? 3200) / 2), rate);
  wav.writeUInt16LE(fields.format ?? 1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt16LE(bits, 34);
  return wav;
}

describe('WAV', () => {
  it('reads back what it writes: rate, channels, bits, samples and length', () => {
    const samples = Int16Array.from([0, 1000, -32768, 32767]);
    const wav = parseWav(encodeWav(samples, 16_000));
    expect(wav).toMatchObject({ format: 1, channels: 1, sampleRate: 16_000, bitsPerSample: 16 });
    expect(wav.data.length).toBe(8);
    expect(wav.seconds).toBeCloseTo(4 / 16_000);
    expect(wavPeak(wav)).toBe(32768);
  });

  it('skips other chunks (padded to an even size) on the way to the data', () => {
    const plain = encodeWav(Int16Array.from([5, -7]), 16_000);
    const list = Buffer.concat([
      Buffer.from('LIST', 'latin1'),
      Buffer.from([3, 0, 0, 0]),
      Buffer.from('abc\0'),
    ]);
    const wav = Buffer.concat([plain.subarray(0, 36), list, plain.subarray(36)]);
    expect(wavPeak(parseWav(wav))).toBe(7);
  });

  it('ends a data chunk that claims more than the file at the file’s end', () => {
    const wav = encodeWav(Int16Array.from([1, 2, 3]), 16_000);
    wav.writeUInt32LE(0xffffffff, 40);
    expect(parseWav(wav).data.length).toBe(6);
  });

  it('refuses what isn’t a WAV', () => {
    expect(() => parseWav(Buffer.from('not a wav at all'))).toThrow(WavError);
    const noData = encodeWav(new Int16Array(0), 16_000).subarray(0, 36);
    expect(() => parseWav(noData)).toThrow(/no data/);
  });

  it('takes the desk’s recording only: 16 kHz mono 16-bit PCM, at most 30 s', () => {
    expect(() => checkDeskWav(wavWith({}))).not.toThrow();
    expect(() => checkDeskWav(wavWith({ rate: 44_100 }))).toThrow(WavError);
    expect(() => checkDeskWav(wavWith({ channels: 2 }))).toThrow(WavError);
    expect(() => checkDeskWav(wavWith({ bits: 8 }))).toThrow(WavError);
    expect(() => checkDeskWav(wavWith({ format: 3 }))).toThrow(WavError);
    expect(() => checkDeskWav(wavWith({ bytes: 30 * 16_000 * 2 }))).not.toThrow();
    expect(() => checkDeskWav(wavWith({ bytes: 30 * 16_000 * 2 + 2 }))).toThrow(/30 seconds/);
  });

  it('takes a voice typing recording of at most five minutes, and says when only its length is wrong', () => {
    expect(checkDictationWav(wavWith({ bytes: 300 * 16_000 * 2 })).seconds).toBe(300);
    const long = (() => {
      try {
        checkDictationWav(wavWith({ bytes: 300 * 16_000 * 2 + 2 }));
      } catch (err) {
        return err;
      }
    })();
    expect(long).toBeInstanceOf(WavError);
    expect((long as WavError).tooLong).toBe(true);
    const stereo = (() => {
      try {
        checkDictationWav(wavWith({ channels: 2 }));
      } catch (err) {
        return err;
      }
    })();
    expect((stereo as WavError).tooLong).toBe(false);
  });
});

describe('the socket client', () => {
  let server: FakeVoiceServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it('asks the service its health, a transcript with the prompt, and speech', async () => {
    server = await startFakeVoice();
    server.voice.ability = { stt: true, tts: true, microphone: false, speaker: true };
    const client = new VoiceSocketClient(server.socketPath);
    expect(await client.health()).toEqual({ stt: true, tts: true, microphone: false, speaker: true });
    const heard = await client.stt(fakeRecording(1), 'Dusty, pve-02.');
    expect(heard.text).toBe(FAKE_TRANSCRIPT);
    expect(heard.seconds).toBeCloseTo(1);
    const wav = parseWav(await client.tts('pve-02 is fine.'));
    expect(wav.data.length).toBeGreaterThan(0);
    expect(server.voice.calls).toEqual([
      { kind: 'stt', prompt: 'Dusty, pve-02.', seconds: 1 },
      { kind: 'tts', text: 'pve-02 is fine.' },
    ]);
  });

  it('reads the models and the graphics chip of a 3.1 service, the chip before any model is there', async () => {
    server = await startFakeVoice();
    server.voice.ability = {
      ...server.voice.ability,
      models: ['parakeet'],
      gpu: { name: 'AMD Radeon 8060S' },
    };
    const client = new VoiceSocketClient(server.socketPath);
    expect(await client.health()).toMatchObject({ models: ['parakeet'], gpu: { name: 'AMD Radeon 8060S' } });
    server.voice.ability = { stt: false, tts: true, microphone: true, speaker: true, gpu: { name: 'x' } };
    const fresh = await client.health();
    expect(fresh.models).toBeUndefined();
    expect(fresh.gpu).toEqual({ name: 'x' });
  });

  it('turns a voice typing recording into text with the settings, and sends the desk’s settings too', async () => {
    server = await startFakeVoice();
    server.voice.ability = { ...server.voice.ability, models: ['parakeet', 'whisper'] };
    const long = 'word '.repeat(450).trim();
    server.voice.transcripts.push(long);
    const client = new VoiceSocketClient(server.socketPath);
    const heard = await client.transcribe(fakeRecording(2), {
      model: 'whisper',
      language: 'nl',
      prompt: 'Dusty, pve-02.',
      seconds: 2,
    });
    // The service answers in parts of at most 1000 characters; joined with a space they are the text.
    expect(heard).toEqual({ text: long, seconds: 2, model: 'whisper', gpu: false });
    await client.stt(fakeRecording(1), undefined, { model: 'auto', language: 'en' });
    expect(server.voice.calls).toEqual([
      { kind: 'transcribe', prompt: 'Dusty, pve-02.', seconds: 2, model: 'whisper', language: 'nl' },
      { kind: 'stt', prompt: null, seconds: 1, model: 'auto', language: 'en' },
    ]);
  });

  it('says a model that isn’t there is unavailable, and gives a long recording time', async () => {
    server = await startFakeVoice();
    server.voice.ability = { ...server.voice.ability, models: ['parakeet'] };
    const client = new VoiceSocketClient(server.socketPath);
    const code = await client
      .transcribe(fakeRecording(1), { model: 'whisper', language: 'auto', seconds: 1 })
      .then(
        () => 'ok',
        (err: unknown) => (err instanceof VoiceCallError ? err.code : 'other'),
      );
    expect(code).toBe('unavailable');
    expect(transcribeTimeoutMs(5)).toBe(90_000);
    expect(transcribeTimeoutMs(300)).toBe(900_000);
  });

  it('keeps the voices the service lists and names one only when it is listed (DK-S52)', async () => {
    server = await startFakeVoice();
    const client = new VoiceSocketClient(server.socketPath);
    expect((await client.health()).voices).toEqual([...DESK_VOICES]);
    await client.tts('Hello.', 'george');
    await client.tts('Hello.', 'alloy');
    await client.tts('Hello.');
    expect(server.voice.calls).toEqual([
      { kind: 'tts', text: 'Hello.', voice: 'george' },
      { kind: 'tts', text: 'Hello.' },
      { kind: 'tts', text: 'Hello.' },
    ]);
  });

  it('asks the health first when a voice is wanted before it knew the voices', async () => {
    server = await startFakeVoice();
    await new VoiceSocketClient(server.socketPath).tts('Hello.', 'bella');
    expect(server.voice.calls).toEqual([{ kind: 'tts', text: 'Hello.', voice: 'bella' }]);
  });

  it('names no voice to a service from before 0.105, which refuses one (400 bad_request)', async () => {
    server = await startFakeVoice();
    server.voice.ability = { stt: true, tts: true, microphone: true, speaker: true };
    const client = new VoiceSocketClient(server.socketPath);
    expect((await client.health()).voices).toBeUndefined();
    expect(parseWav(await client.tts('Hello.', 'bella')).data.length).toBeGreaterThan(0);
    expect(server.voice.calls).toEqual([{ kind: 'tts', text: 'Hello.' }]);
    // The service lost the voice since its last health (a rollback): it refuses, the client reports an error.
    server.voice.ability = { ...server.voice.ability, voices: ['heart', 'bella'] };
    await client.health();
    server.voice.ability = { stt: true, tts: true, microphone: true, speaker: true };
    const failed = await client.tts('Hello.', 'bella').then(
      () => null,
      (err: unknown) => err,
    );
    expect(failed).toBeInstanceOf(VoiceCallError);
    expect((failed as VoiceCallError).message).toContain('bad_request');
  });

  it('names Dutch only to a service that lists it, asking its health first (DK-T22)', async () => {
    server = await startFakeVoice();
    const client = new VoiceSocketClient(server.socketPath);
    await client.tts('Ja, alles draait.', 'heart', 'nl');
    expect((await client.health()).languages).toEqual(['en', 'nl']);
    // English is what every service speaks: never named.
    await client.tts('Yes.', 'heart', 'en');
    server.voice.ability = { stt: true, tts: true, microphone: true, speaker: true, voices: ['heart'] };
    await client.health();
    await client.tts('Ja.', 'heart', 'nl');
    expect(server.voice.calls).toEqual([
      { kind: 'tts', text: 'Ja, alles draait.', voice: 'heart', language: 'nl' },
      { kind: 'tts', text: 'Yes.', voice: 'heart' },
      { kind: 'tts', text: 'Ja.', voice: 'heart' },
    ]);
  });

  it('turns the service’s refusals into codes', async () => {
    server = await startFakeVoice();
    const client = new VoiceSocketClient(server.socketPath);
    const codeOf = (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (err: unknown) => (err instanceof VoiceCallError ? err.code : 'other'),
      );
    expect(await codeOf(client.stt(wavWith({ channels: 2 })))).toBe('bad_audio');
    server.voice.failNext.stt = new VoiceCallError('busy', 'one job at a time');
    expect(await codeOf(client.stt(fakeRecording()))).toBe('busy');
    server.voice.ability = { ...server.voice.ability, tts: false };
    expect(await codeOf(client.tts('hello'))).toBe('unavailable');
    server.voice.failNext.stt = new VoiceCallError('too_large', 'over the limit');
    expect(await codeOf(client.stt(fakeRecording()))).toBe('too_large');
    await server.close();
    server = null;
    expect(await codeOf(client.health())).toBe('unavailable');
  });
});

describe('the voices the box speaks with (DK-50)', () => {
  it('are the health’s while it speaks and names them', () => {
    const health: VoiceAbility = {
      stt: true,
      tts: true,
      microphone: true,
      speaker: true,
      voices: ['heart', 'emma'],
    };
    expect(speakingVoices(health)).toEqual(['heart', 'emma']);
    expect(speakingVoices({ ...health, tts: false })).toBeNull();
    expect(speakingVoices({ ...health, voices: [] })).toBeNull();
    expect(speakingVoices({ stt: true, tts: true, microphone: true, speaker: true })).toBeNull();
    expect(speakingVoices(NO_VOICE)).toBeNull();
    expect(speakingVoices(null)).toBeNull();
  });

  it('sound different in the fake, which refuses a voice it doesn’t list', async () => {
    const fake = new FakeVoice();
    const heart = parseWav(await fake.tts('Hello there.', 'heart'));
    const george = parseWav(await fake.tts('Hello there.', 'george'));
    expect(heart.sampleRate).toBe(george.sampleRate);
    expect(heart.data.equals(george.data)).toBe(false);
    const code = await fake.tts('Hello there.', 'alloy').then(
      () => 'ok',
      (err: unknown) => (err instanceof VoiceCallError ? err.code : 'other'),
    );
    expect(code).toBe('error');
    expect(fake.calls.map((c) => (c.kind === 'tts' ? c.voice : null))).toEqual(['heart', 'george']);
  });
});

describe('which voice and its health', () => {
  const config = (c: Partial<Config>) => ({ config: c as Config });

  it('is the fake, the socket’s client or none, as the config says', () => {
    expect(voiceFor(config({ WHOMBAT_VOICE: 'fake' }))).toBeInstanceOf(FakeVoice);
    expect(voiceFor(config({ WHOMBAT_VOICE_SOCKET: '/run/whombat-voice/voice.sock' }))).toBeInstanceOf(
      VoiceSocketClient,
    );
    expect(
      voiceFor(config({ WHOMBAT_VOICE: 'off', WHOMBAT_VOICE_SOCKET: '/run/whombat-voice/voice.sock' })),
    ).toBeNull();
    expect(voiceFor(config({}))).toBeNull();
  });

  it('asks once a minute, and says nothing works when the service doesn’t answer', async () => {
    let asked = 0;
    let answer: VoiceAbility | Error = { stt: true, tts: false, microphone: true, speaker: false };
    const port: VoicePort = {
      health: async () => {
        asked++;
        if (answer instanceof Error) throw answer;
        return answer;
      },
      stt: async () => ({ text: '', seconds: 0 }),
      tts: async () => Buffer.alloc(0),
      transcribe: async () => ({ text: '', seconds: 0, model: 'parakeet', gpu: false }),
    };
    const services = config({});
    setVoiceFor(services, port);
    expect(await voiceHealth(services)).toEqual(answer);
    expect(await voiceHealth(services)).toEqual(answer);
    expect(asked).toBe(1);
    // A speech model that arrived or went: the next health is asked again.
    forgetVoiceHealth(services);
    await voiceHealth(services);
    expect(asked).toBe(2);
    answer = new VoiceCallError('unavailable', 'gone');
    setVoiceFor(services, port);
    expect(await voiceHealth(services)).toEqual(NO_VOICE);
    // Voice typing tells a service that doesn't answer from one that answers with nothing.
    expect(await answeringVoiceHealth(services)).toBeNull();
    setVoiceFor(services, null);
    expect(await voiceHealth(services)).toEqual(NO_VOICE);
    expect(await answeringVoiceHealth(services)).toBeNull();
  });

  it('gives the fake voice the models and spoken languages the fake fetcher has downloaded', async () => {
    const services = config({ WHOMBAT_VOICE: 'fake' });
    expect(voiceModelsFor(services)).toBeInstanceOf(FakeVoiceModels);
    expect(await voiceFor(services)?.health()).toMatchObject({ models: [], languages: ['en'] });
    setVoiceModelsFor(services, new FakeVoiceModels({ ready: ['parakeet'] }));
    expect(await voiceFor(services)?.health()).toMatchObject({ models: ['parakeet'], languages: ['en'] });
    setVoiceModelsFor(services, new FakeVoiceModels({ ready: ['parakeet', 'supertonic'] }));
    expect(await voiceFor(services)?.health()).toMatchObject({
      models: ['parakeet'],
      languages: ['en', 'nl'],
    });
  });
});
