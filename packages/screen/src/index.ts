/**
 * `@whombat/screen`: the screens of widgets (Whombat docs/decisions/desk-display.md DK-126…DK-149). This entry is pure
 * TypeScript — the grid, the widgets' sizes and forms, page turning, what the modal and the pill show, the contract's
 * shapes as plain types, the screen's words and a world to draw (the fixtures) — for every app and the runtime;
 * `@whombat/screen/react` draws them (React DOM: the box's console, the web app's screen page and editor). No zod and no
 * other package at runtime, so the box's console can take the source as it is.
 */
export * from './attention';
export * from './forms';
export * from './grid';
export * from './pager';
export * from './specs';
export * from './types';
export * from './words';
