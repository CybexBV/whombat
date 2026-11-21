/**
 * A fake voice service (desk-display-talk.md DK-T09; dictation.md): what `whombat-voice` answers (assignment §2.4),
 * without whisper or Kokoro. Development and the appliance's dev world run it in process (`WHOMBAT_VOICE=fake`); tests
 * drive it directly or on a unix socket (`startFakeVoice`), as the runtime's client talks to the real one.
 *
 * It hears fixed transcripts (`transcripts`, then “Is pve-02 okay?”; nothing in a silent recording), speaks a short
 * tone as long as the text would take to say, at a pitch of its own per voice (the six desk voices, heart first, as
 * the box lists them), checks recordings as the real service does (16 kHz mono 16-bit PCM, ≤ 30 s, five minutes for
 * voice typing: else `bad_audio`) and refuses a voice or a spoken language its health doesn't list (400 `bad_request` on
 * the socket, as the real one), and records what it was asked — prompts, texts, voices, models and languages, never
 * audio. It speaks English and Dutch (3.4), as the box does. Its speech
 * models are the ones `models` gives (in development the fake model fetcher's downloads), else `ability.models`; it
 * picks one for a voice typing recording as the real one does and says `unavailable` when it has none. Tests switch
 * what `health` says (no `voices`: a service from before 0.105; no `models`: one from before 3.1; no `languages`: one
 * from before 3.4), fail the next call,
 * or hold transcribing until they let it go.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VOICE_PATHS,
  VOICE_TRANSCRIBE_REQUEST_MAX_BYTES,
  type VoiceSpeechLanguage,
  VoiceSttRequest,
  VoiceTranscribeRequest,
  VoiceTtsRequest,
} from '@whombat/control-contracts/local';
import { DESK_VOICES } from '@whombat/core';
import type { VoiceLanguage, VoiceModelChoice, VoiceSttModel } from '@whombat/core/domain';
import {
  checkDeskWav,
  checkDictationWav,
  encodeWav,
  type VoiceAbility,
  VoiceCallError,
  type VoicePort,
  type VoiceSttSettings,
  type VoiceTranscribeOptions,
  type VoiceTranscript,
  WavError,
  wavPeak,
} from '../speech';
import { modelFor } from '../view';

/** What the fake hears when no transcript is queued. */
export const FAKE_TRANSCRIPT = 'Is pve-02 okay?';

/** The rate of the fake's speech (Kokoro speaks at 24 kHz). */
export const FAKE_SPEECH_RATE = 24_000;

/**
 * The tone each voice speaks at, so a person hears which one they chose in development: the women higher, the men
 * lower, the British a little apart. Any other voice: 440 Hz.
 */
export const FAKE_VOICE_PITCH: Readonly<Record<string, number>> = {
  heart: 440,
  bella: 494,
  michael: 196,
  fenrir: 165,
  emma: 587,
  george: 247,
};

export type FakeVoiceCall =
  /** `model` and `language` only when the request carried them. */
  | {
      kind: 'stt';
      prompt: string | null;
      seconds: number;
      model?: VoiceModelChoice;
      language?: VoiceLanguage;
    }
  /** `voice` and `language` only when the request named them. */
  | { kind: 'tts'; text: string; voice?: string; language?: VoiceSpeechLanguage }
  /** `model` the one it heard with. */
  | {
      kind: 'transcribe';
      prompt: string | null;
      seconds: number;
      model: VoiceSttModel;
      language: VoiceLanguage;
    };

/** Whether `voice` is one `ability` lists: a service without `voices` has none to choose (an older one). */
function listed(ability: VoiceAbility, voice: string): boolean {
  return (ability.voices ?? []).includes(voice);
}

/** Whether `ability` speaks `language`: a service without `languages` names none (one from before 3.4). */
function speaks(ability: VoiceAbility, language: VoiceSpeechLanguage): boolean {
  return (ability.languages ?? []).includes(language);
}

export class FakeVoice implements VoicePort {
  /** What `health` answers: everything there by default, with the six desk voices (heart first), English and Dutch. */
  ability: VoiceAbility = {
    stt: true,
    tts: true,
    microphone: true,
    speaker: true,
    voices: [...DESK_VOICES],
    languages: ['en', 'nl'],
  };
  /** What it hears next, in order; then `FAKE_TRANSCRIPT`. */
  readonly transcripts: string[] = [];
  /** The next call of that kind fails with this (once). */
  readonly failNext: { stt?: VoiceCallError; tts?: VoiceCallError; transcribe?: VoiceCallError } = {};
  /** What it was asked, in order: prompts and texts, never the audio. */
  readonly calls: FakeVoiceCall[] = [];
  #held: { promise: Promise<void>; release: () => void } | null = null;
  readonly #models: (() => readonly VoiceSttModel[]) | null;

  /** `models`: the speech models it runs, asked at each health (the fake fetcher's downloads). */
  constructor(options: { models?: () => readonly VoiceSttModel[] } = {}) {
    this.#models = options.models ?? null;
  }

