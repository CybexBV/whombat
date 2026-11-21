/**
 * Placing comment threads next to their anchors (comments column, ≥1200px). A thread wants to sit level with
 * the block its words are in, never above where the column starts (the reference's 320px), and never on top of
 * the thread before it (16px apart). Threads without a live anchor go last.
 */

/** Where the comments column starts, px from the top of the article (the reference's `canvasPad`). */
export const COLUMN_START = 320;
/** Space between threads (the reference's `gap:16px`). */
export const THREAD_GAP = 16;

export interface ThreadBox {
  id: string;
  /** Top of the anchor's block (px from the column top), or null when the anchor is gone. */
  anchorTop: number | null;
  /** Document position of the anchor (order), or null. */
  anchorPos: number | null;
  height: number;
}

export interface Placed {
  id: string;
  top: number;
}

/** Tops for each thread, in document order; returns the column's height too. */
export function layoutThreads(
  boxes: readonly ThreadBox[],
  start = COLUMN_START,
  gap = THREAD_GAP,
): { placed: Placed[]; height: number } {
  const ordered = [...boxes].sort((a, b) => {
    if (a.anchorPos === null && b.anchorPos === null) return 0;
    if (a.anchorPos === null) return 1;
    if (b.anchorPos === null) return -1;
    return a.anchorPos - b.anchorPos;
  });
  const placed: Placed[] = [];
  let next = start;
  for (const box of ordered) {
    const top = Math.max(next, box.anchorTop ?? 0);
    placed.push({ id: box.id, top });
    next = top + box.height + gap;
  }
  const last = placed.at(-1);
  const lastBox = last ? ordered.find((b) => b.id === last.id) : undefined;
  return { placed, height: last && lastBox ? last.top + lastBox.height : 0 };
}
