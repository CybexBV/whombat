/**
 * Temporary machines (Whombat server-pages.md): build and test machines that come and go by themselves, which a person
 * never set up and never needs to look after. Server pages leave them out of their lists, the busiest list and every
 * count, and a quiet “6 temporary machines hidden · Show” row brings them back. Pure.
 */
import { isTemporaryGuest, type TemporaryFacts } from '@whombat/core';
import { plural } from './format';

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
export const TEMPORARY_WORDS = {
  hidden: (n: number) => `${plural(n, 'temporary machine')} hidden`,
  shown: (n: number) => `${plural(n, 'temporary machine')} shown`,
  show: 'Show',
  hide: 'Hide',
  /** What they are, for the row's tooltip and screen readers. */
  about: 'Build and test machines that come and go by themselves.',
} as const;

/** The guests a list shows: all of them while the temporary ones are asked for, else the others. */
export function shownGuests<T extends GuestFacts>(
  guests: readonly T[],
  showTemporary: boolean,
): { shown: T[]; hidden: number } {
  if (showTemporary) return { shown: [...guests], hidden: 0 };
  const { kept, temporary } = splitTemporary(guests);
  return { shown: kept, hidden: temporary.length };
}
