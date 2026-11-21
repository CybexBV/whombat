/**
 * What the Whombat said each managed push is about, by its ref, for the app's life (a ref always names the same item).
 * The shade check looks up the notifications on screen as soon as the app is open, so tapping one of them opens its
 * item at once instead of waiting for the Whombat again; a tap's own answer is kept here too.
 */
import type { ShadeTarget } from './shade';

export const knownPushRefs = new Map<string, ShadeTarget>();
