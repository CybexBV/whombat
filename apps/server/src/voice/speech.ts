/**
 * Speech on the box (docs/decisions/desk-display.md DK-06, DK-07; desk-display-talk.md DK-T01…; dictation.md): the voice
 * service (`whombat-voice`, whisper.cpp and Kokoro, no network) as the runtime sees it, a small JSON API on its unix
 * socket (`WHOMBAT_VOICE_SOCKET`, contracts 0.100.0 CT-532, 3.1):
 *
 *   GET  /v1/voice/health      → {v, stt, tts, microphone, speaker, voices?, models?, gpu?, languages?}
 *   POST /v1/voice/stt         {v, audioWav, prompt?, model?, language?} → {v, text, seconds}   (the desk, ≤ 30 s)
 *   POST /v1/voice/tts         {v, text, voice?, language?} → {v, audioWav}
 *   POST /v1/voice/transcribe  {v, audioWav, model, language, prompt?} → {v, parts, seconds, model, gpu}  (≤ 5 min)
 *
 * `voices` (0.105, CT-614; DK-50): the voices the service speaks with, its default first. A request names one only when
 * the service's health listed it (DK-S52): an older service has one voice and refuses a member it doesn't know.
 * `models` and `gpu` (3.1): the speech models downloaded and running, and the graphics chip Whisper runs on; only a
 * service whose health has `models` can turn a voice typing recording into text. `languages` (3.4): what `tts` speaks,
 * English first; a request names Dutch only when the health listed it, as with `voice` (desk-display-talk.md DK-T22).
 *
 * Errors are `LocalError`s: 400 `bad_audio`, 413, 503 `busy` (one job at a time, a queue of two) or `unavailable` (the
 * model isn't there). `WHOMBAT_VOICE=fake` puts the fake voice (`testing/fake-voice.ts`) in its place for development and
 * tests. Nothing here keeps or logs audio or what was said: a recording is sent once and dropped (DK-07).
 *
 * The WAV helpers check what the screen and the composers send before it goes anywhere (16 kHz, mono, 16-bit PCM, at
 * most 30 s from the screen, five minutes from a composer) and write the fake's answers.
 */
import {
  DESK_AUDIO_MAX_SECONDS,
  DESK_AUDIO_SAMPLE_RATE,
  LocalError,
  VOICE_PATHS,
  VOICE_TTS_BASE64_MAX,
  VoiceHealth,
  type VoiceSpeechLanguage,
  VoiceSttAnswer,
  VoiceSttRequest,
  VoiceTranscribeAnswer,
  VoiceTranscribeRequest,
  VoiceTtsAnswer,
  VoiceTtsRequest,
} from '@whombat/control-contracts/local';
import {
  VOICE_TYPING_MAX_SECONDS,
  type VoiceLanguage,
  type VoiceModelChoice,
  type VoiceSttModel,
} from '@whombat/core/domain';
import { requestUnixHttp, UnixHttpError } from '@whombat/node-io/http';
import type { Config } from '../config';
import { voiceModelsFor } from './models';
import { FakeVoiceModels } from './testing/fake-models';
import { FakeVoice } from './testing/fake-voice';

/* WAV ------------------------------------------------------------------------------------------------------------- */

/** A WAV the screen or the voice service can't use: not RIFF/WAVE PCM, not what is recorded, or too long (`tooLong`). */
export class WavError extends Error {
  constructor(
    message: string,
    readonly tooLong = false,
  ) {
    super(message);
    this.name = 'WavError';
  }
}

export interface WavInfo {
  /** 1: integer PCM. */
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** The sample bytes. */
  data: Buffer;
  seconds: number;
}

