/**
 * On the page a box serves, What’s new opens as a fresh page: a page left open across an update still runs the version
 * from before it, with that version's changelog, while the box already serves the new one. The hosted app's page
 * follows the hosted app's own version, so it opens in place.
 */
export function whatsNewOpensFresh(): boolean {
  return import.meta.env.VITE_WHOMBAT_TARGET === 'box';
}
