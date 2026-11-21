/**
 * Talk's mic is voice typing (Whombat dictation.md; CG-359…CG-364): tap the mic, speak, *Done*, and the box turns the
 * recording into text that goes into Talk's box, where the person reads it, may change it and sends it. *Cancel* drops
 * it. The composers' recording bar at the desk's size: “Recording 0:12”, then “Turning speech into text…”; a failure
 * shows on the mic's line for five seconds. A small state machine and the helpers the screen draws it with.
 */
import { DESK, DESK_WORDS } from './deskCopy';

/** Voice typing's five minutes (`VOICE_TYPING_MAX_SECONDS`): *Done* happens by itself then. */
export const MAX_HEAR_SECONDS = 300;
/** The longest question sent, typed or heard (`DESK_TALK_TEXT_MAX`). */
export const MAX_TALK_TEXT = 1000;
/** A failure stays on the mic's line this long. */
export const DICTATION_ERROR_MS = 5000;
/** Shorter than this is a tap on the mic, not something said. */
export const MIN_HEAR_SECONDS = 0.2;

export type DictationError = 'microphone' | 'off' | 'nothing' | 'busy' | 'badAudio' | 'tooLong' | 'failed';

export type Dictation =
  /** At rest; `error` (since `at`, the page's clock) shows on the mic's line for a while. */
  | { phase: 'idle'; error?: DictationError; at?: number }
  /** Tapped: the microphone is opening (“Starting…”). */
  | { phase: 'preparing' }
  /** Recording since `since` (the page's clock, ms). */
  | { phase: 'recording'; since: number }
  /** *Done*: the box turns it into text. */
  | { phase: 'transcribing' };

export type DictationEvent =
  | { type: 'start' }
  | { type: 'open'; at: number }
  | { type: 'done' }
  | { type: 'heard' }
  | { type: 'failed'; error: DictationError; at: number }
  | { type: 'cancel' };

export const DICTATION_IDLE: Dictation = { phase: 'idle' };

export function dictationReducer(s: Dictation, e: DictationEvent): Dictation {
  switch (e.type) {
    case 'start':
      return s.phase === 'idle' ? { phase: 'preparing' } : s;
    case 'open':
      return s.phase === 'preparing' ? { phase: 'recording', since: e.at } : s;
    case 'done':
      return s.phase === 'recording'
        ? { phase: 'transcribing' }
        : s.phase === 'preparing'
          ? DICTATION_IDLE
          : s;
    case 'heard':
      return s.phase === 'transcribing' ? DICTATION_IDLE : s;
    case 'failed':
      return s.phase === 'idle' && !s.error ? s : { phase: 'idle', error: e.error, at: e.at };
    case 'cancel':
      return s.phase === 'idle' ? s : DICTATION_IDLE;
  }
}

/** The mic is in use: recording or turning it into text (the bar shows, the screen stays awake). */
export const dictating = (s: Dictation): boolean => s.phase !== 'idle';

/** “0:12”, “4:59”: minutes and seconds recorded so far. */
export function recordingTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** What the bar says now; null at rest. */
export function dictationLabel(s: Dictation, now: number): string | null {
  const w = DESK_WORDS.dictation;
  switch (s.phase) {
    case 'idle':
      return null;
    case 'preparing':
      return w.preparing;
    case 'recording':
      return w.recording.replace('{time}', recordingTime(now - s.since));
    case 'transcribing':
      return w.transcribing;
  }
}

const ERROR_TEXT: Record<DictationError, string> = {
  microphone: DESK.talkMicrophone,
  off: DESK_WORDS.voiceUnavailable,
  nothing: DESK_WORDS.dictation.nothing,
  busy: DESK_WORDS.dictation.busy,
  badAudio: DESK_WORDS.dictation.badAudio,
  tooLong: DESK_WORDS.dictation.tooLong,
  failed: DESK_WORDS.dictation.failed,
};

/** The failure the mic's line shows now, for five seconds after it happened; null otherwise. */
export function dictationNotice(s: Dictation, now: number): string | null {
  if (s.phase !== 'idle' || !s.error || s.at === undefined) return null;
  return now - s.at < DICTATION_ERROR_MS ? ERROR_TEXT[s.error] : null;
}

/** The runtime's refusal of `hear` as the screen says it; `locked` is none (the screen locked: the state shows it). */
export function hearRefusal(status: number, code: string | null): DictationError | null {
  if (status === 409 && code === 'locked') return null;
  if (status === 409 && code === 'busy') return 'busy';
  if (status === 503 && code === 'voice_unavailable') return 'off';
  if (status === 400 && code === 'bad_audio') return 'badAudio';
  if (status === 413) return 'tooLong';
  return 'failed';
}

/** What the runtime heard (`DeskHeard.text`): one line, or null when the answer isn't one. */
export function parseHeard(body: unknown): string | null {
  const text = (body as { text?: unknown } | null)?.text;
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : null;
}

/** The words go at the end of what the box holds, with a space between, at most `MAX_TALK_TEXT` characters. */
export function withHeard(draft: string | null, heard: string): string {
  const before = draft?.trimEnd() ?? '';
  const text = before ? `${before} ${heard}` : heard;
  return [...text].slice(0, MAX_TALK_TEXT).join('');
}

/**
 * How long the page waits for the words: as long as the box may take (three times the recording, at least 90 s,
 * behind others in its queue) and a little more.
 */
export function hearTimeoutMs(seconds: number): number {
  return Math.max(90_000, Math.ceil(seconds * 3) * 1000) + 20_000;
}
