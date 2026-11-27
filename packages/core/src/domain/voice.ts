/**
 * Voice typing (contracts 3.1; docs/decisions/dictation.md): the person speaks instead of
 * typing in any composer, the box turns the recording into text with its own speech models, and the text goes into the
 * draft. Settings → This Whombat shows and changes it (`VoiceTyping`, session ops `voice.*`).
 *
 * Two models, downloaded by the box after it is installed (never in the image):
 * - `parakeet`: NVIDIA Parakeet TDT 0.6B v3 (CC-BY-4.0), fast on the processor, English and Dutch (it hears which);
 * - `whisper`: OpenAI Whisper large-v3-turbo (MIT), the most accurate, quick only on a graphics chip.
 * `auto` uses Whisper where the box has a graphics chip it can use and Parakeet everywhere else.
 */

import { z } from 'zod';
import { coreTranslator, coreTree } from '../i18n/catalog.js';

/** The speech-to-text models a box can download (`VoiceTypingModel.id`). */
export const VOICE_STT_MODELS = ['parakeet', 'whisper'] as const;
export const VoiceSttModel = z.enum(VOICE_STT_MODELS);
export type VoiceSttModel = z.infer<typeof VoiceSttModel>;

/** Every downloadable voice model on the box: speech-to-text and the opt-in Dutch voice (Supertonic 3). */
export const VOICE_DOWNLOAD_MODELS = ['parakeet', 'whisper', 'supertonic'] as const;
export const VoiceDownloadModel = z.enum(VOICE_DOWNLOAD_MODELS);
export type VoiceDownloadModel = z.infer<typeof VoiceDownloadModel>;

/**
 * Pinned total download sizes in bytes of each downloadable voice model
 * (`appliance/nix/packages/voice-models/default.nix`).
 */
export const VOICE_MODEL_SIZES: Readonly<Record<VoiceDownloadModel, number>> = {
  parakeet: 668_757_119,
  whisper: 574_041_195,
  supertonic: 145_310_775,
};

/** Supertonic 3's licence (BigScience Open RAIL-M, dated August 18, 2022), agreed to before download. */
export const DUTCH_VOICE_LICENCE_VERSION = 'open-rail-m-2022-08-18';
export const DUTCH_VOICE_LICENCE_NAME = 'BigScience Open RAIL-M License (August 18, 2022)';
export const DUTCH_VOICE_LICENCE_URL =
  'https://huggingface.co/Supertone/supertonic-3/blob/3cadd1ee6394adea1bd021217a0e650ede09a323/LICENSE';

/** *Speech model*: one of the models, or `auto` (Whisper on a usable graphics chip, else Parakeet). */
export const VOICE_MODEL_CHOICES = ['auto', 'parakeet', 'whisper'] as const;
export const VoiceModelChoice = z.enum(VOICE_MODEL_CHOICES);
export type VoiceModelChoice = z.infer<typeof VoiceModelChoice>;

/** *Language*: `auto` lets the model hear it; English and Dutch for now. Parakeet always hears it itself. */
export const VOICE_LANGUAGES = ['auto', 'en', 'nl'] as const;
export const VoiceLanguage = z.enum(VOICE_LANGUAGES);
export type VoiceLanguage = z.infer<typeof VoiceLanguage>;

/**
 * A model's download on the box: `absent` (not there), `downloading` (`received` of `size` bytes), `waiting` (it will try
 * again by itself, `problem` says why), `ready`, `failed` (needs *Try again*, `problem` says why), `removing` (files are
 * still being removed from disk; `received` is the bytes left).
 */
export const VOICE_MODEL_STATES = [
  'absent',
  'downloading',
  'waiting',
  'ready',
  'failed',
  'removing',
] as const;
export const VoiceModelState = z.enum(VOICE_MODEL_STATES);
export type VoiceModelState = z.infer<typeof VoiceModelState>;

/** Why a download waits or failed: no internet, not enough room, the file wasn't what was expected, anything else. */
export const VOICE_MODEL_PROBLEMS = ['no_network', 'no_room', 'bad_download', 'failed'] as const;
export const VoiceModelProblem = z.enum(VOICE_MODEL_PROBLEMS);
export type VoiceModelProblem = z.infer<typeof VoiceModelProblem>;

/** The longest recording, its WAV (16 kHz mono 16-bit with the 44-byte header) and the longest text it gives. */
export const VOICE_SAMPLE_RATE = 16_000;
export const VOICE_TYPING_MAX_SECONDS = 300;
export const VOICE_TYPING_MAX_BYTES = 44 + VOICE_TYPING_MAX_SECONDS * VOICE_SAMPLE_RATE * 2;
export const VOICE_TYPING_TEXT_MAX = 12_000;

/** One model as Settings shows it. `inUse`: the settings need it now, so there is no *Remove*. */
export const VoiceTypingModel = z.object({
  id: VoiceSttModel,
  state: VoiceModelState,
  /** Its download's size in bytes. */
  size: z.number().int().min(0),
  received: z.number().int().min(0),
  problem: VoiceModelProblem.optional(),
  inUse: z.boolean(),
});
export type VoiceTypingModel = z.infer<typeof VoiceTypingModel>;

/**
 * The opt-in Dutch speaking voice (Supertonic 3, BigScience Open RAIL-M): off until the person agrees to its licence,
 * then downloaded onto the box; turning it off removes its files.
 */
