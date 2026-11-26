/**
 * Every action that hands work to the assistant opens the thread where it happens (Whombat backup-places.md BPL-15),
 * on the web and the phone: the person sees the work start and can follow or stop it, where a toast is easy to miss.
 * Which buttons go to a thread, which go to a page and which keep the person where they are, and the thread an answer
 * names. Pure; both apps ask it.
 */
import { type LookResearch, type NeedsYouAction, parseChatHref } from '@whombat/core';
import { lookThreadHref } from './lookResearch';
import type { NeedsYouButton } from './needsYouList';

/** Where pressing a button takes the person: the thread the work happens in, a page, or nowhere (a toast says it). */
export type ButtonGoes = 'thread' | 'page' | 'stay';

/**
 * One of the server's own buttons on an Inbox item: the yes to a proposal (`ask`) and “Look into it” (`investigate`)
 * start the assistant's turn, so they go to its thread; `open` goes to its page; approving, declining and snoozing stay.
 */
export function needsYouActionGoes(action: Pick<NeedsYouAction, 'kind'>): ButtonGoes {
  switch (action.kind) {
    case 'ask':
    case 'investigate':
      return 'thread';
    case 'open':
      return 'page';
    default:
      return 'stay';
  }
}

/**
 * A button of the Inbox list (an item's sheet or page, a row, the brief): the step it found (`fix`), *Ask {assistant}
 * to fix it*, *Ask {assistant} to handle it* and *Talk to {assistant} about it* go to the thread; *See it* to its page;
 * the server's own as `needsYouActionGoes`; Settle, Remind me tomorrow, Stop watching and Bring it back stay.
 */
export function needsYouButtonGoes(button: Pick<NeedsYouButton, 'kind' | 'action'>): ButtonGoes {
  switch (button.kind) {
    case 'fix':
    case 'askFix':
    case 'handle':
    case 'talk':
    case 'aheadAction':
      return 'thread';
    case 'see':
      return 'page';
    case 'action':
      return button.action ? needsYouActionGoes(button.action) : 'stay';
    default:
      return 'stay';
  }
}

/**
 * The thread an answer that handed work over names (`looks.handle`, `looks.fix`: the look's thread in the person's
 * Chat), or null when it names none (then the card or a toast says it).
 */
export function handedOverThread(
  answer: { research: Pick<LookResearch, 'threadRootId'> } | null | undefined,
): string | null {
  return answer ? lookThreadHref(answer.research) : null;
}

/** A thread's first message, from a Chat link (`/chat?thread=msg_…`) or the id itself. */
function rootOf(thread: string): string | null {
  return thread.startsWith('/') ? (parseChatHref(thread)?.thread ?? null) : thread;
}

/**
 * The thread to open after a hand-over (a Chat link), or null when there is none or the person is in it already
 * (`here`: the thread shown, as a link or its first message's id), where the work shows as it happens.
 */
export function threadToOpen(target: string | null | undefined, here?: string | null): string | null {
  if (!target) return null;
  const root = rootOf(target);
  return here && root && rootOf(here) === root ? null : target;
}
