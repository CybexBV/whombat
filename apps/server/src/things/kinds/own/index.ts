/**
 * Kinds Whombat draws from its own records rather than the service's API: a report tracker (its mirrored reports and
 * fixes) and a generic AI gateway (the turns Whombat sent through it).
 */
import type { KindModule } from '../registry';
import { AI_GATEWAY_KIND } from './gateway';
import { TRACKER_KIND } from './tracker';

export const OWN_KINDS: Record<string, KindModule> = {
  tracker: TRACKER_KIND,
  ai_gateway: AI_GATEWAY_KIND,
};