/** The format and samples of a RIFF/WAVE file; a data chunk longer than the file (a streaming writer's) ends with it. */
export function parseWav(buf: Buffer): WavInfo {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE')
    throw new WavError('not a WAV file');
  let fmt: Omit<WavInfo, 'data' | 'seconds'> | null = null;
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString('latin1', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.length) throw new WavError('a short fmt chunk');
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) throw new WavError('data before fmt');
      const data = buf.subarray(body, Math.min(buf.length, body + size));
      const frame = Math.max(1, fmt.channels * Math.ceil(fmt.bitsPerSample / 8));
      if (fmt.sampleRate === 0) throw new WavError('no sample rate');
      return { ...fmt, data, seconds: Math.floor(data.length / frame) / fmt.sampleRate };
    }
    // Chunks are padded to an even size.
    at = body + size + (size % 2);
  }
  throw new WavError(fmt ? 'no data chunk' : 'no fmt chunk');
}

/** 16 kHz mono 16-bit PCM of at most `maxSeconds`; else a `WavError` (`tooLong` when only the length is wrong). */
function checkSpeechWav(buf: Buffer, maxSeconds: number): WavInfo {
  const wav = parseWav(buf);
  if (
    wav.format !== 1 ||
    wav.channels !== 1 ||
    wav.bitsPerSample !== 16 ||
    wav.sampleRate !== DESK_AUDIO_SAMPLE_RATE
  )
    throw new WavError('not 16 kHz mono 16-bit PCM');
  if (wav.data.length > maxSeconds * DESK_AUDIO_SAMPLE_RATE * 2)
    throw new WavError(`longer than ${maxSeconds} seconds`, true);
  return wav;
}

/** What the desk records (§2.3): 16 kHz mono 16-bit PCM, at most 30 s; else a `WavError`. */
export function checkDeskWav(buf: Buffer): WavInfo {
  return checkSpeechWav(buf, DESK_AUDIO_MAX_SECONDS);
}

/** A voice typing recording: 16 kHz mono 16-bit PCM, at most five minutes; else a `WavError`. */
export function checkDictationWav(buf: Buffer): WavInfo {
  return checkSpeechWav(buf, VOICE_TYPING_MAX_SECONDS);
}

/** The loudest sample of 16-bit PCM (0…32768). */
export function wavPeak(wav: Pick<WavInfo, 'data' | 'bitsPerSample'>): number {
  if (wav.bitsPerSample !== 16) return 0;
  let peak = 0;
  for (let i = 0; i + 1 < wav.data.length; i += 2) {
    const s = Math.abs(wav.data.readInt16LE(i));
    if (s > peak) peak = s;
  }
  return peak;
}

/** A mono 16-bit PCM WAV of these samples. */
export function encodeWav(samples: Int16Array, sampleRate: number): Buffer {
  const data = samples.length * 2;
  const out = Buffer.alloc(44 + data);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(36 + data, 4);
  out.write('WAVE', 8, 'latin1');
  out.write('fmt ', 12, 'latin1');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'latin1');
  out.writeUInt32LE(data, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i] ?? 0, 44 + i * 2);
  return out;
}

/* The voice service ----------------------------------------------------------------------------------------------- */

/** What the box can do with speech, as Settings and the screen ask (`voiceHealth`). */
export interface VoiceAbility {
  stt: boolean;
  tts: boolean;
  microphone: boolean;
  speaker: boolean;
  /** The voices `tts` speaks with, its default first (0.105); absent: one voice, and a request names none. */
  voices?: readonly string[];
  /** The speech models downloaded and running (3.1); absent: a service that can't turn a recording into text. */
  models?: readonly VoiceSttModel[];
  /** The graphics chip Whisper runs on (3.1); absent: none it can use. */
  gpu?: { name: string };
  /** The languages `tts` speaks, English first (3.4); absent: English only, and a request names none. */
  languages?: readonly VoiceSpeechLanguage[];
}

/**
 * The voices the box can answer with now (`DeskScreen.voices`, DK-50): the health's while it speaks (`tts`), else null
 * — no voice service, one that can't speak, or one that can't choose (DK-52).
 */
export function speakingVoices(health: VoiceAbility | null | undefined): readonly string[] | null {
  return health?.tts && health.voices?.length ? health.voices : null;
}

