/**
 * Which page a screen is on (docs/app/decisions/iphone-duo.md). On a phone every screen is the only one; with two
 * pages the tabs are the list on the left and what they opened shows beside them, the first of those with a close
 * button instead of a back arrow.
 */
import { createContext, useContext } from 'react';

export type PaneRole = 'only' | 'list' | 'beside-first' | 'beside';

export const PaneRoleContext = createContext<PaneRole>('only');

export function usePaneRole(): PaneRole {
  return useContext(PaneRoleContext);
}

/** What the right page opened first (its route), so the list can mark it; null with one page or nothing open. */
export interface BesideRoute {
  name: string;
  params?: object;
}

export const BesideContext = createContext<BesideRoute | null>(null);

export function useBeside(): BesideRoute | null {
  return useContext(BesideContext);
}

/** Whether the right page shows the route `name` whose `key` param is `value` (a Watch item, a Needs you item). */
export function isBeside(beside: BesideRoute | null, name: string, key: string, value: string): boolean {
  return beside?.name === name && (beside.params as Record<string, unknown> | undefined)?.[key] === value;
}

/**
 * With two pages the headers with a line under them line up across the divider: each reports how tall it is by itself
 * (`report`, null when it goes) and all of them are `height` tall, the tallest's. Null on one page.
 */
export interface HeaderLine {
  height: number;
  report: (id: string, height: number | null) => void;
}

export const HeaderLineContext = createContext<HeaderLine | null>(null);

/**
 * With two pages the lines over the reply boxes line up across the divider too (ios-native.md): each box reports how
 * tall it is at rest, empty (a wrapped “Ask Dusty anything”, a settled thread's note under it), and every box is at
 * least the tallest's. What is typed grows only its own box. Null on one page.
 */
export const ComposerLineContext = createContext<HeaderLine | null>(null);

/**
 * With two pages, the right page's own page while nothing is open there (beside Chat a new chat, iphone-duo.md):
 * `show` closes what the right page shows and wakes it (the new chat's box gets the cursor); `waking` stays true until
 * the page took it (`woke`), so a page that comes back later doesn't wake by itself. Null on one page.
 */
export interface RestingPage {
  waking: boolean;
  show: () => void;
  woke: () => void;
}

export const RestingPageContext = createContext<RestingPage | null>(null);

/**
 * With two pages, the person can hide the list so the page beside it takes the whole width, the tabs staying where they
 * are (iphone-duo.md AP-6730, AP-6740): `hidden` says whether it is hidden now, `toggle` hides or shows it, kept on the
 * phone for each tab; `chat` says it is Chat's list of threads. Null with one page, and beside the other tabs while
 * nothing is open there.
 */
export interface ListToggle {
  hidden: boolean;
  toggle: () => void;
  chat: boolean;
}

export const ListToggleContext = createContext<ListToggle | null>(null);

/**
 * The tab the list last showed, kept by the stack (docs/app/decisions/iphone-duo.md AP-6340). Going from one page to
 * two or back draws the tabs somewhere else, so React Navigation drops their state and mounts them anew: they start on
 * this tab rather than on Chat. Null before any tab showed (the app opens on Chat).
 */
export const LastTabContext = createContext<{ current: string | null } | null>(null);

export function useLastTab(): string | null {
  return useContext(LastTabContext)?.current ?? null;
}

/** Whether the thread starting at `messageId` is what the right page shows. */
export function isBesideThread(beside: BesideRoute | null, messageId: string | undefined): boolean {
  if (beside?.name !== 'Thread' || !messageId) return false;
  return (beside.params as { messageId?: string } | undefined)?.messageId === messageId;
}

/**
 * How much of a tab's screen iOS's own tab bar covers at the bottom, the home indicator's room under it included
 * (`GlassTabs`, native-feel.md): what a list scrolls on into and what Chat's reply box sits on. Undefined outside iOS's
 * bar, where a tab's screen ends above our bar or runs on to the window's bottom.
 */
export const GlassBarRoomContext = createContext<number | undefined>(undefined);
