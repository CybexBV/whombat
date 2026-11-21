/**
 * The mock is an iPhone frame: its bottom paddings (tab bar 28, composer 34, approval footer 36) include
 * the 34pt home-indicator area. On a device we use the real inset instead: the mock's padding minus the
 * iPhone inset plus the device's, never less than `min` (the bar's own top padding, for devices with
 * no gesture area).
 */
export const MOCK_HOME_INSET = 34;

export function bottomPadding(mockPadding: number, deviceInset: number, min: number): number {
  return Math.max(min, mockPadding - MOCK_HOME_INSET + deviceInset);
}

/**
 * The bottom tab bar's padding under its labels (fold-bar.md AP-2750). On an iPhone the home indicator sits over the
 * bar, which is what `bottomPadding` copies; on Android the area below (the gesture handle, the unfolded screen's
 * stashed taskbar, the three buttons) is the system's: swipe home, long-press for Circle to Search. So the labels stop
 * `TAB_BAR_SYSTEM_GAP` above it, and the bar's colour runs under it. Without such an area, the mock's 14.
 */
export const TAB_BAR_SYSTEM_GAP = 10;

export function tabBarBottomPadding(deviceInset: number): number {
  return Math.max(14, deviceInset + TAB_BAR_SYSTEM_GAP);
}

/**
 * What is under a screen's bottom edge: our tab bar along the bottom, which keeps the system's area itself (`tab-bar`);
 * iOS's own tab bar over the screen's bottom (`glass-bar`, native-feel.md); or the window's edge, with the home
 * indicator or Android's gesture area over it (`edge`: a pushed screen, or a tab's screen with the tabs down the side).
 */
export type BelowScreen = 'tab-bar' | 'glass-bar' | 'edge';

/**
 * How much of a screen's bottom something covers: what a list's last row scrolls clear of, while the rows themselves
 * run on under it to the edge.
 */
export function screenBottomRoom(deviceInset: number, below: BelowScreen, barRoom = 0): number {
  if (below === 'tab-bar') return 0;
  if (below === 'glass-bar') return Math.max(barRoom, deviceInset);
  return deviceInset;
}

/** What is under a screen's composer (chat-settle.md AP-6254): the screen's edge, our tab bar or iOS's. */
export type BelowComposer = 'nothing' | 'tab-bar' | 'glass-bar';

/**
 * The composer's padding under its pill: the mock's 34 on a screen that reaches the window's bottom (`bottomPadding`),
 * the mock phone's 10 above the tab bar — iOS's bar covers `barRoom` of the screen, so 10 above that.
 */
export function composerBottomPadding(deviceInset: number, below: BelowComposer, barRoom = 0): number {
  if (below === 'tab-bar') return 10;
  if (below === 'glass-bar') return Math.max(barRoom, deviceInset) + 10;
  return bottomPadding(34, deviceInset, 10);
}

/** A conversation's side padding (AP-706): messages, cards and pictures take the width between. */
export const CHAT_GUTTER = 14;
/** The space between a conversation's messages. */
export const CHAT_ROW_GAP = 14;

/** How far a reply box or a form's footer sits above the keyboard while it is up. */
export const ABOVE_KEYBOARD = 10;

/**
 * The padding under a bar that rests on the keyboard while it is up: `rest` with the keyboard down (the gesture area,
 * the tab bar), `open` with it up, and in between while the keyboard moves (`progress` 0…1), so the bar travels with
 * the keyboard instead of jumping once it has arrived. Runs on the UI thread.
 */
export function keyboardPadding(rest: number, open: number, progress: number): number {
  'worklet';
  const p = Math.min(1, Math.max(0, progress));
  return rest + (open - rest) * p;
}

/**
 * How much of a view the keyboard covers, all in the app's window: the keyboard rises `keyboard` from the window's
 * bottom, the view ends at `viewBottom` from the window's top. What is under the view (a tab bar, the gesture area)
 * takes its share of the keyboard first. Runs on the UI thread.
 */
export function keyboardOverlap(keyboard: number, windowHeight: number, viewBottom: number): number {
  'worklet';
  return Math.max(0, keyboard - Math.max(0, windowHeight - viewBottom));
}