export const NO_VOICE: VoiceAbility = { stt: false, tts: false, microphone: false, speaker: false };

/** Why a call to the voice service failed: it isn't there or is busy, it refused the audio, or something else. */
export class VoiceCallError extends Error {
  constructor(
    readonly code: 'unavailable' | 'busy' | 'bad_audio' | 'too_large' | 'error',
    message: string,
  ) {
    super(message);
    this.name = 'VoiceCallError';
  }
}

/** The voice typing settings a request carries (3.1): sent only to a service whose health has `models`. */
export interface VoiceSttSettings {
  model: VoiceModelChoice;
  language: VoiceLanguage;
}

/** A voice typing recording to turn into text (dictation.md). */
export interface VoiceTranscribeOptions extends VoiceSttSettings {
  /** The names the person may say (Whisper only). */
  prompt?: string;
  /** The recording's length: a long one may take a while (`transcribeTimeoutMs`). */
  seconds: number;
  /** The person cancelled, or the stream went: stop waiting. */
  signal?: AbortSignal;
}

/** What a recording said, on one line (empty when nothing was heard), and the model that heard it. */
export interface VoiceTranscript {
  text: string;
  seconds: number;
  model: VoiceSttModel;
  gpu: boolean;
}

/** The voice service: the socket client, or the fake. */
export interface VoicePort {
  health(): Promise<VoiceAbility>;
  /**
   * Speech to text for the desk; `prompt` names what the person may say (the assistant, servers, things), `settings`
   * the voice typing settings (only for a service whose health has `models`).
   */
  stt(
    audioWav: Buffer,
    prompt?: string,
    settings?: VoiceSttSettings,
  ): Promise<{ text: string; seconds: number }>;
  /**
   * Text to speech: a WAV, in `voice` when the service's health lists it (else its default), in `language` when it lists
   * that (else English; 3.4: Dutch in its Dutch voice of the same kind as `voice`).
   */
  tts(text: string, voice?: string, language?: VoiceSpeechLanguage): Promise<Buffer>;
  /** A voice typing recording of up to five minutes to text (3.1). */
  transcribe(audioWav: Buffer, options: VoiceTranscribeOptions): Promise<VoiceTranscript>;
}

/** A health check answers at once; speech takes a while (whisper on 30 s, behind a queue of two). */
const HEALTH_TIMEOUT_MS = 2_000;
const STT_TIMEOUT_MS = 60_000;
const TTS_TIMEOUT_MS = 30_000;
/** The answers: a desk transcript is small, a voice typing one up to 12 parts of 1000 characters; speech is larger. */
const SMALL_ANSWER_BYTES = 64 * 1024;
const TRANSCRIPT_ANSWER_BYTES = 256 * 1024;
const TTS_ANSWER_BYTES = VOICE_TTS_BASE64_MAX + 1024;

/**
 * How long a voice typing recording may take: at least 90 s, and three times its length — Whisper on a processor takes
 * about as long as the person spoke, behind up to two others in the queue.
 */
export function transcribeTimeoutMs(seconds: number): number {
  return Math.max(90_000, Math.ceil(seconds * 3) * 1000);
}

/** The voice service on its unix socket (§2.4), validated both ways. */
export class VoiceSocketClient implements VoicePort {
  /** The voices the service's last health listed (null before the first; none: it can't choose). */
  #voices: readonly string[] | null = null;
  /** The languages the service's last health listed (null before the first; none: English only). */
  #languages: readonly VoiceSpeechLanguage[] | null = null;

