/**
 * The speech models' fetcher as the runtime sees it: the socket client against the fake on a
 * unix socket (both ways validated, its refusals as codes), the fake's downloads one at a time with progress, a failure,
 * a removal, and which fetcher the config gives.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../config';
import { VoiceModelsCallError, VoiceModelsSocketClient, voiceModelsFor } from './models';
import { FakeVoiceModels, type FakeVoiceModelsServer, startFakeVoiceModels } from './testing/fake-models';

const quick = () => new FakeVoiceModels({ downloadMs: 40, stepMs: 10 });

describe('the fake fetcher', () => {
  it('downloads one model at a time with progress, the other waiting its turn', async () => {
    const fake = quick();
    const seen: string[] = [];
    fake.onChange(() => {
      void fake.state().then((s) => {
        for (const m of s.models) if (m.state === 'downloading' && m.received > 0) seen.push(m.id);
      });
    });
    await fake.fetch('parakeet');
    const both = await fake.fetch('whisper');
    expect(both.models.map((m) => [m.id, m.state])).toEqual([
      ['parakeet', 'downloading'],
      ['whisper', 'waiting'],
      ['supertonic', 'absent'],
    ]);
    // Asked again while on its way: one download.
    await fake.fetch('parakeet');
    await fake.until((models) =>
      models.filter((m) => m.id !== 'supertonic').every((m) => m.state === 'ready'),
    );
    expect(fake.ready()).toEqual(['parakeet', 'whisper']);
    expect(seen).toContain('parakeet');
    expect(fake.calls).toEqual([
      { kind: 'fetch', model: 'parakeet' },
      { kind: 'fetch', model: 'whisper' },
      { kind: 'fetch', model: 'parakeet' },
    ]);
  });

  it('fails a download when told, starts it again when asked, and removes a model', async () => {
    const fake = quick();
    fake.failNext.whisper = 'no_room';
    await fake.fetch('whisper');
    await fake.until((models) => models.some((m) => m.id === 'whisper' && m.state === 'failed'));
    expect((await fake.state()).models.find((m) => m.id === 'whisper')).toMatchObject({ problem: 'no_room' });
    await fake.fetch('whisper');
    await fake.until((models) => models.some((m) => m.id === 'whisper' && m.state === 'ready'));
    await fake.remove('whisper');
    expect(fake.ready()).toEqual([]);
  });

  it('stops a download it is told to remove and goes on with the next', async () => {
    const fake = quick();
    await fake.fetch('parakeet');
    await fake.fetch('whisper');
    const after = await fake.remove('parakeet');
    expect(after.models.map((m) => [m.id, m.state])).toEqual([
      ['parakeet', 'absent'],
      ['whisper', 'downloading'],
      ['supertonic', 'absent'],
    ]);
    await fake.until((models) => models.some((m) => m.id === 'whisper' && m.state === 'ready'));
    expect(fake.ready()).toEqual(['whisper']);
  });
});

describe('the socket client', () => {
  let server: FakeVoiceModelsServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it('reads the models, asks for a download and removes one', async () => {
    server = await startFakeVoiceModels({ models: quick() });
    const client = new VoiceModelsSocketClient(server.socketPath);
    const before = await client.state();
    expect(before.models.map((m) => [m.id, m.state])).toEqual([
      ['parakeet', 'absent'],
      ['whisper', 'absent'],
      ['supertonic', 'absent'],
    ]);
    expect((await client.fetch('parakeet')).models[0]?.state).toBe('downloading');
    await server.models.until((models) => models.some((m) => m.id === 'parakeet' && m.state === 'ready'));
    expect((await client.state()).models[0]).toMatchObject({
      state: 'ready',
      received: before.models[0]?.size,
    });
    expect((await client.remove('parakeet')).models[0]?.state).toBe('absent');
    expect((await client.fetch('supertonic')).models[2]?.state).toBe('downloading');
    await server.models.until((models) => models.some((m) => m.id === 'supertonic' && m.state === 'ready'));
    expect((await client.remove('supertonic')).models[2]?.state).toBe('absent');
    expect(server.models.calls).toEqual([
      { kind: 'fetch', model: 'parakeet' },
      { kind: 'remove', model: 'parakeet' },
      { kind: 'fetch', model: 'supertonic' },
      { kind: 'remove', model: 'supertonic' },
    ]);
  });

  it('says when nobody answers on the socket', async () => {
    server = await startFakeVoiceModels();
    const client = new VoiceModelsSocketClient(server.socketPath);
    await server.close();
    server = null;
    const err = await client.state().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(VoiceModelsCallError);
    expect((err as VoiceModelsCallError).status).toBe(0);
  });
});

describe('which fetcher', () => {
  const config = (c: Partial<Config>) => ({ config: c as Config });

  it('is the fake with the fake voice, the socket’s client, or none', () => {
    expect(voiceModelsFor(config({ WHOMBAT_VOICE: 'fake' }))).toBeInstanceOf(FakeVoiceModels);
    expect(
      voiceModelsFor(config({ WHOMBAT_VOICE_MODELS_SOCKET: '/run/whombat-voice-models/models.sock' })),
    ).toBeInstanceOf(VoiceModelsSocketClient);
    expect(
      voiceModelsFor(
        config({
          WHOMBAT_VOICE: 'off',
          WHOMBAT_VOICE_MODELS_SOCKET: '/run/whombat-voice-models/models.sock',
        }),
      ),
    ).toBeNull();
    expect(voiceModelsFor(config({}))).toBeNull();
  });
});
