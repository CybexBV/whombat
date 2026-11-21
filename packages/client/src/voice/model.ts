/**
 * Voice typing as the person sees it (docs/decisions/dictation.md DT-01, DT-03, DT-04, DT-06, DT-12): what Settings →
 * This Whombat → VOICE TYPING shows, whether a composer has a mic, the recording bar's words and every failure in
 * words. The words are `@whombat/core/domain`'s `VOICE_WORDS`, the same on the web and the phone, plus the few only
 * the composer needs. Pure.
 */
import {
  DICTATION_ERROR_CODES,
  DUTCH_VOICE_LICENCE_URL,
  DUTCH_VOICE_LICENCE_VERSION,
  VOICE_LANGUAGES,
  VOICE_MODEL_CHOICES,
  VOICE_WORDS,
  type VoiceDutchVoice,
  type VoiceLanguage,
  type VoiceModelChoice,
  type VoiceModelState,
  type VoiceSttModel,
  type VoiceTyping,
  type VoiceTypingModel,
} from '@whombat/core/domain';
import { VOICE_IN_USE } from '@whombat/protocol/session';
import { OperationError } from '../session/managed-ops';
import { ConnectError } from '../session/wire';
import type { VoiceTypingProblem } from './controller';

/** `{name}`, `{percent}`, `{time}` in a `VOICE_WORDS` sentence. */
export function fillVoiceWords(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));
}

/** Every word of voice typing: `VOICE_WORDS`, and what only the composer and the settings' failures need. */
export const VOICE_TEXT = {
  ...VOICE_WORDS,
  /** The section's label, as Settings' labels are written. */
  sectionLabel: VOICE_WORDS.section.toUpperCase(),
  /** What a screen reader hears once when recording starts (the clock isn't read out every second). */
  recordingNow: 'Recording',
  errors: {
    ...VOICE_WORDS.errors,
    /** The draft changed while the person spoke: the words were not put in (DT-08). */
    changed: 'The message changed while you spoke, so the words weren’t added.',
    /** Another composer records now. */
    elsewhere: 'Voice typing is already recording somewhere else.',
    /** The microphone stopped, or the app went to the background. */
    interrupted: 'The recording stopped. Try again.',
    /** *Remove* for a model the settings use (`in_use`). */
    inUse: 'The settings use this model, so it stays.',
    /** Any other refusal of a setting. */
    setting: 'That didn’t go through. Try again.',
  },
} as const;

/* The composer's mic --------------------------------------------------------------------------------------------------- */

/**
 * The mic in a composer: none (`hidden`: no answer, an older box, `available` false, or voice typing off), one that
 * records (`ready`), or one that says the model is still downloading (`not_ready`).
 */
export type VoiceMic = 'hidden' | 'ready' | 'not_ready';

export function voiceMicOf(voice: VoiceTyping | null | undefined): VoiceMic {
  if (!voice?.available || !voice.on) return 'hidden';
  return voice.ready ? 'ready' : 'not_ready';
}

/** `0:12`, `4:59`. */
export function formatRecordingTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** “Recording 0:12”. */
export function recordingLabel(seconds: number): string {
  return fillVoiceWords(VOICE_TEXT.composer.recording, { time: formatRecordingTime(seconds) });
}

/** How long errors stay in the composer before it is quiet again. */
export const VOICE_ERROR_SHOWN_MS = 5_000;

/** How many bars the recording bar's waveform keeps (about three seconds of sound). */
export const VOICE_LEVELS = 64;

/** The last `VOICE_LEVELS` loudnesses with `level` at the end. */
export function pushVoiceLevel(levels: readonly number[], level: number, keep = VOICE_LEVELS): number[] {
  const next = levels.length >= keep ? levels.slice(levels.length - keep + 1) : levels.slice();
  next.push(Math.max(0, Math.min(1, level)));
  return next;
}

const DICTATION_CODES = new Set<string>(DICTATION_ERROR_CODES);
const OFFLINE_CODES = new Set(['lost', 'offline', 'closed', 'unavailable', 'timeout']);

function detailsCode(error: unknown): string | null {
  const code = (error as { details?: { code?: unknown } } | null)?.details?.code;
  return typeof code === 'string' ? code : null;
}

