/**
 * A thing's glyph on the phone: the shared one (`thingGlyph`), except Website feedback, which draws the speech bubble
 * its logo tile has (`connectionLogo`) rather than the generic plug: it has no brand mark of its own. Pure.
 */
import { type ThingGlyph, thingGlyph } from '@whombat/client';
import type { ThingSummary } from '@whombat/core';

export type PhoneGlyph = ThingGlyph | 'message';

export function phoneThingGlyph(thing: Pick<ThingSummary, 'icon' | 'catalogId' | 'kind'>): PhoneGlyph {
  return thing.catalogId === 'feedback' || thing.icon === 'feedback' ? 'message' : thingGlyph(thing);
}
