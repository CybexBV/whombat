/**
 * A list scrolled to one of its rows, when that row is still there. React Native's list throws on an index past its
 * rows, and a scroll asked for a moment later (the next frame, a timer) may find the list shorter than when it was
 * asked: a saved copy replaced by a fresh answer. A throw in a frame or timer is outside every page's boundary and
 * ends the app, so a row that is gone is skipped instead.
 */
export interface RowList {
  /** The rows it has now. */
  props: { data?: ArrayLike<unknown> | null };
  scrollToIndex(to: { index: number; viewPosition?: number; animated?: boolean }): void;
}

/** True when the list was asked to scroll. */
export function scrollToRow(
  list: RowList | null | undefined,
  to: { index: number; viewPosition?: number; animated?: boolean },
): boolean {
  if (!list) return false;
  const rows = list.props.data?.length ?? 0;
  if (!Number.isInteger(to.index) || to.index < 0 || to.index >= rows) return false;
  try {
    list.scrollToIndex(to);
    return true;
  } catch {
    return false;
  }
}