  async health(): Promise<VoiceAbility> {
    const { voices, models, gpu, languages, ...rest } = this.ability;
    const running = this.#models?.() ?? models;
    return {
      ...rest,
      ...(voices ? { voices: [...voices] } : {}),
      ...(languages ? { languages: [...languages] } : {}),
      ...(running ? { models: [...running] } : {}),
      ...(gpu ? { gpu: { ...gpu } } : {}),
    };
  }

  /** Transcribing waits until `release()` (a test sees the talk in `transcribing`). */
  hold(): void {
    let release = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#held = { promise, release };
  }

  release(): void {
    this.#held?.release();
    this.#held = null;
  }

  async stt(
    audioWav: Buffer,
    prompt?: string,
    settings?: VoiceSttSettings,
  ): Promise<{ text: string; seconds: number }> {
    if (!this.ability.stt) throw new VoiceCallError('unavailable', 'fake voice: no speech to text');
    const failure = this.failNext.stt;
    if (failure) {
      delete this.failNext.stt;
      throw failure;
    }
    let wav: ReturnType<typeof checkDeskWav>;
    try {
      wav = checkDeskWav(audioWav);
    } catch (err) {
      throw new VoiceCallError('bad_audio', err instanceof WavError ? err.message : 'bad audio');
    }
    // The service rounds the length to whole seconds (`VoiceSttAnswer`).
    const seconds = Math.round(wav.seconds);
    this.calls.push({ kind: 'stt', prompt: prompt ?? null, seconds, ...(settings ?? {}) });
    if (this.#held) await this.#held.promise;
    if (wavPeak(wav) === 0) return { text: '', seconds };
    return { text: this.transcripts.shift() ?? FAKE_TRANSCRIPT, seconds };
  }

  async transcribe(audioWav: Buffer, options: VoiceTranscribeOptions): Promise<VoiceTranscript> {
    const health = await this.health();
    const gpu = health.gpu !== undefined;
    const model = modelFor(options.model, new Set(health.models ?? []), gpu);
    if (!model) throw new VoiceCallError('unavailable', 'fake voice: that speech model isn’t downloaded');
    const failure = this.failNext.transcribe;
    if (failure) {
      delete this.failNext.transcribe;
      throw failure;
    }
    let wav: ReturnType<typeof checkDictationWav>;
    try {
      wav = checkDictationWav(audioWav);
    } catch (err) {
      throw new VoiceCallError('bad_audio', err instanceof WavError ? err.message : 'bad audio');
    }
    const seconds = Math.round(wav.seconds);
    this.calls.push({
      kind: 'transcribe',
      prompt: options.prompt ?? null,
      seconds,
      model,
      language: options.language,
    });
    if (this.#held) await this.#held.promise;
    if (options.signal?.aborted) throw new VoiceCallError('unavailable', 'fake voice: cancelled');
    const text = wavPeak(wav) === 0 ? '' : (this.transcripts.shift() ?? FAKE_TRANSCRIPT);
    return { text, seconds, model, gpu: gpu && model === 'whisper' };
  }

  async tts(text: string, voice?: string, language?: VoiceSpeechLanguage): Promise<Buffer> {
    if (!this.ability.tts) throw new VoiceCallError('unavailable', 'fake voice: no text to speech');
    if (voice !== undefined && !listed(this.ability, voice))
      throw new VoiceCallError('error', `fake voice: no voice ${voice}`);
    if (language !== undefined && !speaks(this.ability, language))
      throw new VoiceCallError('error', `fake voice: no ${language}`);
    const failure = this.failNext.tts;
    if (failure) {
      delete this.failNext.tts;
      throw failure;
    }
    this.calls.push({
      kind: 'tts',
      text,
      ...(voice !== undefined ? { voice } : {}),
      ...(language !== undefined ? { language } : {}),
    });
    const pitch = FAKE_VOICE_PITCH[voice ?? this.ability.voices?.[0] ?? ''] ?? 440;
    return toneWav(spokenSeconds(text), FAKE_SPEECH_RATE, 6000, pitch);
  }
}

/** About as long as the words take to say (2.5 words a second), between half a second and 4 seconds. */
export function spokenSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(4, Math.max(0.5, words / 2.5));
}

/** A soft tone (440 Hz unless said) that fades in and out: mono 16-bit PCM. */
export function toneWav(seconds: number, sampleRate: number, amplitude = 6000, hz = 440): Buffer {
  const n = Math.max(1, Math.round(seconds * sampleRate));
  const fade = Math.min(n / 2, Math.round(sampleRate * 0.05));
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const edge = Math.min(1, i / fade, (n - 1 - i) / fade);
    samples[i] = Math.round(amplitude * edge * Math.sin((2 * Math.PI * hz * i) / sampleRate));
  }
  return encodeWav(samples, sampleRate);
}

/** A recording as the desk screen sends one (16 kHz mono 16-bit): a tone, or silence. */
export function fakeRecording(seconds = 1.5, options: { silent?: boolean } = {}): Buffer {
  return options.silent
    ? encodeWav(new Int16Array(Math.round(seconds * 16_000)), 16_000)
    : toneWav(seconds, 16_000);
}

/* On a unix socket ------------------------------------------------------------------------------------------------ */

