/**
 * The voice socket (0.100, CT-532; Whombat docs/decisions/desk-display.md DK-06, DK-07, DK-12): the runtime → the
 * appliance's speech service `whombat-voice`, HTTP/1.1 JSON over a unix socket at `WHOMBAT_VOICE_SOCKET`
 * (`VOICE_SOCKET_DEFAULT`; unset: no voice). The service has no network; speech becomes text and text becomes speech on
 * the box itself, and neither the audio nor the text is kept after the job.
 *
 * | Path | Request | Answer |
 * |---|---|---|
 * | `GET /v1/voice/health` | — | `VoiceHealth {v, stt, tts, microphone, speaker, voices?}` |
 * | `POST /v1/voice/stt` | `VoiceSttRequest {v, audioWav, prompt?}` | `VoiceSttAnswer {v, text, seconds}` |
 * | `POST /v1/voice/tts` | `VoiceTtsRequest {v, text, voice?, language?}` | `VoiceTtsAnswer {v, audioWav}` |
 * | `POST /v1/voice/transcribe` | `VoiceTranscribeRequest {v, audioWav, model, language, prompt?}` | `VoiceTranscribeAnswer {v, text, seconds, model, gpu}` |
 *
 * Voice typing (3.1; Whombat dictation.md): the speech models are downloaded after the box is installed (the models
 * socket, `voice-models.ts`), so the health names the ones that are there and run (`models`) and the graphics chip the
 * service uses for Whisper (`gpu`). `transcribe` takes a person's recording of up to five minutes; the service cuts it
 * at pauses into pieces of at most 30 s and joins their text. `stt` (the desk's question) may name a model and a
 * language too, sent only to a 3.1 service (one whose box has the models socket).
 *
 * 0.105 (CT-614; Whombat DK-50): the service names the voices it can speak with (`voices`, its default first) and a
 * request may choose one. The runtime sends `voice` only to a service whose health lists it: an older service refuses
 * the unknown member (requests are strict).
 *
 * 3.4 (Whombat desk-display-talk.md): the service may speak Dutch too (`languages`, English first). A request names the
 * text's `language` only when the health listed it; for Dutch the service speaks with its Dutch voice of the same kind
 * as the `voice` asked for (a woman's or a man's), and the runtime has written the text out as it is said (numbers,
 * times, names).
 *
 * Errors are `LocalError` with the codes of `VOICE_ERRORS`: 400 `bad_request` or `bad_audio` (not a 16 kHz mono 16-bit
 * WAV of at most 30 s, five minutes for `transcribe`), 413 `too_large`, 503 `busy` (one job at a time, at most `VOICE_QUEUE_MAX` waiting) or
 * `unavailable` (the model isn't there). Requests are strict, answers tolerant.
 */
import {
  VOICE_TYPING_MAX_BYTES,
  VOICE_TYPING_MAX_SECONDS,
  VOICE_TYPING_TEXT_MAX,
  VoiceLanguage,
  VoiceModelChoice,
  VoiceSttModel,
} from '@whombat/core/domain';
import { z } from 'zod';
import { DESK_QUESTION_MAX, DeskWav, deskTextSchema } from './desk.js';

const V = z.literal(1);

export const VOICE_SOCKET_ENV = 'WHOMBAT_VOICE_SOCKET';
export const VOICE_SOCKET_DEFAULT = '/run/whombat-voice/voice.sock';

export const VOICE_PATHS = {
  /** GET: what works here. */
  health: '/v1/voice/health',
  /** Speech to text. */
  stt: '/v1/voice/stt',
  /** Text to speech. */
  tts: '/v1/voice/tts',
  /** Voice typing (3.1): a recording of up to five minutes. */
  transcribe: '/v1/voice/transcribe',
} as const;

/** Jobs waiting behind the running one; more answer 503 `busy`. */
export const VOICE_QUEUE_MAX = 2;
/** The words that help the transcription (the assistant's name, the burrow's server and thing names). */
export const VOICE_PROMPT_MAX = 400;
/** The longest text spoken at once (a desk answer). */
export const VOICE_TTS_TEXT_MAX = 600;
/** The largest spoken answer: a WAV of mono 16-bit PCM (the voice's own rate, 16–48 kHz), base64. */
export const VOICE_TTS_WAV_MAX_BYTES = 6_291_456;
export const VOICE_TTS_BASE64_MAX = 4 * Math.ceil(VOICE_TTS_WAV_MAX_BYTES / 3);
/** Voice typing's recording in base64 (core's `VOICE_TYPING_MAX_BYTES`), and the largest `transcribe` body. */
export const VOICE_TRANSCRIBE_BASE64_MAX = 4 * Math.ceil(VOICE_TYPING_MAX_BYTES / 3);
export const VOICE_TRANSCRIBE_REQUEST_MAX_BYTES = VOICE_TRANSCRIBE_BASE64_MAX + 4_096;

export const VOICE_ERRORS = ['bad_request', 'bad_audio', 'too_large', 'busy', 'unavailable'] as const;

/** A voice's name (0.105, CT-614): the desk's names (`DESK_VOICES` of `@whombat/core/domain`), lower case. */
export const VoiceName = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export type VoiceName = z.infer<typeof VoiceName>;

/** The languages the service may speak (3.4): English, its default, and Dutch. */
export const VOICE_SPEECH_LANGUAGES = ['en', 'nl'] as const;
export const VoiceSpeechLanguage = z.enum(VOICE_SPEECH_LANGUAGES);
export type VoiceSpeechLanguage = z.infer<typeof VoiceSpeechLanguage>;

