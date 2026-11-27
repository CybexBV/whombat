/**
 * Talk on the desk (DK-06; appliance CG-44, CG-359): type or dictate (`dictation.ts`), the question goes to Whombat,
 * the page follows the talk until it is answered or failed. A small state machine the screen dispatches into, and the view of
 * it with the runtime's `DeskTalk`. One talk at a time, as Whombat does it. Since 0.116 (TF-16, CG-283) a talk past
 * 90 s is `working`: not final, the page keeps following it (“Neo is working on it…”) until it is answered, or failed
 * after 30 minutes.
 */

import { english, localized, type Translate } from '../i18n/translate';
import type { DeskServer, DeskTalk } from './desk';
import { deskCopy, deskWordsCopy, fill } from './deskCopy';

export type TalkError = 'busy' | 'off' | 'failed' | 'locked';

export type TalkUi =
  | { phase: 'ready' }
  | { phase: 'sending'; typed: string | null }
  /**
   * `since` (Whombat's clock, ms): a talk the page follows without a question of its own (the words after a decision,
   * DK-63), from when; its line goes once the assistant says something newer (TF-16).
   */
  | { phase: 'waiting'; id: string; typed: string | null; since?: number }
  | { phase: 'done'; id: string; typed: string | null; since?: number }
  | { phase: 'error'; error: TalkError; typed: string | null };

export type TalkEvent =
  /** A question was sent: typed, or the words Talk's mic heard (CG-359). */
  | { type: 'type'; text: string }
  | { type: 'sent'; id: string }
  /** Whombat refused the talk: its HTTP status and code. */
  | { type: 'refused'; status: number; code: string | null }
  /** The request didn't reach Whombat. */
  | { type: 'netFailed' }
  /** Whombat's latest view of the talk (from `/api/state` or `talk/get`). */
  | { type: 'update'; talk: DeskTalk }
  /**
   * A reloaded page picks up a talk that is still going; or, with `at` (Whombat's clock, ms), the assistant's words
   * after a decision (DK-63).
   */
  | { type: 'resume'; id: string; at?: number }
  /**
   * Whombat no longer knows the talk it follows (`talk/get` 404: it was kept as long as Whombat keeps talks): the page
   * stops following it; what was said is in the conversation (CG-283).
   */
  | { type: 'lost'; id: string }
  | { type: 'reset' };

export const TALK_READY: TalkUi = { phase: 'ready' };

const settled = (t: DeskTalk) => t.state === 'answered' || t.state === 'failed';

/** Whether a new question may start now (one at a time). */
export const canAsk = (s: TalkUi) => s.phase === 'ready' || s.phase === 'done' || s.phase === 'error';

/**
 * Talk is in use: sending, thinking or working (waiting for the answer, TF-18) or saying the answer out loud
 * (`speaking`); the mic recording is the page's too (`dictating`). The screen never goes idle meanwhile, and the idle
 * time counts from when it ends (DK-71, CG-172).
 */
export const talkBusy = (s: TalkUi, speaking: boolean): boolean =>
  speaking || s.phase === 'sending' || s.phase === 'waiting';

export function talkReducer(s: TalkUi, e: TalkEvent): TalkUi {
  switch (e.type) {
    case 'type': {
      const text = e.text.trim();
      return canAsk(s) && text ? { phase: 'sending', typed: text } : s;
    }
    case 'sent':
      return s.phase === 'sending' ? { phase: 'waiting', id: e.id, typed: s.typed } : s;
    case 'refused': {
      if (s.phase !== 'sending') return s;
      const error: TalkError =
        e.status === 409 && e.code === 'locked'
          ? 'locked'
          : e.status === 503
            ? 'off'
            : e.status === 409 && e.code === 'busy'
              ? 'busy'
              : 'failed';
      return { phase: 'error', error, typed: s.typed };
    }
    case 'netFailed':
      return s.phase === 'sending' ? { phase: 'error', error: 'failed', typed: s.typed } : s;
    case 'update':
      return s.phase === 'waiting' && e.talk.id === s.id && settled(e.talk) ? { ...s, phase: 'done' } : s;
    case 'resume':
      return canAsk(s)
        ? { phase: 'waiting', id: e.id, typed: null, ...(e.at === undefined ? {} : { since: e.at }) }
        : s;
    case 'lost':
      return s.phase === 'waiting' && s.id === e.id ? TALK_READY : s;
    case 'reset':
      return TALK_READY;
  }
}

