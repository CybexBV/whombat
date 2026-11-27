import { splitPairs } from './pairs.js';

/** The two sentences `@whombat/protocol` shows people: a version refusal and the Link offer. */
export const PROTOCOL = splitPairs({
  'version.refusal.client': [
    'Update the app to use this Whombat.',
    'Werk de app bij om deze Whombat te gebruiken.',
  ],
  'version.refusal.appliance': [
    'This Whombat needs an update to work with this app.',
    'Deze Whombat heeft een update nodig om met deze app te werken.',
  ],
  'link.price': ['€2.50 a month', '€2,50 per maand'],
  'link.priceYear': ['€25 a year', '€25 per jaar'],
  'link.trial': ['First month free', 'Eerste maand gratis'],
  'link.offer': ['{trial}, then {price} or {priceYear}', '{trial}, daarna {price} of {priceYear}'],
});
