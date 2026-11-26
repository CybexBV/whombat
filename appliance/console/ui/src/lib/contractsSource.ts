/**
 * Test helper: the vendored contracts' sources (`vendor/whombat-contracts`, CG-40) as text, and the string lists they
 * declare (`export const NAME = ['a', 'b'] as const;`). The page copies what it needs; the tests compare.
 */
import { readFileSync } from 'node:fs';

export const deskWordsSource = readFileSync(
  new URL('../../vendor/whombat-contracts/desk.ts', import.meta.url),
  'utf8',
);
/** A server task's card (`@whombat/core` domain/task-card.ts, 0.116): its states' words and the helpers the page copies. */
export const taskCardSource = readFileSync(
  new URL('../../vendor/whombat-contracts/task-card.ts', import.meta.url),
  'utf8',
);
/** Remote help's words (`@whombat/core` domain/remote-help.ts, 0.120): the desk's line (CG-290). */
export const remoteHelpSource = readFileSync(
  new URL('../../vendor/whombat-contracts/remote-help.ts', import.meta.url),
  'utf8',
);
/** Quiet notices (`@whombat/core` domain/quiet.ts, 0.122): a line's kinds and a check's id (CG-332). */
export const quietSource = readFileSync(
  new URL('../../vendor/whombat-contracts/quiet.ts', import.meta.url),
  'utf8',
);
/** What the assistant found out about a look (`@whombat/core` domain/look-research.ts, 3.5): its states and bounds (CG-372). */
export const lookResearchSource = readFileSync(
  new URL('../../vendor/whombat-contracts/look-research.ts', import.meta.url),
  'utf8',
);
export const deskSocketSource = readFileSync(
  new URL('../../vendor/whombat-contracts/desk-socket.ts', import.meta.url),
  'utf8',
);
/** The console file's shapes (`@whombat/control-contracts/local`): the sign-in's `ConsoleSignIn` (CG-151). */
export const consoleFileSource = readFileSync(
  new URL('../../vendor/whombat-contracts/console-file.ts', import.meta.url),
  'utf8',
);
/** The sign-in's letters (`@whombat/protocol/claim` screen.ts, BX-04). */
export const screenSignInSource = readFileSync(
  new URL('../../vendor/whombat-contracts/screen-signin.ts', import.meta.url),
  'utf8',
);

/** The box's Bluetooth (`@whombat/protocol/session` bluetooth.ts, 0.109): the kinds, phases, failures, the bounds. */
export const bluetoothSource = readFileSync(
  new URL('../../vendor/whombat-contracts/bluetooth.ts', import.meta.url),
  'utf8',
);

/** The calm glance's shapes (`@whombat/core` domain/desk-glance.ts, 3.2, CG-350): its lists and limits. */
export const deskGlanceSource = readFileSync(
  new URL('../../vendor/whombat-contracts/desk-glance.ts', import.meta.url),
  'utf8',
);

/** The values of `export const name = [...] as const` in `source`. */
export function constList(source: string, name: string): string[] {
  const m = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(source);
  if (!m?.[1]) throw new Error(`${name} isn't in the vendored contracts`);
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1] ?? '');
}

/** The screen of widgets' shapes (`@whombat/core` domain/desk-screens.ts, 3.6): the grid's ids, bounds and lists. */
export const deskScreensSource = readFileSync(
  new URL('../../vendor/whombat-contracts/desk-screens.ts', import.meta.url),
  'utf8',
);

/** The weather (`@whombat/core` domain/weather.ts): the forecast's bounds and MET's symbol, for the weather view. */
export const weatherSource = readFileSync(
  new URL('../../vendor/whombat-contracts/weather.ts', import.meta.url),
  'utf8',
);
