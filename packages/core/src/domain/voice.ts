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

/** The words of voice typing, the same on the web and the phone (concise-replies.md: plain, short). */
export const VOICE_WORDS = {
  section: 'Voice typing',
  on: {
    label: 'Voice typing',
    meta: 'Speak instead of typing. This Whombat turns what you say into text, and the recording never leaves it.',
  },
  model: {
    label: 'Speech model',
    choices: { auto: 'Automatic', parakeet: 'Fast', whisper: 'Most accurate' },
    /** Under the choice: what a recording goes to now. */
    uses: { parakeet: 'Uses Fast now', whisper: 'Uses Most accurate now' },
    /** Most accurate chosen on a box without a graphics chip. */
    slow: 'Without a graphics chip this takes about as long as you spoke.',
  },
  language: { label: 'Language', choices: { auto: 'Automatic', en: 'English', nl: 'Nederlands' } },
  models: {
    label: 'Speech models',
    parakeet: { name: 'Fast', about: 'Parakeet. Quick on the processor, English and Dutch.' },
    whisper: { name: 'Most accurate', about: 'Whisper. Best with Dutch, quick with a graphics chip.' },
  },
  dutchVoice: {
    label: 'Dutch voice',
    meta: 'Speak Dutch answers in a Dutch voice instead of an English one (Supertonic 3, {size}).',
    removing: 'Still removing the Dutch voice.',
    dialog: {
      title: 'Download the Dutch voice?',
      intro:
        'Whombat downloads Supertonic 3 ({size}) onto this Whombat. It uses the BigScience Open RAIL-M licence, which allows personal and business use with a few restrictions. By turning this on, you agree not to use it:',
      restrictions: [
        'to break the law, harm minors, harass or defame others, or spread harmful falsehoods or personal data;',
        'to impersonate someone without their consent, or publish generated audio without saying it is AI-generated;',
        'for discrimination, exploiting vulnerable groups, automated legal decisions, justice or immigration profiling, or medical advice.',
      ],
      licenceLink: 'Read the full Open RAIL-M licence',
      agree: 'Agree and download',
      cancel: 'Cancel',
    },
  },
  states: {
    absent: 'Not downloaded',
    downloading: 'Downloading · {percent}%',
    waiting: 'Waiting to download',
    ready: 'Ready',
    failed: 'Couldn’t download',
    removing: 'Removing…',
  },
  problems: {
    no_network: 'No internet right now. It tries again by itself.',
    no_room: 'Not enough room on this Whombat.',
    bad_download: 'The download was damaged.',
    failed: 'Something went wrong.',
  },
  actions: { download: 'Download', remove: 'Remove', retry: 'Try again' },
  gpu: {
    found: 'Graphics chip: {name}',
    none: 'No graphics chip found, so speech runs on the processor.',
  },
  composer: {
    dictate: 'Dictate',
    cancel: 'Cancel',
    done: 'Done',
    preparing: 'Starting…',
    recording: 'Recording {time}',
    transcribing: 'Turning speech into text…',
  },
  errors: {
    dictation_off: 'Voice typing is off. You can turn it on in Settings.',
    not_ready: 'Voice typing is still downloading its speech model.',
    busy: 'This Whombat is busy with another recording. Try again in a moment.',
    bad_audio: 'That recording didn’t work. Try again.',
    too_long: 'That was longer than 5 minutes. Try a shorter one.',
    failed: 'Couldn’t turn that into text. Try again.',
    microphone: 'Allow the microphone to use voice typing.',
    nothing: 'Nothing was heard.',
    offline: 'Can’t reach your Whombat right now.',
  },
} as const;