/** What a failed recording was, in the controller's terms: the box's code, no connection, or `failed`. */
export function voiceTypingProblemOf(error: unknown): VoiceTypingProblem {
  const code = detailsCode(error);
  if (code && DICTATION_CODES.has(code)) return code as VoiceTypingProblem;
  if (error instanceof ConnectError) return 'offline';
  const name = (error as { code?: unknown } | null)?.code;
  if (typeof name === 'string' && OFFLINE_CODES.has(name)) return 'offline';
  return 'failed';
}

/** A problem in words. */
export function voiceProblemText(problem: VoiceTypingProblem): string {
  return VOICE_TEXT.errors[problem];
}

/** A refused setting, *Download*, *Try again* or *Remove* in words. */
export function voiceSettingErrorText(error: unknown): string {
  if (detailsCode(error) === VOICE_IN_USE) return VOICE_TEXT.errors.inUse;
  if (error instanceof ConnectError) return VOICE_TEXT.errors.offline;
  if (error instanceof OperationError && OFFLINE_CODES.has(error.code)) return VOICE_TEXT.errors.offline;
  return VOICE_TEXT.errors.setting;
}

/* Settings → This Whombat → VOICE TYPING ------------------------------------------------------------------------------- */

export interface VoiceChoice<T extends string> {
  value: T;
  label: string;
}

/** A model's row: its name, what it is for, its size, its state and the one thing to do about it. */
export interface VoiceModelRow {
  id: VoiceSttModel;
  name: string;
  about: string;
  /** “669 MB”. */
  size: string;
  state: VoiceModelState;
  /** “Ready”, “Downloading · 40%”, “Waiting to download”, “Couldn’t download”, “Not downloaded”. */
  status: string;
  /** The status dot: ready, under way, needs you, nothing yet. */
  tone: 'ok' | 'warn' | 'bad' | 'mut';
  /** 0…1 while downloading, else null. */
  progress: number | null;
  /** Why it waits or failed. */
  problem: string | null;
  /** *Download*, *Try again*, *Remove* (not while the settings use it), or nothing while it downloads. */
  action: { kind: 'download' | 'retry' | 'remove'; label: string } | null;
}

/** The opt-in Dutch voice switch row and its licence agreement dialog copy. */
export interface VoiceDutchRow {
  title: string;
  meta: string;
  on: boolean;
  /** “145 MB”. */
  size: string;
  state: VoiceModelState;
  status: string;
  tone: 'ok' | 'warn' | 'bad' | 'mut';
  progress: number | null;
  problem: string | null;
  /** *Try again* when on and the download failed; otherwise null. */
  retryLabel: string | null;
  licenceVersion: typeof DUTCH_VOICE_LICENCE_VERSION;
  licenceUrl: string;
  dialog: {
    title: string;
    intro: string;
    restrictions: readonly string[];
    licenceLink: string;
    agree: string;
    cancel: string;
  };
}

export interface VoiceSectionView {
  on: { title: string; meta: string; on: boolean };
  model: {
    title: string;
    options: VoiceChoice<VoiceModelChoice>[];
    value: VoiceModelChoice;
    /** “Uses Fast now”, where it says more than the choice. */
    uses: string | null;
    /** Most accurate without a graphics chip: slow. */
    warning: string | null;
  };
  language: { title: string; options: VoiceChoice<VoiceLanguage>[]; value: VoiceLanguage };
  models: { title: string; rows: VoiceModelRow[] };
  /** Opt-in Dutch speaking voice (Supertonic 3), or null when the box doesn't offer it. */
  dutchVoice: VoiceDutchRow | null;
  /** The graphics chip line. */
  gpu: string;
}

/** Whether This Whombat shows VOICE TYPING: only where the box has the speech service. */
export function voiceSectionShown(voice: VoiceTyping | null | undefined): voice is VoiceTyping {
  return voice?.available === true;
}

/** Bytes as whole MB, as the models' sizes are given (669 MB). */
export function formatModelSize(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}

const TONES: Record<VoiceModelState, VoiceModelRow['tone']> = {
  ready: 'ok',
  downloading: 'warn',
  waiting: 'warn',
  failed: 'bad',
  absent: 'mut',
};

