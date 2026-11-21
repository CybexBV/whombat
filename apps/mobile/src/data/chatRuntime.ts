/**
 * What answers in Chat, on the phone (Whombat chat-runtime.md CR-01…CR-11; chat-runtime-android.md AP-2715…AP-2749).
 * The rules and words are `@whombat/client`'s (`chat/runtime.ts`, shared with the web); what is here is the phone's own
 * shape of a reply's marks for its memoised rows (`ChatItem.ranOn`): the provider's mark and name after the time and
 * the whole line on a tap or a long press (CR-07), the divider above it when it ran on something else than the thread's
 * reply before (CR-07), and the quiet lines under it (CR-08). Pure.
 */
import { chatModelsOf, type RanOnSwitch, ranOnMark, ranOnMarked, ranOnNotes } from '@whombat/client';
import type { ChatProvider, ChatRuntimeView, Message } from '@whombat/core';

/** What a reply says about what answered it (CR-07, CR-08). */
export interface RanOnView {
  provider: ChatProvider;
  /** After the time: “Claude”, “ChatGPT”, with the provider's mark. */
  label: string;
  /**
   * Whether the mark shows after the time: only on a reply that ran on something else than the thread's reply before it
   * (a first reply never), and only where more than one AI can answer (`ranOnMarked`), as on the web.
   */
  marked: boolean;
  /** On a tap or a long press, and what TalkBack reads: “Claude · Opus · High effort · Fast”. */
  text: string;
  /** The quiet divider above the reply: “Switched to ChatGPT · High effort”; null when nothing asked for changed. */
  switched: string | null;
  /** Under the reply: “Fable wasn’t available, so this one came from Opus.” */
  modelSkipped: string | null;
  /** Under the reply, when the person can change it: “Fast replies need usage credits on your Claude account, …”. */
  fastSkipped: string | null;
}

/**
 * A reply's `ranOn` as its row shows it (null without one): `switched` is its divider from `ranOnSwitches` (in a thread;
 * none at the room's top level, where every message is a thread of its own), `view` names a skipped model.
 */
export function ranOnView(
  message: Pick<Message, 'ranOn'>,
  switched: RanOnSwitch | undefined,
  view: Pick<ChatRuntimeView, 'providers'> | null | undefined,
): RanOnView | null {
  const mark = ranOnMark(message);
  if (!mark) return null;
  const notes = ranOnNotes(message.ranOn, chatModelsOf(view, mark.provider));
  return {
    provider: mark.provider,
    label: mark.label,
    marked: !!switched && ranOnMarked(view),
    text: mark.title,
    switched: switched?.text ?? null,
    modelSkipped: notes.find((n) => n.kind === 'model')?.text ?? null,
    fastSkipped: notes.find((n) => n.kind === 'fast')?.text ?? null,
  };
}

/**
 * The divider's words split for the mockup's bold (“Switched to **ChatGPT** · High effort”): what it switched to first,
 * then the rest; “Fast replies on” alone has nothing bold.
 */
export function switchedParts(text: string): { lead: string; bold: string; rest: string } {
  const lead = 'Switched to ';
  if (!text.startsWith(lead)) return { lead: text, bold: '', rest: '' };
  const after = text.slice(lead.length);
  const cut = after.indexOf(' · ');
  return cut < 0
    ? { lead, bold: after, rest: '' }
    : { lead, bold: after.slice(0, cut), rest: after.slice(cut) };
}