export const VoiceDutchVoice = z.object({
  /** Whether the person has turned *Dutch voice* on (agreed to its licence). */
  on: z.boolean(),
  /** Download state of the Dutch voice model on the box (`absent` when off and gone, `removing` while files remain). */
  state: VoiceModelState,
  /** Total download size in bytes across all files of the model. */
  size: z.number().int().min(0),
  /** Bytes downloaded so far, or bytes left on disk while removing. */
  received: z.number().int().min(0),
  /** Why a download waits or failed. */
  problem: VoiceModelProblem.optional(),
  /** When the person agreed to the licence (ISO timestamp), or null when off. */
  agreedAt: z.string().datetime().nullable(),
  /** The licence version agreed to, or null when off. */
  licenceVersion: z.string().min(1).max(64).nullable(),
});
export type VoiceDutchVoice = z.infer<typeof VoiceDutchVoice>;

/** `voice.get` and every `voice.*` change: voice typing and the opt-in Dutch voice as Settings and the composers see them. */
export const VoiceTyping = z.object({
  /** This Whombat can turn speech into text at all (it has the speech service); false: no mic, no section. */
  available: z.boolean(),
  /** *Voice typing* (on by default). */
  on: z.boolean(),
  model: VoiceModelChoice,
  language: VoiceLanguage,
  /** On, and a model it can use is downloaded: the composers' mic works. */
  ready: z.boolean(),
  /** The model a recording goes to now; null when none can. */
  uses: VoiceSttModel.nullable(),
  /** The graphics chip the box uses for Whisper; null when it has none it can use. */
  gpu: z.object({ name: z.string().regex(/^[\x20-\x7e]{1,200}$/) }).nullable(),
  models: z.array(VoiceTypingModel).max(8),
  /** The longest recording in seconds (`VOICE_TYPING_MAX_SECONDS`). */
  maxSeconds: z.number().int().min(1).max(VOICE_TYPING_MAX_SECONDS),
  /** Opt-in Dutch speaking voice (Supertonic 3); null or absent when the box doesn't offer it. */
  dutchVoice: VoiceDutchVoice.nullable().optional(),
});
export type VoiceTyping = z.infer<typeof VoiceTyping>;

/** `voice.update`: any of the settings; an empty patch changes nothing. */
export const VoiceTypingPatch = z.strictObject({
  on: z.boolean().optional(),
  model: VoiceModelChoice.optional(),
  language: VoiceLanguage.optional(),
});
export type VoiceTypingPatch = z.infer<typeof VoiceTypingPatch>;

/** `stream_done.output` of a `dictation` upload: what was said, on one line; empty when nothing was heard. */
export const DictationOutput = z.object({
  text: z.string().max(VOICE_TYPING_TEXT_MAX),
  seconds: z.number().int().min(0).max(VOICE_TYPING_MAX_SECONDS),
  model: VoiceSttModel,
});
export type DictationOutput = z.infer<typeof DictationOutput>;

/**
 * Why a recording wasn't turned into text, in `error.details.code` of the upload stream's `error`: voice typing is off,
 * no model is downloaded yet, the box is busy with others, the audio isn't a 16 kHz mono 16-bit WAV, it is longer than
 * five minutes, or the speech service failed.
 */
export const DICTATION_ERROR_CODES = [
  'dictation_off',
  'not_ready',
  'busy',
  'bad_audio',
  'too_long',
  'failed',
] as const;
export const DictationErrorCode = z.enum(DICTATION_ERROR_CODES);
export type DictationErrorCode = z.infer<typeof DictationErrorCode>;

const VOICE_WORDS_SHAPE = {
  section: 0,
  on: {
    label: 0,
    meta: 0,
  },
  model: {
    label: 0,
    choices: {
      auto: 0,
      parakeet: 0,
      whisper: 0,
    },
    /** Under the choice: what a recording goes to now. */
    uses: {
      parakeet: 0,
      whisper: 0,
    },
    /** Most accurate chosen on a box without a graphics chip. */
    slow: 0,
  },
  language: {
    label: 0,
    choices: {
      auto: 0,
      en: 0,
      nl: 0,
    },
  },
  models: {
    label: 0,
    parakeet: {
      name: 0,
      about: 0,
    },
    whisper: {
      name: 0,
      about: 0,
    },
  },
  dutchVoice: {
    label: 0,
    meta: 0,
    removing: 0,
    dialog: {
      title: 0,
      intro: 0,
      licenceLink: 0,
      agree: 0,
      cancel: 0,
    },
  },
  states: {
    absent: 0,
    downloading: 0,
    waiting: 0,
    ready: 0,
    failed: 0,
    removing: 0,
  },
  problems: {
    no_network: 0,
    no_room: 0,
    bad_download: 0,
    failed: 0,
  },
  actions: {
    download: 0,
    remove: 0,
    retry: 0,
  },
  gpu: {
    found: 0,
    none: 0,
  },
  composer: {
    dictate: 0,
    cancel: 0,
    done: 0,
    preparing: 0,
    recording: 0,
    transcribing: 0,
  },
  errors: {
    dictation_off: 0,
    not_ready: 0,
    busy: 0,
    bad_audio: 0,
    too_long: 0,
    failed: 0,
    microphone: 0,
    nothing: 0,
    offline: 0,
  },
} as const;

/** The words of voice typing, the same on the web and the phone (concise-replies.md: plain, short). */
export function voiceWords(locale?: string | null) {
  const tr = coreTranslator(locale);
  const words = coreTree(locale, 'voice', VOICE_WORDS_SHAPE);
  return {
    ...words,
    dutchVoice: {
      ...words.dutchVoice,
      dialog: {
        ...words.dutchVoice.dialog,
        restrictions: [
          tr.t('voice.dutchVoice.dialog.restriction.law'),
          tr.t('voice.dutchVoice.dialog.restriction.impersonate'),
          tr.t('voice.dutchVoice.dialog.restriction.discrimination'),
        ],
      },
    },
  };
}

export const VOICE_WORDS = voiceWords('en');
