/** Radii, spacing, shadows, layout sizes, breakpoints and motion. README "Radii", "Spacing", "Shadows". */

/** Radii in px. */
export const radii = {
  /** Pills, chips, badges. */
  pill: 999,
  /** Modals. */
  modal: 22,
  /** Large cards (roster cards), mobile groups. 18–20px. */
  cardLarge: 18,
  cardXLarge: 20,
  /** Cards, composer. */
  card: 16,
  /** Inputs, panels, toasts. */
  panel: 14,
  /** Large buttons, list items. */
  buttonLarge: 12,
  /** Segmented control container. */
  segmented: 11,
  /** Default buttons, sidebar rows. */
  button: 10,
  /** Small buttons. 8–9px. */
  buttonSmall: 9,
  /** Segmented control items, icon buttons. */
  small: 8,
  /** Tags, receipt numbers. 5–6px. */
  tag: 5,
  tagLarge: 6,
  /** Mobile phone frame (reference only). */
  phoneFrame: 56,
  phoneScreen: 46,
} as const;

/** Base spacing rhythm in px. CSS: `--space-<n>`. */
export const spacing = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 48, 56] as const;
export type Spacing = (typeof spacing)[number];

/** Box shadows (fixed, both themes). */
export const shadows = {
  modal: '0 30px 80px -20px rgba(0,0,0,.45)',
  toast: '0 12px 30px -10px rgba(0,0,0,.4)',
  /** Right pane when it overlays the main column below the pane breakpoint. */
  pane: '-20px 0 50px -20px rgba(0,0,0,.3)',
  /** Halo around the live run dot. */
  liveHalo: '0 0 0 4px rgba(111,207,151,.22)',
} as const;

/**
 * The box status's shadows (box-status.md, AP-1148): a chart's tooltip and the picked item of a soft segmented control.
 * Apart from `shadows` so the feedback widget, which bundles those, stays within its size budget.
 */
export const chartShadows = {
  chartTip: '0 8px 20px -8px rgba(0,0,0,.35)',
  segmentLift: '0 1px 2px rgba(0,0,0,.08)',
} as const;

/** Content max-widths in px. */
export const contentWidths = {
  messages: 880,
  run: 1120,
  log: 1040,
  onboarding: 720,
  canvas: 680,
  /** Chat cards. */
  card: 640,
} as const;

/** Fixed layout sizes in px. */
export const layout = {
  sidebar: 256,
  /** Right panes. */
  paneThread: 400,
  paneBranch: 340,
  /** Modal widths (`width: min(100%, N)`). */
  modal: 560,
  modalWide: 760,
  /** A server's console: its screen and the machine list beside it. */
  modalConsole: 1080,
  /** Desktop reference viewport. */
  viewportWidth: 1440,
  viewportHeight: 900,
  /** Mobile reference viewport (iOS). */
  mobileWidth: 390,
  mobileHeight: 844,
  /** Minimum touch target on mobile; primary actions use 52. */
  touchTarget: 44,
  touchTargetLarge: 52,
} as const;

/** Viewport breakpoints in px (`min-width`). */
export const breakpoints = {
  /** At and above: right panes sit inline and push content. Below: they overlay (absolute + shadow). */
  pane: 1240,
  /** At and above: the canvas comments column is shown. */
  canvasComments: 1200,
} as const;

/** `@media` query strings for the breakpoints (CSS variables cannot be used in media queries). */
export const media = {
  paneInline: `(min-width: ${breakpoints.pane}px)`,
  paneOverlay: `(max-width: ${breakpoints.pane - 0.02}px)`,
  canvasComments: `(min-width: ${breakpoints.canvasComments}px)`,
} as const;

/** Durations in ms. */
export const durations = {
  /** Toggle knob translate. */
  toggle: 150,
  /** Run progress bar width. */
  progress: 600,
  /** Toast auto-dismiss. */
  toast: 2600,
  /** One scripted run log line. */
  liveTick: 2600,
} as const;

export const zIndex = {
  pane: 5,
  modal: 20,
  toast: 30,
} as const;
