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
  type VoiceDutchVoice,
  type VoiceLanguage,
  type VoiceModelChoice,
  type VoiceModelState,
  type VoiceSttModel,
  type VoiceTyping,
  type VoiceTypingModel,
  voiceWords,
} from '@whombat/core/domain';
import { VOICE_IN_USE } from '@whombat/protocol/session';
import { clientTree } from '../i18n/catalog';
import { SETTINGS_AREA_WORDS } from '../i18n/messages/chatWork/settings';
import { OperationError } from '../session/managed-ops';
import { ConnectError } from '../session/wire';
import type { VoiceTypingProblem } from './controller';

/** `{name}`, `{percent}`, `{time}` in a `VOICE_WORDS` sentence. */
export function fillVoiceWords(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));
}

/** Every word of voice typing: `VOICE_WORDS`, and what only the composer and the settings' failures need, in a locale. */
export function voiceText(locale?: string | null) {
  const shared = voiceWords(locale);
  const w = clientTree(locale, SETTINGS_AREA_WORDS).voice;
  return {
    ...shared,
    /** The section's label, as Settings' labels are written. */
    sectionLabel: shared.section.toUpperCase(),
    /** What a screen reader hears once when recording starts (the clock isn't read out every second). */
    recordingNow: w.recordingNow,
    errors: {
      ...shared.errors,
      /** The draft changed while the person spoke: the words were not put in. */
      changed: w.changed,
      /** Another composer records now. */
      elsewhere: w.elsewhere,
      /** The microphone stopped, or the app went to the background. */
      interrupted: w.interrupted,
      /** *Remove* for a model the settings use (`in_use`). */
      inUse: w.inUse,
      /** The box doesn't have this voice setting yet (`unknown_op`). */
      needsUpdate: w.needsUpdate,
      /** The box answered without keeping the change. */
      notSaved: w.notSaved,
      /** Any other refusal of a setting. */
      setting: w.setting,
    },
  };
}

export const VOICE_TEXT = voiceText();

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
export function recordingLabel(seconds: number, locale?: string | null): string {
  return fillVoiceWords(voiceText(locale).composer.recording, { time: formatRecordingTime(seconds) });
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
export function voiceProblemText(problem: VoiceTypingProblem, locale?: string | null): string {
  return voiceText(locale).errors[problem];
}

/** A refused setting, *Download*, *Try again* or *Remove* in words. */
export function voiceSettingErrorText(error: unknown, locale?: string | null): string {
  const text = voiceText(locale);
  if (detailsCode(error) === VOICE_IN_USE) return text.errors.inUse;
  if (error instanceof ConnectError) return text.errors.offline;
  if (error instanceof OperationError) {
    if (error.code === 'unknown_op') return text.errors.needsUpdate;
    if (OFFLINE_CODES.has(error.code)) return text.errors.offline;
  }
  return text.errors.setting;
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
  removing: 'warn',
  failed: 'bad',
  absent: 'mut',
};

export function voiceModelRow(model: VoiceTypingModel, locale?: string | null): VoiceModelRow {
  const text = voiceText(locale);
  const words = text.models[model.id];
  const progress =
    model.state === 'downloading' && model.size > 0 ? Math.min(1, model.received / model.size) : null;
  const status =
    model.state === 'downloading'
      ? fillVoiceWords(text.states.downloading, { percent: Math.floor((progress ?? 0) * 100) })
      : text.states[model.state];
  const action: VoiceModelRow['action'] =
    model.state === 'absent'
      ? { kind: 'download', label: text.actions.download }
      : model.state === 'failed'
        ? { kind: 'retry', label: text.actions.retry }
        : model.state === 'ready' && !model.inUse
          ? { kind: 'remove', label: text.actions.remove }
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
    problem: shownProblem && model.problem ? text.problems[model.problem] : null,
    action,
  };
}

export function voiceDutchRow(dutch: VoiceDutchVoice, locale?: string | null): VoiceDutchRow {
  const text = voiceText(locale);
  const size = formatModelSize(dutch.size);
  const progress =
    dutch.on && dutch.state === 'downloading' && dutch.size > 0
      ? Math.min(1, dutch.received / dutch.size)
      : null;
  const status =
    dutch.state === 'removing'
      ? text.dutchVoice.removing
      : dutch.state === 'downloading'
        ? fillVoiceWords(text.states.downloading, { percent: Math.floor((progress ?? 0) * 100) })
        : text.states[dutch.state];
  const shownProblem = dutch.on && (dutch.state === 'waiting' || dutch.state === 'failed');
  return {
    title: text.dutchVoice.label,
    meta: fillVoiceWords(text.dutchVoice.meta, { size }),
    on: dutch.on,
    size,
    state: dutch.state,
    status,
    tone: TONES[dutch.state],
    progress,
    problem: shownProblem && dutch.problem ? text.problems[dutch.problem] : null,
    retryLabel: dutch.on && dutch.state === 'failed' ? text.actions.retry : null,
    licenceVersion: DUTCH_VOICE_LICENCE_VERSION,
    licenceUrl: DUTCH_VOICE_LICENCE_URL,
    dialog: {
      title: text.dutchVoice.dialog.title,
      intro: fillVoiceWords(text.dutchVoice.dialog.intro, { size }),
      restrictions: text.dutchVoice.dialog.restrictions,
      licenceLink: text.dutchVoice.dialog.licenceLink,
      agree: text.dutchVoice.dialog.agree,
      cancel: text.dutchVoice.dialog.cancel,
    },
  };
}

/** The section's rows, from `voice.get`. */
export function voiceSectionView(voice: VoiceTyping, locale?: string | null): VoiceSectionView {
  const text = voiceText(locale);
  const usesShown = voice.uses !== null && (voice.model === 'auto' || voice.uses !== voice.model);
  return {
    on: { title: text.on.label, meta: text.on.meta, on: voice.on },
    model: {
      title: text.model.label,
      options: VOICE_MODEL_CHOICES.map((value) => ({ value, label: text.model.choices[value] })),
      value: voice.model,
      uses: usesShown && voice.uses ? text.model.uses[voice.uses] : null,
      warning: voice.model === 'whisper' && voice.gpu === null ? text.model.slow : null,
    },
    language: {
      title: text.language.label,
      options: VOICE_LANGUAGES.map((value) => ({ value, label: text.language.choices[value] })),
      value: voice.language,
    },
    models: { title: text.models.label, rows: voice.models.map((m) => voiceModelRow(m, locale)) },
    dutchVoice: voice.dutchVoice ? voiceDutchRow(voice.dutchVoice, locale) : null,
    gpu: voice.gpu ? fillVoiceWords(text.gpu.found, { name: voice.gpu.name }) : text.gpu.none,
  };
}