/** A graphics chip the service runs Whisper on (3.1): its name as the driver gives it, through Vulkan. */
export const VoiceGpu = z.object({
  name: z.string().regex(/^[\x20-\x7e]{1,200}$/),
  backend: z.literal('vulkan'),
  memoryMiB: z.number().int().min(0).max(1_048_576).optional(),
});
export type VoiceGpu = z.infer<typeof VoiceGpu>;

/**
 * `microphone` / `speaker`: a capture / playback PCM device exists (`/proc/asound/pcm`); `stt` / `tts`: the models are
 * there and run. `voices` (0.105, CT-614): the voices `tts` can speak with, its default first; absent (services before
 * 0.105): only its one voice, and no `voice` in a request.
 */
export const VoiceHealth = z.object({
  v: V,
  stt: z.boolean(),
  tts: z.boolean(),
  microphone: z.boolean(),
  speaker: z.boolean(),
  voices: z.array(VoiceName).max(32).optional(),
  /**
   * 3.1: the speech-to-text models that are downloaded and run; `stt` is true when one is. Absent: none is (or a
   * service from before 3.1; a box with the models socket has a 3.1 service).
   */
  models: z.array(VoiceSttModel).max(8).optional(),
  /** 3.1: the graphics chip Whisper runs on; absent when there is none the service can use. */
  gpu: VoiceGpu.optional(),
  /** 3.4: the languages `tts` speaks, English first; absent (a service before 3.4): English only, no `language`. */
  languages: z.array(VoiceSpeechLanguage).max(8).optional(),
});
export type VoiceHealth = z.infer<typeof VoiceHealth>;

/** A question as heard by the screen: `DeskWav` (16 kHz mono 16-bit, at most 30 s). */
export const VoiceSttRequest = z.strictObject({
  v: V,
  audioWav: DeskWav,
  prompt: deskTextSchema(VOICE_PROMPT_MAX).optional(),
  /** 3.1: the person's voice typing settings; absent: `auto`. Only to a 3.1 service (the box has the models socket). */
  model: VoiceModelChoice.optional(),
  language: VoiceLanguage.optional(),
});
export type VoiceSttRequest = z.infer<typeof VoiceSttRequest>;

/**
 * What was said, on one line (the service joins segments with a space), empty when nothing was heard; `seconds` the
 * audio's length, rounded.
 */
export const VoiceSttAnswer = z.object({
  v: V,
  text: deskTextSchema(DESK_QUESTION_MAX, 0),
  seconds: z.number().int().min(0).max(30),
});
export type VoiceSttAnswer = z.infer<typeof VoiceSttAnswer>;

/**
 * `voice` (0.105, CT-614): one of the health's `voices`, else 400 `bad_request`; absent: the service's default.
 * `language` (3.4): one of the health's `languages`, else 400 `bad_request`; absent: English. Dutch is spoken in the
 * service's Dutch voice of the same kind as `voice`.
 */
export const VoiceTtsRequest = z.strictObject({
  v: V,
  text: deskTextSchema(VOICE_TTS_TEXT_MAX),
  voice: VoiceName.optional(),
  language: VoiceSpeechLanguage.optional(),
});
export type VoiceTtsRequest = z.infer<typeof VoiceTtsRequest>;

export const VoiceTtsAnswer = z.object({
  v: V,
  audioWav: z
    .string()
    .min(60)
    .max(VOICE_TTS_BASE64_MAX)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
});
export type VoiceTtsAnswer = z.infer<typeof VoiceTtsAnswer>;

/**
 * Voice typing (3.1): a recording of at most `VOICE_TYPING_MAX_SECONDS` (16 kHz mono 16-bit WAV, base64). `model`
 * `auto` is Whisper when it is downloaded and the service has a graphics chip for it, else Parakeet, else Whisper on the
 * processor; a model that isn't downloaded is 503 `unavailable`. `language` is Whisper's (`auto` lets it hear which);
 * Parakeet always hears it. `prompt` names what the person may say (Whisper only).
 */
export const VoiceTranscribeRequest = z.strictObject({
  v: V,
  audioWav: z
    .string()
    .min(60)
    .max(VOICE_TRANSCRIBE_BASE64_MAX)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  model: VoiceModelChoice,
  language: VoiceLanguage,
  prompt: deskTextSchema(VOICE_PROMPT_MAX).optional(),
});
export type VoiceTranscribeRequest = z.infer<typeof VoiceTranscribeRequest>;

/** The most parts a transcript comes in, each at most `VOICE_TEXT_PART_MAX` code points. */
export const VOICE_TEXT_PART_MAX = 1_000;
export const VOICE_TEXT_PARTS_MAX = VOICE_TYPING_TEXT_MAX / VOICE_TEXT_PART_MAX;

/**
 * What was said, on one line without control characters, in `parts` cut at spaces (a string pattern counts to 1000 in
 * Go): joined with a space they are the text, no parts when nothing was heard. `seconds` the recording's length,
 * rounded; `model` the one that heard it and `gpu` whether it ran on the graphics chip.
 */
export const VoiceTranscribeAnswer = z.object({
  v: V,
  parts: z.array(deskTextSchema(VOICE_TEXT_PART_MAX, 0)).max(VOICE_TEXT_PARTS_MAX),
  seconds: z.number().int().min(0).max(VOICE_TYPING_MAX_SECONDS),
  model: VoiceSttModel,
  gpu: z.boolean(),
});
export type VoiceTranscribeAnswer = z.infer<typeof VoiceTranscribeAnswer>;
