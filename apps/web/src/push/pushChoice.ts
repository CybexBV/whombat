/**
 * Whether this browser turns Whombat's notifications on by itself, offers them once in the Chat, or leaves them be, and
 * what the person said about them here. Pure, apart from the small record this browser keeps.
 *
 * Where the browser already allows notifications for the page, they come on by themselves: the person said yes to the
 * browser before, and a new sign-in shouldn't ask again. Where the browser has never asked, the Chat asks once, with
 * one reason, and the browser's own question follows the click. Turning them off here is remembered, so they never come
 * back by themselves.
 */

export interface PushStartInput {
  /** Notifications can work here: the browser has Push and the Whombat can send them to this page. */
  supported: boolean;
  /** The browser's permission for this site. */
  permission: NotificationPermission;
  /** This browser is already registered with this Whombat. */
  registered: boolean;
  /** The person turned notifications off in this browser. */
  offHere: boolean;
  /** The person already answered the Chat's question here (Turn on or Not now). */
  answered: boolean;
}

/** Subscribe without asking, offer the Chat's card, or do nothing. */
export type PushStart = 'subscribe' | 'offer' | 'none';

export function pushStart(input: PushStartInput): PushStart {
  if (!input.supported || input.registered || input.offHere) return 'none';
  if (input.permission === 'granted') return 'subscribe';
  if (input.permission === 'default' && !input.answered) return 'offer';
  return 'none';
}

/** What the person said about notifications in this browser. */
export interface PushChoice {
  /** They turned them off here: nothing turns them back on but they. */
  off: boolean;
  /** They answered the Chat's card (Turn on or Not now): it doesn't come back. */
  answered: boolean;
}

export const PUSH_CHOICE_KEY = 'whombat:web-push-choice';

type ChoiceStorage = Pick<Storage, 'getItem' | 'setItem'>;

function reach(storage?: ChoiceStorage): ChoiceStorage | null {
  try {
    return storage ?? window.localStorage;
  } catch {
    return null;
  }
}

/** This browser's record; unreadable (private mode, blocked storage) is nothing said yet. */
export function readPushChoice(storage?: ChoiceStorage): PushChoice {
  try {
    const raw = reach(storage)?.getItem(PUSH_CHOICE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<PushChoice>) : {};
    return { off: parsed.off === true, answered: parsed.answered === true };
  } catch {
    return { off: false, answered: false };
  }
}

/** Changes this browser's record; where it can't be kept, the choice lasts for this page only. */
export function writePushChoice(change: Partial<PushChoice>, storage?: ChoiceStorage): void {
  try {
    const next = { ...readPushChoice(storage), ...change };
    reach(storage)?.setItem(PUSH_CHOICE_KEY, JSON.stringify(next));
  } catch {
    // Not kept: the next visit may offer again, which is harmless.
  }
}
