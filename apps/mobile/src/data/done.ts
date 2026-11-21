/**
 * Everything I did's words on the phone (Whombat home-redesign HR-24; home-redesign-mobile.md AP-2259…AP-2261; Home's
 * card is gone, home-simplify.md AP-2269). What Undo did is the shared `undoOutcome`. Pure; the parts are
 * `screens/home/DoneParts.tsx` and `screens/DoneScreen.tsx`.
 */
export const DONE_COPY = {
  screenTitle: 'Everything I did',
  intro: (name: string) =>
    `What ${name} changed for you, newest first. Undo works for a day where there’s a way back.`,
  screenEmpty: (name: string) => `Nothing yet. What ${name} changes for you shows up here.`,
  failed: 'This list didn’t load.',
  showOlder: 'Show older',
  undo: 'Undo',
  review: 'Review',
  undone: 'Undone',
  /** Opens the chat where the assistant puts a change back (contracts 0.91 `requested`). */
  openChat: 'Open chat',
} as const;
