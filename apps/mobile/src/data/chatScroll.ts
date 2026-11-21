/**
 * Where a conversation's list scrolls (MX-01, MX-03). Pure: `ChatView` asks these on every content or size change and
 * on every page of an anchor's search, and does what they say.
 *
 * Following (MX-01): the list opens at the newest message and follows what arrives — a message, the thinking row, the
 * list shrinking for the keyboard — only while the reader is at the end (or right after their own send, which puts them
 * there). Someone reading further up stays where they are; a new message below shows the “New messages ↓” pill
 * instead, until they reach the end or tap it. While the reader's finger or fling moves the list, it isn't moved under
 * them: what would take it to the end waits until they let go.
 *
 * Anchors (MX-03): a link to a message (a mention push, a copied link, a pinned message, a search result) opens the list
 * at it: older pages load until it is there, at most `ANCHOR_MAX_PAGES`, then it is scrolled into view and highlighted;
 * meanwhile nothing follows the end.
 *
 * A field in a row (a feature request's reason or question): once the keyboard is up and the list has shrunk
 * above it, the list scrolls just enough that the field and its buttons show (`revealBy`).
 */

/** What the list does after its content or size changed. */
export type FollowAction =
  /** Scroll to the newest message (and stay there). */
  | 'end'
  /** Something new arrived below a reader who is further up: show the “New messages ↓” pill. */
  | 'pill'
  /** It would go to the end, but the reader is scrolling: ask again once they let go. */
  | 'later'
  | 'none';

export interface FollowInput {
  /** The reader is at the end (within `AT_END_SLACK` of it). */
  atEnd: boolean;
  /** The newest message the reader has been shown at the end ('' before the list first had messages). */
  seen: string;
  /** The newest message now ('' while there are none). */
  last: string;
  /** An anchor owns the scroll (MX-03): it is being looked for or was just shown. */
  anchored: boolean;
  /**
   * The list got shorter without a new message (a thread left it, folding away): the scroll view keeps its end by
   * itself, and scrolling there on every frame of the fold would fight it.
   */
  shrank?: boolean;
  /**
   * The reader's drag or fling moves the list now. Scrolling to the end then fought their finger: rows drawn above as
   * they near them, and the thinking row's words, change the content's size while they are still within the end's slack.
   */
  reader?: boolean;
}

/** How close to the end still counts as at the end, in dp. */
export const AT_END_SLACK = 80;

export function followAction({
  atEnd,
  seen,
  last,
  anchored,
  shrank = false,
  reader = false,
}: FollowInput): FollowAction {
  if (!last) return 'none';
  if (shrank && seen && last === seen) return 'none';
  const end = reader ? 'later' : 'end';
  // The list's first messages: open at the end, unless a link opens it at a message.
  if (!seen) return anchored ? 'none' : end;
  if (atEnd && !anchored) return end;
  return last !== seen ? 'pill' : 'none';
}

/** Whether a scroll position is at the end of the list. */
export function isAtEnd(e: {
  contentOffset: { y: number };
  layoutMeasurement: { height: number };
  contentSize: { height: number };
}): boolean {
  return e.contentOffset.y + e.layoutMeasurement.height >= e.contentSize.height - AT_END_SLACK;
}

/* Anchors (MX-03) ------------------------------------------------------------------------------------------------ */

/** Pages of history loaded while looking for an anchor (50 messages each): further back opens at the end instead. */
export const ANCHOR_MAX_PAGES = 10;

/** How long the message a link opened at stays highlighted (the web's pins jump is 1.6 s; a screen transition first). */
export const ANCHOR_FLASH_MS = 2000;

/** What the screen says when the message isn't there (deleted, or too far back to load on the phone). */
export const ANCHOR_MISSING_TEXT = 'That message isn’t here any more, or it’s too far back.';

export type AnchorStep =
  /** It is the list's `index`-th item (or inside it, a run's folded line): scroll there and highlight `id`. */
  | { kind: 'show'; index: number; id: string }
  /** Not loaded yet: load the next older page. */
  | { kind: 'load' }
  /** A page is on its way. */
  | { kind: 'wait' }
  /** Not there and nothing more to load (or the bound is reached): open at the end and say so. */
  | { kind: 'missing' };

export function anchorStep(input: {
  anchor: string;
  items: readonly { id: string; inside?: readonly { id: string }[] }[];
  /** Older pages exist (a thread loads whole: false). */
  hasMore: boolean;
  /** A page is being fetched. */
  loading: boolean;
  pagesLoaded: number;
  maxPages?: number;
}): AnchorStep {
  const index = input.items.findIndex(
    (i) => i.id === input.anchor || (i.inside ?? []).some((s) => s.id === input.anchor),
  );
  const item = input.items[index];
  if (item) return { kind: 'show', index, id: item.id };
  if (input.loading) return { kind: 'wait' };
  if (input.hasMore && input.pagesLoaded < (input.maxPages ?? ANCHOR_MAX_PAGES)) return { kind: 'load' };
  return { kind: 'missing' };
}

/** The “New messages ↓” pill's words and what TalkBack hears. */
export const NEW_MESSAGES_PILL = {
  label: 'New messages ↓',
  spoken: 'New messages',
  hint: 'Scrolls to the newest message',
} as const;

/**
 * Where a pinned message opens (MX-03): a reply in its thread at the reply; a top-level one back in the conversation the
 * pins were opened from, at the message — or, when that isn't the screen below, the conversation by id.
 */
export function pinnedMessageOpen(
  m: { id: string; threadRootId: string | null },
  conversationId: string,
  below: string | undefined,
):
  | { kind: 'thread'; messageId: string; anchor: string }
  | { kind: 'back'; anchor: string }
  | { kind: 'conversation'; conversationId: string; anchor: string } {
  if (m.threadRootId) return { kind: 'thread', messageId: m.threadRootId, anchor: m.id };
  if (below === 'Conversation') return { kind: 'back', anchor: m.id };
  return { kind: 'conversation', conversationId, anchor: m.id };
}

/* A field in a row ---------------------------------------------------------------------------------------------- */

/** What stays between a field's form and the list's bottom edge (the composer under it), in dp. */
export const REVEAL_MARGIN = 12;

/** How long a field waits for the keyboard to come up before it stops waiting (a hardware keyboard raises none). */
export const REVEAL_WAIT_MS = 1500;

/**
 * How far down the list scrolls so `target` (a row's form, in window coordinates) shows inside `box` (the list, shrunk
 * for the keyboard) with `margin` to spare: 0 when it shows already, and never so far that its top leaves the list — a
 * form taller than what is left shows from its top, where the field is.
 */
export function revealBy(
  target: { top: number; bottom: number },
  box: { top: number; bottom: number },
  margin: number = REVEAL_MARGIN,
): number {
  const below = target.bottom + margin - box.bottom;
  if (below <= 0) return 0;
  return Math.max(0, Math.min(below, target.top - margin - box.top));
}
