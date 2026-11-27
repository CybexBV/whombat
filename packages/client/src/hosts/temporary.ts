/**
 * Temporary machines (Whombat server-pages.md): build and test machines that come and go by themselves, which a person
 * never set up and never needs to look after. Server pages leave them out of their lists, the busiest list and every
 * count, and a quiet “6 temporary machines hidden · Show” row brings them back. Pure.
 */
import { isTemporaryGuest, type TemporaryFacts } from '@whombat/core';
import { clientTree } from '../i18n/catalog';
import { HOSTS_TEMPORARY_WORDS } from '../i18n/messages/connectionsHosts/hostsBasics';

/**
 * Whether a guest is a temporary machine: an Incus instance outside the `default` project, a CI job's machine, a leased
 * sandbox, or a container Whombat runs itself; never the machine this Whombat runs in. Core's rule, which care plans
 * use too (Whombat care-plan.md).
 */
export { isTemporaryGuest };

type GuestFacts = TemporaryFacts;

/** A list without its temporary machines, and those apart (in their order). */
export function splitTemporary<T extends GuestFacts>(guests: readonly T[]): { kept: T[]; temporary: T[] } {
  const kept: T[] = [];
  const temporary: T[] = [];
  for (const g of guests) (isTemporaryGuest(g) ? temporary : kept).push(g);
  return { kept, temporary };
}

/** The row that brings them back (“6 temporary machines hidden”, then Show or Hide). */
export function temporaryWords(locale?: string | null) {
  const w = clientTree(locale, HOSTS_TEMPORARY_WORDS);
  return {
    hidden: (n: number) => w.hidden(n),
    shown: (n: number) => w.shown(n),
    show: w.show,
    hide: w.hide,
    /** What they are, for the row's tooltip and screen readers. */
    about: w.about,
  };
}

export const TEMPORARY_WORDS = temporaryWords('en');

/** The guests a list shows: all of them while the temporary ones are asked for, else the others. */
export function shownGuests<T extends GuestFacts>(
  guests: readonly T[],
  showTemporary: boolean,
): { shown: T[]; hidden: number } {
  if (showTemporary) return { shown: [...guests], hidden: 0 };
  const { kept, temporary } = splitTemporary(guests);
  return { shown: kept, hidden: temporary.length };
}
