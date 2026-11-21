/**
 * Where a moved card went (Whombat card-moves.md): a council's or a checklist's card moves to the thread's
 * end with its next news and leaves the agent's words above it behind. That message gets a quiet link to the card's
 * message now, so “Tick what you want” never points at nothing; where the person talked after it, it also keeps the card
 * as it was then, folded into one line that opens it read-only. Shared by web and the phone. Pure.
 */
import type { Message, MovedCard } from '@whombat/core';
import { CARD_FRAME_WORDS } from './cardFrame';
import { COUNCIL_WORDS, councilScoreText } from './council';
import { delegationTaskView } from './delegation';

export const MOVED_CARD_WORDS = {
  link: {
    council: 'The council’s card is further down',
    delegation: 'The Tasks card is further down',
  } satisfies Record<MovedCard['kind'], string>,
  /** The folded line of the card as it was here: “Tasks · earlier version · 5 tasks”. */
  earlier: 'earlier version',
  /** The status word of the card as it was, opened: it no longer does anything. */
  earlierWord: 'Earlier version',
  /** The folded line's link to the card as it is now. */
  newest: 'Newest',
  show: 'Show the earlier version',
  hide: 'Hide the earlier version',
} as const;

/** What the card as it was here said, in a few words: “5 tasks”, “2 of 3 answered”. */
function earlierSummary(card: NonNullable<Message['card']>): string | null {
  if (card.kind === 'delegation') {
    const tasks = card.tasks.filter((t) => t.state !== 'skipped');
    if (card.stage === 'offer') return `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`;
    const done = tasks.filter((t) => t.state === 'done').length;
    return `${done} of ${tasks.length} done`;
  }
  if (card.kind === 'council') {
    const round = card.members.filter((m) => m.role === 'member');
    if (!card.live) return null;
    return `${round.filter((m) => m.state === 'done').length} of ${round.length} answered`;
  }
  return null;
}

type ThreadRow = Pick<Message, 'card' | 'earlierCard' | 'movedCard'>;

/** How many councils a thread holds, by their cards, the copies of them and the links to them. */
function councilsIn(thread: readonly ThreadRow[]): number {
  const ids = new Set<string>();
  for (const m of thread) {
    for (const card of [m.card, m.earlierCard]) if (card?.kind === 'council') ids.add(card.councilId);
    if (m.movedCard?.kind === 'council') ids.add(m.movedCard.id);
  }
  return ids.size;
}

const TITLE_IN_LINE_MAX = 48;

/**
 * The folded line of a card as it was on this message, or null when the message keeps none: its kind, that it
 * is an earlier version and what it said then. In a thread with more than one council (`thread`, as loaded), a council's
 * line names it, so the copies of two councils can be told apart.
 */
export function earlierCardLine(
  message: Pick<Message, 'earlierCard'>,
  thread: readonly ThreadRow[] = [],
): string | null {
  const card = message.earlierCard;
  if (!card || (card.kind !== 'council' && card.kind !== 'delegation')) return null;
  const kind = CARD_FRAME_WORDS.kinds[card.kind];
  const title =
    card.kind === 'council' && councilsIn(thread) > 1
      ? card.title.length > TITLE_IN_LINE_MAX
        ? `${card.title.slice(0, TITLE_IN_LINE_MAX - 1).trimEnd()}…`
        : card.title
      : null;
  return [kind, title, MOVED_CARD_WORDS.earlier, earlierSummary(card)].filter(Boolean).join(' · ');
}

/** Whether `card` is the moved one: the same kind of card for the same council or checklist. */
function holds(card: Message['card'], moved: MovedCard): boolean {
  if (!card || card.kind !== moved.kind) return false;
  if (card.kind === 'council') return card.councilId === moved.id;
  if (card.kind === 'delegation') return card.delegationId === moved.id;
  return false;
}

/**
 * The link under a message whose card moved on: the words and the message that holds the card now, the newest of
 * `messages` (the thread as loaded). Null when the message held none or the card isn't in the thread as loaded.
 */
export function movedCardLink(
  message: Pick<Message, 'id' | 'movedCard'>,
  messages: readonly Pick<Message, 'id' | 'card'>[],
): { label: string; targetId: string } | null {
  const moved = message.movedCard;
  if (!moved) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.id !== message.id && holds(m.card, moved))
      return { label: MOVED_CARD_WORDS.link[moved.kind], targetId: m.id };
  }
  return null;
}

/**
 * The card as it was, read out (screen readers get it in words, the drawn copy being inert): its title, then each task
 * by its number, or each member with its score or state. Null when the message keeps none.
 */
export function earlierCardText(message: Pick<Message, 'earlierCard'>): string | null {
  const card = message.earlierCard;
  if (!card) return null;
  if (card.kind === 'delegation') {
    const tasks = card.tasks.filter((t) => t.state !== 'skipped');
    const offered = card.stage === 'offer';
    // Offered: which weren't ticked; handed over: each one's state then, as the copy shows it (no clock).
    const said = (t: (typeof tasks)[number]) =>
      offered
        ? t.picked
          ? ''
          : ', not ticked'
        : `, ${delegationTaskView(t, card, Date.parse(card.startedAt)).status.toLowerCase()}`;
    return `${card.title}, as it was: ${tasks.map((t) => `${t.n}, ${t.title}${said(t)}`).join('; ')}.`;
  }
  if (card.kind === 'council') {
    const members = card.members.filter((m) => m.role === 'member');
    const said = members.map(
      (m) =>
        `${m.name}, ${m.state === 'done' && m.score !== null ? councilScoreText(m.score) : COUNCIL_WORDS.states[m.state].toLowerCase()}`,
    );
    return `${card.title}, as it was: ${said.join('; ')}.`;
  }
  return null;
}
