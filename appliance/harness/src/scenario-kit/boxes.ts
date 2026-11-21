/**
 * The Whombat the scenarios claim: the environment's dev appliance, as a person meets it (Whombat whombat-link.md
 * LNK-12, LNK-13). It made its identity itself and was told at its installer to be reached with Whombat Link, so its
 * screen first shows a Link code and where to type it, then, once its owner confirmed the code at the account site,
 * the four claim letters and its own page. `consoleOf` is that screen (`WHOMBAT_CONSOLE_FILE`, what tty1 draws on a
 * box); the claim itself runs on the box's own page, over the direct connection that page uses (`directUrl`).
 */
import { CLAIM_CODE_ALPHABET } from '@whombat/protocol/claim';
import { readConsoleState } from '../dev/console.ts';
import { paths } from '../lib/paths.ts';
import { sleep } from '../lib/proc.ts';
import { directSocketUrl, env } from './world.ts';

export interface Box {
  name: string;
  deviceId: string;
  peerId: string;
  consoleFile: string;
  adminSocket: string;
  managerSocket: string;
  /** The box's direct socket, which its own page connects to (`ws://127.0.0.1:<port>/v1/direct` here). */
  directUrl: string;
}

/** The environment's dev appliance as a box. */
export function applianceBox(): Box {
  const e = env();
  const a = e.appliance;
  if (!a) throw new Error('no dev appliance');
  const directUrl = directSocketUrl(e);
  if (!directUrl) throw new Error('the dev appliance has no direct listener: its own page can’t be reached');
  return {
    name: 'dev appliance',
    deviceId: a.deviceId,
    peerId: a.peerId,
    consoleFile: paths.console,
    adminSocket: a.adminSocket,
    managerSocket: a.managerSocket,
    directUrl,
  };
}

/** Whombat Link as the screen shows it: its state and, while it starts, the code and the page to type it at. */
export interface ConsoleLinkView {
  state: string;
  code: string | null;
  url: string | null;
  waitingForAddress: boolean;
}

/** What a box's console shows, as the person reads it (the letters of a `claimable` console, CC-13). */
export interface ConsoleView {
  state: string;
  code: string | null;
  url: string;
  retryAt: string | null;
  /** Null when the screen says nothing about Link (a box that was never asked to use it). */
  link: ConsoleLinkView | null;
}

export function consoleOf(box: Box): ConsoleView | null {
  const s = readConsoleState(box.consoleFile);
  if (!s) return null;
  const link = s.reach?.link;
  return {
    state: s.state,
    code: s.code ?? null,
    url: s.url,
    retryAt: s.retryAt ? String(s.retryAt) : null,
    link: link
      ? {
          state: link.state,
          code: link.code ?? null,
          url: link.url ?? null,
          waitingForAddress: link.waitingForAddress === true,
        }
      : null,
  };
}

/** Waits until the box's console satisfies `ok` (the runtime rewrites the file on every change). */
export async function waitForConsole(
  box: Box,
  ok: (c: ConsoleView) => boolean,
  what: string,
  timeoutMs = 60_000,
): Promise<ConsoleView> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const c = consoleOf(box);
    if (c && ok(c)) return c;
    if (Date.now() > until)
      throw new Error(`${box.name}: console never showed ${what} (last: ${JSON.stringify(c)})`);
    await sleep(250);
  }
}

/** The screen shows four claim letters. */
export const claimable = (c: ConsoleView) => c.state === 'claimable' && !!c.code;

/** The letters a person types (CC-13: the console shows only them; before contracts 0.8 the code carried digits). */
export function lettersOf(code: string): string {
  const parts = code.split('-');
  return parts.length === 3 ? `${parts[0]}${parts[2]}` : code;
}

/** Four letters of the claim alphabet that differ from `letters` in every place (a wrong guess). */
export function wrongLetters(letters: string): string {
  return [...letters]
    .map((c) => CLAIM_CODE_ALPHABET[(CLAIM_CODE_ALPHABET.indexOf(c) + 1) % CLAIM_CODE_ALPHABET.length])
    .join('');
}
