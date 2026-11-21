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
  VOICE_STT_MODELS,
  VOICE_TYPING_MAX_BYTES,
  type VoiceDownloadModel,
  type VoiceSttModel,
  VoiceTyping,
} from '@whombat/core/domain';
import { and, asc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
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
