/**
 * The segmented control's props, and which of iOS's own controls it draws on iPhone (docs/app/decisions/native-feel.md):
 * iOS's segmented control when every label fits an equal share of the narrowest iPhone's width on one line, else iOS's
 * menu picker, which shows the whole words of the chosen one and of every choice in its list. iOS's segments are as
 * wide as each other and cut a label that doesn't fit with “…”; they can't wrap as ours do. Pure.
 */

export interface SegmentedProps<T extends string> {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  /**
   * Read-only: the choice shows and can't change, the others' words in `mut` as the web's read-only control keeps the
   * chosen one legible (desk-display-android.md AP-3626).
   */
  disabled?: boolean;
  /**
   * Lines a label may take: 2 lets one that doesn't fit a third of a phone wrap under itself rather than end in “…”
   * (Lock again's “When you press Lock”, AP-3626); the items stay as wide as each other.
   */
  lines?: 1 | 2;
  /**
   * Each item as wide as its words, the rest shared: three words of different lengths (Always · When it matters · Off,
   * desk-display-android.md AP-5865) fit a phone's width where equal thirds would cut the longest.
   */
  fit?: boolean;
}

export type SegmentedLook = 'segments' | 'menu';

/**
 * The width a segmented control gets on the narrowest iPhone iOS 27 runs on (the iPhone SE, 375pt): a page's 16pt sides
 * and a part's 16pt sides inside it.
 */
export const NARROWEST_CONTROL_WIDTH = 375 - 2 * 16 - 2 * 16;

/** More than five segments is a menu on any width (Apple: “limit the number of segments to about five”). */
export const MOST_SEGMENTS = 5;

/** iOS's segmented control: the track's inset each side, and the room a segment keeps each side of its label. */
const TRACK_INSET = 2;
const LABEL_INSET = 8;
/** Its labels' size: 13pt SF Pro, semibold on the chosen one. */
const LABEL_SIZE = 13;

/**
 * How wide `text` draws in iOS's segmented control, in points: SF Pro's semibold advance widths by kind of letter,
 * rounded up so the estimate errs wide (a label that only just fits goes to the menu, not to “…”).
 */
export function segmentLabelWidth(text: string): number {
  let ems = 0;
  for (const ch of text) {
    if ("ijlI.,:;'’!|".includes(ch)) ems += 0.28;
    else if ('ftr '.includes(ch)) ems += 0.36;
    else if ('mwMW'.includes(ch)) ems += 0.88;
    else if (ch >= '0' && ch <= '9') ems += 0.62;
    else if (ch !== ch.toLowerCase()) ems += 0.68;
    else ems += 0.58;
  }
  return ems * LABEL_SIZE;
}

/** iOS's segmented control when every label fits its share of `width` on one line, else iOS's menu picker. */
export function segmentedLook(
  options: readonly { label: string }[],
  width: number = NARROWEST_CONTROL_WIDTH,
): SegmentedLook {
  if (options.length > MOST_SEGMENTS) return 'menu';
  const share = (width - 2 * TRACK_INSET) / options.length - 2 * LABEL_INSET;
  return options.every((o) => segmentLabelWidth(o.label) <= share) ? 'segments' : 'menu';
}