export function voiceModelRow(model: VoiceTypingModel): VoiceModelRow {
  const words = VOICE_TEXT.models[model.id];
  const progress =
    model.state === 'downloading' && model.size > 0 ? Math.min(1, model.received / model.size) : null;
  const status =
    model.state === 'downloading'
      ? fillVoiceWords(VOICE_TEXT.states.downloading, { percent: Math.floor((progress ?? 0) * 100) })
      : VOICE_TEXT.states[model.state];
  const action: VoiceModelRow['action'] =
    model.state === 'absent'
      ? { kind: 'download', label: VOICE_TEXT.actions.download }
      : model.state === 'failed'
        ? { kind: 'retry', label: VOICE_TEXT.actions.retry }
        : model.state === 'ready' && !model.inUse
          ? { kind: 'remove', label: VOICE_TEXT.actions.remove }
          : null;
  const shownProblem = model.state === 'waiting' || model.state === 'failed';
  return {
    id: model.id,
    name: words.name,
    about: words.about,
    size: formatModelSize(model.size),
    state: model.state,
    status,
    tone: TONES[model.state],
    progress,
    problem: shownProblem && model.problem ? VOICE_TEXT.problems[model.problem] : null,
    action,
  };
}

export function voiceDutchRow(dutch: VoiceDutchVoice): VoiceDutchRow {
  const size = formatModelSize(dutch.size);
  const progress =
    dutch.on && dutch.state === 'downloading' && dutch.size > 0
      ? Math.min(1, dutch.received / dutch.size)
      : null;
  const status =
    dutch.state === 'downloading'
      ? fillVoiceWords(VOICE_TEXT.states.downloading, { percent: Math.floor((progress ?? 0) * 100) })
      : VOICE_TEXT.states[dutch.state];
  const shownProblem = dutch.on && (dutch.state === 'waiting' || dutch.state === 'failed');
  return {
    title: VOICE_TEXT.dutchVoice.label,
    meta: fillVoiceWords(VOICE_TEXT.dutchVoice.meta, { size }),
    on: dutch.on,
    size,
    state: dutch.state,
    status,
    tone: TONES[dutch.state],
    progress,
    problem: shownProblem && dutch.problem ? VOICE_TEXT.problems[dutch.problem] : null,
    retryLabel: dutch.on && dutch.state === 'failed' ? VOICE_TEXT.actions.retry : null,
    licenceVersion: DUTCH_VOICE_LICENCE_VERSION,
    licenceUrl: DUTCH_VOICE_LICENCE_URL,
    dialog: {
      title: VOICE_TEXT.dutchVoice.dialog.title,
      intro: fillVoiceWords(VOICE_TEXT.dutchVoice.dialog.intro, { size }),
      restrictions: VOICE_TEXT.dutchVoice.dialog.restrictions,
      licenceLink: VOICE_TEXT.dutchVoice.dialog.licenceLink,
      agree: VOICE_TEXT.dutchVoice.dialog.agree,
      cancel: VOICE_TEXT.dutchVoice.dialog.cancel,
    },
  };
}

/** The section's rows, from `voice.get`. */
export function voiceSectionView(voice: VoiceTyping): VoiceSectionView {
  const usesShown = voice.uses !== null && (voice.model === 'auto' || voice.uses !== voice.model);
  return {
    on: { title: VOICE_TEXT.on.label, meta: VOICE_TEXT.on.meta, on: voice.on },
    model: {
      title: VOICE_TEXT.model.label,
      options: VOICE_MODEL_CHOICES.map((value) => ({ value, label: VOICE_TEXT.model.choices[value] })),
      value: voice.model,
      uses: usesShown && voice.uses ? VOICE_TEXT.model.uses[voice.uses] : null,
      warning: voice.model === 'whisper' && voice.gpu === null ? VOICE_TEXT.model.slow : null,
    },
    language: {
      title: VOICE_TEXT.language.label,
      options: VOICE_LANGUAGES.map((value) => ({ value, label: VOICE_TEXT.language.choices[value] })),
      value: voice.language,
    },
    models: { title: VOICE_TEXT.models.label, rows: voice.models.map(voiceModelRow) },
    dutchVoice: voice.dutchVoice ? voiceDutchRow(voice.dutchVoice) : null,
    gpu: voice.gpu ? fillVoiceWords(VOICE_TEXT.gpu.found, { name: voice.gpu.name }) : VOICE_TEXT.gpu.none,
  };
}
