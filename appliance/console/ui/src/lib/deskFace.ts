/**
 * What the desk's faces show (`@whombat/avatars`' live face): Talk's newest face follows the conversation, the glance's
 * faces doze while nobody's there and in quiet hours and say hello when someone is back, and a look's face says where
 * the assistant is with it. Pure: the page's state comes in as values.
 */
import type { FaceState } from '@whombat/avatars/motion';
import type { ConvoRow } from './conversation';
import type { DeskTalk } from './desk';
import type { DeskScene } from './deskScene';
import { type Dictation, dictationNotice } from './dictation';
import type { LookStage } from './needsYou';
import { type TalkUi, talkId } from './talk';

export interface TalkFaceInput {
  /** Talk's mic. */
  dictation: Dictation;
  /** The page's clock (ms): a failure of the mic shows for a while, and so does the face's apology. */
  pageNow: number;
  talk: TalkUi;
  /** Whombat's latest view of the talk the page follows. */
  followed: DeskTalk | null;
  /** The answer is being said out loud. */
  speaking: boolean;
  /** The assistant works in the open conversation. */
  convoWorking: boolean;
}

/**
 * Talk's face: listening while the mic records the person, thinking while the box turns it into words and while the
 * answer is awaited (working once the talk or the conversation says so), speaking while the answer is said out loud,
 * sorry after a failure, else idle. The person speaking wins: they can start the mic while an answer is awaited.
 */
export function talkFace(i: TalkFaceInput): FaceState {
  const mic = i.dictation.phase;
  if (mic === 'preparing' || mic === 'recording') return 'listening';
  if (mic === 'transcribing') return 'thinking';
  if (i.speaking) return 'speaking';
  const t = i.talk;
  const own = i.followed && i.followed.id === talkId(t) ? i.followed : null;
  if (t.phase === 'sending' || t.phase === 'waiting')
    return own?.state === 'working' || i.convoWorking ? 'working' : 'thinking';
  if (i.convoWorking) return 'working';
  if (t.phase === 'error' && t.error !== 'locked') return 'sorry';
  if (t.phase === 'done' && own?.state === 'failed') return 'sorry';
  if (dictationNotice(i.dictation, i.pageNow) !== null) return 'sorry';
  return 'idle';
}

/**
 * The row whose face shows what the assistant is doing: the newest face, that is the first row of the last run of the
 * assistant's rows (Talk draws a face once per run). -1 when the assistant hasn't said anything.
 */
export function liveFaceRow(rows: readonly ConvoRow[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]?.from === 'assistant' && rows[i - 1]?.from !== 'assistant') return i;
  }
  return -1;
}

/** The faces doze while nobody's there (the dimmed glance) and in quiet hours; Talk's never do. */
export const facesAsleep = (scene: DeskScene, quiet: boolean): boolean =>
  scene === 'idle' || (quiet && scene !== 'talk');

/**
 * What the glance's faces show when nothing else says: asleep, then welcome once they woke (someone came back, quiet
 * hours ended), which plays the hello once and then rests like idle; idle before they ever dozed.
 */
export const deskMood = (asleep: boolean, dozed: boolean): FaceState =>
  asleep ? 'asleep' : dozed ? 'welcome' : 'idle';

/** A look's face (the hero's words beside it): thinking while the assistant looks into it, working while it fixes it. */
export function researchFace(stage: LookStage | null): FaceState | undefined {
  switch (stage) {
    case 'looking':
      return 'thinking';
    case 'fixing':
      return 'working';
    case 'fixed':
      return 'done';
    default:
      return undefined;
  }
}