/** The real service's body limits: 30 s of 16 kHz audio in base64 fits, five minutes for voice typing. */
const BODY_MAX = 1.5 * 1024 * 1024;
const TRANSCRIBE_BODY_MAX = VOICE_TRANSCRIBE_REQUEST_MAX_BYTES;

export interface FakeVoiceServer {
  socketPath: string;
  voice: FakeVoice;
  close(): Promise<void>;
}

/** The fake behind §2.4's socket API, as `whombat-voice` serves it (errors as `LocalError`s). */
export async function startFakeVoice(
  options: { socketPath?: string; voice?: FakeVoice } = {},
): Promise<FakeVoiceServer> {
  const voice = options.voice ?? new FakeVoice();
  const dir = options.socketPath ? null : mkdtempSync(join(tmpdir(), 'wb-voice-'));
  const socketPath = options.socketPath ?? join(dir as string, 'voice.sock');
  if (existsSync(socketPath)) rmSync(socketPath);
  const server = createServer((req, res) => {
    serve(voice, req, res).catch((err: unknown) => fail(res, 500, 'internal', String(err)));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
    voice,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          if (dir) rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  if (!res.headersSent) send(res, status, { error: { code, message } });
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Read to the end even past the limit, so the client gets the 413 rather than a reset connection.
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size <= max) chunks.push(chunk as Buffer);
  }
  return size > max ? null : Buffer.concat(chunks);
}

const ERROR_STATUS: Record<VoiceCallError['code'], number> = {
  unavailable: 503,
  busy: 503,
  bad_audio: 400,
  too_large: 413,
  error: 500,
};

async function serve(voice: FakeVoice, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'GET' && req.url === VOICE_PATHS.health) {
    const { gpu, ...health } = await voice.health();
    send(res, 200, { v: 1, ...health, ...(gpu ? { gpu: { name: gpu.name, backend: 'vulkan' } } : {}) });
    return;
  }
  const routes: readonly string[] = [VOICE_PATHS.stt, VOICE_PATHS.tts, VOICE_PATHS.transcribe];
  if (req.method !== 'POST' || !routes.includes(req.url ?? '')) {
    fail(res, 404, 'not_found', 'no such route');
    return;
  }
  const raw = await readBody(req, req.url === VOICE_PATHS.transcribe ? TRANSCRIBE_BODY_MAX : BODY_MAX);
  if (!raw) {
    fail(res, 413, 'too_large', 'body too large');
    return;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    fail(res, 400, 'bad_request', 'not JSON');
    return;
  }
  try {
    if (req.url === VOICE_PATHS.stt) {
      const body = VoiceSttRequest.safeParse(json);
      if (!body.success) return fail(res, 400, 'bad_request', 'bad request');
      const { audioWav, prompt, model, language } = body.data;
      const settings = model && language ? { model, language } : undefined;
      const heard = await voice.stt(Buffer.from(audioWav, 'base64'), prompt, settings);
      send(res, 200, { v: 1, ...heard });
      return;
    }
    if (req.url === VOICE_PATHS.transcribe) {
      const body = VoiceTranscribeRequest.safeParse(json);
      if (!body.success) return fail(res, 400, 'bad_request', 'bad request');
      const { audioWav, model, language, prompt } = body.data;
      const wav = Buffer.from(audioWav, 'base64');
      const heard = await voice.transcribe(wav, {
        model,
        language,
        ...(prompt ? { prompt } : {}),
        seconds: 0,
      });
      // Cut at spaces into parts of at most 1000 characters, as the real one answers.
      send(res, 200, {
        v: 1,
        parts: textParts(heard.text),
        seconds: heard.seconds,
        model: heard.model,
        gpu: heard.gpu,
      });
      return;
    }
    const body = VoiceTtsRequest.safeParse(json);
    if (!body.success) return fail(res, 400, 'bad_request', 'bad request');
    // A voice its health doesn't list, as the real service refuses it (and one from before 0.105 any `voice`).
    if (body.data.voice !== undefined && !listed(voice.ability, body.data.voice))
      return fail(res, 400, 'bad_request', 'no such voice');
    // A language it doesn't speak, as the real service refuses it (and one from before 3.4 any `language`).
    if (body.data.language !== undefined && !speaks(voice.ability, body.data.language))
      return fail(res, 400, 'bad_request', 'no such language');
    const wav = await voice.tts(body.data.text, body.data.voice, body.data.language);
    send(res, 200, { v: 1, audioWav: wav.toString('base64') });
  } catch (err) {
    if (err instanceof VoiceCallError) fail(res, ERROR_STATUS[err.code], err.code, err.message);
    else throw err;
  }
}

/** A transcript in parts of at most 1000 code points, cut at spaces (`VoiceTranscribeAnswer.parts`). */
export function textParts(text: string): string[] {
  const parts: string[] = [];
  let part = '';
  for (const word of text.split(' ').filter(Boolean)) {
    const next = part ? `${part} ${word}` : word;
    if ([...next].length > 1000 && part) {
      parts.push(part);
      part = word;
    } else part = next;
  }
  if (part) parts.push(part);
  return parts;
}
