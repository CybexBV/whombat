/**
 * What’s new opens as a fresh page in the built app: a page left open across an update still runs the version from
 * before it, with that version's changelog, while the box (or the hosted app) already serves the new one. On the hosted
 * app a fresh load shows it as its public page, with the way back into the app at its top.
 */
export function whatsNewOpensFresh(): boolean {
  const target = import.meta.env.VITE_WHOMBAT_TARGET;
  return target === 'box' || target === 'hosted';
}