  constructor(private readonly socketPath: string) {}

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    timeoutMs: number,
    maxAnswerBytes: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let answer: Awaited<ReturnType<typeof requestUnixHttp>>;
    try {
      answer = await requestUnixHttp({
        socketPath: this.socketPath,
        path,
        method,
        headers:
          payload === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        ...(payload === undefined ? {} : { body: payload }),
        deadlineMs: timeoutMs,
        ...(signal ? { signal } : {}),
        maxResponseBytes: maxAnswerBytes,
      });
    } catch (err) {
      if (err instanceof UnixHttpError && err.kind === 'too_large')
        throw new VoiceCallError('error', `voice ${path}: answer too large`);
      if (err instanceof UnixHttpError && err.kind === 'timeout')
        throw new VoiceCallError('unavailable', `voice ${path}: timed out`);
      throw new VoiceCallError('unavailable', `voice ${path}: ${String(err)}`);
    }
    const text = answer.body.toString('utf8');
    if (answer.status >= 300) throw voiceErrorOf(path, answer.status, text);
    try {
      return JSON.parse(text);
    } catch {
      throw new VoiceCallError('error', `voice ${path}: not JSON`);
    }
  }

  async health(): Promise<VoiceAbility> {
    const h = VoiceHealth.parse(
      await this.call('GET', VOICE_PATHS.health, undefined, HEALTH_TIMEOUT_MS, SMALL_ANSWER_BYTES),
    );
    this.#voices = h.voices ?? [];
    this.#languages = h.languages ?? [];
    return {
      stt: h.stt,
      tts: h.tts,
      microphone: h.microphone,
      speaker: h.speaker,
      ...(h.voices?.length ? { voices: h.voices } : {}),
      ...(h.models ? { models: h.models } : {}),
      // The chip is known before any model is downloaded: Automatic must know it to fetch Most accurate.
      ...(h.gpu ? { gpu: { name: h.gpu.name } } : {}),
      ...(h.languages?.length ? { languages: h.languages } : {}),
    };
  }

  async stt(
    audioWav: Buffer,
    prompt?: string,
    settings?: VoiceSttSettings,
  ): Promise<{ text: string; seconds: number }> {
    const body = VoiceSttRequest.parse({
      v: 1,
      audioWav: audioWav.toString('base64'),
      ...(prompt ? { prompt } : {}),
      ...(settings ? { model: settings.model, language: settings.language } : {}),
    });
    const answer = VoiceSttAnswer.parse(
      await this.call('POST', VOICE_PATHS.stt, body, STT_TIMEOUT_MS, SMALL_ANSWER_BYTES),
    );
    return { text: answer.text, seconds: answer.seconds };
  }

  async tts(text: string, voice?: string, language?: VoiceSpeechLanguage): Promise<Buffer> {
    // A voice or a language goes only to a service whose health listed it (DK-S52, DK-T22); asked once when it wasn't
    // yet. English is what every service speaks without being told.
    const other = language && language !== 'en' ? language : undefined;
    if ((voice && this.#voices === null) || (other && this.#languages === null))
      await this.health().catch(() => null);
    const named = {
      ...(voice && this.#voices?.includes(voice) ? { voice } : {}),
      ...(other && this.#languages?.includes(other) ? { language: other } : {}),
    };
    const answer = VoiceTtsAnswer.parse(
      await this.call(
        'POST',
        VOICE_PATHS.tts,
        VoiceTtsRequest.parse({ v: 1, text, ...named }),
        TTS_TIMEOUT_MS,
        TTS_ANSWER_BYTES,
      ),
    );
    const wav = Buffer.from(answer.audioWav, 'base64');
    parseWav(wav);
    return wav;
  }

  async transcribe(audioWav: Buffer, options: VoiceTranscribeOptions): Promise<VoiceTranscript> {
    const body = VoiceTranscribeRequest.parse({
      v: 1,
      audioWav: audioWav.toString('base64'),
      model: options.model,
      language: options.language,
      ...(options.prompt ? { prompt: options.prompt } : {}),
    });
    const answer = VoiceTranscribeAnswer.parse(
      await this.call(
        'POST',
        VOICE_PATHS.transcribe,
        body,
        transcribeTimeoutMs(options.seconds),
        TRANSCRIPT_ANSWER_BYTES,
        options.signal,
      ),
    );
    return {
      text: answer.parts.join(' ').trim(),
      seconds: answer.seconds,
      model: answer.model,
      gpu: answer.gpu,
    };
  }
}

function voiceErrorOf(path: string, status: number, text: string): VoiceCallError {
  let code = '';
  try {
    code = LocalError.parse(JSON.parse(text)).error.code;
  } catch {
    /* not a LocalError */
  }
  const message = `voice ${path}: ${status} ${code || text.slice(0, 120)}`;
  if (status === 413) return new VoiceCallError('too_large', message);
  if (status === 400 && code === 'bad_audio') return new VoiceCallError('bad_audio', message);
  if (status === 503) return new VoiceCallError(code === 'busy' ? 'busy' : 'unavailable', message);
  return new VoiceCallError('error', message);
}

/* Per process ----------------------------------------------------------------------------------------------------- */

type VoiceConfig = Pick<Config, 'WHOMBAT_VOICE' | 'WHOMBAT_VOICE_SOCKET' | 'WHOMBAT_VOICE_MODELS_SOCKET'>;

const ports = new WeakMap<object, VoicePort | null>();

/**
 * The process's voice service (one per `Services`): the fake, the socket's client, or none. The fake's speech models are
 * the ones the fake model fetcher has downloaded (`voiceModelsFor`).
 */
export function voiceFor(services: { config: VoiceConfig }): VoicePort | null {
  if (ports.has(services)) return ports.get(services) ?? null;
  const { WHOMBAT_VOICE: mode, WHOMBAT_VOICE_SOCKET: socket } = services.config;
  const port =
    mode === 'off'
      ? null
      : mode === 'fake'
        ? new FakeVoice({ models: () => fakeModelsOf(services) })
        : socket
          ? new VoiceSocketClient(socket)
          : null;
  ports.set(services, port);
  return port;
}

/** Tests: this voice service (or none) for these services; the health cache starts over. */
export function setVoiceFor(services: object, port: VoicePort | null): void {
  ports.set(services, port);
  healths.delete(services);
}

/** The models the fake model fetcher of these services has downloaded (the fake voice's `models`). */
function fakeModelsOf(services: { config: VoiceConfig }): readonly VoiceSttModel[] {
  const fetcher = voiceModelsFor(services);
  return fetcher instanceof FakeVoiceModels ? fetcher.ready() : [];
}

/** How long a health answer is kept: a minute, a failure 15 s (the service may just be starting). */
export const VOICE_HEALTH_TTL_MS = 60_000;
const VOICE_HEALTH_FAILED_TTL_MS = 15_000;

const healths = new WeakMap<object, { at: number; ttl: number; value: Promise<VoiceAbility | null> }>();

/**
 * The voice service's health, cached a minute; null when there is no voice service or it doesn't answer (voice typing's
 * `available`).
 */
export function answeringVoiceHealth(services: { config: VoiceConfig }): Promise<VoiceAbility | null> {
  const now = Date.now();
  const hit = healths.get(services);
  if (hit && now - hit.at <= hit.ttl) return hit.value;
  const port = voiceFor(services);
  const entry = { at: now, ttl: VOICE_HEALTH_TTL_MS, value: Promise.resolve<VoiceAbility | null>(null) };
  entry.value = port
    ? port.health().catch(() => {
        entry.ttl = VOICE_HEALTH_FAILED_TTL_MS;
        return null;
      })
    : Promise.resolve(null);
  healths.set(services, entry);
  return entry.value;
}

/**
 * What the box can do with speech (`DeskScreen.hasMicrophone`, `hasSpeaker`, `voiceAvailable`; Talk's checks), cached a
 * minute. No voice service, or one that doesn't answer: nothing.
 */
export async function voiceHealth(services: { config: VoiceConfig }): Promise<VoiceAbility> {
  return (await answeringVoiceHealth(services)) ?? NO_VOICE;
}

/** The next health is asked again: a speech model was downloaded or removed, and the service runs it now or not. */
export function forgetVoiceHealth(services: object): void {
  healths.delete(services);
}
