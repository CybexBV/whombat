/**
 * Voice typing against a real database (docs/decisions/dictation.md): it needs Postgres because `voice.update` is a
 * command of the pipeline (migration 0009's `voice_typing` row and its signed event), what is in use and downloaded
 * follows the desk's Talk switch in `desk_screens`, the `voice.*` ops run through the session's dispatcher as the
 * person, and a recording goes up a session stream into the person's burrow, whose assistant Whisper is told about.
 * The speech service and the model fetcher are the fakes, with downloads of a few milliseconds.
 */
import { createHash } from 'node:crypto';
import { topics } from '@whombat/core';
import {
  DUTCH_VOICE_LICENCE_VERSION,
  VOICE_MODEL_SIZES,
  VOICE_STT_MODELS,
  VOICE_TYPING_MAX_BYTES,
  type VoiceDownloadModel,
  type VoiceSttModel,
  VoiceTyping,
} from '@whombat/core/domain';
import { and, asc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { events, voiceTyping } from '../db/schema/index';
import { setDeskScreen } from '../desk/store';
import { loadAgentRow } from '../read/principals';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';
import { setVoiceModelsFor } from './models';
import { setVoiceTypingFor, VoiceTypingService } from './service';
import { setVoiceFor, VoiceCallError, voiceHealth } from './speech';
import { FakeVoiceModels } from './testing/fake-models';
import { FAKE_TRANSCRIPT, FakeVoice, fakeRecording } from './testing/fake-voice';

const m = useManagedRuntime({ seed: true });
let mara: Awaited<ReturnType<typeof m.enroll>>;
let fetcher: FakeVoiceModels;
let voice: FakeVoice;
let typing: VoiceTypingService;

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const CHUNK = 65_536;

beforeAll(async () => {
  mara = await m.enroll(IDS.mara);
});

/** A speech service and a fetcher of their own, and voice typing with short timings (not started). */
function fresh(options: { ready?: VoiceDownloadModel[]; fetcher?: boolean } = {}) {
  fetcher = new FakeVoiceModels({
    downloadMs: 30,
    stepMs: 10,
    ...(options.ready ? { ready: options.ready } : {}),
  });
  const models = fetcher;
  voice = new FakeVoice({
    models: () =>
      models
        .ready()
        .filter((id): id is VoiceSttModel => (VOICE_STT_MODELS as readonly string[]).includes(id)),
    languages: () => (models.ready().includes('supertonic') ? ['en', 'nl'] : ['en']),
  });
  setVoiceModelsFor(m.t.services, options.fetcher === false ? null : fetcher);
  setVoiceFor(m.t.services, voice);
  typing = new VoiceTypingService(m.t.services, { pollMs: 10, announceMs: 10, startRetryMs: 20 });
  setVoiceTypingFor(m.t.services, typing);
}

async function view(c: Awaited<ReturnType<typeof m.client>>): Promise<VoiceTyping> {
  const answer = (await c.request('voice.get', {})) as { t: string; output?: unknown };
  expect(answer.t).toBe('result');
  return VoiceTyping.parse(answer.output);
}

/** The next `voice.changed` to the person. */
function nextChange(): Promise<void> {
  return new Promise((resolve) => {
    const off = m.t.services.bus.onFrame((frame) => {
      if (frame.event.type !== 'voice.changed' || frame.topic !== topics.me(IDS.mara)) return;
      off();
      resolve();
    });
  });
}

/** Until `voice.get` holds `done`: asked now and after every `voice.changed`. */
async function until(
  c: Awaited<ReturnType<typeof m.client>>,
  done: (v: VoiceTyping) => boolean,
): Promise<VoiceTyping> {
  for (;;) {
    const changed = nextChange();
    const now = await view(c);
    if (done(now)) return now;
    await changed;
  }
}

const state = (v: VoiceTyping, id: 'parakeet' | 'whisper') => v.models.find((x) => x.id === id);

/** Voice typing's settings, as the person sets them. */
async function settings(c: Awaited<ReturnType<typeof m.client>>, patch: Record<string, unknown>) {
  const answer = await c.request('voice.update', patch);
  expect(answer).toMatchObject({ t: 'result' });
  return VoiceTyping.parse((answer as { output: unknown }).output);
}

/** A recording up the session's upload stream: its `opened` (or refusal) and its last word. */
async function record(c: Awaited<ReturnType<typeof m.client>>, recording: Buffer, size = recording.length) {
  const spec = {
    kind: 'upload' as const,
    target: { type: 'dictation' as const, burrow: 'burrow-hq' },
    size,
    sha256: sha(recording),
    chunkSize: CHUNK,
  };
  const { stream, answer } = await c.open(spec);
  if (answer.t !== 'opened') return { answer, done: null };
  for (let index = 0; index * CHUNK < recording.length; index++) {
    const bytes = recording.subarray(index * CHUNK, (index + 1) * CHUNK);
    c.send({ t: 'chunk', stream, index, offset: index * CHUNK, size: bytes.length, sha256: sha(bytes) });
    await c.writeWithCredit(stream, bytes);
  }
  c.frame({ type: 'end', streamId: stream });
  const done = await c.waitFor(
    (x) => (x.t === 'stream_done' || x.t === 'error') && (x as { stream?: number }).stream === stream,
  );
  return { answer, done };
}

describe('voice typing’s settings and models', () => {
  it('starts on and downloads Fast by itself, then the mic is ready', async () => {
    fresh();
    const c = await m.client(mara);
    await settings(c, { on: true, model: 'auto', language: 'auto' });
    typing.start();
    const ready = await until(c, (v) => v.ready);
    expect(ready).toMatchObject({ available: true, on: true, uses: 'parakeet', gpu: null, maxSeconds: 300 });
    // No graphics chip: Most accurate isn't fetched in Automatic.
    expect(state(ready, 'whisper')).toMatchObject({ state: 'absent', inUse: false });
    expect(state(ready, 'parakeet')).toMatchObject({ state: 'ready', inUse: true });
    expect(fetcher.calls).toEqual([{ kind: 'fetch', model: 'parakeet' }]);
  });

  it('downloads Fast and then Most accurate by itself on a box with a graphics chip', async () => {
    fresh();
    voice.ability = { ...voice.ability, gpu: { name: 'AMD Radeon 8050S Graphics (RADV STRIX_HALO)' } };
    const c = await m.client(mara);
    await settings(c, { on: true, model: 'auto', language: 'auto' });
    typing.start();
    const both = await until(c, (v) => state(v, 'whisper')?.state === 'ready');
    expect(both).toMatchObject({
      uses: 'whisper',
      gpu: { name: 'AMD Radeon 8050S Graphics (RADV STRIX_HALO)' },
    });
    expect(fetcher.calls.map((x) => x.model).sort()).toEqual(['parakeet', 'whisper']);
  });

  it('keeps a change in one signed commit, downloads what it wants and removes only what isn’t needed', async () => {
    fresh({ ready: ['parakeet'] });
    const c = await m.client(mara);
    const chosen = await settings(c, { model: 'whisper', language: 'nl' });
    expect(chosen).toMatchObject({ model: 'whisper', language: 'nl', uses: null, ready: false });
    expect(state(chosen, 'whisper')).toMatchObject({ state: 'downloading', inUse: true });
    const [row] = await m.t.services.db.select().from(voiceTyping);
    expect(row).toMatchObject({ enabled: true, model: 'whisper', language: 'nl' });
    const signed = await m.t.services.db
      .select({ actorId: events.actorId, text: events.text })
      .from(events)
      .where(and(eq(events.burrowId, TEST_BURROW_ID), eq(events.type, 'voice.updated')))
      .orderBy(asc(events.seq));
    expect(signed.at(-1)).toEqual({ actorId: IDS.mara, text: null });
    expect((await until(c, (v) => v.ready)).uses).toBe('whisper');

    // Both are needed while voice typing is on: Fast as the fallback the settings want.
    for (const model of ['whisper', 'parakeet'])
      expect(await c.request('voice.removeModel', { model })).toMatchObject({
        t: 'error',
        code: 'conflict',
        details: { code: 'in_use' },
      });
    await settings(c, { on: false });
    const removed = await c.request('voice.removeModel', { model: 'parakeet' });
    expect(removed).toMatchObject({ t: 'result' });
    expect(state(VoiceTyping.parse((removed as { output: unknown }).output), 'parakeet')?.state).toBe(
      'absent',
    );
    // Nothing comes back by itself while nothing hears.
    await settings(c, { language: 'en' });
    expect(fetcher.calls.filter((x) => x.kind === 'fetch').map((x) => x.model)).toEqual(['whisper']);
  });

  it('asks again for a failed download once per start, then only on Try again', async () => {
    fresh();
    const c = await m.client(mara);
    await settings(c, { on: false, model: 'auto', language: 'auto' });
    fetcher.failNext.parakeet = 'no_network';
    await settings(c, { on: true });
    await until(c, (v) => state(v, 'parakeet')?.state === 'failed');
    // The next change asks once more by itself; it fails again.
    fetcher.failNext.parakeet = 'no_room';
    await settings(c, { language: 'nl' });
    const failed = await until(c, (v) => state(v, 'parakeet')?.problem === 'no_room');
    expect(state(failed, 'parakeet')).toMatchObject({ state: 'failed', inUse: true });
    await settings(c, { language: 'en' });
    expect(fetcher.calls.filter((x) => x.model === 'parakeet')).toHaveLength(2);
    // *Try again*.
    expect(await c.request('voice.fetchModel', { model: 'parakeet' })).toMatchObject({ t: 'result' });
    expect((await until(c, (v) => v.ready)).uses).toBe('parakeet');
    expect(fetcher.calls.filter((x) => x.model === 'parakeet')).toHaveLength(3);
  });

  it('downloads Fast for the desk’s Talk while voice typing is off', async () => {
    fresh();
    const c = await m.client(mara);
    await settings(c, { on: false, model: 'auto', language: 'auto' });
    typing.start();
    // The screen turned on pairs it with its Talk on; the desk says so with `desk.changed`.
    await m.t.commit(IDS.mara, setDeskScreen, { on: true });
    const changed = nextChange();
    m.t.services.bus.publish({
      topic: topics.me(IDS.mara),
      event: { type: 'desk.changed' },
      eventId: null,
      at: new Date().toISOString(),
      outboxId: null,
    });
    await changed;
    const desk = await until(c, (v) => state(v, 'parakeet')?.state === 'ready');
    expect(desk).toMatchObject({ on: false, ready: false, uses: 'parakeet' });
    expect(state(desk, 'parakeet')?.inUse).toBe(true);
    await m.t.commit(IDS.mara, setDeskScreen, { on: false });
  });

  it('says there is nothing to download without a fetcher, and no voice typing without a speech service', async () => {
    fresh({ ready: ['parakeet'], fetcher: false });
    const c = await m.client(mara);
    await settings(c, { on: true, model: 'auto', language: 'auto' });
    expect(await view(c)).toMatchObject({ available: true, ready: true, models: [{ id: 'parakeet' }] });
    expect(await c.request('voice.fetchModel', { model: 'whisper' })).toMatchObject({
      t: 'error',
      code: 'not_implemented',
    });
    setVoiceFor(m.t.services, null);
    expect(await view(c)).toMatchObject({ available: false, ready: false, uses: null, dutchVoice: null });
  });

  it('requires licence agreement for Dutch voice, records it via the commit pipeline, downloads it, and removes files when turned off', async () => {
    fresh({ ready: ['parakeet'] });
    const c = await m.client(mara);
    await settings(c, { on: true, model: 'auto', language: 'auto' });

    // Off by default: Dutch not in health, and downloading supertonic without agreeing is refused.
    expect((await view(c)).dutchVoice).toMatchObject({
      on: false,
      state: 'absent',
      agreedAt: null,
      licenceVersion: null,
    });
    expect((await voiceHealth(m.t.services)).languages).toEqual(['en']);
    expect(await c.request('voice.fetchModel', { model: 'supertonic' })).toMatchObject({
      t: 'error',
      code: 'forbidden',
    });

    // Wrong licence version is refused at schema validation.
    expect(
      await c.request('voice.setDutchVoice', { on: true, licenceVersion: 'wrong-version' }),
    ).toMatchObject({ t: 'error', code: 'validation_failed' });

    // Agreeing records who, when and licence version in DB and the signed audit log, and downloads Supertonic.
    const agreed = await c.request('voice.setDutchVoice', {
      on: true,
      licenceVersion: DUTCH_VOICE_LICENCE_VERSION,
    });
    expect(agreed).toMatchObject({ t: 'result' });
    const [row] = await m.t.services.db.select().from(voiceTyping);
    expect(row).toMatchObject({
      dutchVoice: true,
      dutchVoiceAgreedBy: IDS.mara,
      dutchVoiceLicenceVersion: DUTCH_VOICE_LICENCE_VERSION,
    });
    expect(row?.dutchVoiceAgreedAt).toBeInstanceOf(Date);
    const signedAgree = await m.t.services.db
      .select({ actorId: events.actorId, payload: events.payload })
      .from(events)
      .where(and(eq(events.burrowId, TEST_BURROW_ID), eq(events.type, 'voice.dutch_agreed')))
      .orderBy(asc(events.seq));
    expect(signedAgree.at(-1)).toMatchObject({
      actorId: IDS.mara,
      payload: {
        on: true,
        agreedBy: IDS.mara,
        licenceVersion: DUTCH_VOICE_LICENCE_VERSION,
      },
    });

    const ready = await until(c, (v) => v.dutchVoice?.state === 'ready');
    expect(ready.dutchVoice).toMatchObject({
      on: true,
      state: 'ready',
      licenceVersion: DUTCH_VOICE_LICENCE_VERSION,
    });
    // Voice health refreshed and now speaks Dutch.
    expect((await voiceHealth(m.t.services)).languages).toEqual(['en', 'nl']);
    // Can't remove directly while on.
    expect(await c.request('voice.removeModel', { model: 'supertonic' })).toMatchObject({
      t: 'error',
      code: 'conflict',
      details: { code: 'in_use' },
    });

    // Turning it off clears agreement, signs the event, removes the files and falls back to English only.
    const offRes = await c.request('voice.setDutchVoice', { on: false });
    expect(offRes).toMatchObject({ t: 'result' });
    const offView = VoiceTyping.parse((offRes as { output: unknown }).output);
    expect(offView.dutchVoice).toMatchObject({
      on: false,
      state: 'absent',
      agreedAt: null,
      licenceVersion: null,
    });
    const [afterRow] = await m.t.services.db.select().from(voiceTyping);
    expect(afterRow).toMatchObject({
      dutchVoice: false,
      dutchVoiceAgreedBy: null,
      dutchVoiceAgreedAt: null,
      dutchVoiceLicenceVersion: null,
    });
    const signedOff = await m.t.services.db
      .select({ actorId: events.actorId, payload: events.payload })
      .from(events)
      .where(and(eq(events.burrowId, TEST_BURROW_ID), eq(events.type, 'voice.dutch_disabled')))
      .orderBy(asc(events.seq));
    expect(signedOff.at(-1)).toMatchObject({ actorId: IDS.mara, payload: { on: false } });
    expect(fetcher.calls).toContainEqual({ kind: 'remove', model: 'supertonic' });
    expect((await voiceHealth(m.t.services)).languages).toEqual(['en']);

    // Failed download can be retried once agreed.
    fetcher.failNext.supertonic = 'no_room';
    await c.request('voice.setDutchVoice', { on: true, licenceVersion: DUTCH_VOICE_LICENCE_VERSION });
    const failed = await until(c, (v) => v.dutchVoice?.state === 'failed');
    expect(failed.dutchVoice?.problem).toBe('no_room');
    expect(await c.request('voice.fetchModel', { model: 'supertonic' })).toMatchObject({ t: 'result' });
    await until(c, (v) => v.dutchVoice?.state === 'ready');
    // Clean up back to off for subsequent tests.
    await c.request('voice.setDutchVoice', { on: false });
  });

  it('retries removing Dutch voice until it succeeds, including partial files on an absent state', async () => {
    fresh({ ready: ['parakeet'] });
    const c = await m.client(mara);
    await settings(c, { on: true, model: 'auto', language: 'auto' });
    await c.request('voice.setDutchVoice', { on: true, licenceVersion: DUTCH_VOICE_LICENCE_VERSION });
    await until(c, (v) => v.dutchVoice?.state === 'ready');
    expect((await voiceHealth(m.t.services)).languages).toEqual(['en', 'nl']);

    // Turn Dutch voice off while remove fails twice: setting turns off immediately, reports removing while files remain,
    // and removal retries until it succeeds.
    fetcher.failNextRemove.supertonic = 2;
    const offRes = await c.request('voice.setDutchVoice', { on: false });
    expect(offRes).toMatchObject({ t: 'result' });
    expect(VoiceTyping.parse((offRes as { output: unknown }).output).dutchVoice).toMatchObject({
      on: false,
      state: 'removing',
    });
    expect(
      VoiceTyping.parse((offRes as { output: unknown }).output).dutchVoice?.received ?? 0,
    ).toBeGreaterThan(0);

    await vi.waitFor(
      async () => {
        const s = await fetcher.state();
        const sup = s.models.find((x) => x.id === 'supertonic');
        expect(sup).toMatchObject({ state: 'absent', received: 0 });
      },
      { interval: 10, timeout: 3000 },
    );
    expect(
      fetcher.calls.filter((x) => x.kind === 'remove' && x.model === 'supertonic').length,
    ).toBeGreaterThanOrEqual(3);
    expect((await view(c)).dutchVoice).toMatchObject({ on: false, state: 'absent', received: 0 });
    expect((await voiceHealth(m.t.services)).languages).toEqual(['en']);

    // After a restart (fresh VoiceTypingService with no in-memory retry flag), if the fetcher still reports leftover
    // files ("removing", bytes left) because startup cleanup failed too, the server exposes "removing" to current apps
    // (and "absent" to older apps below minor 3) and keeps retrying removal until deletion succeeds.
    fresh({ ready: ['parakeet'] });
    fetcher.setRemoving('supertonic', 65_536);
    fetcher.setRemoving('whisper', 32_768);
    const older = await m.client(mara, { minor: 2 });
    expect((await view(c)).dutchVoice).toMatchObject({ on: false, state: 'removing', received: 65_536 });
    expect((await view(c)).models.find((x) => x.id === 'whisper')).toMatchObject({
      state: 'removing',
      received: 32_768,
    });
    expect((await view(older)).dutchVoice).toMatchObject({ on: false, state: 'absent', received: 0 });
    expect((await view(older)).models.find((x) => x.id === 'whisper')).toMatchObject({
      state: 'absent',
      received: 0,
    });
    fetcher.failNextRemove.supertonic = 2;
    fetcher.failNextRemove.whisper = 1;
    typing.start();
    await vi.waitFor(
      async () => {
        const s = await fetcher.state();
        expect(s.models.find((x) => x.id === 'supertonic')).toMatchObject({ state: 'absent', received: 0 });
        expect(s.models.find((x) => x.id === 'whisper')).toMatchObject({ state: 'absent', received: 0 });
      },
      { interval: 10, timeout: 3000 },
    );
    expect(
      fetcher.calls.filter((x) => x.kind === 'remove' && x.model === 'supertonic').length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      fetcher.calls.filter((x) => x.kind === 'remove' && x.model === 'whisper').length,
    ).toBeGreaterThanOrEqual(2);
    expect((await view(c)).dutchVoice).toMatchObject({ on: false, state: 'absent', received: 0 });

    // An explicit removeModel('whisper') whose deletion fails leaves whisper in 'removing' and retries until gone.
    fresh({ ready: ['parakeet', 'whisper'] });
    fetcher.failNextRemove.whisper = 1;
    expect(await c.request('voice.removeModel', { model: 'whisper' })).toMatchObject({
      t: 'error',
      code: 'unknown_outcome',
    });
    await vi.waitFor(
      async () => {
        const s = await fetcher.state();
        expect(s.models.find((x) => x.id === 'whisper')).toMatchObject({ state: 'absent', received: 0 });
      },
      { interval: 10, timeout: 3000 },
    );
    expect(
      fetcher.calls.filter((x) => x.kind === 'remove' && x.model === 'whisper').length,
    ).toBeGreaterThanOrEqual(2);

    // Leftover partial files (state 'absent' with received > 0) while Dutch voice is off are also removed and retried.
    fresh({ ready: ['parakeet'] });
    fetcher.setPartial('supertonic', 65_536);
    fetcher.failNextRemove.supertonic = 1;
    typing.start();
    await vi.waitFor(
      async () => {
        const s = await fetcher.state();
        const sup = s.models.find((x) => x.id === 'supertonic');
        expect(sup).toMatchObject({ state: 'absent', received: 0 });
      },
      { interval: 10, timeout: 3000 },
    );
    expect(
      fetcher.calls.filter((x) => x.kind === 'remove' && x.model === 'supertonic').length,
    ).toBeGreaterThanOrEqual(2);

    // A wanted model stuck in 'removing' keeps reporting its remaining bytes until trash clears, then downloads.
    fresh({ ready: ['parakeet'] });
    fetcher.setRemoving('whisper', 49_152);
    fetcher.failNextRemove.whisper = 2;
    const wantedRemoving = await settings(c, { on: true, model: 'whisper', language: 'auto' });
    expect(state(wantedRemoving, 'whisper')).toMatchObject({ state: 'removing', received: 49_152 });
    const whisperReady = await until(c, (v) => state(v, 'whisper')?.state === 'ready');
    expect(state(whisperReady, 'whisper')?.state).toBe('ready');
    expect(
      fetcher.calls.filter((x) => x.kind === 'fetch' && x.model === 'whisper').length,
    ).toBeGreaterThanOrEqual(3);
    await settings(c, { on: true, model: 'auto', language: 'auto' });

    // Fetcher completely unreachable when turning Dutch voice off, then comes back online: returns saved off/removing
    // state and retries removal until gone.
    fresh({ ready: ['parakeet'] });
    await c.request('voice.setDutchVoice', { on: true, licenceVersion: DUTCH_VOICE_LICENCE_VERSION });
    await until(c, (v) => v.dutchVoice?.state === 'ready');
    fetcher.unreachable = true;
    const offWhileDown = await c.request('voice.setDutchVoice', { on: false });
    expect(offWhileDown).toMatchObject({ t: 'result' });
    expect(VoiceTyping.parse((offWhileDown as { output: unknown }).output).dutchVoice).toMatchObject({
      on: false,
      state: 'removing',
    });
    fetcher.unreachable = false;
    await vi.waitFor(
      async () => {
        const s = await fetcher.state();
        const sup = s.models.find((x) => x.id === 'supertonic');
        expect(sup).toMatchObject({ state: 'absent', received: 0 });
      },
      { interval: 10, timeout: 3000 },
    );
    expect((await voiceHealth(m.t.services)).languages).toEqual(['en']);
  });

  it('keeps saved state and retries automatically when the fetcher is restarting or fails a fetch', async () => {
    // 1. Turning Dutch voice on while whombat-voice-models is restarting (unreachable):
    // commits consent, returns saved on/waiting state (no error), and retries until the download finishes.
    fresh({ ready: ['parakeet'] });
    const c = await m.client(mara);
    await settings(c, { on: true, model: 'auto', language: 'auto' });
    // Read once while reachable so the service has seen supertonic's size (as Settings always does).
    const before = await view(c);
    expect(before.dutchVoice?.size).toBeGreaterThan(0);

    fetcher.unreachable = true;
    const agreedWhileDown = await c.request('voice.setDutchVoice', {
      on: true,
      licenceVersion: DUTCH_VOICE_LICENCE_VERSION,
    });
    expect(agreedWhileDown).toMatchObject({ t: 'result' });
    const savedWhileDown = VoiceTyping.parse((agreedWhileDown as { output: unknown }).output);
    expect(savedWhileDown.dutchVoice).toMatchObject({
      on: true,
      state: 'waiting',
      size: before.dutchVoice?.size,
      licenceVersion: DUTCH_VOICE_LICENCE_VERSION,
    });
    const [rowDown] = await m.t.services.db.select().from(voiceTyping);
    expect(rowDown).toMatchObject({
      dutchVoice: true,
      dutchVoiceLicenceVersion: DUTCH_VOICE_LICENCE_VERSION,
    });

    fetcher.unreachable = false;
    const readyAfterRestart = await until(c, (v) => v.dutchVoice?.state === 'ready');
    expect(readyAfterRestart.dutchVoice).toMatchObject({
      on: true,
      state: 'ready',
      licenceVersion: DUTCH_VOICE_LICENCE_VERSION,
    });
    expect((await voiceHealth(m.t.services)).languages).toEqual(['en', 'nl']);

    // 1b. After a server restart (fresh VoiceTypingService with no cached model sizes) while the fetcher is
    // unreachable, ready models use their catalog total sizes instead of reporting 0 bytes.
    fresh({ ready: ['parakeet', 'supertonic'] });
    fetcher.unreachable = true;
    const restartedView = await view(c);
    expect(restartedView.dutchVoice).toMatchObject({
      on: true,
      state: 'ready',
      size: VOICE_MODEL_SIZES.supertonic,
      received: VOICE_MODEL_SIZES.supertonic,
      licenceVersion: DUTCH_VOICE_LICENCE_VERSION,
    });
    expect(state(restartedView, 'parakeet')).toMatchObject({
      state: 'ready',
      size: VOICE_MODEL_SIZES.parakeet,
      received: VOICE_MODEL_SIZES.parakeet,
    });
    fetcher.unreachable = false;
    await c.request('voice.setDutchVoice', { on: false });

    // 2. Turning Dutch voice on when fetch() fails transiently while state() answers 'absent':
    // returns saved on/waiting state and retries until accepted.
    fresh({ ready: ['parakeet'] });
    fetcher.failNextFetch.supertonic = 2;
    const agreedTransient = await c.request('voice.setDutchVoice', {
      on: true,
      licenceVersion: DUTCH_VOICE_LICENCE_VERSION,
    });
    expect(agreedTransient).toMatchObject({ t: 'result' });
    expect(VoiceTyping.parse((agreedTransient as { output: unknown }).output).dutchVoice).toMatchObject({
      on: true,
      state: 'waiting',
    });
    await until(c, (v) => v.dutchVoice?.state === 'ready');
    expect(
      fetcher.calls.filter((x) => x.kind === 'fetch' && x.model === 'supertonic').length,
    ).toBeGreaterThanOrEqual(3);
    await c.request('voice.setDutchVoice', { on: false });

    // 3. Turning Dutch voice on while leftover .removing-* trash is still undeletable:
    // returns saved on/removing state with remaining bytes, retries until trash clears, then downloads.
    fresh({ ready: ['parakeet'] });
    fetcher.setRemoving('supertonic', 65_536);
    fetcher.failNextRemove.supertonic = 2;
    const agreedRemoving = await c.request('voice.setDutchVoice', {
      on: true,
      licenceVersion: DUTCH_VOICE_LICENCE_VERSION,
    });
    expect(agreedRemoving).toMatchObject({ t: 'result' });
    expect(VoiceTyping.parse((agreedRemoving as { output: unknown }).output).dutchVoice).toMatchObject({
      on: true,
      state: 'removing',
      received: 65_536,
    });
    await until(c, (v) => v.dutchVoice?.state === 'ready');
    expect(
      fetcher.calls.filter((x) => x.kind === 'fetch' && x.model === 'supertonic').length,
    ).toBeGreaterThanOrEqual(3);
    await c.request('voice.setDutchVoice', { on: false });

    // 4. Changing speech model (voice.update) while fetcher is restarting also retries once fetcher answers.
    fresh({ ready: ['parakeet'] });
    fetcher.unreachable = true;
    await settings(c, { on: true, model: 'whisper', language: 'auto' });
    fetcher.unreachable = false;
    await until(c, (v) => state(v, 'whisper')?.state === 'ready');
    await settings(c, { on: true, model: 'auto', language: 'auto' });
  });

  it('serialises Dutch voice consent checks, setting changes and fetcher calls across interleaved devices', async () => {
    fresh({ ready: ['parakeet'] });
    const deviceA = await m.client(mara);
    const deviceB = await m.client(mara);
    await settings(deviceA, { on: true, model: 'auto', language: 'auto' });

    // Start with Dutch voice enabled whose download failed so device B can press Try again.
    fetcher.failNext.supertonic = 'no_room';
    await deviceA.request('voice.setDutchVoice', {
      on: true,
      licenceVersion: DUTCH_VOICE_LICENCE_VERSION,
    });
    await until(deviceA, (v) => v.dutchVoice?.state === 'failed');
    fetcher.calls.length = 0;

    // Interleaving 1: device A starts turning Dutch voice off and pauses right before committing (DB still has
    // dutchVoice = true). Device B simultaneously retries supertonic. Because both run in one serial queue, device B
    // must check consent after device A finishes and be refused rather than downloading after removal.
    let commitEntered!: () => void;
    const atCommit = new Promise<void>((resolve) => {
      commitEntered = resolve;
    });
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const origCommit = m.t.services.pipeline.commit.bind(m.t.services.pipeline);
    let gatedOnce = false;
    const commitSpy = vi.spyOn(m.t.services.pipeline, 'commit').mockImplementation((async (
      cmd: Parameters<typeof origCommit>[0],
      input: Parameters<typeof origCommit>[1],
      ctx: Parameters<typeof origCommit>[2],
    ) => {
      if (!gatedOnce && (typeof cmd === 'string' ? cmd : cmd.name) === 'set_dutch_voice') {
        gatedOnce = true;
        commitEntered();
        await commitGate;
      }
      return origCommit(cmd, input, ctx);
    }) as typeof origCommit);

    let retryQueued!: () => void;
    const atRetryQueued = new Promise<void>((resolve) => {
      retryQueued = resolve;
    });
    const origFetchModel = typing.fetchModel.bind(typing);
    const fetchModelSpy = vi.spyOn(typing, 'fetchModel').mockImplementation((principal, model) => {
      const p = origFetchModel(principal, model);
      retryQueued();
      return p;
    });

    try {
      const offP = deviceA.request('voice.setDutchVoice', { on: false });
      await atCommit;
      const retryP = deviceB.request('voice.fetchModel', { model: 'supertonic' });
      await atRetryQueued;
      releaseCommit();

      const [offRes, retryRes] = await Promise.all([offP, retryP]);
      expect(offRes).toMatchObject({ t: 'result' });
      expect(retryRes).toMatchObject({ t: 'error', code: 'forbidden' });
    } finally {
      fetchModelSpy.mockRestore();
      commitSpy.mockRestore();
    }

    expect(fetcher.calls.filter((x) => x.model === 'supertonic')).toEqual([
      { kind: 'remove', model: 'supertonic' },
    ]);
    const [rowAfterOff] = await m.t.services.db.select().from(voiceTyping);
    expect(rowAfterOff?.dutchVoice).toBe(false);
    expect((await fetcher.state()).models.find((x) => x.id === 'supertonic')).toMatchObject({
      state: 'absent',
      received: 0,
    });

    // Interleaving 2: retry enters fetcher.fetch first while device A turns Dutch voice off concurrently.
    // Turning off waits behind the retry in the serial queue, then commits false and removes the download.
    fetcher.failNext.supertonic = 'no_room';
    await deviceA.request('voice.setDutchVoice', {
      on: true,
      licenceVersion: DUTCH_VOICE_LICENCE_VERSION,
    });
    await until(deviceA, (v) => v.dutchVoice?.state === 'failed');
    fetcher.calls.length = 0;

    let fetchEntered!: () => void;
    const atFetch = new Promise<void>((resolve) => {
      fetchEntered = resolve;
    });
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const origFetch = fetcher.fetch.bind(fetcher);
    const fetchSpy = vi.spyOn(fetcher, 'fetch').mockImplementation(async (model) => {
      if (model === 'supertonic') {
        fetchEntered();
        await fetchGate;
      }
      return origFetch(model);
    });

    let offQueued!: () => void;
    const atOffQueued = new Promise<void>((resolve) => {
      offQueued = resolve;
    });
    const origSetDutch = typing.setDutchVoice.bind(typing);
    const setDutchSpy = vi.spyOn(typing, 'setDutchVoice').mockImplementation((principal, input) => {
      const p = origSetDutch(principal, input);
      offQueued();
      return p;
    });

    try {
      const retryP = deviceB.request('voice.fetchModel', { model: 'supertonic' });
      await atFetch;
      const offP = deviceA.request('voice.setDutchVoice', { on: false });
      await atOffQueued;
      releaseFetch();

      const [retryRes, offRes] = await Promise.all([retryP, offP]);
      expect(retryRes).toMatchObject({ t: 'result' });
      expect(offRes).toMatchObject({ t: 'result' });
    } finally {
      setDutchSpy.mockRestore();
      fetchSpy.mockRestore();
    }

    expect(fetcher.calls.filter((x) => x.model === 'supertonic')).toEqual([
      { kind: 'fetch', model: 'supertonic' },
      { kind: 'remove', model: 'supertonic' },
    ]);
    const [rowAfterBoth] = await m.t.services.db.select().from(voiceTyping);
    expect(rowAfterBoth?.dutchVoice).toBe(false);
    expect((await fetcher.state()).models.find((x) => x.id === 'supertonic')).toMatchObject({
      state: 'absent',
      received: 0,
    });

    // Interleaving 3: toggling on on device A and off on device B concurrently keeps DB and fetcher state aligned.
    fetcher.calls.length = 0;
    let onCommitEntered!: () => void;
    const atOnCommit = new Promise<void>((resolve) => {
      onCommitEntered = resolve;
    });
    let releaseOnCommit!: () => void;
    const onCommitGate = new Promise<void>((resolve) => {
      releaseOnCommit = resolve;
    });
    let gatedOnOnce = false;
    const onCommitSpy = vi.spyOn(m.t.services.pipeline, 'commit').mockImplementation((async (
      cmd: Parameters<typeof origCommit>[0],
      input: Parameters<typeof origCommit>[1],
      ctx: Parameters<typeof origCommit>[2],
    ) => {
      if (!gatedOnOnce && (typeof cmd === 'string' ? cmd : cmd.name) === 'set_dutch_voice') {
        gatedOnOnce = true;
        onCommitEntered();
        await onCommitGate;
      }
      return origCommit(cmd, input, ctx);
    }) as typeof origCommit);

    let secondToggleQueued!: () => void;
    const atSecondToggleQueued = new Promise<void>((resolve) => {
      secondToggleQueued = resolve;
    });
    let toggleCalls = 0;
    const toggleSpy = vi.spyOn(typing, 'setDutchVoice').mockImplementation((principal, input) => {
      const p = origSetDutch(principal, input);
      toggleCalls += 1;
      if (toggleCalls === 2) secondToggleQueued();
      return p;
    });

    try {
      const onP = deviceA.request('voice.setDutchVoice', {
        on: true,
        licenceVersion: DUTCH_VOICE_LICENCE_VERSION,
      });
      await atOnCommit;
      const offP = deviceB.request('voice.setDutchVoice', { on: false });
      await atSecondToggleQueued;
      releaseOnCommit();

      const [onRes, offRes] = await Promise.all([onP, offP]);
      expect(onRes).toMatchObject({ t: 'result' });
      expect(offRes).toMatchObject({ t: 'result' });
    } finally {
      toggleSpy.mockRestore();
      onCommitSpy.mockRestore();
    }

    expect(fetcher.calls.filter((x) => x.model === 'supertonic')).toEqual([
      { kind: 'fetch', model: 'supertonic' },
      { kind: 'remove', model: 'supertonic' },
    ]);
    const [finalRow] = await m.t.services.db.select().from(voiceTyping);
    expect(finalRow?.dutchVoice).toBe(false);
    expect((await fetcher.state()).models.find((x) => x.id === 'supertonic')).toMatchObject({
      state: 'absent',
      received: 0,
    });
  });
});

describe('a recording', () => {
  it('becomes text, with the names Whisper is told', async () => {
    fresh({ ready: ['parakeet', 'whisper'] });
    const c = await m.client(mara);
    await settings(c, { on: true, model: 'auto', language: 'auto' });
    const fast = await record(c, fakeRecording(2));
    expect(fast.done).toMatchObject({
      t: 'stream_done',
      output: { text: FAKE_TRANSCRIPT, seconds: 2, model: 'parakeet' },
    });
    await settings(c, { model: 'whisper', language: 'nl' });
    voice.transcripts.push('Kijk even naar pve-02 [BLANK_AUDIO]');
    const accurate = await record(c, fakeRecording(1));
    expect(accurate.done).toMatchObject({ output: { text: 'Kijk even naar pve-02', model: 'whisper' } });
    const asked = voice.calls.filter((x) => x.kind === 'transcribe');
    const agent = await loadAgentRow(m.t.services.db, TEST_BURROW_ID);
    expect(asked[0]).toMatchObject({ model: 'parakeet', prompt: null });
    expect(asked[1]).toMatchObject({ model: 'whisper', language: 'nl' });
    expect(asked[1]?.prompt).toContain(agent?.name);
    // Silence is nothing heard, without asking the speech service.
    const quiet = await record(c, fakeRecording(1, { silent: true }));
    expect(quiet.done).toMatchObject({ output: { text: '', seconds: 1 } });
    expect(voice.calls.filter((x) => x.kind === 'transcribe')).toHaveLength(2);
  });

  it('is refused when voice typing is off, too long, not ready or the service is busy', async () => {
    // Without a fetcher nothing downloads meanwhile: Most accurate stays missing.
    fresh({ ready: ['parakeet'], fetcher: false });
    const c = await m.client(mara);
    await settings(c, { on: false, model: 'auto', language: 'auto' });
    expect((await record(c, fakeRecording(1))).done).toMatchObject({
      t: 'error',
      details: { code: 'dictation_off' },
    });
    await settings(c, { on: true });
    const long = await record(c, fakeRecording(1), VOICE_TYPING_MAX_BYTES + 2);
    expect(long.answer).toMatchObject({ t: 'error', code: 'stream_refused', details: { code: 'too_long' } });
    voice.failNext.transcribe = new VoiceCallError('busy', 'one at a time');
    expect((await record(c, fakeRecording(1))).done).toMatchObject({ t: 'error', details: { code: 'busy' } });
    await settings(c, { model: 'whisper' });
    expect((await record(c, fakeRecording(1))).done).toMatchObject({
      t: 'error',
      code: 'unavailable',
      details: { code: 'not_ready' },
    });
  });
});
