/**
 * With two pages the person can hide a tab's list so what is open beside it takes the whole width (iphone-duo.md):
 * beside Chat always, since its right page is a thread or a new chat; beside the other tabs
 * only while something is open there, since their right page is empty without the list. Each tab keeps its own choice
 * on the phone. Pure.
 */
import { HOME_TAB, TABS, type Tab } from './shell';

/** The tabs other than Chat whose list the person hid, as the phone keeps them (`NeedsYou,Automations`). */
export function parseFullWidthTabs(raw: string | null): ReadonlySet<Tab> {
  const known = new Set<string>(TABS);
  return new Set((raw ?? '').split(',').filter((t): t is Tab => known.has(t) && t !== HOME_TAB));
}

export function writeFullWidthTabs(tabs: ReadonlySet<Tab>): string {
  return TABS.filter((t) => t !== HOME_TAB && tabs.has(t)).join(',');
}

/** The tabs with this one's list hidden, or shown again. */
export function withFullWidth(tabs: ReadonlySet<Tab>, tab: Tab, on: boolean): ReadonlySet<Tab> {
  const next = new Set(tabs);
  if (on) next.add(tab);
  else next.delete(tab);
  return next;
}

export interface ListHiding {
  /** Whether the list is hidden now. */
  hidden: boolean;
  /** Whether the right page's header offers the button that hides and shows it. */
  offered: boolean;
}

/**
 * Whether the tab's list is hidden and whether the button is offered: Chat's always; another tab's only while something
 * is open beside it, so closing that page brings the list back and the choice comes back with the next thing opened.
 */
export function listHiding({
  chat,
  kept,
  open,
}: {
  chat: boolean;
  kept: boolean;
  open: boolean;
}): ListHiding {
  const offered = chat || open;
  return { hidden: offered && kept, offered };
}

/** From this width a page's cards sit in two columns (an open Duo or foldable with the list hidden; a phone is narrower). */
export const WIDE_PAGE_MIN_WIDTH = 680;

export function isWidePage(width: number): boolean {
  return width >= WIDE_PAGE_MIN_WIDTH;
}