/** The talk id the page follows, if any. */
export const talkId = (s: TalkUi): string | null =>
  s.phase === 'waiting' || s.phase === 'done' ? s.id : null;

export type TalkAnswer =
  | { kind: 'prompt'; text: string }
  /** Thinking…, or “Neo is working on it…” past 90 s (TF-16). */
  | { kind: 'thinking'; text: string }
  | { kind: 'answer'; text: string }
  /** `slow`: no answer in time, still working (the conversation's working row says it better, CG-285). */
  | { kind: 'error'; text: string; slow?: boolean };

export interface TalkView {
  /** Under “You asked”. */
  question: string | null;
  answer: TalkAnswer | null;
  thing: DeskServer | null;
  /** Whombat has the answer as speech. */
  audio: boolean;
}

const errorTextCopy = localized(
  (t): Record<Exclude<TalkError, 'locked'>, string> => ({
    busy: deskCopy(t).talkBusy,
    off: deskWordsCopy(t).voiceUnavailable,
    failed: deskWordsCopy(t).talkFailed,
  }),
);

/** The talk the page follows that has its answer (or failed): the thread changed then too (CG-54). */
export const settledId = (s: TalkUi): string | null => (s.phase === 'done' ? s.id : null);

/**
 * What Talk shows for the page's state and Whombat's talk (`talk` is the one with the followed id, if any). Without
 * `voice` (Talk off, no microphone or no speech here) typing still asks (DK-T12): at rest it says so (CG-53).
 */
export function talkView(
  s: TalkUi,
  talk: DeskTalk | null,
  assistant: string,
  voice = true,
  t: Translate = english,
): TalkView {
  const DESK = deskCopy(t);
  const DESK_WORDS = deskWordsCopy(t);
  const thinking = thinkingCopy(t);
  const ERROR_TEXT = errorTextCopy(t);

  const none = { thing: null, audio: false };
  switch (s.phase) {
    case 'ready':
      return {
        question: null,
        answer: voice
          ? { kind: 'prompt', text: DESK.talkPrompt }
          : { kind: 'error', text: DESK_WORDS.voiceUnavailable },
        ...none,
      };
    case 'sending':
      return { question: s.typed, answer: thinking, ...none };
    case 'error':
      return {
        question: s.typed,
        answer: s.error === 'locked' ? null : { kind: 'error', text: ERROR_TEXT[s.error] },
        ...none,
      };
    case 'waiting':
    case 'done': {
      const current = talk && talk.id === s.id ? talk : null;
      const question = current?.question ?? s.typed;
      if (!current || current.state === 'transcribing' || current.state === 'thinking') {
        return { question, answer: thinking, ...none };
      }
      if (current.state === 'working') {
        return {
          question,
          answer: { kind: 'thinking', text: fill(DESK_WORDS.working, { assistant }) },
          ...none,
        };
      }
      if (current.state === 'failed') {
        return {
          question,
          answer: {
            kind: 'error',
            text: failedText(current, assistant, t),
            ...(current.reason === 'slow' && { slow: true }),
          },
          ...none,
        };
      }
      return {
        question,
        answer: { kind: 'answer', text: current.answer ?? '' },
        thing: current.thing,
        audio: current.audio,
      };
    }
  }
}

const thinkingCopy = localized((t): TalkAnswer => ({ kind: 'thinking', text: deskWordsCopy(t).thinking }));

function failedText(talk: DeskTalk, assistant: string, t: Translate = english): string {
  const DESK_WORDS = deskWordsCopy(t);

  switch (talk.reason) {
    case 'not_heard':
      return DESK_WORDS.notHeard;
    case 'slow':
      return fill(DESK_WORDS.slow, { assistant });
    case 'voice_unavailable':
      return DESK_WORDS.voiceUnavailable;
    default:
      return DESK_WORDS.talkFailed;
  }
}
